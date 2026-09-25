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

  it("counts every match and names the argument that shows the rest", async () => {
    searchTokens.mockResolvedValue({
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
});
