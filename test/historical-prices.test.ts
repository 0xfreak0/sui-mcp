import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { explainUnpriced, priceUsdAtTime, pricingScale } from "../src/utils/valuation.js";

const REAL_SUI = `0x${"0".repeat(63)}2::sui::SUI`;
/** Struct name says SUI; nothing vouches for it. A real mainnet coin type. */
const FAKE_SUI = "0x00a3017cc5fd396c38263ec57c8f2266507ce1a737000000000000000000000f::sui::SUI";
const HASUI = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI";
const AT = 1747909800; // 2025-05-22 10:30:00 UTC

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
      price_offset_sec: 1,
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
      expect.objectContaining({ coin_type: FAKE_SUI, code: "not_listed" }),
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

  it("prices a Sui Bridge token with no price of its own as the asset it is minted against, and no lookalike", async () => {
    const BRIDGE_USDT = "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT";
    /** Same module and struct name, another package: nothing vouches for it. */
    const OTHER_USDT = "0x1d8f5b3e0e7a9b0c7c2e4f6a8b9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70812::usdt::USDT";
    // DefiLlama at 2025-05-22 10:30 UTC: nothing for the Sui type, Tether at $1.
    routes({ llama: { "coingecko:tether": { symbol: "USDT", price: 1, timestamp: AT - 1, confidence: 0.99 } } });
    const { points, unpriced } = await priceUsdAtTime([BRIDGE_USDT, OTHER_USDT], AT);
    expect(points.get(BRIDGE_USDT)).toMatchObject({ price: 1, source: "defillama", priced_as: "coingecko:tether" });
    expect(points.has(OTHER_USDT)).toBe(false);
    expect(unpriced.map((u) => u.coin_type)).toEqual([OTHER_USDT]);
  });

  it("keeps a Sui Bridge token's own price when DefiLlama has one", async () => {
    const BRIDGE_ETH = "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH";
    routes({
      llama: {
        [`sui:${BRIDGE_ETH}`]: { decimals: 8, symbol: "ETH", price: 2669.22, timestamp: AT + 1736, confidence: 0.99 },
        "coingecko:ethereum": { symbol: "ETH", price: 1, timestamp: AT, confidence: 0.99 },
      },
    });
    const { points } = await priceUsdAtTime([BRIDGE_ETH], AT);
    expect(points.get(BRIDGE_ETH)?.price).toBe(2669.22);
    expect(points.get(BRIDGE_ETH)?.priced_as).toBeUndefined();
  });

  it("asks nobody but Pyth in oracle-only mode, and says so when there is no key", async () => {
    routes({});
    const { points, unpriced } = await priceUsdAtTime([REAL_SUI], AT, { sources: ["pyth"] });
    expect(points.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unpriced[0]).toMatchObject({ code: "no_oracle_price" });
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
      [HASUI, "provider_unavailable"],
      [FAKE_SUI, "not_listed"],
      [lp, "type_parameters"],
    ]);
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
