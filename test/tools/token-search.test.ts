import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockClient } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();
const searchTokens = vi.fn();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/discovery.js", () => ({ searchTokens, probeOnChain: vi.fn(async () => null) }));

// Import after installing the mocked discovery boundary.
const { registerTokenSearchTools } = await import("../../src/tools/token-search.js");

const tools = new Map<string, Function>();
registerTokenSearchTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);

const SUI = `0x${"0".repeat(63)}2::sui::SUI`;
const IMPOSTOR = "0x006e09c3c3ebb8c4670e0320da7efe926d35347608f964b4625dd47bae40a664::sui::SUI";
const coverage = { dexscreener: "ok", geckoterminal: "skipped" };
const unavailable = [
  { provider: "dexscreener", reason: "HTTP 429" },
  { provider: "geckoterminal", reason: "HTTP 503" },
];

function liveCoin(coin_type: string, symbol: string, name: string) {
  return {
    coin_type, symbol, name, decimals: 9, total_supply: "1000000", liquidity_usd: 7654,
    pool_count: 2, volume_24h: 123, providers: ["dexscreener"], verified: false,
    package_id: coin_type.split("::")[0], publisher_hint: "Inspect package publisher",
  };
}

async function search(query: string, options: Record<string, unknown> = {}) {
  return JSON.parse((await tools.get("search_token")!({ query, ...options })).content[0].text);
}

describe("search_token", () => {
  beforeAll(() => { process.env.SUI_DISABLE_LIVE_COIN_LIST = "1"; });
  beforeEach(() => searchTokens.mockReset());

  it("lists the verified type first and marks a pooled symbol lookalike as an impostor", async () => {
    searchTokens.mockResolvedValue({
      source: "dex_search", coverage, unavailable_providers: [],
      tokens: [liveCoin(IMPOSTOR, "SUI", "Sui")],
    });
    const data = await search("SUI", { limit: 500 });
    const real = data.results.find((r: { coin_type: string }) => r.coin_type === SUI);
    const fake = data.results.find((r: { coin_type: string }) => r.coin_type === IMPOSTOR);

    expect(real).toMatchObject({ verified: true, source: "verified_list" });
    expect(fake).toMatchObject({
      verified: false, source: "dex_search", impostor_of: SUI, total_supply: "1000000",
      liquidity_usd: 7654, pool_count: 2, volume_24h: 123, providers: ["dexscreener"],
      package_id: IMPOSTOR.split("::")[0], publisher_hint: "Inspect package publisher",
    });
    expect(data.results.indexOf(real)).toBeLessThan(data.results.indexOf(fake));
    expect(data.search_coverage).toMatchObject({ providers: coverage, unavailable_providers: [] });
    expect(data.search_coverage.note).toMatch(/pool/);
    expect(data.discovery_scan_truncated).toBeUndefined();
  });

  it("reports both provider failures and a bounded scan instead of claiming no coin exists", async () => {
    searchTokens.mockResolvedValue({
      source: "scan", tokens: [{ coin_type: "0x9::fresh::FRESH", name: "Fresh", symbol: "FRESH", decimals: 9 }],
      coverage: { dexscreener: "rate_limited", geckoterminal: "unavailable" },
      unavailable_providers: unavailable,
      scan: { scanned: 3000, truncated: true },
    });
    const data = await search("fresh");
    expect(data.results).toMatchObject([{ symbol: "FRESH", source: "discovery", verified: false }]);
    expect(data.search_coverage).toMatchObject({ unavailable_providers: unavailable });
    expect(data.discovery_scan_scanned).toBe(3000);
    expect(data.discovery_scan_truncated).toBe(true);
  });

  it("distinguishes a failed CoinMetadata read from a completed scan", async () => {
    searchTokens.mockResolvedValue({
      source: "scan", tokens: [],
      coverage: { dexscreener: "unavailable", geckoterminal: "unavailable" },
      unavailable_providers: unavailable,
      scan: { scanned: 0, truncated: true, failed: "fetch failed" },
    });
    const data = await search("zzqy");
    expect(data.discovery_scan_failed).toBe("fetch failed");
    expect(data.discovery_scan_note).toMatch(/failed after 0 objects.*fetch failed/);
    expect(data.search_coverage.unavailable_providers).toEqual(unavailable);
  });

  it("counts every live candidate and names the argument that shows the rest", async () => {
    searchTokens.mockResolvedValue({
      source: "dex_search", coverage, unavailable_providers: [],
      tokens: Array.from({ length: 80 }, (_, i) => liveCoin(`0x${(i + 1).toString(16).padStart(64, "0")}::fake::FAKE`, "ZZQX", `Fake ${i}`)),
    });
    const data = await search("zzqx", { limit: 20 });
    expect(data.results).toHaveLength(20);
    expect(data.total_matches).toBe(80);
    expect(data.more_matches_note).toMatch(/limit/);
  });
  it("says when capped providers leave live symbol coverage partial", async () => {
    searchTokens.mockResolvedValue({
      source: "dex_search", coverage: { dexscreener: "ok", geckoterminal: "ok" },
      unavailable_providers: [], tokens: [liveCoin(IMPOSTOR, "SUI", "Sui")],
      partial: true, unconfirmed: 0,
    });
    const data = await search("SUI");
    expect(data.search_coverage).toMatchObject({ partial: true, unconfirmed: 0 });
    expect(data.search_coverage.note).toMatch(/coverage is partial.*providers' result caps/i);
    expect(data.results.find((r: { coin_type: string }) => r.coin_type === IMPOSTOR).impostor_of).toBe(SUI);
  });

  it("does not call a failed on-chain confirmation a missing symbol", async () => {
    searchTokens.mockResolvedValue({
      source: "scan", coverage, unavailable_providers: [], tokens: [],
      partial: false, unconfirmed: 2, unconfirmed_reason: "gRPC timed out",
      scan: { scanned: 3000, truncated: true },
    });
    const data = await search("UNKNOWN-CANDIDATE");
    expect(data.status).toBe("could_not_confirm");
    expect(data.search_coverage.note).toMatch(/2 candidates could not be confirmed on chain \(gRPC timed out\)/);
  });

});
