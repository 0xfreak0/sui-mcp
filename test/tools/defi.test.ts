import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ValuedPosition } from "../../src/utils/position-value.js";

// The real readers are replaced by the synthetic ones registered below.
vi.mock("../../src/utils/valuers/index.js", () => ({}));

// Imported after the mock above.
const { registerValuer } = await import("../../src/utils/position-value.js");
const { registerDefiTools } = await import("../../src/tools/defi.js");

const tools = new Map<string, Function>();
registerDefiTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);

const position = (object_id: string, protocol: string, usd: number | null): ValuedPosition => ({
  protocol,
  kind: "staked_sui",
  object_id,
  assets: [{ coin_type: "0x2::sui::SUI", amount: "1", side: "stake", usd }],
  usd_net: usd,
  method: "synthetic",
  tier: "price-provider",
  ...(usd === null ? { unpriced_reason: "no price" } : {}),
});

let nftRuns = 0;
registerValuer({ name: "stakes", value: async () => ({ positions: [position("0xa1", "Sui staking", 10), position("0xa2", "Sui staking", 2.5)], unread: [] }) });
registerValuer({ name: "pools", value: async () => ({ positions: [position("0xb1", "Pool", null)], unread: [{ what: "0xb2", reason: "pool unreadable" }] }) });
registerValuer({ name: "broken", value: async () => { throw new Error("service down"); } });
registerValuer({ name: "nft", value: async () => { nftRuns++; return { positions: [position("0xc1", "Art", 1000)], unread: [] }; } });

const run = async () => JSON.parse((await tools.get("get_defi_positions")!({ address: "0x00000000000000000000000000000000000000000000000000000000000000d1" })).content[0].text);

describe("get_defi_positions", () => {
  it("gives every position its usd, method and tier, most valuable first", async () => {
    const data = await run();
    expect(data.positions.map((p: { object_id: string }) => p.object_id)).toEqual(["0xa1", "0xa2", "0xb1"]);
    for (const p of data.positions) {
      expect(p).toHaveProperty("usd");
      expect(p.method).toBeTruthy();
      expect(p.tier).toBeTruthy();
    }
  });

  it("sums priced positions only and counts the unpriced apart", async () => {
    const data = await run();
    expect(data.total_usd).toBe(12.5);
    expect(data.priced_positions).toBe(2);
    expect(data.unpriced_positions).toBe(1);
    expect(data.by_protocol["Sui staking"]).toEqual({ count: 2, usd: 12.5, unpriced: 0 });
    expect(data.by_protocol.Pool).toEqual({ count: 1, usd: 0, unpriced: 1 });
  });

  it("states what a reader could not read, and a failed reader, without losing the rest", async () => {
    const data = await run();
    expect(data.unread.map((u: { what: string }) => u.what).sort()).toEqual(["0xb2", "broken"]);
    expect(data.total_positions).toBe(3);
  });

  it("leaves NFTs to the wallet overview", async () => {
    nftRuns = 0;
    const data = await run();
    expect(nftRuns).toBe(0);
    expect(data.positions.some((p: { object_id: string }) => p.object_id === "0xc1")).toBe(false);
  });
});
