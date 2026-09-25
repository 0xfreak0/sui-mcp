import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockClient } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockSui,
}));

// Imported after the mock above, which the factory closes over.
const { registerDefiTools } = await import("../../src/tools/defi.js");

const tools = new Map<string, Function>();
registerDefiTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);

const STAKED = "0x0000000000000000000000000000000000000000000000000000000000000003::staking_pool::StakedSui";

/** A StakedSui as the SDK's listOwnedObjects returns it with `include: { json: true }`. */
function stakedSui(id: string, principal: string) {
  return {
    objectId: id,
    version: "988732962",
    digest: "AvQg6ywqWwqGo471qka7wvcMLWzwcwsiaaUiw6n9XbtP",
    owner: { $kind: "AddressOwner", AddressOwner: "0xwallet" },
    type: STAKED,
    json: { id, pool_id: "0xpool", principal, stake_activation_epoch: "1240" },
  };
}

describe("get_defi_positions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads every page of a protocol's positions", async () => {
    // One page of 50 was the whole answer, flagged or not.
    mockSui.listOwnedObjects.mockImplementation(async ({ type, cursor }: { type: string; cursor: string | null }) => {
      if (type !== "0x3::staking_pool::StakedSui") return { objects: [], hasNextPage: false, cursor: null };
      return cursor === null
        ? { objects: [stakedSui("0xs1", "1"), stakedSui("0xs2", "2")], hasNextPage: true, cursor: "c1" }
        : { objects: [stakedSui("0xs3", "3")], hasNextPage: false, cursor: null };
    });

    const data = JSON.parse((await tools.get("get_defi_positions")!({ address: "0xwallet" })).content[0].text);

    expect(data.total_positions).toBe(3);
    expect(data.positions.staked_sui.map((p: { object_id: string }) => p.object_id)).toEqual(["0xs1", "0xs2", "0xs3"]);
    expect(data.positions.staked_sui[2].summary.principal).toBe("3");
    expect(data.truncated_protocols).toBeUndefined();
  });
});
