import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withNetworkParam } from "../src/tools/with-network.js";
import { retryingJson } from "../src/clients/graphql.js";
import { fetchDefiLlama } from "../src/utils/price-providers.js";
import { withPriceProviderCall } from "../src/utils/price-call-context.js";
import { priceUsdAtTime } from "../src/utils/valuation.js";
import { fetchHistoricalMarketPrices, resetRecentPriceCache } from "../src/utils/recent-prices.js";
import { resetWindowPriceCache, windowPrices, WindowAmounts } from "../src/utils/window-prices.js";
import { registerPriceTools } from "../src/tools/prices.js";

const COIN = "0x2::sui::SUI";
const AT = Date.parse("2025-01-01T00:00:00Z") / 1000;
const quote = { coins: { [`sui:0x${"0".repeat(63)}2::sui::SUI`]: { price: 2, timestamp: AT, decimals: 9 } } };
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  resetRecentPriceCache();
  resetWindowPriceCache();
  vi.stubEnv("PYTH_API_KEY", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("retries a 429 and a plain-text success before accepting the historical quote", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(json({ error: "limited" }, 429))
    .mockResolvedValueOnce(new Response("usage limit", { status: 200, headers: { "content-type": "text/plain" } }))
    .mockResolvedValueOnce(json(quote));
  vi.stubGlobal("fetch", fetchMock);
  const result = await priceUsdAtTime([COIN], AT, { sources: ["defillama"] });
  expect(result.points.get(COIN)).toMatchObject({ price: 2, source: "defillama" });
  expect(result.unpriced).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("honours Retry-After but caps the wait, without retrying 404", async () => {
  const waits: number[] = [];
  const options = { attempts: 3, baseDelayMs: 10, maxDelayMs: 40, timeoutMs: 1000,
    concurrency: 1, rateLimit: null, sleep: async (ms: number) => { waits.push(ms); } };
  const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 429, { "retry-after": "120" }))
    .mockResolvedValueOnce(json({ value: 3 }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await retryingJson("https://coins.llama.fi/prices", (body) => body, options)).toEqual({ value: 3 });
  expect(waits).toEqual([40]);
  fetchMock.mockClear().mockResolvedValue(json({ error: "not found" }, 404));
  expect(await retryingJson("https://coins.llama.fi/prices", (_body, status) => status, options)).toBe(404);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retries a connection error and unusable JSON using the same policy", async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValueOnce(json({ nope: true })).mockResolvedValueOnce(json({ coins: {} }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await fetchDefiLlama([COIN], AT);
  expect(result.unanswered.size).toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("reports an outage on point and window samples and leaves their amounts unpriced", async () => {
  const fetchMock = vi.fn(async (url: string) => url.includes("coins.llama.fi")
    ? json({ error: "limited" }, 429) : json({ error: "not found" }, 404));
  vi.stubGlobal("fetch", fetchMock);
  const point = await priceUsdAtTime([COIN], AT, { sources: ["defillama"] });
  expect(point.unpriced).toMatchObject([{ coin_type: COIN, code: "provider_unavailable",
    provider_unavailable: [{ source: "defillama", reason: "HTTP 429", samples: 1 }] }]);
  const prices = await windowPrices([{ at: AT, coins: [COIN] }, { at: AT + 3600, coins: [COIN] }]);
  expect(prices.basis).toMatchObject({ partial: true, provider_unavailable: [{ source: "defillama", samples: 2 }],
    missing_coin_samples: [{ coin_type: COIN, samples: 2, request_failed_samples: 2 }] });
  const amounts = new WindowAmounts(prices);
  amounts.add(COIN, -1_000_000_000n, AT);
  expect(amounts.coverage(COIN)).toMatchObject({ unpriced_raw: { in: "0", out: "1000000000" } });
});

it("opens a per-call DefiLlama circuit instead of retrying every batch, then resets it for the next call", async () => {
  const fetchMock = vi.fn(async () => json({}, 503));
  vi.stubGlobal("fetch", fetchMock);
  const coins = Array.from({ length: 250 }, (_, i) => `0x${(i + 1000).toString(16)}::coin::COIN`);
  const first = await withPriceProviderCall(() => fetchDefiLlama(coins, AT));
  expect(first.unanswered.size).toBe(250);
  const initialCalls = fetchMock.mock.calls.length;
  expect(initialCalls).toBeLessThan(30); // 10 batches would each make three attempts without a circuit.
  expect(initialCalls).toBeGreaterThan(0);
  await withPriceProviderCall(() => fetchDefiLlama([COIN], AT));
  expect(fetchMock.mock.calls.length).toBe(initialCalls + 3);
});

it("shares the breaker across separate price reads in one tool call but not across calls", async () => {
  const fetchMock = vi.fn(async () => json({}, 503));
  vi.stubGlobal("fetch", fetchMock);
  let handler: ((args: unknown) => Promise<unknown>) | undefined;
  const server = { registerTool: (_name: string, _config: unknown, call: typeof handler) => { handler = call; } } as unknown as McpServer;
  withNetworkParam(server).tool("probe", "Pricing probe", {}, async () => {
    for (let hour = 0; hour < 3; hour++) {
      const result = await priceUsdAtTime([COIN], AT + hour * 3600, { sources: ["defillama"] });
      expect(result.unpriced[0]?.code).toBe("provider_unavailable");
    }
    return { content: [] };
  });
  await handler!({});
  expect(fetchMock).toHaveBeenCalledTimes(6);
  await handler!({});
  expect(fetchMock).toHaveBeenCalledTimes(12);
});

it("attributes only failed DefiLlama samples to DefiLlama when fallbacks fail too", async () => {
  const times = Array.from({ length: 101 }, (_, i) => Math.floor(Date.now() / 1000) - 86400 + i * 60);
  let firstChunkSize = 0;
  let firstBatchUrl: string | undefined;
  const fetchMock = vi.fn(async (url: string) => {
    if (!url.includes("/batchHistorical")) return json({}, 503);
    if (firstBatchUrl === undefined) {
      firstBatchUrl = url;
      const entries = JSON.parse(new URL(url).searchParams.get("coins")!) as Record<string, number[]>;
      firstChunkSize = Object.values(entries)[0].length;
    }
    return url === firstBatchUrl ? json({}, 503) : json({ coins: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  const result = await fetchHistoricalMarketPrices(new Map([[COIN, times]]));
  const counts = Object.fromEntries(result.provider_unavailable.map(({ source, samples }) => [source, samples]));
  expect(firstChunkSize).toBeGreaterThan(0);
  expect(firstChunkSize).toBeLessThan(times.length);
  expect(counts).toMatchObject({ defillama: firstChunkSize, coingecko: times.length, geckoterminal: times.length });
  expect(result.unanswered.get(COIN)?.size).toBe(times.length);
});

it("keeps outage coverage when a fallback prices the point or fixed-time window", async () => {
  const at = Math.floor(Date.now() / 1000) - 86400;
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("coins.llama.fi")) return json({}, 503);
    if (url.includes("/market_chart/")) return json({ prices: [[at * 1000, 2]] });
    if (url.includes("api.coingecko.com")) return json({ platforms: { sui: `0x${"0".repeat(63)}2::sui::SUI` } });
    throw new Error(`Unexpected provider: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const point = await priceUsdAtTime([COIN], at);
  expect(point.points.get(COIN)).toMatchObject({ source: "coingecko", price: 2 });
  expect(point.unpriced).toEqual([]);
  expect(point.provider_unavailable).toMatchObject([{ source: "defillama", samples: 1 }]);

  const prices = await windowPrices([{ at, coins: [COIN] }], at);
  expect(prices.basis).toMatchObject({
    priced_coin_samples: 1, missing_coin_samples: [], provider_unavailable: [{ source: "defillama", samples: 1 }],
  });
  const amounts = new WindowAmounts(prices);
  amounts.add(COIN, 1_000_000_000n, at);
  expect(amounts.coverage(COIN)).toMatchObject({ raw: { in: "1000000000", out: "0" } });

  let call: ((args: { coin_types: string[]; at: number }) => Promise<{ content: Array<{ text: string }> }>) | undefined;
  registerPriceTools({ tool: (_name: string, _description: string, _schema: unknown, handler: typeof call) => { call = handler; } } as never);
  const output = JSON.parse((await call!({ coin_types: [COIN], at })).content[0].text) as Record<string, unknown>;
  expect(output.provider_unavailable).toMatchObject([{ source: "defillama", samples: 1 }]);
});
