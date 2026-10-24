import { describe, expect, it, vi } from "vitest";

const listBalances = vi.fn();
vi.mock("../src/clients/grpc.js", () => ({ sui: { listBalances } }));

// Load the helper only after Vitest registers the transport mock for this test module.
const { objectAddressBalanceFields } = await import("../src/utils/address-balance.js");
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

function page(n: number) {
  return {
    balances: [{ coinType: SUI, addressBalance: String(n) }],
    hasNextPage: n < 5,
    cursor: n < 5 ? `cursor-${n}` : null,
  };
}

describe("object address-balance pagination", () => {
  it("continues after four pages without dropping the next coin balances", async () => {
    listBalances.mockReset();
    listBalances.mockImplementation(async ({ cursor }: { cursor: string | null }) => page(cursor ? Number(cursor.split("-")[1]) + 1 : 1));
    const first = await objectAddressBalanceFields("0x2");
    expect(first.address_balances).toHaveLength(4);
    expect(first.address_balances_truncated).toBe(true);
    expect(first.address_balances_next_call).toEqual({
      tool: "get_object", args: { object_id: "0x2", balance_cursor: "cursor-4" },
    });
    const second = await objectAddressBalanceFields("0x2", "cursor-4");
    expect(second.address_balances).toHaveLength(1);
    expect(second.address_balances_truncated).toBeUndefined();
    expect(listBalances).toHaveBeenLastCalledWith({ owner: "0x2", limit: 50, cursor: "cursor-4" });
  });

  it("does not advertise a continuation when the service repeats its cursor", async () => {
    listBalances.mockReset();
    listBalances.mockResolvedValue({ balances: [{ coinType: SUI, addressBalance: "1" }], hasNextPage: true, cursor: "stale" });
    const result = await objectAddressBalanceFields("0x2", "stale");
    expect(result.address_balances_truncated).toBe(true);
    expect(result.address_balances_next_call).toBeUndefined();
    expect(listBalances).toHaveBeenCalledTimes(1);
  });
});
