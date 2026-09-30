import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import { buildSymbolIndex } from "../../scripts/lib/coin-symbols-encode.mjs";
import type { SymbolIndex } from "../../src/utils/coin-symbols.js";
import type * as CoinSymbols from "../../src/utils/coin-symbols.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../../src/tools/prices.js", () => ({ fetchAftermathPrices: vi.fn(async () => ({})) }));
vi.mock("../../src/tools/holders.js", () => ({
  scanTokenTopHolders: vi.fn(async () => ({ holders: [], total_scanned: 0, truncated: false })),
  stoppedWalks: vi.fn(() => []),
}));
vi.mock("../../src/utils/price-providers.js", () => ({ fetchDefiLlamaChange24h: vi.fn(async () => ({ changes: new Map() })) }));
// The symbol index the resolver sees. Each test installs the one it needs.
const shipped = vi.hoisted(() => ({ index: null as SymbolIndex | null }));
vi.mock("../../src/utils/coin-symbols.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CoinSymbols>()),
  symbolIndex: () => shipped.index,
}));

// Imported after the mocks above, which the factories close over.
const { registerAnalyzeTokenTools } = await import("../../src/tools/analyze-token.js");
const { createSymbolIndex } = await import("../../src/utils/coin-symbols.js");
const { refreshLiveCoins, resetLiveCoins } = await import("../../src/utils/coin-registry.js");

const tools = new Map<string, Function>();
registerAnalyzeTokenTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);

/** A state-service failure as @protobuf-ts's RpcError carries it. */
const rpcError = (code: string, message: string) => Object.assign(new Error(message), { name: "RpcError", code });

describe("analyze_token on something that is not a coin", () => {
  it("is an error for a coin type nothing on chain knows", async () => {
    // Analysed anyway, 0x1::nope::NOPE came back with decimals assumed and
    // "nobody can freeze holders of this coin".
    mockSui.stateService.getCoinInfo.mockRejectedValue(
      rpcError("NOT_FOUND", "Coin%20type%200x1::nope::NOPE%20not%20found"),
    );
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [] } });

    const result = await tools.get("analyze_token")!({ query: "0x1::nope::NOPE" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/No coin of type/);
  });

  it("is an error for a coin type that does not parse", async () => {
    mockSui.stateService.getCoinInfo.mockRejectedValue(
      rpcError("INVALID_ARGUMENT", 'invalid%20coin_type:%20unable%20to%20parse%20type%20"0xZZ::coin::COIN"'),
    );
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [] } });

    const result = await tools.get("analyze_token")!({ query: "0xZZ::coin::COIN" });

    expect(result.isError).toBe(true);
  });
});

const KONG_SUI = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG";
/** "Ca kong": more raw units than KONG SUI, fewer whole coins. */
const CA_KONG = "0x494de27c9e7c9c1a2de43794d318b6deefe30841b84c955726acf123953c1d29::kong::KONG";
/** "King": nothing minted. */
const KING = "0x17e8cf6189361693fe0eff4f173f08372ff6035f298793a6e501c9b0819acd00::kong::KONG";
/** A KONG the live Aftermath list vouches for, which the checked-in list has not seen. */
const LIVE_KONG = `0x${"a".repeat(64)}::kong::KONG`;

function indexOf(coins: Array<{ coin_type: string; symbol: string; name: string; decimals: number }>, maxRows = 100) {
  return createSymbolIndex({
    synced_at: "2026-09-26",
    checkpoint: 190000000,
    counts: { coins: coins.length },
    max_rows_per_symbol: maxRows,
    symbols: buildSymbolIndex(coins, maxRows).symbols,
  });
}

/** getCoinInfo for each KONG, as mainnet answered it on 2026-09-26 (LIVE_KONG aside). */
const COIN_INFO: Record<string, { metadata: { name: string; symbol: string; decimals: number }; treasury: { totalSupply: bigint } }> = {
  [KONG_SUI]: { metadata: { name: "KONG SUI", symbol: "KONG", decimals: 1 }, treasury: { totalSupply: 100000000000n } },
  [CA_KONG]: { metadata: { name: "Ca kong", symbol: "KONG", decimals: 9 }, treasury: { totalSupply: 1000000000000000000n } },
  [KING]: { metadata: { name: "King", symbol: "KONG", decimals: 9 }, treasury: { totalSupply: 0n } },
  [LIVE_KONG]: { metadata: { name: "Kong", symbol: "KONG", decimals: 9 }, treasury: { totalSupply: 5000000000n } },
};

