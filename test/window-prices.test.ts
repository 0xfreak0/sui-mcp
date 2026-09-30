import { beforeEach, describe, expect, it, vi } from "vitest";
import { windowPrices, WindowAmounts, resetWindowPriceCache } from "../src/utils/window-prices.js";
import { resetLiveCoinScale } from "../src/utils/valuation.js";
import { getNetwork, runWithNetwork } from "../src/config.js";
const pythKey = vi.hoisted(() => vi.fn());
const metadataRead = vi.hoisted(() => vi.fn());
vi.mock("../src/clients/grpc.js", () => ({ sui: { stateService: { getCoinInfo: metadataRead } }, archive: {} }));
const pointRead = vi.hoisted(() => vi.fn());
const historyRead = vi.hoisted(() => vi.fn());
vi.mock("../src/utils/valuation.js", async (original) => ({ ...(await original<object>()), priceUsdAtTime: pointRead }));
vi.mock("../src/utils/price-providers.js", async (original) => ({ ...(await original<object>()), fetchDefiLlamaHistory: historyRead, pythApiKey: pythKey }));
const SUI = "0x2::sui::SUI";
const JAN = 1735689600;
const JUL = 1751328000;
beforeEach(() => { resetWindowPriceCache(); resetLiveCoinScale(); vi.clearAllMocks(); pythKey.mockReturnValue(null); });

