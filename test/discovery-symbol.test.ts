import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWithNetwork } from "../src/config.js";

const mockGqlQuery = vi.fn();
const mockSearchLiveTickers = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/ticker-search.js", () => ({ searchLiveTickers: mockSearchLiveTickers }));

const { resolveSymbolDetailed, resolveTokenBySymbol, searchTokens } = await import("../src/discovery.js");

/** One page of `0x2::coin::CoinMetadata` objects, shaped as GraphQL returns it. */
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
const coverage = { dexscreener: "ok" as const, geckoterminal: "ok" as const };
const unavailable = { dexscreener: "unavailable" as const, geckoterminal: "unavailable" as const };

function ticker(coin_type: string, symbol: string, name: string, decimals = 9) {
  return {
    coin_type, symbol, name, decimals,
    total_supply: "1000000000", liquidity_usd: 20000, pool_count: 2, volume_24h: 3500,
    providers: ["dexscreener", "geckoterminal"], verified: false,
    package_id: coin_type.split("::")[0], publisher_hint: coin_type.split("::")[0],
  };
}

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockSearchLiveTickers.mockReset();
  mockSearchLiveTickers.mockResolvedValue({ candidates: [], providers: coverage, unavailable_providers: [] });
});

describe("resolveSymbolDetailed with live ticker discovery", () => {
  it("keeps a curated verified symbol authoritative even when a pooled lookalike exists", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [ticker("0x1::fake::SUI", "SUI", "Sui")], providers: coverage, unavailable_providers: [],
    });
    const result = await resolveSymbolDetailed("SUI");
    expect(result).toMatchObject({ status: "resolved", verified: true, token: { coin_type: `0x${"0".repeat(63)}2::sui::SUI` } });
    expect(mockSearchLiveTickers).not.toHaveBeenCalled();
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("preserves ambiguity among curated verified symbols without consulting DEXs", async () => {
    expect(await resolveSymbolDetailed("USDC")).toMatchObject({ status: "ambiguous", source: "curated" });
    expect(mockSearchLiveTickers).not.toHaveBeenCalled();
  });

  it("reports every exact on-chain-confirmed ticker and refuses to choose one", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [ticker(KONG_SUI, "KONG", "KONG SUI", 1), ticker(KONG_DING_DONG, "KONG", "Kong Ding Dong", 6), ticker(YUNGOG, "YUNGOG", "Yung Kong Khan")],
      providers: coverage, unavailable_providers: [],
    });
    expect(await resolveSymbolDetailed("KONG")).toMatchObject({
      status: "ambiguous", source: "dex_search", coverage, unavailable_providers: [],
      candidates: [{ coin_type: KONG_SUI }, { coin_type: KONG_DING_DONG }],
    });
    expect(await resolveTokenBySymbol("KONG")).toBeNull();
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("returns a sole exact live ticker as unverified, not a verified coin", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [ticker(KONG_SUI, "KONG", "KONG SUI", 1)], providers: coverage, unavailable_providers: [],
    });
    expect(await resolveSymbolDetailed("kong")).toMatchObject({
      status: "unverified", source: "dex_search", token: { coin_type: KONG_SUI, verified: false }, coverage,
    });
  });
  it("does not silently resolve one partial candidate as the only exact symbol", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [ticker(KONG_SUI, "KONG", "Kong", 1)], providers: coverage,
      unavailable_providers: [], partial: true, unconfirmed: 0,
    });
    expect(await resolveSymbolDetailed("KONG")).toMatchObject({
      status: "unverified", source: "dex_search", partial: true, token: { coin_type: KONG_SUI },
    });
    expect(await resolveTokenBySymbol("KONG")).toBeNull();
  });

  it("reports an unconfirmed candidate as a read failure instead of not_found", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [], providers: coverage, unavailable_providers: [],
      partial: false, unconfirmed: 1, unconfirmed_reason: "gRPC unavailable",
    });
    mockGqlQuery.mockResolvedValue(metadataPage([]));
    expect(await resolveSymbolDetailed("UNCHECKED")).toMatchObject({
      status: "could_not_confirm", scan: { scanned: 0, truncated: false },
      unconfirmed: 1, unconfirmed_reason: "gRPC unavailable",
    });
    expect(await searchTokens("UNCHECKED")).toMatchObject({
      source: "scan", tokens: [], unconfirmed: 1, unconfirmed_reason: "gRPC unavailable",
    });
  });


  it("does not resolve a symbol to a token whose name merely contains it", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [ticker(YUNGOG, "YUNGOG", "Yung Kong Khan")], providers: coverage, unavailable_providers: [],
    });
    mockGqlQuery.mockResolvedValue(metadataPage([{ coinType: YUNGOG, name: "Yung Kong Khan", symbol: "YUNGOG" }]));
    expect(await resolveSymbolDetailed("NEWKONG")).toMatchObject({
      status: "not_found", scan: { scanned: 1, truncated: false }, coverage,
    });
  });
});

