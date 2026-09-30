import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { priceUsdAtTime } from "../src/utils/valuation.js";
import { fetchHistoricalMarketPrices, fetchRecentHistory, resetRecentPriceCache } from "../src/utils/recent-prices.js";
import { defiLlamaKey } from "../src/utils/price-providers.js";
import { WindowAmounts, resetWindowPriceCache, windowPrices } from "../src/utils/window-prices.js";

const COIN = "0xabc::coin::COIN";
const NOW = Date.parse("2026-09-30T12:00:00Z") / 1000;
const AT = NOW - 2 * 86400;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const coinGeckoReply = (url: string, prices: unknown, coin = COIN) =>
  ok(url.includes("/market_chart/") ? { prices, current_price: { usd: 99 } } : { platforms: { sui: coin } });
let fetchMock: Mock;
beforeEach(() => {
  resetRecentPriceCache();
  resetWindowPriceCache();
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  vi.stubEnv("PYTH_API_KEY", "");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("recent historical fallbacks", () => {
  it("reports out-of-range when no selected market provider can serve the date", async () => {
    const result = await priceUsdAtTime([COIN], NOW - 366 * 86400, { sources: ["coingecko", "geckoterminal"] });
    expect(result.unpriced).toMatchObject([{ coin_type: COIN, code: "out_of_range",
      out_of_range_sources: ["coingecko", "geckoterminal"] }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a served no-quote answer separate from another provider's skipped range", async () => {
    const at = NOW - 181 * 86400;
    fetchMock.mockImplementation(async (url: string) => coinGeckoReply(url, []));
    const result = await priceUsdAtTime([COIN], at, { sources: ["coingecko", "geckoterminal"] });
    expect(result.unpriced).toMatchObject([{ coin_type: COIN, code: "not_listed", out_of_range_sources: ["geckoterminal"] }]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("api.geckoterminal.com"))).toBe(false);
  });

  it.each([false, true])("carries out-of-range sources into window coverage (fixed=%s)", async (fixed) => {
    const sui = "0x2::sui::SUI";
    const at = NOW - 400 * 86400;
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    const prices = await windowPrices([{ at, coins: [sui] }, { at: at + 3600, coins: [sui] }], fixed ? at : undefined);
    expect(prices.basis).toMatchObject({ partial: true, out_of_range_coin_samples: [
      { coin_type: sui, source: "coingecko", samples: fixed ? 1 : 2 },
      { coin_type: sui, source: "geckoterminal", samples: fixed ? 1 : 2 },
    ], missing_coin_samples: [{ samples: fixed ? 1 : 2, request_failed_samples: fixed ? 1 : 2 }] });
    const amounts = new WindowAmounts(prices);
    amounts.add(sui, 1_000_000_000n, at);
    expect(amounts.coverage(sui)).toMatchObject({ unpriced_raw: { in: "1000000000", out: "0" } });
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("coins.llama.fi"))).toBe(true);
  });

  it.each(["0xabc::coin::coin", "0xabc::Coin::COIN"])("rejects CoinGecko case-insensitive matches for %s", async (coin) => {
    fetchMock.mockImplementation(async (url: string) => url.includes("/market_chart/")
      ? ok({ prices: [[AT * 1000, 9]] }) : ok({ platforms: { sui: COIN }, contract_address: coin }));
    const result = await priceUsdAtTime([coin], AT, { sources: ["coingecko"] });
    expect(result.points.has(coin)).toBe(false);
    expect(result.unpriced).toMatchObject([{ coin_type: coin, code: "not_listed" }]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/market_chart/"))).toBe(false);
    const exact = await priceUsdAtTime([COIN], AT, { sources: ["coingecko"] });
    expect(exact.points.get(COIN)).toMatchObject({ price: 9, source: "coingecko", publishTime: AT });
  });

  it("rejects GeckoTerminal pool records for a case-distinct Move type", async () => {
    const coin = "0xabc::coin::coin";
    fetchMock.mockImplementation(async (url: string) => url.includes("/tokens/") ? ok({ data: [{
      attributes: { address: "0xpool", reserve_in_usd: "100" },
      relationships: { base_token: { data: { id: `sui-network_${COIN}` } } },
    }] }) : ok({ data: { attributes: { ohlcv_list: [[AT - 3600, 9, 9, 9, 9, 1]] } } }));
    const result = await priceUsdAtTime([coin], AT, { sources: ["geckoterminal"] });
    expect(result.points.has(coin)).toBe(false);
    expect(result.unpriced).toMatchObject([{ coin_type: coin, code: "not_listed" }]);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/ohlcv/"))).toBe(false);
  });

  it("prices the exact contract from CoinGecko after a plain-text DefiLlama failure", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("coins.llama.fi")) return { ok: true, status: 200, json: async () => { throw new SyntaxError("usage limit"); } };
      if (url.includes("api.coingecko.com")) return coinGeckoReply(url, [[(AT - 20) * 1000, 0.25], [(AT + 300) * 1000, 0.5]]);
      throw new Error(`Unexpected provider: ${url}`);
    });
    const result = await priceUsdAtTime([COIN], AT);
    expect(result.points.get(COIN)).toMatchObject({ source: "coingecko", price: 0.25, publishTime: AT - 20 });
    expect(result.unpriced).toEqual([]);
    const request = fetchMock.mock.calls.find(([url]) => String(url).includes("/market_chart/"))!;
    expect(decodeURIComponent(String(request[0]))).toContain("::coin::COIN/market_chart/range");
  });

  it("does not mistake successful empty replies for request failures", async () => {
    fetchMock.mockImplementation(async (url: string) => url.includes("coins.llama.fi") ? ok({ coins: {} })
      : url.includes("api.coingecko.com") ? coinGeckoReply(url, []) : ok({ data: [] }));
    expect((await priceUsdAtTime([COIN], AT)).unpriced).toMatchObject([{ coin_type: COIN, code: "not_listed" }]);
  });

  it.each([
    { ok: false, status: 429, json: async () => ({ error: "limited" }) },
    { ok: true, status: 200, json: async () => { throw new SyntaxError("not JSON"); } },
    ok({ error: "usage limit" }),
  ])("reports an unanswered fallback instead of no price", async (failure) => {
    fetchMock.mockImplementation(async (url: string) => url.includes("coins.llama.fi") ? ok({ coins: {} })
      : url.includes("api.coingecko.com") ? failure : ok({ data: [] }));
    expect((await priceUsdAtTime([COIN], AT)).unpriced).toMatchObject([{ coin_type: COIN, code: "request_failed" }]);
  });

  it("skips expired and future dates before any discovery or chart request", async () => {
    for (const [source, days] of [["coingecko", 365], ["geckoterminal", 180]] as const) {
      const result = await fetchRecentHistory(new Map([[COIN, [NOW - days * 86400 - 1, NOW + 1]]]), source);
      expect(result.quotes.size).toBe(0);
      expect(result.unanswered.size).toBe(0);
      expect(result.outOfRange).toEqual([
        { coin_type: COIN, at: NOW - days * 86400 - 1, source },
        { coin_type: COIN, at: NOW + 1, source },
      ]);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a current quote and distant or malformed chart samples", async () => {
    fetchMock.mockImplementation(async (url: string) => coinGeckoReply(url, [[NOW * 1000, 99], [(AT + 3601) * 1000, 3], [AT * 1000, -1], [AT * 1000, "4"]]));
    const result = await fetchRecentHistory(new Map([[COIN, [AT]]]), "coingecko");
    expect(result.quotes.size).toBe(0);
    expect(result.unanswered.size).toBe(0);
  });

  it("shares one day chart between duplicate spellings, dates and concurrent callers", async () => {
    fetchMock.mockImplementation(async (url: string) => coinGeckoReply(url, [[AT * 1000, 2], [(AT + 3600) * 1000, 3]]));
    const padded = defiLlamaKey(COIN)!.slice(4);
    const [first, second] = await Promise.all([
      fetchRecentHistory(new Map([[COIN, [AT, AT, AT + 3600]], [padded, [AT]]]), "coingecko"),
      fetchRecentHistory(new Map([[COIN, [AT + 3600]]]), "coingecko"),
    ]);
    expect(first.quotes.get(COIN)?.get(AT)?.price).toBe(2);
    expect(first.quotes.get(padded)?.get(AT)?.price).toBe(2);
    expect(second.quotes.get(COIN)?.get(AT + 3600)?.price).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed read as an absent coin", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 }).mockImplementation(async (url: string) => coinGeckoReply(url, [[AT * 1000, 2]]));
    const request = new Map([[COIN, [AT]]]);
    expect((await fetchRecentHistory(request, "coingecko")).unanswered.get(COIN)?.has(AT)).toBe(true);
    expect((await fetchRecentHistory(request, "coingecko")).quotes.get(COIN)?.get(AT)?.price).toBe(2);
  });

  it("uses the most liquid matching pool across pages and prices the correct side at candle close", async () => {
    const pool = (address: string, reserve: number, coin = COIN) => ({
      attributes: { address, reserve_in_usd: String(reserve) },
      relationships: { base_token: { data: { id: "sui-network_0xdef::coin::OTHER" } }, quote_token: { data: { id: `sui-network_${coin}` } } },
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("coins.llama.fi")) return ok({ coins: {} });
      if (url.includes("api.coingecko.com")) return { ok: false, status: 404, json: async () => ({ error: "coin not found" }) };
      if (url.includes("/tokens/")) return ok({ data: url.includes("page=1")
        ? Array.from({ length: 20 }, (_, i) => pool(`0x${i + 1}`, i + 1))
        : [pool("0xbest", 1000), pool("0ximpostor", 99999, "0xeee::coin::COIN")] });
      expect(url).toContain("/pools/0xbest/ohlcv/hour");
      expect(new URL(url).searchParams.get("token")).toBe("quote");
      expect(new URL(url).searchParams.get("currency")).toBe("usd");
      return ok({ data: { attributes: { ohlcv_list: [[AT - 3600, 4, 5, 2, 3, 10]] } } });
    });
    const result = await priceUsdAtTime([COIN], AT);
    expect(result.points.get(COIN)).toMatchObject({ price: 3, source: "geckoterminal", publishTime: AT,
      market: { pool_address: "0xbest", candle_start: AT - 3600, candle_end: AT, pool_scan_complete: true } });
  });

  it("states a capped pool scan and rejects unfinished candles", async () => {
    fetchMock.mockImplementation(async (url: string) => url.includes("/tokens/") ? ok({ data: Array.from({ length: 20 }, () => ({
      attributes: { address: "0xpool", reserve_in_usd: "10" },
      relationships: { base_token: { data: { id: `sui-network_${COIN}` } } },
    })) }) : ok({ data: { attributes: { ohlcv_list: [[AT - 3600, 1, 2, 1, 2, 1], [NOW, 99, 99, 99, 99, 1]] } } }));
    const result = await fetchRecentHistory(new Map([[COIN, [AT, NOW]]]), "geckoterminal");
    expect(result.quotes.get(COIN)?.get(AT)?.market?.pool_scan_complete).toBe(false);
    expect(result.quotes.get(COIN)?.has(NOW)).toBe(false);
  });

  it("preserves batch failure evidence while filling only missing samples", async () => {
    fetchMock.mockImplementation(async (url: string) => url.includes("coins.llama.fi")
      ? { ok: false, status: 429 }
      : coinGeckoReply(url, [[AT * 1000, 2], [(AT + 3600) * 1000, 3]]));
    const result = await fetchHistoricalMarketPrices(new Map([[COIN, [AT, AT + 3600]]]));
    expect([...result.unanswered.get(COIN)!]).toEqual([AT, AT + 3600]);
    expect(result.quotes.get(COIN)?.get(AT)).toMatchObject({ source: "coingecko", price: 2 });
    expect(result.quotes.get(COIN)?.get(AT + 3600)).toMatchObject({ source: "coingecko", price: 3 });
  });

  it("attributes signed window amounts and sample offsets to their actual provider", async () => {
    const sui = "0x2::sui::SUI";
    fetchMock.mockImplementation(async (url: string) => url.includes("coins.llama.fi")
      ? ok({ coins: { [defiLlamaKey(sui)!]: { prices: [{ timestamp: AT, price: 2 }] } } })
      : coinGeckoReply(url, [[(AT + 10800 - 10) * 1000, 3]], sui));
    const prices = await windowPrices([{ at: AT, coins: [sui] }, { at: AT + 10800, coins: [sui] }]);
    const amounts = new WindowAmounts(prices);
    amounts.add(sui, 1_000_000_000n, AT);
    amounts.add(sui, -2_000_000_000n, AT + 10800);
    expect(amounts.usd(sui)).toBe(-4);
    expect(amounts.coverage(sui)).toMatchObject({ priced_by_source: [
      { source: "defillama", raw: { in: "1000000000", out: "0" } },
      { source: "coingecko", raw: { in: "0", out: "2000000000" } },
    ] });
    expect(prices.basis.price_samples).toContainEqual(expect.objectContaining({ coin_type: sui, source: "coingecko", requested_at: AT + 10800,
      price_time: AT + 10800 - 10, price_offset_sec: -10 }));
  });

  it("keeps failed window samples separate from answered empty history", async () => {
    fetchMock.mockImplementation(async (url: string) => url.includes("coins.llama.fi") ? { ok: false, status: 429 }
      : url.includes("api.coingecko.com") ? coinGeckoReply(url, [], "0x2::sui::SUI") : ok({ data: [] }));
    const prices = await windowPrices([{ at: AT, coins: ["0x2::sui::SUI"] }, { at: AT + 3600, coins: ["0x2::sui::SUI"] }]);
    expect(prices.basis).toMatchObject({ partial: true, missing_coin_samples: [{ samples: 2, request_failed_samples: 2 }] });
  });
});