describe("window USD", () => {
  it("sums differently priced signed legs even when their raw net is zero", async () => {
    historyRead.mockResolvedValue(new Map([[SUI, new Map([[JAN, { price: 4, at: JAN }], [JUL, { price: 2, at: JUL }]])]]));
    const prices = await windowPrices([{ at: JAN + 100, coins: [SUI] }, { at: JUL + 200, coins: [SUI] }]);
    const amounts = new WindowAmounts(prices);
    amounts.add(SUI, 10_000_000_000n, JAN + 100);
    amounts.add(SUI, -10_000_000_000n, JUL + 200);
    expect(amounts.amounts()[0]).toMatchObject({ amount: 0, usd: 20, priced_raw: { in: "10000000000", out: "10000000000" } });
    expect(prices.basis).toMatchObject({ priced_coin_days: 2, partial: false, approximate: true });
  });

  it("excludes missing dates and timestamps without pricing them at a nearby day", async () => {
    historyRead.mockResolvedValue(new Map([[SUI, new Map([[JAN, { price: 4, at: JAN }]])]]));
    const prices = await windowPrices([{ at: JAN, coins: [SUI] }, { at: JUL, coins: [SUI] }, { at: null, coins: [SUI] }]);
    const amounts = new WindowAmounts(prices);
    amounts.add(SUI, 1_000_000_000n, JAN);
    amounts.add(SUI, -2_000_000_000n, JUL);
    amounts.add(SUI, 3_000_000_000n, null);
    expect(amounts.amounts()[0]).toMatchObject({ amount: 2, usd: 4, unpriced_raw: { in: "3000000000", out: "2000000000" } });
    expect(prices.basis).toMatchObject({ partial: true, priced_coin_days: 1, unknown_time_transactions: 1, missing_coin_days: [{ coin_type: SUI, days: 1 }] });
  });

  it("prices one day once and reuses successful historical quotes", async () => {
    pointRead.mockResolvedValue({ points: new Map([[SUI, { price: 4, publishTime: JAN, source: "defillama" }]]), unpriced: [] });
    const requests = [{ at: JAN + 1, coins: [SUI] }, { at: JAN + 86399, coins: [SUI] }];
    expect((await windowPrices(requests)).point(SUI, JAN + 80000)?.price).toBe(4);
    expect((await windowPrices(requests)).basis.priced_coin_days).toBe(1);
    expect(pointRead).toHaveBeenCalledTimes(1);
    expect(historyRead).not.toHaveBeenCalled();
  });

  it("leaves dates beyond the budget unpriced with complete raw coverage", async () => {
    historyRead.mockImplementation(async (requests: Map<string, number[]>) => new Map([...requests].map(([coin, times]) => [coin, new Map(times.map((at) => [at, { price: 2, at }]))])));
    const requests = Array.from({ length: 367 }, (_, i) => ({ at: JAN + i * 86400, coins: [SUI] }));
    const prices = await windowPrices(requests);
    const amounts = new WindowAmounts(prices);
    for (const r of requests) amounts.add(SUI, 1_000_000_000n, r.at);
    expect(prices.basis).toMatchObject({ budget_skipped_coin_days: 1, priced_coin_days: 366, partial: true });
    expect(prices.basis.continue_with).toMatchObject({ from: "2025-01-01T00:00:00.000Z", to: "2025-01-01T23:59:59.999Z" });
    expect(amounts.amounts()[0]).toMatchObject({ amount: 367, usd: 732, unpriced_raw: { in: "1000000000", out: "0" } });
  });

  it("does not reuse stale samples or silently turn a failed day into zero USD", async () => {
    pointRead.mockResolvedValue({ points: new Map([[SUI, { price: 4, publishTime: JAN - 7200, source: "defillama" }]]), unpriced: [] });
    const prices = await windowPrices([{ at: JAN, coins: [SUI] }]);
    const amounts = new WindowAmounts(prices);
    amounts.add(SUI, 10_000_000_000n, JAN);
    expect(amounts.amounts()[0]).toMatchObject({ amount: 10, usd: null, unpriced_raw: { in: "10000000000", out: "0" } });
    expect(prices.basis).toMatchObject({ partial: true, priced_coin_days: 0 });
  });

  it("resolves and caches decimals independently of batch quotes", async () => {
    const coin = `0x${"ab".repeat(32)}::coin::SIX`;
    metadataRead.mockResolvedValue({ response: { metadata: { decimals: 6 } } });
    historyRead.mockResolvedValue(new Map([[coin, new Map([[JAN, { price: 2, at: JAN }], [JUL, { price: 2, at: JUL }]])]]));
    const requests = [{ at: JAN, coins: [coin] }, { at: JUL, coins: [coin] }];
    const prices = await windowPrices(requests);
    const amounts = new WindowAmounts(prices);
    amounts.add(coin, 1_000_000n, JAN);
    amounts.add(coin, 1_000_000n, JUL);
    expect(amounts.amounts()[0]).toMatchObject({ amount: 2, usd: 4 });
    expect(prices.basis).toMatchObject({ priced_coin_days: 2, partial: false });
    await windowPrices(requests);
    expect(metadataRead).toHaveBeenCalledTimes(1);
  });

  it("counts quotes with unknown decimals as unpriced rather than guessing a scale", async () => {
    const coin = `0x${"ac".repeat(32)}::coin::UNKNOWN`;
    metadataRead.mockResolvedValue({ response: {} });
    historyRead.mockResolvedValue(new Map([[coin, new Map([[JAN, { price: 2, at: JAN }], [JUL, { price: 2, at: JUL }]])]]));
    const prices = await windowPrices([{ at: JAN, coins: [coin] }, { at: JUL, coins: [coin] }]);
    const amounts = new WindowAmounts(prices);
    amounts.add(coin, 1_000_000n, JAN);
    amounts.add(coin, -1_000_000n, JUL);
    expect(amounts.amounts()[0]).toMatchObject({ usd: null, unpriced_raw: { in: "1000000", out: "1000000" } });
    expect(prices.basis).toMatchObject({ priced_coin_days: 0, partial: true, missing_coin_days: [{ coin_type: coin, days: 2 }] });
  });

  it("does not reuse a mainnet Pyth quote on another network", async () => {
    pythKey.mockReturnValue("synthetic-key");
    metadataRead.mockResolvedValue({ response: { metadata: { decimals: 9 } } });
    pointRead.mockImplementation(async (_coins: string[], at: number) => ({
      points: new Map([[SUI, { price: getNetwork() === "mainnet" ? 4 : 2, publishTime: at,
        source: getNetwork() === "mainnet" ? "pyth" : "defillama", decimals: 9 }]]),
      unpriced: [],
    }));
    const request = [{ at: JAN, coins: [SUI] }];
    const main = await runWithNetwork("mainnet", () => windowPrices(request));
    const test = await runWithNetwork("testnet", () => windowPrices(request));
    expect(main.point(SUI, JAN)).toMatchObject({ price: 4, source: "pyth" });
    expect(test.point(SUI, JAN)).toMatchObject({ price: 2, source: "defillama" });
  });
});
