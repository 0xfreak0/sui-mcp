import { describe, expect, it, vi } from "vitest";
const SENDER = `0x${"a1".repeat(32)}`;
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const readTxs = vi.hoisted(() => vi.fn());
const gql = vi.hoisted(() => vi.fn());
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: gql }));
vi.mock("../../src/utils/attack-read.js", () => ({ readAttackTransactions: readTxs }));
vi.mock("../../src/utils/valuation.js", async (original) => ({ ...(await original<object>()), prefetchCoinScale: async () => undefined }));
vi.mock("../../src/utils/price-providers.js", async (original) => ({
  ...(await original<object>()), pythApiKey: () => null,
  fetchDefiLlamaHistory: async (requests: Map<string, number[]>) => new Map([...requests].map(([coin, times]) => [
    coin, new Map(times.map((at) => [at, { price: at < Date.parse("2025-06-01") / 1000 ? 4 : 2, at, source: "defillama" }])),
  ])),
}));
import { registerAggregateTools } from "../../src/tools/aggregate.js";
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers = new Map<string, Handler>();
registerAggregateTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never);

describe("aggregate_events historical P&L", () => {
  it("keeps a USD gain when equal raw amounts enter and leave months apart", async () => {
    gql.mockResolvedValue({ events: { nodes: [1, 2].map((i) => ({ sender: { address: SENDER }, transaction: { digest: `synthetic-${i}` },
      contents: { type: { repr: "0x2::example::Event" }, json: { value: i } } })), pageInfo: { hasNextPage: false } } });
    readTxs.mockResolvedValue({ txs: ["2025-01-01", "2025-07-01"].map((date, i) => ({
      digest: `synthetic-${i + 1}`, sender: SENDER, timestampMs: Date.parse(date), calls: [],
      balanceChanges: [{ address: SENDER, coinType: SUI, amount: i ? "-10000000000" : "10000000000" }],
    })), missing: [] });
    const result = JSON.parse((await handlers.get("aggregate_events")!({ sender: SENDER, group_pnl: true, max_events: 50 })).content[0].text);
    expect(result.pnl.senders[0]).toMatchObject({ sender: SENDER, usd_net: 20, usd_gained: 20, usd_lost: 0,
      net: [{ amount: 0, usd: 20, raw: { in: "10000000000", out: "10000000000" } }] });
    expect(result.pnl.usd_basis).toMatchObject({ method: "hourly_utc", approximate: true, partial: false, priced_coin_samples: 2 });
  });
});
