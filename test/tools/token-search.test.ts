import { describe, it, expect, vi, beforeAll } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockClient } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();
const searchTokens = vi.fn();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/discovery.js", () => ({ searchTokens, probeOnChain: vi.fn(async () => null) }));

// Imported after the mocks above, which the factories close over.
const { registerTokenSearchTools } = await import("../../src/tools/token-search.js");

const tools = new Map<string, Function>();
registerTokenSearchTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);

const CIRCLE_USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const IMPOSTOR = "0x006e09c3c3ebb8c4670e0320da7efe926d35347608f964b4625dd47bae40a664::usdc::USDC";

describe("search_token", () => {
  beforeAll(() => {
    process.env.SUI_DISABLE_LIVE_COIN_LIST = "1";
  });

  it("lists verified coins first and marks the scan's matches unverified", async () => {
    // What the bounded CoinMetadata scan returned for "USDC" on mainnet: the
    // first 3,000 objects by ID held impostors and no real USDC.
    searchTokens.mockResolvedValue({
      source: "scan",
      index: null,
      tokens: [
        { coin_type: IMPOSTOR, name: "USDC v2 (complete bridge: usdv2.com)", symbol: "USDC", decimals: 6 },
        { coin_type: "0x00035fc6dac8b502ad26291a180a03ec02ff218688aa619072119a334dcc4002::privatecoin::PRIVATECOIN", name: "Tatr U", symbol: "USDC ", decimals: 9 },
      ],
      truncated: true,
      scanned: 3000,
    });

    const data = JSON.parse((await tools.get("search_token")!({ query: "USDC" })).content[0].text);
    const circle = data.results.find((r: { coin_type: string }) => r.coin_type === CIRCLE_USDC);
    const impostor = data.results.find((r: { coin_type: string }) => r.coin_type === IMPOSTOR);

    expect(circle).toMatchObject({ verified: true, decimals: 6 });
    expect(impostor.verified).toBe(false);
    expect(data.results.findIndex((r: { verified: boolean }) => !r.verified)).toBeGreaterThan(
      data.results.indexOf(circle),
    );
    expect(data.discovery_scan_truncated).toBe(true);
  });

  /**
   * A failed metadata page is reported with its error, distinct from the
   * discovery_scan_truncated wording of a spent page budget.
   */
  it("says the scan failed, with its error, when a page read failed", async () => {
    searchTokens.mockResolvedValue({ source: "scan", index: null, tokens: [], truncated: true, scanned: 0, failed: "fetch failed" });

    const data = JSON.parse((await tools.get("search_token")!({ query: "zzqy" })).content[0].text);

    expect(data.discovery_scan_failed).toBe("fetch failed");
    expect(data.discovery_scan_note).toMatch(/failed after reading 0 CoinMetadata objects \(fetch failed\)/);
    expect(data.discovery_scan_note).not.toMatch(/stopped before the end/);
  });

  it("counts every match and names the argument that shows the rest", async () => {
    searchTokens.mockResolvedValue({
      source: "scan",
      index: null,
      tokens: Array.from({ length: 80 }, (_, i) => ({
        coin_type: `0x${(i + 1).toString(16).padStart(64, "0")}::fake::FAKE`,
        name: `Fake ${i}`,
        symbol: "ZZQX",
        decimals: 9,
      })),
      truncated: false,
      scanned: 3000,
    });

    const data = JSON.parse((await tools.get("search_token")!({ query: "zzqx", limit: 20 })).content[0].text);

    expect(data.results).toHaveLength(20);
    expect(data.total_matches).toBe(80);
    expect(data.more_matches_note).toMatch(/limit/);
  });

  it("says the index's date, so a coin published later is not taken as absent", async () => {
    // Two of the coins the index holds for "KONG".
    searchTokens.mockResolvedValue({
      source: "symbol_index",
      tokens: [
        { coin_type: "0x009f33ecca62cb3a6eff9df6517f4bc2cd3f879003e3c69454f5271f6674be26::yungog::YUNGOG", name: "Yung Kong Khan", symbol: "YUNGOG", decimals: 9 },
        { coin_type: "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG", name: "KONG SUI", symbol: "KONG ", decimals: 1 },
      ],
      index: { synced_at: "2026-09-26", checkpoint: 190000000, coins: 174684, max_rows_per_symbol: 100 },
      unlisted_exact_count: null,
      unlisted_containing: [],
    });

    const data = JSON.parse((await tools.get("search_token")!({ query: "KONG" })).content[0].text);

    // An exact symbol, trailing space and all, ranks above a name match.
    expect(data.results[0]).toMatchObject({ symbol: "KONG ", source: "symbol_index", verified: false });
    expect(data.symbol_index).toEqual({ synced_at: "2026-09-26", checkpoint: 190000000 });
    expect(data.symbol_index_note).toMatch(/published after/);
    expect(data.discovery_scan_truncated).toBeUndefined();
  });

  /**
   * The index keeps only a count for a symbol more than 100 coins use, so
   * search_token names each such symbol containing the query, with its count.
   */
  it("names the symbols too common to list that contain the query", async () => {
    searchTokens.mockResolvedValue({
      source: "symbol_index",
      tokens: [{ coin_type: "0x00035fc6dac8b502ad26291a180a03ec02ff218688aa619072119a334dcc4002::privatecoin::PRIVATECOIN", name: "Tatr U", symbol: "USDC ", decimals: 9 }],
      index: { synced_at: "2026-09-26", checkpoint: 190000000, coins: 174684, max_rows_per_symbol: 100 },
      unlisted_exact_count: null,
      unlisted_containing: [
        { symbol: "usdt", count: 1093 },
        { symbol: "usdc", count: 735 },
        { symbol: "usdd", count: 134 },
        { symbol: "usd1", count: 117 },
      ],
    });

    const data = JSON.parse((await tools.get("search_token")!({ query: "usd" })).content[0].text);

    expect(data.unlisted_symbols).toEqual([
      { symbol: "usdt", coins: 1093 },
      { symbol: "usdc", coins: 735 },
      { symbol: "usdd", coins: 134 },
      { symbol: "usd1", coins: 117 },
    ]);
    expect(data.symbol_index_note).toContain('"usdt" (1093 coins)');
    expect(data.symbol_index_note).toContain("2079 coins is listed");
  });
});
