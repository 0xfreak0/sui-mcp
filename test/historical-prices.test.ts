import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { explainUnpriced, priceUsdAtTime, pricingScale } from "../src/utils/valuation.js";

const REAL_SUI = `0x${"0".repeat(63)}2::sui::SUI`;
/** Struct name says SUI; nothing vouches for it. Real one found on mainnet. */
const FAKE_SUI = "0x00a3017cc5fd396c38263ec57c8f2266507ce1a737000000000000000000000f::sui::SUI";
const HASUI = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI";
const AT = 1747909800; // 2025-05-22 10:30:00 UTC, the Cetus exploit

const savedEnv = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const denied = { ok: false, status: 401, json: async () => ({}) };

/** Route by host: Hermes feed search, Hermes prices, DefiLlama. */
function routes(opts: { hermesPrice?: "ok" | "401"; llama?: Record<string, unknown> }) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/v2/price_feeds")) {
      return ok([{ id: "feedsui", attributes: { symbol: "Crypto.SUI/USD", base: "SUI", quote_currency: "USD" } }]);
    }
    if (url.includes("/v2/updates/price/")) {
      if (opts.hermesPrice !== "ok") return denied;
      return ok({
        parsed: [
          {
            id: "feedsui",
            price: { price: "416000000", conf: "250000", expo: -8, publish_time: AT - 2 },
            ema_price: { price: "416000000", conf: "250000", expo: -8, publish_time: AT - 2 },
          },
        ],
      });
    }
    if (url.includes("coins.llama.fi")) return ok({ coins: opts.llama ?? {} });
    throw new Error(`unexpected ${url}`);
  });
}

const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.PYTH_API_KEY;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("priceUsdAtTime", () => {
  it("prices at block time with no key at all, from DefiLlama", async () => {
    routes({
      llama: {
        [`sui:${REAL_SUI}`]: { decimals: 9, symbol: "SUI", price: 4.16, timestamp: AT + 1, confidence: 0.99 },
      },
    });
    const { points, unpriced } = await priceUsdAtTime([REAL_SUI], AT);
    expect(points.get(REAL_SUI)).toEqual({
      price: 4.16,
      publishTime: AT + 1,
      source: "defillama",
      confidence: 0.99,
      decimals: 9,
    });
    expect(unpriced).toEqual([]);
    expect(urls().some((u) => u.includes("hermes"))).toBe(false);
  });

  it("prefers Pyth for a verified coin and never asks Pyth about an impostor with the same symbol", async () => {
    process.env.PYTH_API_KEY = "k";
    routes({ hermesPrice: "ok" });
    const { points, unpriced } = await priceUsdAtTime([REAL_SUI, FAKE_SUI], AT);

    expect(points.get(REAL_SUI)).toMatchObject({ price: 4.16, source: "pyth", publishTime: AT - 2 });
    // The symbol-matched SUI feed would have priced the impostor at $4.16.
    expect(points.has(FAKE_SUI)).toBe(false);
    const llamaUrl = urls().find((u) => u.includes("coins.llama.fi"))!;
    expect(llamaUrl).toContain(FAKE_SUI);
    expect(llamaUrl).not.toContain(REAL_SUI);
    expect(unpriced).toEqual([
      expect.objectContaining({ coin_type: FAKE_SUI, code: "not_listed", reason: expect.stringContaining("matched by symbol") }),
    ]);
  });

  it("falls back to DefiLlama for a verified coin when Pyth refuses", async () => {
    process.env.PYTH_API_KEY = "expired";
    routes({
      hermesPrice: "401",
      llama: { [`sui:${REAL_SUI}`]: { price: 4.16, timestamp: AT + 1, confidence: 0.99, decimals: 9 } },
    });
    const { points } = await priceUsdAtTime([REAL_SUI], AT);
    expect(points.get(REAL_SUI)?.source).toBe("defillama");
  });

  it("asks nobody but Pyth in oracle-only mode, and says so when there is no key", async () => {
    routes({});
    const { points, unpriced } = await priceUsdAtTime([REAL_SUI], AT, { sources: ["pyth"] });
    expect(points.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unpriced[0]).toMatchObject({ code: "no_oracle_price", reason: expect.stringContaining("PYTH_API_KEY") });
  });
});

describe("explainUnpriced", () => {
  const llama = (over: Partial<{ unanswered: Set<string>; unsupported: Set<string> }>) => ({
    quotes: new Map(),
    unanswered: over.unanswered ?? new Set<string>(),
    unsupported: over.unsupported ?? new Set<string>(),
  });
  const ctx = { sources: ["pyth", "defillama"] as const, pythKey: false };

  it("keeps a failed request apart from an answer that had no price", () => {
    const lp = "0xabc::lp::LP<0x2::sui::SUI>";
    const out = explainUnpriced([HASUI, FAKE_SUI, lp], new Map(), {
      ...ctx,
      llama: llama({ unanswered: new Set([HASUI]), unsupported: new Set([lp]) }),
    });
    expect(out.map((u) => [u.coin_type, u.code])).toEqual([
      [HASUI, "request_failed"],
      [FAKE_SUI, "not_listed"],
      [lp, "type_parameters"],
    ]);
    expect(out[0].reason).toContain("says nothing about whether the coin had a price");
  });

  it("lists nothing that was priced", () => {
    const priced = new Map([[HASUI, { price: 4.39, publishTime: AT, source: "defillama" as const }]]);
    expect(explainUnpriced([HASUI], priced, { ...ctx, llama: llama({}) })).toEqual([]);
  });
});

describe("pricingScale", () => {
  it("keeps registry decimals over the provider's for a verified coin", () => {
    expect(pricingScale(REAL_SUI, { decimals: 6 })).toEqual({ decimals: 9, source: "registry" });
  });

  it("scales an unverified coin at the decimals its price is per", () => {
    expect(pricingScale(FAKE_SUI, { decimals: 6 })).toEqual({ decimals: 6, source: "price_provider" });
    expect(pricingScale(FAKE_SUI, null).source).toBe("assumed");
  });
});
