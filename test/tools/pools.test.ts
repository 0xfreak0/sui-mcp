import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

// Imported after the mocks above, which the factories close over.
const { registerPoolTools, discoverCoinPools } = await import("../../src/tools/pools.js");

const tools = new Map<string, Function>();
registerPoolTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const CETUS = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool";
const TURBOS = "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::Pool";
const BLUEMOVE = "0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9::swap::Pool";
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
      if (vars.type === `${BLUEMOVE}<${USDC}, ${SUI}>`) return page([node("0xb1", `${BLUEMOVE}<${USDC}, ${SUI}>`)]);
      return page([]);
    });

    const data = JSON.parse((await tools.get("find_pools")!({ token_a: SUI, token_b: USDC })).content[0].text);

    expect(data.pools.map((p: { pool_id: string }) => p.pool_id).sort()).toEqual(["0xb1", "0xc1", "0xc2", "0xc3", "0xt1"]);
    expect(data.pools.every((p: { token_a: string; token_b: string }) => p.token_a === USDC && p.token_b === SUI)).toBe(true);
    expect(data.incomplete).toBe(true);
    expect(data.venues.find((venue: { venue: string }) => venue.venue === "flowx_v2").status).toBe("failed");
    expect(data.venues.find((venue: { venue: string }) => venue.venue === "cetus").status).toBe("complete");
  });

  it("reads an Aftermath pool whose other type names contain nested unprefixed addresses", async () => {
    const aftermath = "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c::pool::Pool";
    mockGqlQuery.mockResolvedValue(page([{
      address: "0xa1",
      asMoveObject: {
        contents: {
          type: { repr: `${aftermath}<0xa::af_lp::AF_LP>` },
          json: {
            type_names: [
              SUI.slice(2),
              USDC.slice(2),
              `0x3::lp::LP<${SUI.slice(2)},${USDC.slice(2)}>`,
            ]
          },
        }
      },
    }]));

    const data = JSON.parse((await tools.get("find_pools")!({ token_a: SUI, token_b: USDC, protocol: "aftermath" })).content[0].text);
    expect(data.venues[0].status).toBe("complete");
    expect(data.pools).toEqual([expect.objectContaining({ pool_id: "0xa1", token_a: SUI, token_b: USDC })]);
  });

  it("says when a search failed instead of reporting no pools", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("object(address")) throw new Error("Rate-limited by graphql.mainnet.sui.io (HTTP 429)");
      return page([]);
    });

    const result = await tools.get("find_pools")!({ token_a: SUI, token_b: USDC, protocol: "turbos" });

    expect(result.isError).toBe(true);
  });

  it("keeps verified pools when one of a venue's ordered searches fails", async () => {
    const bluefin = "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::pool::Pool";
    mockGqlQuery.mockImplementation(async (_query: string, vars: { type: string }) => {
      if (vars.type === `${bluefin}<${SUI}, ${USDC}>`) throw new Error("GraphQL temporarily unavailable");
      return page([node("0xb1", `${bluefin}<${USDC}, ${SUI}>`)]);
    });

    const result = await tools.get("find_pools")!({ token_a: SUI, token_b: USDC, protocol: "bluefin" });
    const data = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(false);
    expect(data.pools.map((pool: { pool_id: string }) => pool.pool_id)).toEqual(["0xb1"]);
    expect(data.venues).toEqual([expect.objectContaining({ venue: "bluefin", status: "failed", searched: 2 })]);
    expect(data.failed_searches[0].error).toContain("temporarily unavailable");
  });

  it("marks a null continuation cursor incomplete without losing matched pools", async () => {
    const bluefin = "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::pool::Pool";
    mockGqlQuery.mockImplementation(async (_query: string, vars: { type: string }) =>
      vars.type === `${bluefin}<${USDC}, ${SUI}>`
        ? { objects: { nodes: [node("0xb2", vars.type)], pageInfo: { hasNextPage: true, endCursor: null } } }
        : page([]));

    const result = await tools.get("find_pools")!({ token_a: SUI, token_b: USDC, protocol: "bluefin" });
    const data = JSON.parse(result.content[0].text);
    expect(data.pools.map((pool: { pool_id: string }) => pool.pool_id)).toEqual(["0xb2"]);
    expect(data.venues[0]).toMatchObject({ status: "incomplete", searched: 2 });
    expect(data.incomplete).toBe(true);
  });

  it("pages a venue's many pools with a structured continuation, counting every pool", async () => {
    const bluefin = "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::pool::Pool";
    const type = `${bluefin}<${SUI}, ${USDC}>`;
    const ids = Array.from({ length: 900 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`);
    mockGqlQuery.mockImplementation(async (_query: string, vars: { type: string; after?: string | null }) => {
      if (vars.type !== type) return page([]);
      const from = vars.after ? Number(vars.after) : 0;
      const end = Math.min(from + 50, ids.length);
      return page(ids.slice(from, end).map((id) => node(id, type)), end < ids.length ? String(end) : null);
    });

    const seen: string[] = [];
    let args: Record<string, unknown> = { token_a: SUI, token_b: USDC, protocol: "bluefin" };
    for (let call = 0; call < 20; call++) {
      const data = JSON.parse((await tools.get("find_pools")!(args)).content[0].text);
      expect(data.total).toBe(900);
      expect(data.offset).toBe(seen.length);
      expect(JSON.stringify(data).length).toBeLessThan(50_000);
      seen.push(...data.pools.map((pool: { pool_id: string }) => pool.pool_id));
      if (!data.omitted) break;
      expect(data.omitted.lists.pools.from).toBe(seen.length);
      expect(data.omitted.next_call.tool).toBe("find_pools");
      args = data.omitted.next_call.args;
    }
    expect(seen).toEqual(ids);
  });

  it("resumes only the capped selectors, without repeating pools or skipping the final page", async () => {
    const bluefin = "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::pool::Pool";
    const forward = `${bluefin}<${SUI}, ${USDC}>`;
    const reverse = `${bluefin}<${USDC}, ${SUI}>`;
    const reads: Array<{ type: string; after?: string | null }> = [];
    mockGqlQuery.mockImplementation(async (_query: string, vars: { type: string; after?: string | null }) => {
      reads.push(vars);
      if (vars.type === reverse) return page([node("0xreverse", reverse)]);
      const index = vars.after ? Number(vars.after) : 0;
      return page([node(`0xforward${index}`, forward)], index < 20 ? String(index + 1) : null);
    });

    const initial = JSON.parse((await tools.get("find_pools")!({
      token_a: SUI, token_b: USDC, protocol: "bluefin",
    })).content[0].text);
    expect(initial.total).toBe(21);
    expect(initial.venues[0].status).toBe("incomplete");
    expect(initial.total_note).toContain("Lower bound");
    expect(initial.total_is_lower_bound).toBe(true);
    const continuation = initial.venues[0].next_call;
    expect(continuation).toMatchObject({ tool: "find_pools", args: { token_a: SUI, token_b: USDC, protocol: "bluefin" } });
    expect(continuation.args.venue_cursor).toEqual(expect.any(String));
    const resumed = JSON.parse((await tools.get("find_pools")!(continuation.args)).content[0].text);
    expect(resumed.venues[0].status).toBe("complete");
    expect(resumed.venues[0].next_call).toBeUndefined();
    expect(resumed.total).toBe(1);
    expect(resumed.total_is_lower_bound).toBe(true);
    expect(resumed.total_note).toContain("earlier slices");
    expect(reads.filter((r) => r.type === reverse)).toHaveLength(1);
    expect(reads.filter((r) => r.type === forward).map((r) => r.after)).toEqual([
      null, ...Array.from({ length: 20 }, (_, i) => String(i + 1)),
    ]);
    expect([...initial.pools, ...resumed.pools].map((p: { pool_id: string }) => p.pool_id)).toEqual([
      ...Array.from({ length: 20 }, (_, i) => `0xforward${i}`), "0xreverse", "0xforward20",
    ]);
  });

  it("continues failed selectors from their last successful page and retries a failed first page", async () => {
    const bluefin = "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::pool::Pool";
    const forward = `${bluefin}<${SUI}, ${USDC}>`;
    const reverse = `${bluefin}<${USDC}, ${SUI}>`;
    const reads: Array<{ type: string; after: string | null }> = [];
    let failedForward = false;
    let failedReverse = false;
    mockGqlQuery.mockImplementation(async (_query: string, vars: { type: string; after: string | null }) => {
      reads.push(vars);
      if (vars.type === reverse) {
        if (!failedReverse) {
          failedReverse = true;
          throw new Error("Temporary reverse read failure");
        }
        return page([node("0xreverse", reverse)]);
      }
      if (vars.after === "p2") {
        if (!failedForward) {
          failedForward = true;
          throw new Error("Temporary forward read failure");
        }
        return page([node("0xlast", forward)]);
      }
      return page([node("0xfirst", forward)], "p2");
    });
    const initial = JSON.parse((await tools.get("find_pools")!({ token_a: SUI, token_b: USDC, protocol: "bluefin" })).content[0].text);
    expect(initial.venues[0].status).toBe("failed");
    expect(initial.pools.map((p: { pool_id: string }) => p.pool_id)).toEqual(["0xfirst"]);
    const next = initial.venues[0].next_call;
    expect(next.args.venue_cursor).toEqual(expect.any(String));
    const resumed = JSON.parse((await tools.get("find_pools")!(next.args)).content[0].text);
    expect(resumed.venues[0].status).toBe("complete");
    expect([...initial.pools, ...resumed.pools].map((p: { pool_id: string }) => p.pool_id)).toEqual(["0xfirst", "0xlast", "0xreverse"]);
    expect(reads).toEqual([
      { type: forward, after: null }, { type: reverse, after: null },
      { type: forward, after: "p2" }, { type: forward, after: "p2" },
      { type: reverse, after: null },
    ]);
  });

  it("stops on an unchanged end cursor rather than exposing a looping continuation", async () => {
    const bluefin = "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::pool::Pool";
    const forward = `${bluefin}<${SUI}, ${USDC}>`;
    mockGqlQuery.mockImplementation(async (_query: string, vars: { type: string; after: string | null }) =>
      vars.type === forward ? page([node("0xfirst", forward)], "same") : page([]));
    const data = JSON.parse((await tools.get("find_pools")!({ token_a: SUI, token_b: USDC, protocol: "bluefin" })).content[0].text);
    expect(data.venues[0].status).toBe("incomplete");
    expect(data.venues[0].next_call).toBeUndefined();
    expect(mockGqlQuery).toHaveBeenCalledTimes(3);
  });

  it("stops a coin's pool discovery at its time budget and marks the venue incomplete", async () => {
    const coin = `0x${"c0".padStart(64, "0")}::coin::COIN`;
    const type = `${CETUS}<${coin}, ${SUI}>`;
    let pages = 0;
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockImplementation(() => start + (pages > 0 ? 31_000 : 0));
    mockGqlQuery.mockImplementation(async (query: string, vars: { type?: string }) => {
      if (query.includes("object(address")) return { object: null };
      if (vars.type !== type) return page([]);
      pages++;
      return page([node(`0x${pages.toString(16).padStart(64, "0")}`, type)], `p${pages}`);
    });
    try {
      const discovery = await discoverCoinPools(coin);
      const cetus = discovery.venues.find((venue) => venue.venue === "cetus")!;
      expect(pages).toBe(1);
      expect(cetus.status).toBe("incomplete");
      expect(cetus.error).toMatch(/30 s time budget after 1 page /);
      expect(discovery.pools.map((pool) => pool.pool_id)).toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });
});
