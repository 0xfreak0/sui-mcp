import { describe, expect, it, vi } from "vitest";

const mockGqlQuery = vi.fn();
const mockReadTransactions = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/utils/attack-read.js", () => ({ readAttackTransactions: mockReadTransactions }));
vi.mock("../src/utils/window-prices.js", () => ({
  windowPrices: async () => ({ basis: { method: "fixture", partial: false } }),
  WindowAmounts: class {
    values = new Map();
    addMap() { }
    amounts() { return []; }
  },
}));

const { registerAggregateTools } = await import("../src/tools/aggregate.js");
type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
let aggregate!: Handler;
registerAggregateTools({
  tool: (name: string, _description: string, _schema: unknown, handler: Handler) => {
    if (name === "aggregate_events") aggregate = handler;
  }
} as never);

const firstSender = `0x${"a".repeat(64)}`;
const secondSender = `0x${"b".repeat(64)}`;

const report = async (args: Record<string, unknown>) => {
  const result = await aggregate({ sender: firstSender, group_pnl: true, top: 1, ...args });
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
};

describe("aggregate_events P&L result paging", () => {
  it("reaches every sender and every transaction digest beyond display caps", async () => {
    const digests = Array.from({ length: 7 }, (_, i) => `digest-${i}`);
    mockGqlQuery.mockResolvedValue({
      events: {
        nodes: digests.map((digest) => ({ sender: { address: firstSender }, transaction: { digest }, contents: { type: { repr: "0x2::m::E" }, json: {} } })),
        pageInfo: { hasNextPage: false, endCursor: null },
      }
    });
    mockReadTransactions.mockImplementation(async (requested: string[]) => ({
      txs: requested.map((digest) => ({
        digest, sender: digest === "digest-6" ? secondSender : firstSender,
        timestampMs: null, balanceChanges: [], calls: [],
      })),
      missing: [],
    }));

    const first = (await report({})).pnl;
    expect(first).toMatchObject({ sender_count: 2, sender_offset: 0, digest_offset: 0 });
    expect(first.senders[0].digests).toEqual(digests.slice(0, 5));
    expect(first.senders_next_call).toMatchObject({ tool: "aggregate_events", repeat_with: { pnl_sender_offset: 1 } });
    expect(first.digests_next_call).toMatchObject({ tool: "aggregate_events", repeat_with: { pnl_digest_offset: 5 } });

    const nextDigests = (await report({ pnl_digest_offset: 5 })).pnl;
    expect(nextDigests.senders[0].digests).toEqual(["digest-5"]);
    expect(nextDigests.digests_next_call).toBeUndefined();

    const nextSender = (await report({ pnl_sender_offset: 1 })).pnl;
    expect(nextSender.senders[0].sender).toBe(secondSender);
    expect(nextSender.senders[0].digests).toEqual(["digest-6"]);
    expect(nextSender.senders_next_call).toBeUndefined();

    const small = (await report({ pnl_max_transactions: 3 })).pnl;
    expect(small.transactions_next_call).toMatchObject({ tool: "aggregate_events", repeat_with: { pnl_transaction_offset: 3 } });
    expect(small.senders[0].digests).toEqual(digests.slice(0, 3));
    const middle = (await report({ pnl_max_transactions: 3, pnl_transaction_offset: 3 })).pnl;
    expect(middle.senders[0].digests).toEqual(digests.slice(3, 6));
    expect(middle.transactions_next_call.repeat_with.pnl_transaction_offset).toBe(6);
    const last = (await report({ pnl_max_transactions: 3, pnl_transaction_offset: 6 })).pnl;
    expect(last.senders[0].digests).toEqual(["digest-6"]);
    expect(last.transactions_next_call).toBeUndefined();
  });

  it("pages all discovered event types past the first fifteen", async () => {
    const types = Array.from({ length: 17 }, (_, i) => `0x2::m::Type${i}`);
    mockGqlQuery.mockResolvedValue({
      events: {
        nodes: types.map((repr, i) => ({ sender: { address: firstSender }, transaction: { digest: `d${i}` }, contents: { type: { repr }, json: {} } })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const first = await aggregate({ sender: firstSender });
    const firstPage = JSON.parse(first.content[0].text);
    expect(firstPage.event_types).toHaveLength(15);
    expect(firstPage.event_types_page.next_call).toMatchObject({ tool: "aggregate_events", repeat_with: { event_type_offset: 15 } });
    const later = await aggregate({ sender: firstSender, event_type_offset: 15 });
    const laterPage = JSON.parse(later.content[0].text);
    expect(laterPage.event_types.map((t: { type: string }) => t.type)).toEqual(types.slice(15));
    expect(laterPage.event_types_page.next_call).toBeUndefined();
  });
});
