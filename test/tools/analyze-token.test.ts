import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../../src/tools/prices.js", () => ({ fetchAftermathPrices: vi.fn(async () => ({})) }));
vi.mock("../../src/tools/holders.js", () => ({
  scanTokenTopHolders: vi.fn(async () => ({ holders: [], total_scanned: 0, truncated: false })),
  stoppedWalks: vi.fn(() => []),
}));

// Imported after the mocks above, which the factories close over.
const { registerAnalyzeTokenTools } = await import("../../src/tools/analyze-token.js");

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
