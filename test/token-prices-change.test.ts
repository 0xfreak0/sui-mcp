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
const SUI_KEY = "sui:0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

let fetchMock: Mock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("get_token_prices: 24h change", () => {
  it("reports DefiLlama's 24h change, not Aftermath's field, which reads 0 for every coin", async () => {
    // Both answers as the services gave them for SUI on the same minute:
    // Aftermath 0.0, DefiLlama +16.78% (SUI went from $1.009 to $1.16).
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://aftermath.finance/")) {
        return ok({ [SUI]: { price: 1.1598, priceChange24HoursPercentage: 0.0 }, [JUNK]: { price: -1, priceChange24HoursPercentage: 0.0 } });
      }
      if (url.startsWith("https://coins.llama.fi/percentage/")) {
        // A coin DefiLlama does not list is absent from its answer.
        return ok({ coins: { [SUI_KEY]: 16.778330414302467 } });
      }
      return ok({ coins: {} });
    });

    const out = JSON.parse((await handler({ coin_types: [SUI, JUNK] })).content[0].text);

    expect(out.prices[0].price_usd).toBe(1.1598);
    expect(out.prices[0].price_change_24h_percent).toBeCloseTo(16.778, 3);
    expect(out.prices[1].price_change_24h_percent).toBeNull();
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
