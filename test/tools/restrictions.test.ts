import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const probe = vi.hoisted(() => ({
  currentEpoch: vi.fn(), findCoinConfig: vi.fn(), readCoinRestrictions: vi.fn(), checkAddressAcrossCoins: vi.fn(),
}));
vi.mock("../../src/utils/deny-list-probe.js", () => probe);
vi.mock("../../src/utils/identity.js", () => ({ describeAddresses: vi.fn(async () => new Map()) }));

const { registerRestrictionTools } = await import("../../src/tools/restrictions.js");
const tools = new Map<string, Function>();
registerRestrictionTools({ tool: (name: string, _description: string, _schema: unknown, handler: Function) => tools.set(name, handler) } as unknown as McpServer);
const call = async (args: Record<string, unknown>) => JSON.parse((await tools.get("check_coin_restrictions")!(args)).content[0].text);

describe("check_coin_restrictions", () => {
  it("pages displayed rows before advancing the scan cursor and withholds incomplete negatives", async () => {
    probe.currentEpoch.mockResolvedValue(10);
    probe.findCoinConfig.mockResolvedValue("0xcafe");
    probe.readCoinRestrictions.mockImplementation(async (_coin: string, _config: string, _epoch: number, _pages: number, cursor: string | null) => ({
      denied: cursor ? [{ address: "0x4", active: true }] : ["0x1", "0x2", "0x3"].map((address) => ({ address, active: true })),
      globally_paused: null, truncated: !cursor, next_cursor: cursor ? undefined : "page-2",
    }));
    const args = { coin_type: "0x2::sui::SUI", address: "0x99", max_addresses: 2 };
    const first = await call(args);
    expect(first).toMatchObject({
      denied_count: 3, denied_count_scope: "this scan segment only", queried_address_denied: null,
      next_call: { tool: "check_coin_restrictions", repeat_with: { denied_offset: 2 } }
    });
    expect(first.denied).toHaveLength(2);
    const second = await call({ ...args, denied_offset: 2 });
    expect(second).toMatchObject({
      denied: [{ address: "0x3", active: true }],
      next_call: { tool: "check_coin_restrictions", repeat_with: { cursor: "page-2", denied_offset: 0 } }
    });
    const third = await call({ ...args, cursor: "page-2", denied_offset: 0 });
    expect(third).toMatchObject({ denied: [{ address: "0x4", active: true }], queried_address_denied: null });
    expect(third.next_call).toBeUndefined();
    expect(probe.readCoinRestrictions.mock.calls.map((args) => args[4])).toEqual([null, null, "page-2"]);
  });
});
