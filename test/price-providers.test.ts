import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  availableSources,
  defiLlamaKey,
  fetchAftermath,
  fetchDefiLlama,
  fetchDefiLlamaHistory,
  parseDefiLlamaPrices,
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
    // One request carries the whole set. Looping would be slower and heavier
    // on the endpoint.
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
  it("reports only the free sources when no keys are set", () => {
    expect(availableSources()).toEqual(["aftermath", "defillama"]);
    expect(pythApiKey()).toBeNull();
  });

  it("adds Pyth only once its key is present", () => {
    process.env.PYTH_API_KEY = "k1";
    expect(availableSources()).toEqual(["aftermath", "defillama", "pyth"]);
  });

  it("treats a blank key as unset, so whitespace does not enable a paid call", () => {
    process.env.PYTH_API_KEY = "   ";
    expect(pythApiKey()).toBeNull();
    expect(availableSources()).toEqual(["aftermath", "defillama"]);
  });
});

describe("pricesForRanking", () => {
  it("uses the free current-price source and never a paid historical one", async () => {
    // Ranking needs relative value; which recipient got the most does not
    // become more correct with block-time precision, so no paid per-hop
    // historical lookup is made.
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

const PADDED_SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const CETUS = "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS";
const HASUI = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI";

/** A real `/prices/historical/1747909800/…` body, 2025-05-22 10:30:00 UTC. */
const HISTORICAL_BODY = {
  coins: {
    [`sui:${PADDED_SUI}`]: { decimals: 9, symbol: "SUI", price: 4.16, timestamp: 1747909801, confidence: 0.99 },
    [`sui:${CETUS}`]: { decimals: 9, symbol: "CETUS", price: 0.249101, timestamp: 1747909803, confidence: 0.99 },
    [`sui:${HASUI}`]: { decimals: 9, symbol: "haSUI", price: 4.39, timestamp: 1747911452, confidence: 0.99 },
  },
};

describe("defiLlamaKey", () => {
  it("pads the address, because DefiLlama does not resolve a stripped leading zero", () => {
    // sui:0x6864a6f9…::cetus::CETUS returns nothing; the padded key returns
    // CETUS.
    expect(defiLlamaKey("0x6864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS")).toBe(
      `sui:${CETUS}`,
    );
    expect(defiLlamaKey("0x2::sui::SUI")).toBe(`sui:${PADDED_SUI}`);
  });

  it("has no key for a coin type with type parameters, which the comma list would split", () => {
    expect(defiLlamaKey("0xabc::lp::LP<0x2::sui::SUI, 0xdef::usdc::USDC>")).toBeNull();
    expect(defiLlamaKey("not a coin")).toBeNull();
  });

  it("refuses a module or struct that is not a Move identifier, since the key goes into a URL path", () => {
    expect(defiLlamaKey("0x2::sui/../../x::SUI")).toBeNull();
    expect(defiLlamaKey("0x2::sui::SUI?x=1")).toBeNull();
  });
});

describe("parseDefiLlamaPrices", () => {
  it("maps each key back to every spelling that asked for it, with time, confidence and decimals", () => {
    const keyToCoins = new Map([
      [`sui:${PADDED_SUI}`, ["0x2::sui::SUI", PADDED_SUI]],
      [`sui:${HASUI}`, [HASUI]],
    ]);
    const out = parseDefiLlamaPrices(HISTORICAL_BODY, keyToCoins);
    expect(out.get("0x2::sui::SUI")).toEqual({
      price: 4.16,
      source: "defillama",
      at: 1747909801,
      confidence: 0.99,
      decimals: 9,
      symbol: "SUI",
    });
    expect(out.get(PADDED_SUI)?.price).toBe(4.16);
    expect(out.get(HASUI)?.at).toBe(1747911452);
    // CETUS was in the body but not asked for.
    expect(out.has(CETUS)).toBe(false);
  });

  it("drops an entry whose price is missing, negative or not finite", () => {
    const key = `sui:${PADDED_SUI}`;
    const keyToCoins = new Map([[key, [PADDED_SUI]]]);
    for (const price of [undefined, -1, "4.16", Number.NaN]) {
      expect(parseDefiLlamaPrices({ coins: { [key]: { price, timestamp: 1 } } }, keyToCoins).size).toBe(0);
    }
  });
});

describe("fetchDefiLlama", () => {
  it("asks the historical endpoint at the second requested, with padded keys", async () => {
    fetchMock.mockResolvedValue(ok(HISTORICAL_BODY));
    const r = await fetchDefiLlama(["0x2::sui::SUI", CETUS], 1747909800);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://coins.llama.fi/prices/historical/1747909800/sui:${PADDED_SUI},sui:${CETUS}`,
    );
    expect(r.quotes.get("0x2::sui::SUI")?.price).toBe(4.16);
    expect(r.quotes.get(CETUS)?.price).toBe(0.249101);
  });

  it("tells a failed request apart from a coin DefiLlama does not list", async () => {
    // 30 coins: a first batch of 25 that fails and a second of 5 that answers
    // with nothing. Only the first batch is "unanswered".
    const coins = Array.from({ length: 30 }, (_, i) => `0x${(i + 16).toString(16)}::c::C`);
    fetchMock.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(ok({ coins: {} }));
    const r = await fetchDefiLlama([...coins, "0xabc::lp::LP<0x2::sui::SUI>"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("/prices/current/");
    expect([...r.unanswered]).toEqual(coins.slice(0, 25));
    expect(r.quotes.size).toBe(0);
    expect([...r.unsupported]).toEqual(["0xabc::lp::LP<0x2::sui::SUI>"]);
  });
});

describe("historical date batches", () => {
  it("matches unsorted samples to their requested dates without borrowing a distant quote", async () => {
    const january = 1735689600;
    const july = 1751328000;
    fetchMock.mockResolvedValue(ok({ coins: { [defiLlamaKey(SUI)!]: { prices: [
      { timestamp: july - 5, price: 2, confidence: 0.99 },
      { timestamp: january + 10, price: 4, confidence: 0.99 },
      { timestamp: july + 86400, price: -1 },
    ] } } }));
    const prices = await fetchDefiLlamaHistory(new Map([[SUI, [january, july, july + 86400]]]));
    expect(prices.get(SUI)?.get(january)).toMatchObject({ price: 4, at: january + 10, source: "defillama" });
    expect(prices.get(SUI)?.get(july)).toMatchObject({ price: 2, at: july - 5 });
    expect(prices.get(SUI)?.has(july + 86400)).toBe(false);
  });

  it("keeps successful date batches when another request fails", async () => {
    const first = 1735689600;
    const dates = Array.from({ length: 101 }, (_, i) => first + 86400 * i);
    fetchMock.mockImplementation(async (url: string) => {
      const coins = JSON.parse(new URL(url).searchParams.get("coins")!) as Record<string, number[]>;
      const times = coins[defiLlamaKey(SUI)!];
      if (times.includes(dates[100])) return { ok: false, status: 503 };
      return ok({ coins: { [defiLlamaKey(SUI)!]: { prices: times.map((timestamp) => ({ timestamp, price: 2 })) } } });
    });
    const prices = await fetchDefiLlamaHistory(new Map([[SUI, dates]]));
    expect(prices.get(SUI)?.get(first)?.price).toBe(2);
    expect(prices.get(SUI)?.get(dates[99])?.price).toBe(2);
    expect(prices.get(SUI)?.has(dates[100])).toBe(false);
  });
});
