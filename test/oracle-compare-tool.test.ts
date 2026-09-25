import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchCandles = vi.fn();
const resolvePool = vi.fn();
vi.mock("../src/utils/deepbook-indexer.js", () => ({
  fetchCandles,
  resolvePool,
  fetchOrderbook: vi.fn(),
  fetchPools: vi.fn(),
  fetchTrades: vi.fn(),
}));
const priceUsdAtTime = vi.fn();
vi.mock("../src/utils/valuation.js", () => ({ priceUsdAtTime }));
const pythApiKey = vi.fn();
vi.mock("../src/utils/price-providers.js", () => ({ pythApiKey }));

const { registerDeepBookTools } = await import("../src/tools/deepbook.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, Handler> = {};
registerDeepBookTools({
  tool: (name: string, _d: string, _s: unknown, h: Handler) => {
    handlers[name] = h;
  },
} as never);
const run = async (args: Record<string, unknown>) => JSON.parse((await handlers.compare_oracle_price(args)).content[0].text);

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
// SUI_USDC 1h candles from the DeepBook indexer, [open ms, open, high, low, close, volume]:
// the two before the Cetus exploit, read with end_time 2025-05-22T10:40:00Z.
const END = Date.parse("2025-05-22T10:40:00Z") / 1000;
const NINE = Date.parse("2025-05-22T09:00:00Z");
const TEN = Date.parse("2025-05-22T10:00:00Z");
const CANDLES = [
  [TEN, 4.162, 4.21, 4.15, 4.193, 76423.5],
  [NINE, 4.147, 4.18, 4.13, 4.162, 251624.4],
];

beforeEach(() => {
  fetchCandles.mockReset().mockResolvedValue(CANDLES);
  resolvePool.mockReset().mockResolvedValue({ pool_name: "SUI_USDC", base_asset_id: SUI, base_asset_symbol: "SUI" });
  priceUsdAtTime.mockReset();
  pythApiKey.mockReset();
});

describe("compare_oracle_price", () => {
  it("reads the oracle at each candle's close, where the market price is taken", async () => {
    pythApiKey.mockReturnValue("key");
    priceUsdAtTime.mockImplementation(async (_coins: string[], at: number) => ({
      points: new Map([[SUI, { price: 4.19, publishTime: at, source: "pyth" }]]),
      unpriced: [],
    }));

    const out = await run({ pool_name: "SUI_USDC", interval: "1h", limit: 2, end_time: END });

    // The 09:00 candle closes at 10:00; the 10:00 candle is still open at the
    // window's end, 10:40.
    const asked = priceUsdAtTime.mock.calls.map((c) => c[1]).sort();
    expect(asked).toEqual([TEN / 1000, END]);
    expect(out.flagged_count).toBe(0);
    expect(out.oracle_unavailable).toBeUndefined();
  });

  it("says nothing was compared when no PYTH_API_KEY is set, rather than flagging zero", async () => {
    pythApiKey.mockReturnValue(null);

    const out = await run({ pool_name: "SUI_USDC", interval: "1h", limit: 2, end_time: END });

    expect(priceUsdAtTime).not.toHaveBeenCalled();
    expect(out.oracle_unavailable).toMatch(/PYTH_API_KEY/);
    expect(out.flagged_count).toBeNull();
    expect(out.points.map((p: { market_price: number }) => p.market_price)).toEqual([4.193, 4.162]);
  });
});
