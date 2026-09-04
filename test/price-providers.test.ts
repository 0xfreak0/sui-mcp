import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  availableSources,
  cmcApiKey,
  fetchAftermath,
  fetchCoinMarketCap,
  pricesForRanking,
  pythApiKey,
} from "../src/utils/price-providers.js";

const SUI = "0x2::sui::SUI";
const USDC = "0xa::usdc::USDC";

let fetchMock: ReturnType<typeof vi.fn>;
const savedEnv = { ...process.env };

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.PYTH_API_KEY;
  delete process.env.CMC_API_KEY;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("fetchAftermath", () => {
  it("filters the -1 sentinel rather than reporting a negative price", async () => {
    // Aftermath answers an unknown coin with price: -1 — not null, not absent.
    // Passing that through would put a negative USD value in a report.
    fetchMock.mockResolvedValue(
      ok({
        [SUI]: { price: 0.75, priceChange24HoursPercentage: 0 },
        [USDC]: { price: -1, priceChange24HoursPercentage: 0 },
      }),
    );

    const out = await fetchAftermath([SUI, USDC]);
    expect(out.get(SUI)?.price).toBe(0.75);
    expect(out.has(USDC)).toBe(false);
  });

  it("labels every quote with its source", async () => {
    fetchMock.mockResolvedValue(ok({ [SUI]: { price: 0.75, priceChange24HoursPercentage: 0 } }));
    expect((await fetchAftermath([SUI])).get(SUI)?.source).toBe("aftermath");
  });

  it("batches into one request", async () => {
    // Measured: four coins in one request is faster than one coin. Looping
    // would be both slower and ruder to the endpoint.
    fetchMock.mockResolvedValue(ok({}));
    await fetchAftermath([SUI, USDC, "0xb::c::D"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).coins).toHaveLength(3);
  });

  it("makes no request for an empty set", async () => {
    expect((await fetchAftermath([])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns nothing rather than throwing when the endpoint fails", async () => {
    // A pricing failure must never break a trace.
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    expect((await fetchAftermath([SUI])).size).toBe(0);
    fetchMock.mockRejectedValue(new Error("network"));
    await expect(fetchAftermath([SUI])).resolves.toBeInstanceOf(Map);
  });
});

describe("opt-in providers", () => {
  it("reports only the free source when no keys are set", () => {
    expect(availableSources()).toEqual(["aftermath"]);
    expect(pythApiKey()).toBeNull();
    expect(cmcApiKey()).toBeNull();
  });

  it("adds a paid source only once its key is present", () => {
    process.env.PYTH_API_KEY = "k1";
    expect(availableSources()).toEqual(["aftermath", "pyth"]);
    process.env.CMC_API_KEY = "k2";
    expect(availableSources()).toEqual(["aftermath", "pyth", "coinmarketcap"]);
  });

  it("treats a blank key as unset, so whitespace does not enable a paid call", () => {
    process.env.CMC_API_KEY = "   ";
    expect(cmcApiKey()).toBeNull();
    expect(availableSources()).not.toContain("coinmarketcap");
  });

  it("does not call CoinMarketCap without a key", async () => {
    await fetchCoinMarketCap(new Map([["SUI", SUI]]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the key as a header and maps symbols back to coin types", async () => {
    process.env.CMC_API_KEY = "secret";
    fetchMock.mockResolvedValue(ok({ data: { SUI: [{ quote: { USD: { price: 0.75 } } }] } }));

    const out = await fetchCoinMarketCap(new Map([["SUI", SUI]]));
    expect(out.get(SUI)).toMatchObject({ price: 0.75, source: "coinmarketcap" });
    expect(fetchMock.mock.calls[0][1].headers["X-CMC_PRO_API_KEY"]).toBe("secret");
  });

  it("ignores a CMC symbol it was not given a coin type for", async () => {
    // CMC keys on tickers, which are not unique — anyone can mint a coin called
    // USDC. Only the caller's own mapping decides which coin a ticker meant.
    process.env.CMC_API_KEY = "secret";
    fetchMock.mockResolvedValue(ok({ data: { GHOST: [{ quote: { USD: { price: 9 } } }] } }));
    expect((await fetchCoinMarketCap(new Map([["SUI", SUI]]))).size).toBe(0);
  });
});

describe("pricesForRanking", () => {
  it("uses the free current-price source and never a paid historical one", async () => {
    // Ranking needs relative value; which recipient got the most does not
    // become more correct with block-time precision. The old code paid for a
    // per-hop historical lookup to answer a question that did not need it.
    process.env.PYTH_API_KEY = "k1";
    fetchMock.mockResolvedValue(ok({ [SUI]: { price: 0.75, priceChange24HoursPercentage: 0 } }));

    const out = await pricesForRanking([SUI, SUI]);
    expect(out.get(SUI)?.source).toBe("aftermath");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("aftermath");
    // De-duplicated before the request.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).coins).toEqual([SUI]);
  });
});
