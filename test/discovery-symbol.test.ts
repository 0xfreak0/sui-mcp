import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSymbolIndex } from "../scripts/lib/coin-symbols-encode.mjs";
import { runWithNetwork } from "../src/config.js";
import type { SymbolIndex } from "../src/utils/coin-symbols.js";
import type * as CoinSymbols from "../src/utils/coin-symbols.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));

// The index the resolver sees. Each test installs the one it needs.
const shipped = vi.hoisted(() => ({ index: null as SymbolIndex | null }));
vi.mock("../src/utils/coin-symbols.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CoinSymbols>()),
  symbolIndex: () => shipped.index,
}));

// Imported after the mocks above, whose factories close over this file's mocks.
const { resolveSymbolDetailed, resolveTokenBySymbol, searchTokens } = await import("../src/discovery.js");
const { createSymbolIndex } = await import("../src/utils/coin-symbols.js");

/** One page of `0x2::coin::CoinMetadata` objects, shaped as mainnet GraphQL returns it. */
function metadataPage(
  coins: Array<{ coinType: string; name: string; symbol: string; decimals?: number }>,
  hasNextPage = false,
) {
  return {
    objects: {
      nodes: coins.map((c) => ({
        asMoveObject: {
          contents: {
            type: { repr: `0x0000000000000000000000000000000000000000000000000000000000000002::coin::CoinMetadata<${c.coinType}>` },
            json: { name: c.name, symbol: c.symbol, decimals: c.decimals ?? 9 },
          },
        },
      })),
      pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor1" : undefined },
    },
  };
}

const YUNGOG = "0x009f33ecca62cb3a6eff9df6517f4bc2cd3f879003e3c69454f5271f6674be26::yungog::YUNGOG";
const KONG_SUI = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG";
const KONG_DING_DONG = "0xcc345bb9b0d5ddd2d01a4e303a9fa4c00b6da760e4618ed31e303c585df962ca::kong::KONG";

function indexOf(coins: Array<{ coin_type: string; symbol: string; name: string; decimals: number }>, maxRows = 100) {
  return createSymbolIndex({
    synced_at: "2026-09-26",
    checkpoint: 190000000,
    counts: { coins: coins.length },
    max_rows_per_symbol: maxRows,
    symbols: buildSymbolIndex(coins, maxRows).symbols,
  });
}

const BOTH_KONGS = [
  { coin_type: KONG_SUI, symbol: "KONG", name: "KONG SUI", decimals: 1 },
  { coin_type: KONG_DING_DONG, symbol: "KONG", name: "Kong Ding Dong", decimals: 6 },
  { coin_type: YUNGOG, symbol: "YUNGOG", name: "Yung Kong Khan", decimals: 9 },
];

beforeEach(() => {
  mockGqlQuery.mockReset();
  shipped.index = null;
});

