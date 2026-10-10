import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();
const mockSearchLiveTickers = vi.fn();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../../src/utils/ticker-search.js", () => ({ searchLiveTickers: mockSearchLiveTickers }));
vi.mock("../../src/tools/prices.js", () => ({ fetchAftermathPrices: vi.fn(async () => ({})) }));
vi.mock("../../src/tools/holders.js", () => ({
  scanTokenTopHolders: vi.fn(async () => ({ holders: [], total_scanned: 0, truncated: false })),
  stoppedWalks: vi.fn(() => []),
}));
vi.mock("../../src/utils/price-providers.js", () => ({ fetchDefiLlamaChange24h: vi.fn(async () => ({ changes: new Map() })) }));

// Import after registration so resolution, metadata and enrichments use the test's boundaries.
const { registerAnalyzeTokenTools } = await import("../../src/tools/analyze-token.js");

const tools = new Map<string, Function>();
registerAnalyzeTokenTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);

const rpcError = (code: string, message: string) => Object.assign(new Error(message), { name: "RpcError", code });
const KONG_SUI = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG";
const CA_KONG = "0x494de27c9e7c9c1a2de43794d318b6deefe30841b84c955726acf123953c1d29::kong::KONG";
const coverage = { dexscreener: "ok", geckoterminal: "skipped" };

function ticker(coin_type: string, name: string, decimals: number, liquidity_usd: number) {
  return {
    coin_type, name, symbol: "KONG", decimals,
    total_supply: "100000000000", liquidity_usd, pool_count: 2, volume_24h: 700,
    providers: ["dexscreener"], verified: false,
    package_id: coin_type.split("::")[0], publisher_hint: "Inspect package publisher",
  };
}

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockSearchLiveTickers.mockReset();
  mockSearchLiveTickers.mockResolvedValue({ candidates: [], providers: coverage, unavailable_providers: [] });
  mockSui.stateService.getCoinInfo.mockReset();
  mockSui.stateService.getCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => {
    if (coinType === KONG_SUI) return { response: { coinType, metadata: { name: "KONG SUI", symbol: "KONG", decimals: 1 }, treasury: { totalSupply: 100000000000n } } };
    if (coinType === CA_KONG) return { response: { coinType, metadata: { name: "Ca kong", symbol: "KONG", decimals: 9 }, treasury: { totalSupply: 1000000000000000000n } } };
    throw rpcError("NOT_FOUND", `Coin type ${coinType} not found`);
  });
});

describe("analyze_token on something that is not a coin", () => {
  it("is an error for a coin type nothing on chain knows", async () => {
    mockSui.stateService.getCoinInfo.mockRejectedValue(rpcError("NOT_FOUND", "Coin%20type%200x1::nope::NOPE%20not%20found"));
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [] } });
    const result = await tools.get("analyze_token")!({ query: "0x1::nope::NOPE" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/No coin of type/);
  });

  it("is an error for a coin type that does not parse", async () => {
    mockSui.stateService.getCoinInfo.mockRejectedValue(rpcError("INVALID_ARGUMENT", 'invalid%20coin_type:%20unable%20to%20parse%20type%20"0xZZ::coin::COIN"'));
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [] } });
    const result = await tools.get("analyze_token")!({ query: "0xZZ::coin::COIN" });
    expect(result.isError).toBe(true);
  });
});

describe("analyze_token resolving a symbol", () => {
  it("reports several exact pooled coins as ambiguous, with liquidity and incomplete coverage", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [ticker(KONG_SUI, "KONG SUI", 1, 40000), ticker(CA_KONG, "Ca kong", 9, 20000)],
      providers: coverage, unavailable_providers: [],
    });
    const result = await tools.get("analyze_token")!({ query: "KONG", include_holders: false });
    const data = JSON.parse(result.content[0].text);
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({
      status: "ambiguous_symbol", coin_count: 2,
      candidates: [{ coin_type: KONG_SUI, verified: false, liquidity_usd: 40000 }, { coin_type: CA_KONG, liquidity_usd: 20000 }],
      search_coverage: { providers: coverage, unavailable_providers: [] },
    });
    expect(data.message).toMatch(/pool-backed.*full coin_type/);
    expect(data.candidate_order).toMatch(/liquidity is not proof/i);
    expect(mockGqlQuery).not.toHaveBeenCalled();
    expect(mockSui.stateService.getCoinInfo).not.toHaveBeenCalled();
  });

  it("analyses one pooled coin but calls symbol discovery unverified", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [ticker(KONG_SUI, "KONG SUI", 1, 40000)], providers: coverage, unavailable_providers: [],
    });
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [] } });
    const result = await tools.get("analyze_token")!({ query: "KONG", include_holders: false });
    const data = JSON.parse(result.content[0].text);
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({ coin_type: KONG_SUI, verified: false, decimals: 1 });
    expect(data.symbol_resolution).toMatchObject({
      via: "dex_search", liquidity_usd: 40000, pool_count: 2, coverage, unavailable_providers: [],
    });
    expect(data.symbol_resolution.note).toMatch(/not proof of identity/);
  });

  it("preserves curated verified ambiguity ahead of pooled candidates", async () => {
    const result = await tools.get("analyze_token")!({ query: "USDC", include_holders: false });
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe("ambiguous_symbol");
    expect(data.candidates.length).toBeGreaterThan(1);
    expect(data.candidates.every((candidate: { verified: boolean }) => candidate.verified)).toBe(true);
    expect(mockSearchLiveTickers).not.toHaveBeenCalled();
  });

  it("reports provider failures and the scan's reach when neither finds a symbol", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [], providers: { dexscreener: "rate_limited", geckoterminal: "unavailable" },
      unavailable_providers: [{ provider: "dexscreener", reason: "HTTP 429" }, { provider: "geckoterminal", reason: "HTTP 503" }],
    });
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [], pageInfo: { hasNextPage: false } } });
    const result = await tools.get("analyze_token")!({ query: "NEWCOIN", include_holders: false });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/both providers were unavailable.*HTTP 429.*HTTP 503.*scan read 0 objects/i);
  });

  it("calls a failed CoinMetadata page a read failure, not a miss", async () => {
    mockGqlQuery.mockRejectedValue(new TypeError("fetch failed"));
    const result = await tools.get("analyze_token")!({ query: "OUTAGECOIN", include_holders: false });
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0].text).error as string;
    expect(error).toMatch(/scan failed after 0 objects \(.*fetch failed.*\)/);
    expect(error).not.toMatch(/not found|stopped before the end/);
  });
  it("distinguishes unconfirmed on-chain candidates from a missing symbol", async () => {
    mockSearchLiveTickers.mockResolvedValue({
      candidates: [], providers: coverage, unavailable_providers: [],
      partial: true, unconfirmed: 2, unconfirmed_reason: "gRPC overloaded",
    });
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [], pageInfo: { hasNextPage: false } } });
    const result = await tools.get("analyze_token")!({ query: "UNCONFIRMED", include_holders: false });
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0].text).error as string;
    expect(error).toMatch(/could not be confirmed.*2 candidates could not be confirmed on chain \(gRPC overloaded\)/i);
    expect(error).toMatch(/coverage is partial/);
    expect(error).not.toMatch(/Token "UNCONFIRMED" not found/);
  });

});
