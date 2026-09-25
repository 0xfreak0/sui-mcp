import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

// Imported after the mocks above, which the factories close over.
const { registerPoolTools } = await import("../../src/tools/pools.js");

const tools = new Map<string, Function>();
registerPoolTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const CETUS = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool";
const TURBOS = "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::Pool";
const FEE = "91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::fee500bps::FEE500BPS";

const node = (id: string, type: string) => ({ address: id, asMoveObject: { contents: { type: { repr: type } } } });
const page = (nodes: unknown[], endCursor: string | null = null) => ({
  objects: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
});

describe("find_pools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads every page, reports the pool's own token order, and finds Turbos's three-parameter pools", async () => {
    // Mainnet has 16 Cetus Pool<USDC, SUI>; `first: 10` returned ten, each
    // labelled token_a SUI because that was the query's order. Turbos pools are
    // Pool<A, B, FeeTier>, which a Pool<A, B> filter never matches.
    const cetusType = `${CETUS}<${USDC}, ${SUI}>`;
    const turbosType = `${TURBOS}<${USDC}, ${SUI}, 0x${FEE}>`;
    mockGqlQuery.mockImplementation(async (query: string, vars: { type?: string; after?: string | null }) => {
      if (query.includes("object(address")) {
        return { object: { asMoveObject: { contents: { json: { fee_map: { contents: [{ key: FEE, value: "0x1" }] } } } } } };
      }
      if (vars.type === `${CETUS}<${USDC}, ${SUI}>`) {
        return vars.after
          ? page([node("0xc3", cetusType)])
          : page([node("0xc1", cetusType), node("0xc2", cetusType)], "p2");
      }
      if (vars.type === `${TURBOS}<${USDC}, ${SUI}, 0x${FEE}>`) return page([node("0xt1", turbosType)]);
      return page([]);
    });

    const data = JSON.parse((await tools.get("find_pools")!({ token_a: SUI, token_b: USDC })).content[0].text);

    expect(data.pools.map((p: { pool_id: string }) => p.pool_id).sort()).toEqual(["0xc1", "0xc2", "0xc3", "0xt1"]);
    expect(data.pools.every((p: { token_a: string; token_b: string }) => p.token_a === USDC && p.token_b === SUI)).toBe(true);
    expect(data.incomplete).toBeUndefined();
  });

  it("says when a search failed instead of reporting no pools", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("object(address")) throw new Error("Rate-limited by graphql.mainnet.sui.io (HTTP 429)");
      return page([]);
    });

    const result = await tools.get("find_pools")!({ token_a: SUI, token_b: USDC, protocol: "turbos" });

    expect(result.isError).toBe(true);
  });
});