describe("resolveSymbolDetailed with the symbol index", () => {
  /**
   * A symbol several coins use is answered from the index with every coin that
   * uses it. The live scan reads CoinMetadata in object-ID order and can stop
   * before reaching any of them, so it does not run.
   */
  it("answers a symbol several coins use with every one of them, without scanning", async () => {
    shipped.index = indexOf(BOTH_KONGS);
    const result = await resolveSymbolDetailed("KONG");
    expect(result).toMatchObject({ status: "ambiguous", source: "symbol_index", count: 2 });
    expect(result.status === "ambiguous" ? result.candidates.map((c) => c.coin_type) : []).toEqual([KONG_SUI, KONG_DING_DONG]);
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("resolves a symbol exactly one indexed coin uses, still unverified", async () => {
    shipped.index = indexOf(BOTH_KONGS.slice(0, 1));
    const result = await resolveSymbolDetailed("kong");
    expect(result).toMatchObject({ status: "unverified", source: "symbol_index", token: { coin_type: KONG_SUI, decimals: 1 } });
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("reports a symbol too common to list as ambiguous with its count", async () => {
    const spam = Array.from({ length: 3 }, (_, i) => ({
      coin_type: `0x${(i + 1).toString(16).padStart(64, "0")}::fwp::FWP`,
      symbol: "FWP",
      name: "fixwalletspls",
      decimals: 9,
    }));
    shipped.index = indexOf(spam, 2);
    expect(await resolveSymbolDetailed("FWP")).toMatchObject({ status: "ambiguous", source: "symbol_index", count: 3, candidates: [] });
  });

  it("refuses to pick one of several indexed coins for callers that need a single type", async () => {
    shipped.index = indexOf(BOTH_KONGS);
    expect(await resolveTokenBySymbol("KONG")).toBeNull();
    shipped.index = indexOf(BOTH_KONGS.slice(0, 1));
    expect((await resolveTokenBySymbol("KONG"))?.coin_type).toBe(KONG_SUI);
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });
});

describe("resolveSymbolDetailed for a symbol the index does not have", () => {
  /**
   * A coin whose name contains the query but whose symbol differs (`Yung Kong
   * Khan`, symbol YUNGOG) does not match a symbol query. The scan is the
   * fallback for a symbol the index lacks, and it matches symbols exactly.
   */
  it("does not resolve a symbol query to a coin whose NAME merely contains it", async () => {
    shipped.index = indexOf([BOTH_KONGS[2]]);
    mockGqlQuery.mockResolvedValue(
      metadataPage([{ coinType: YUNGOG, name: "Yung Kong Khan", symbol: "YUNGOG" }]),
    );
    const result = await resolveSymbolDetailed("NEWKONG");
    expect(result).toMatchObject({
      status: "not_found",
      scan: { scanned: 1, truncated: false },
      index: { synced_at: "2026-09-26" },
    });
  });

  it("still resolves an exact symbol match found within the scanned window", async () => {
    shipped.index = indexOf([BOTH_KONGS[2]]);
    mockGqlQuery.mockResolvedValue(
      metadataPage([
        { coinType: YUNGOG, name: "Yung Kong Khan", symbol: "YUNGOG" },
        { coinType: KONG_SUI, name: "KONG SUI", symbol: "KONG", decimals: 1 },
      ]),
    );
    const result = await resolveSymbolDetailed("KONG");
    expect(result).toMatchObject({
      status: "unverified",
      source: "scan",
      token: { coin_type: KONG_SUI, symbol: "KONG", decimals: 1 },
      index: { synced_at: "2026-09-26" },
    });
  });

  /**
   * A scan stopped at its page budget does not show the symbol is absent, so
   * the miss says whether the scan reached the end.
   */
  it("reports a miss as partial when the scan stopped before the last page", async () => {
    vi.useFakeTimers();
    try {
      mockGqlQuery.mockResolvedValue(metadataPage([{ coinType: YUNGOG, name: "Yung Kong Khan", symbol: "YUNGOG" }], true));
      // A symbol no earlier test resolved: a resolved symbol is cached.
      const pending = resolveSymbolDetailed("DINGDONG");
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result).toMatchObject({ status: "not_found", scan: { truncated: true } });
      expect(result).not.toHaveProperty("scan.failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a miss as complete when the scan read the last page", async () => {
    mockGqlQuery.mockResolvedValue(metadataPage([{ coinType: YUNGOG, name: "Yung Kong Khan", symbol: "YUNGOG" }]));
    expect(await resolveSymbolDetailed("NOSUCHCOIN")).toMatchObject({ status: "not_found", scan: { truncated: false } });
  });

  /**
   * A failed page is reported with its error, distinct from a spent page
   * budget, so an outage does not read as "not found".
   */
  it("reports a failed page as a read failure, with its error", async () => {
    mockGqlQuery.mockRejectedValue(new TypeError("fetch failed"));
    expect(await resolveSymbolDetailed("FAILEDREAD")).toMatchObject({
      status: "not_found",
      scan: { truncated: true, scanned: 0, failed: expect.stringContaining("fetch failed") },
    });
  });
});

describe("searchTokens", () => {
  it("answers from the index when it has a match, exact symbols first, without scanning", async () => {
    shipped.index = indexOf(BOTH_KONGS);
    const result = await searchTokens("kong");
    expect(result.source).toBe("symbol_index");
    expect(result.tokens.map((t) => t.coin_type)).toEqual([KONG_SUI, KONG_DING_DONG, YUNGOG]);
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("falls back to the live scan when the index has nothing, and says which index missed", async () => {
    shipped.index = indexOf(BOTH_KONGS);
    mockGqlQuery.mockResolvedValue(metadataPage([{ coinType: "0x5::fresh::FRESH", name: "Fresh", symbol: "FRESH" }]));
    const result = await searchTokens("fresh");
    expect(result).toMatchObject({ source: "scan", truncated: false, index: { synced_at: "2026-09-26" } });
    expect(result.tokens.map((t) => t.symbol)).toEqual(["FRESH"]);
  });

  /**
   * A symbol too common to list still counts as a match for a query it
   * contains, so the index answers and the live scan does not run.
   */
  it("counts a symbol too common to list that contains the query as a match, without scanning", async () => {
    const nftReceived = Array.from({ length: 3 }, (_, i) => ({
      coin_type: `0x${(i + 1).toString(16).padStart(64, "0")}::nft::NFT`,
      symbol: "NFT RECEIVED",
      name: "Claim at nft-sui.io",
      decimals: 0,
    }));
    shipped.index = indexOf([...nftReceived, ...BOTH_KONGS], 2);
    const result = await searchTokens("nft receiv");
    expect(result).toMatchObject({ source: "symbol_index", tokens: [], unlisted_exact_count: null, unlisted_containing: [{ symbol: "nft received", count: 3 }] });
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("lists what the index lists beside the symbols too common to list", async () => {
    const usdc = Array.from({ length: 3 }, (_, i) => ({
      coin_type: `0x${(i + 1).toString(16).padStart(64, "0")}::usdc::USDC`,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    }));
    const usdx = { coin_type: `0x${"9".repeat(64)}::usdx::USDX`, symbol: "USDX", name: "USDX", decimals: 6 };
    shipped.index = indexOf([...usdc, usdx, ...BOTH_KONGS], 2);
    const result = await searchTokens("usd");
    expect(result).toMatchObject({ source: "symbol_index", unlisted_containing: [{ symbol: "usdc", count: 3 }] });
    expect(result.tokens.map((t) => t.coin_type)).toEqual([usdx.coin_type]);
    // The exact symbol stays in unlisted_exact_count, not in the containing list.
    expect(await searchTokens("usdc")).toMatchObject({ unlisted_exact_count: 3, unlisted_containing: [] });
  });
});

describe("searchTokens when a metadata page fails", () => {
  it("reports the failure and reads again next time instead of caching the partial list", async () => {
    const FRESH = { coinType: "0x5::fresh::FRESH", name: "Fresh", symbol: "FRESH" };
    const FRESHER = { coinType: "0x6::fresher::FRESHER", name: "Fresher", symbol: "FRESHER" };
    // Devnet: the mainnet scan cache holds the earlier tests' list.
    await runWithNetwork("devnet", async () => {
      mockGqlQuery.mockResolvedValueOnce(metadataPage([FRESH], true)).mockRejectedValueOnce(new TypeError("fetch failed"));
      expect(await searchTokens("fresh")).toMatchObject({
        source: "scan",
        truncated: true,
        scanned: 1,
        failed: expect.stringContaining("fetch failed"),
        tokens: [{ symbol: "FRESH" }],
      });

      mockGqlQuery.mockResolvedValueOnce(metadataPage([FRESH, FRESHER]));
      const retried = await searchTokens("fresh");
      expect(retried).toMatchObject({ source: "scan", truncated: false, scanned: 2 });
      expect(retried).not.toHaveProperty("failed");
      expect(retried.tokens.map((t) => t.symbol)).toEqual(["FRESH", "FRESHER"]);
    });
  });
});