describe("searchTokens", () => {
  it("returns DEX matches with liquidity evidence and provider coverage without scanning", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [ticker(KONG_SUI, "KONG", "KONG SUI", 1), ticker(YUNGOG, "YUNGOG", "Yung Kong Khan")],
      providers: coverage, unavailable_providers: [],
    });
    const result = await searchTokens("kong");
    expect(result).toMatchObject({ source: "dex_search", coverage, unavailable_providers: [], tokens: [{ coin_type: KONG_SUI, liquidity_usd: 20000 }, { coin_type: YUNGOG }] });
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("falls back to scanning when both indexers fail, exposing both outages", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [], providers: unavailable,
      unavailable_providers: [
        { provider: "dexscreener", reason: "timeout" },
        { provider: "geckoterminal", reason: "HTTP 503" },
      ],
    });
    mockGqlQuery.mockResolvedValue(metadataPage([{ coinType: "0x5::fresh::FRESH", name: "Fresh", symbol: "FRESH" }]));
    const result = await searchTokens("fresh");
    expect(result).toMatchObject({
      source: "scan", coverage: unavailable,
      unavailable_providers: [{ provider: "dexscreener", reason: "timeout" }, { provider: "geckoterminal", reason: "HTTP 503" }],
      scan: { scanned: 1, truncated: false }, tokens: [{ symbol: "FRESH" }],
    });
  });

  it("uses skipped provider coverage on other networks", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [], providers: { dexscreener: "skipped", geckoterminal: "skipped" }, unavailable_providers: [],
    });
    await runWithNetwork("testnet", async () => {
      mockGqlQuery.mockResolvedValue(metadataPage([{ coinType: "0x7::testcoin::TESTCOIN", name: "Test Coin", symbol: "TESTCOIN" }]));
      expect(await searchTokens("testcoin")).toMatchObject({
        source: "scan", coverage: { dexscreener: "skipped", geckoterminal: "skipped" },
        unavailable_providers: [], tokens: [{ symbol: "TESTCOIN" }],
      });
      expect(mockSearchLiveTickers).toHaveBeenCalledWith("testcoin");
    });
  });
});

describe("searchTokens when an off-mainnet metadata page fails", () => {
  it("reports the failure and reads again next time instead of caching the partial list", async () => {
    const FRESH = { coinType: "0x5::fresh::FRESH", name: "Fresh", symbol: "FRESH" };
    const FRESHER = { coinType: "0x6::fresher::FRESHER", name: "Fresher", symbol: "FRESHER" };
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [], providers: { dexscreener: "skipped", geckoterminal: "skipped" }, unavailable_providers: [],
    });
    await runWithNetwork("devnet", async () => {
      mockGqlQuery.mockResolvedValueOnce(metadataPage([FRESH], true)).mockRejectedValueOnce(new TypeError("fetch failed"));
      expect(await searchTokens("fresh")).toMatchObject({
        source: "scan", scan: { truncated: true, scanned: 1, failed: expect.stringContaining("fetch failed") },
        tokens: [{ symbol: "FRESH" }],
      });
      mockGqlQuery.mockResolvedValueOnce(metadataPage([FRESH, FRESHER]));
      const retried = await searchTokens("fresh");
      expect(retried).toMatchObject({ source: "scan", scan: { truncated: false, scanned: 2 } });
      expect(retried.tokens.map((t) => t.symbol)).toEqual(["FRESH", "FRESHER"]);
      expect(mockSearchLiveTickers).toHaveBeenCalledTimes(2);
    });
  });
});
