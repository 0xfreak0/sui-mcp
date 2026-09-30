import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerScreeningTools } from "../src/tools/screening.js";
import type * as Labels from "../src/utils/labels.js";
import type { GqlBalanceChangeNode } from "../src/utils/gql-adapters.js";

const { mockGqlQuery } = vi.hoisted(() => ({ mockGqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/price-providers.js", () => ({ pricesForRanking: async () => new Map() }));
vi.mock("../src/utils/labels.js", async (importOriginal) => ({
  ...await importOriginal<typeof Labels>(),
  getLabel: (address: string) => address.endsWith("bc".repeat(32))
    ? { label: "Synthetic exchange", category: "cex", source: "curated" }
    : null,
}));

let handler: (a: { address: string; direction: string; hops: number }) => Promise<{ content: { text: string }[] }>;
registerScreeningTools({
  tool: (name: string, _description: string, _schema: unknown, fn: typeof handler) => {
    if (name === "screen_address") handler = fn;
  },
} as never);
const run = async () => JSON.parse((await handler({ address: SUBJECT, direction: "out", hops: 1 })).content[0].text);

const SUBJECT = "0x" + "ab".repeat(32);
const EXCHANGE = "0x" + "bc".repeat(32);
const SUI = "0x" + "2".padStart(64, "0") + "::sui::SUI";
const change = (owner: string, amount: string) => ({ owner: { address: owner }, amount, coinType: { repr: SUI } });
const filler = Array.from({ length: 49 }, (_, i) => change("0x" + (i + 100).toString(16).padStart(64, "0"), "0"));
const transaction = (rows: GqlBalanceChangeNode[]) => ({
  digest: "synthetic-payment",
  sender: { address: SUBJECT },
  effects: {
    status: "SUCCESS",
    timestamp: "2025-01-01T00:00:00Z",
    balanceChanges: { nodes: rows, pageInfo: { hasNextPage: true, endCursor: "balance-page-1" } },
    events: { nodes: [], pageInfo: { hasNextPage: false } },
  },
  kind: { commands: { nodes: [] as unknown[] } },
});
const window = (tx: unknown) => ({
  transactions: { nodes: [tx], pageInfo: { hasPreviousPage: false, startCursor: null } },
});

beforeEach(() => { mockGqlQuery.mockReset(); });

describe("screen_address balance-change pages", () => {
  it.each(["subject", "recipient"])("finds exposure with the decisive %s row on page two", async (late) => {
    const debit = change(SUBJECT, "-2000000000");
    const credit = change(EXCHANGE, "2000000000");
    mockGqlQuery.mockResolvedValueOnce(window(transaction([...filler, late === "subject" ? credit : debit])))
      .mockResolvedValueOnce({ transactionEffects: { balanceChanges: {
        nodes: [late === "subject" ? debit : credit], pageInfo: { hasNextPage: false, endCursor: null },
      } } });
    const result = await run();
    expect(result.exposures).toEqual([expect.objectContaining({
      category: "cex", counterparty: EXCHANGE,
      legs: [expect.objectContaining({ amount: "2 SUI", digests: ["synthetic-payment"] })],
    })]);
  });

  it("withholds partial paths and reports the unread transaction instead of a complete negative", async () => {
    mockGqlQuery.mockResolvedValueOnce(window(transaction([
      ...filler.slice(1), change(SUBJECT, "-2000000000"), change(EXCHANGE, "2000000000"),
    ]))).mockImplementationOnce(async () => { throw new Error("continuation unavailable"); });
    const result = await run();
    expect(result.exposures).toEqual([]);
    expect(result.windows).toEqual([expect.objectContaining({ incomplete_transactions: ["synthetic-payment"] })]);
    expect(result.summary).toContain("incomplete");
  });

  it("keeps an independently detected bridge exit but withholds its partial sent amount", async () => {
    const tx = transaction([...filler, change(SUBJECT, "-2000000000")]);
    tx.kind.commands.nodes = [{ function: {
      name: "deposit_for_burn", module: { name: "deposit_for_burn", package: { address: "0x123" } },
    } }];
    mockGqlQuery.mockResolvedValueOnce(window(tx))
      .mockImplementationOnce(async () => { throw new Error("continuation unavailable"); })
      .mockResolvedValueOnce({ transaction: { effects: { events: { nodes: [], pageInfo: { hasNextPage: false } } } } });
    const result = await run();
    expect(result.exposures).toEqual([expect.objectContaining({
      category: "bridge", sent: null, incomplete_transactions: ["synthetic-payment"],
    })]);
  });
});
