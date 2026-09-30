import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../src/discovery.js", () => ({ buildPythFeedMap: async () => ({ feedIds: [], reverseMap: new Map() }) }));

const { registerPriceTools } = await import("../src/tools/prices.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
let handler: Handler;
registerPriceTools({
  tool: (_n: string, _d: string, _s: unknown, h: Handler) => {
    handler = h;
  },
} as never);

const SUI = "0x2::sui::SUI";
const JUNK = "0x1111111111111111111111111111111111111111111111111111111111111111::junk::JUNK";
const SUI_LONG_KEY = "sui:0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const NOW = Date.parse("2026-09-30T12:00:00Z");
const DAY_AGO = NOW / 1000 - 86400;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

let fetchMock: Mock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("get_token_prices: 24h change", () => {
  it("calculates change from DefiLlama prices while preserving Aftermath's current-price precedence", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://aftermath.finance/")) {
        return ok({ [SUI]: { price: 1.1598, priceChange24HoursPercentage: 0.0 }, [JUNK]: { price: -1, priceChange24HoursPercentage: 0.0 } });
      }
      if (url.startsWith("https://coins.llama.fi/prices/current/")) {
        return ok({ coins: { [SUI_LONG_KEY]: { price: 1.2 } } });
      }
      if (url.startsWith(`https://coins.llama.fi/prices/historical/${DAY_AGO}/`)) {
        return ok({ coins: { [SUI_LONG_KEY]: { price: 1, timestamp: DAY_AGO } } });
      }
      return ok({ coins: {} });
    });

    const out = JSON.parse((await handler({ coin_types: [SUI, JUNK] })).content[0].text);

    expect(out.prices[0].price_usd).toBe(1.1598);
    expect(out.prices[0].price_change_24h_percent).toBeCloseTo(20, 10);
    expect(out.prices[1].price_change_24h_percent).toBeNull();
  });

  it.each([
    { label: "a decline", current: 0.8, previous: 1, expected: -20 },
    { label: "a zero current price", current: 0, previous: 1, expected: -100 },
    { label: "a missing current price", current: null, previous: 1, expected: null },
    { label: "a missing previous price", current: 1.2, previous: null, expected: null },
    { label: "a zero previous price", current: 1.2, previous: 0, expected: null },
  ])("handles $label", async ({ current, previous, expected }) => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://aftermath.finance/")) {
        return ok({ [SUI]: { price: -1, priceChange24HoursPercentage: 0 } });
      }
      const price = url.startsWith("https://coins.llama.fi/prices/current/") ? current
        : url.startsWith(`https://coins.llama.fi/prices/historical/${DAY_AGO}/`) ? previous : null;
      return ok({ coins: price === null ? {} : { [SUI_LONG_KEY]: { price, timestamp: url.includes("/current/") ? NOW / 1000 : DAY_AGO } } });
    });
    const out = JSON.parse((await handler({ coin_types: [SUI] })).content[0].text);
    expect(out.prices[0].price_usd).toBe(current);
    if (expected === null) expect(out.prices[0].price_change_24h_percent).toBeNull();
    else expect(out.prices[0].price_change_24h_percent).toBeCloseTo(expected, 10);
  });

  it("leaves the change null when DefiLlama's request fails", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("https://aftermath.finance/")
        ? ok({ [SUI]: { price: 1.1598, priceChange24HoursPercentage: 0.0 } })
        : { ok: false, status: 502, json: async () => ({}) },
    );

    const out = JSON.parse((await handler({ coin_types: [SUI] })).content[0].text);

    expect(out.prices[0].price_usd).toBe(1.1598);
    expect(out.prices[0].price_change_24h_percent).toBeNull();
  });
});
