import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tool-level test for `screen_address`'s default window.
 *
 * A wallet can send hundreds of transactions after the one that matters, so
 * the default window reads the schema's max of 300 sent transactions rather
 * than only the most recent 100.
 *
 * A subject with 120 sent transactions, the oldest of which pays a labelled
 * counterparty. A 100-transaction window walks past it; the 300-transaction
 * default does not.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/price-providers.js", () => ({ pricesForRanking: async () => new Map() }));

// vi.mock factories above must run before the module under test resolves its
// own imports, so the import stays dynamic rather than static (repo-wide
// convention for tool-level tests; see e.g. test/trace-object-flow.test.ts).
const { registerScreeningTools } = await import("../src/tools/screening.js");

type Args = { address: string; max_transactions?: number };
let handler: (a: Args) => Promise<{ content: { text: string }[] }>;
registerScreeningTools({
  tool: (n: string, _d: string, _s: unknown, h: typeof handler) => {
    if (n === "screen_address") handler = h;
  },
} as never);

const run = async (a: Args) => {
  const r = await handler(a);
  return JSON.parse(r.content[0]!.text);
};

const SUBJECT = "0x" + "ab".repeat(32);
// Real disclosed label (category "malicious"), so the test exercises the
// actual label lookup, not a mocked stand-in.
const LABELLED_COUNTERPARTY = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const TOTAL_SENT = 120;

// Oldest first, matching fetchWindow's own ordering. Index 0 (the oldest
// send) is the one that pays the labelled counterparty; everything after it
// is filler so the transfer falls outside a 100-transaction "most recent"
// window but inside a 300-transaction one.
const sentTxs = Array.from({ length: TOTAL_SENT }, (_, i) => ({
  digest: `sent${i}`,
  sender: { address: SUBJECT },
  gasInput: { gasSponsor: { address: SUBJECT } },
  effects: {
    status: "SUCCESS",
    timestamp: i === 0 ? "2024-01-01T00:00:00Z" : "2024-06-01T00:00:00Z",
    balanceChanges: {
      nodes:
        i === 0
          ? [
              { amount: "-31175000000000", owner: { address: SUBJECT }, coinType: { repr: SUI } },
              { amount: "31175000000000", owner: { address: LABELLED_COUNTERPARTY }, coinType: { repr: SUI } },
            ]
          : [],
    },
    events: { pageInfo: { hasNextPage: false }, nodes: [] },
  },
  kind: { commands: { nodes: [] } },
}));

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockGqlQuery.mockImplementation(async (_query: string, vars: Record<string, unknown>) => {
    const filter = vars.filter as { sentAddress?: string; affectedAddress?: string };
    if (filter?.affectedAddress) {
      return { transactions: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } } };
    }
    const last = vars.last as number;
    const before = vars.before as string | undefined;
    const end = before !== undefined ? Number(before) : TOTAL_SENT;
    const start = Math.max(0, end - last);
    const hasPreviousPage = start > 0;
    return {
      transactions: {
        nodes: sentTxs.slice(start, end),
        pageInfo: { hasPreviousPage, startCursor: hasPreviousPage ? String(start) : null },
      },
    };
  });
});

describe("screen_address default window", () => {
  it("finds a transfer outside the most recent 100 transactions by default", async () => {
    const r = await run({ address: SUBJECT });
    const window = r.windows.find((w: { kind: string }) => w.kind === "sent");
    expect(window.scanned).toBe(TOTAL_SENT);
    expect(window.truncated).toBe(false);
    expect(r.exposures.some((e: { counterparty?: string }) => e.counterparty === LABELLED_COUNTERPARTY)).toBe(true);
  });

  it("still misses it when the caller explicitly asks for only 100", async () => {
    const r = await run({ address: SUBJECT, max_transactions: 100 });
    const window = r.windows.find((w: { kind: string }) => w.kind === "sent");
    expect(window.scanned).toBe(100);
    expect(window.truncated).toBe(true);
    expect(r.exposures.some((e: { counterparty?: string }) => e.counterparty === LABELLED_COUNTERPARTY)).toBe(false);
  });
});