describe("analyze_token on a symbol several coins use", () => {
  beforeEach(() => {
    resetLiveCoins();
    shipped.index = null;
    mockGqlQuery.mockReset();
    mockSui.stateService.getCoinInfo.mockReset();
    mockSui.stateService.getCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => {
      if (!COIN_INFO[coinType]) throw rpcError("NOT_FOUND", `Coin type ${coinType} not found`);
      return { response: { coinType, ...COIN_INFO[coinType] } };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  /**
   * Every coin the index lists under the symbol is a candidate, verified first
   * and then by whole-coin supply, and the live scan does not run.
   */
  it("returns every candidate from the index, verified first and then by supply", async () => {
    // Warm the live Aftermath layer so LIVE_KONG is vouched for.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [LIVE_KONG] })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ symbol: "KONG", name: "Kong", decimals: 9 }] }),
    );
    delete process.env.SUI_DISABLE_LIVE_COIN_LIST;
    await refreshLiveCoins();
    shipped.index = indexOf([
      { coin_type: KONG_SUI, symbol: "KONG", name: "KONG SUI", decimals: 1 },
      { coin_type: CA_KONG, symbol: "KONG", name: "Ca kong", decimals: 9 },
      { coin_type: KING, symbol: "KONG", name: "King", decimals: 9 },
      { coin_type: LIVE_KONG, symbol: "KONG", name: "Kong", decimals: 9 },
    ]);

    const result = await tools.get("analyze_token")!({ query: "KONG", include_holders: false });
    const data = JSON.parse(result.content[0].text);

    expect(result.isError).toBeFalsy();
    expect(data.status).toBe("ambiguous_symbol");
    expect(data.coin_count).toBe(4);
    // Verified first. Then 10,000,000,000 KONG SUI (1 decimal) above
    // 1,000,000,000 Ca kong (9 decimals), though Ca kong's raw supply is
    // larger and its coin type sorts first; an unminted coin last.
    expect(data.candidates.map((c: { coin_type: string }) => c.coin_type)).toEqual([LIVE_KONG, KONG_SUI, CA_KONG, KING]);
    expect(data.candidates[1]).toMatchObject({ verified: false, decimals: 1, total_supply: "100000000000" });
    expect(data.symbol_index).toMatchObject({ synced_at: "2026-09-26", checkpoint: 190000000 });
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("gives a symbol too common to list its count and asks for the coin type", async () => {
    shipped.index = indexOf(
      Array.from({ length: 3 }, (_, i) => ({
        coin_type: `0x${(i + 1).toString(16).padStart(64, "0")}::fwp::FWP`,
        symbol: "FWP",
        name: "fixwalletspls",
        decimals: 9,
      })),
      2,
    );
    const data = JSON.parse((await tools.get("analyze_token")!({ query: "FWP", include_holders: false })).content[0].text);
    expect(data).toMatchObject({ status: "ambiguous_symbol", coin_count: 3, candidates: [] });
    expect(data.message).toMatch(/full coin type/);
    expect(mockSui.stateService.getCoinInfo).not.toHaveBeenCalled();
  });

  it("analyses the one coin an indexed symbol names, and says the index is dated", async () => {
    shipped.index = indexOf([{ coin_type: KONG_SUI, symbol: "KONG", name: "KONG SUI", decimals: 1 }]);
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [] } });
    const data = JSON.parse((await tools.get("analyze_token")!({ query: "KONG", include_holders: false })).content[0].text);
    expect(data).toMatchObject({ coin_type: KONG_SUI, verified: false, decimals: 1 });
    expect(data.symbol_resolution).toMatchObject({ via: "symbol_index", synced_at: "2026-09-26" });
  });

  it("names the index date and the scan's reach when neither finds the symbol", async () => {
    shipped.index = indexOf([{ coin_type: KONG_SUI, symbol: "KONG", name: "KONG SUI", decimals: 1 }]);
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [], pageInfo: { hasNextPage: false } } });
    const result = await tools.get("analyze_token")!({ query: "NEWCOIN", include_holders: false });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/symbol index \(every mainnet coin up to 2026-09-26.*scan of 0 CoinMetadata objects/);
  });

  /**
   * A failed CoinMetadata page is reported as a read failure with its error,
   * distinct from a scan that spent its page budget without a match.
   */
  it("calls a failed metadata read a read failure, not a miss", async () => {
    shipped.index = indexOf([{ coin_type: KONG_SUI, symbol: "KONG", name: "KONG SUI", decimals: 1 }]);
    mockGqlQuery.mockRejectedValue(new TypeError("fetch failed"));
    const result = await tools.get("analyze_token")!({ query: "OUTAGECOIN", include_holders: false });
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0].text).error as string;
    expect(error).toMatch(/could not be looked up: .*scan of CoinMetadata failed after 0 objects \(.*fetch failed.*\)/);
    expect(error).not.toMatch(/not found|stopped before the end/);
  });
});
