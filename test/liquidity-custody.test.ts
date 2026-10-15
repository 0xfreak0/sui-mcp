import { describe, expect, it } from "vitest";
import { aggregateCustodyRows, capLiquidityHolders, fractionOfLiquidity, liquidityHolderKind } from "../src/utils/liquidity-custody.js";
import type { NextCall } from "../src/utils/output-cap.js";

function nextOffset(page: { omitted?: { next_call: NextCall } }): number {
  const call = page.omitted?.next_call;
  if (!call || !("args" in call) || typeof call.args.liquidity_offset !== "number") {
    throw new Error("Liquidity continuation has no numeric offset");
  }
  return call.args.liquidity_offset;
}

describe("liquidity custody", () => {
  const deployer = "0xabcdef";

  it("distinguishes burn addresses, publisher and wallets", () => {
    expect(liquidityHolderKind("0x0", deployer, undefined, "wallet")).toBe("burned");
    expect(liquidityHolderKind("0x2", deployer, undefined, "wallet")).toBe("burned");
    expect(liquidityHolderKind(deployer, deployer, undefined, "wallet")).toBe("publisher");
    expect(liquidityHolderKind("0x123456", deployer, undefined, "wallet")).toBe("wallet");
    expect(liquidityHolderKind("0x123456", null, undefined, undefined)).toBe("unknown");
  });

  it("does not infer a lock from an object and identifies the framework kiosk exactly", () => {
    expect(liquidityHolderKind("0x123456", deployer, "0x2::kiosk::Kiosk", "object")).toBe("kiosk");
    expect(liquidityHolderKind("0x123456", deployer, "0xabc::kiosk::Kiosk", "object")).toBe("protocol_object");
    expect(liquidityHolderKind("0x123456", deployer, "0xabc::locker::Lock", "object")).toBe("protocol_object");
  });

  it("computes fractional shares with bigint arithmetic without overflow", () => {
    const supply = 10n ** 75n;
    expect(fractionOfLiquidity(supply / 4n, supply)).toBe(0.25);
    expect(fractionOfLiquidity(1n, 0n)).toBeNull();
    expect(fractionOfLiquidity(1n, -1n)).toBeNull();
  });

  it("sums a wallet's positions before assigning its pool share", () => {
    const holders = aggregateCustodyRows([
      { address: "0xa", amount: 13n, counterpart: 40n, position_id: "0x1" },
      { address: "0xb", amount: 70n, counterpart: 10n, position_id: "0x2" },
      { address: "0xA", amount: 17n, counterpart: 50n, position_id: "0x3" },
    ]);
    expect(holders).toHaveLength(2);
    expect(holders[0]).toMatchObject({
      amount: 30n, counterpart: 90n, position_ids: ["0x1", "0x3"],
    });
    expect(fractionOfLiquidity(holders[0]!.amount, 100n)).toBe(0.3);
    expect(fractionOfLiquidity(holders[0]!.counterpart!, 100n)).toBe(0.9);
  });

  it("pages every owner with an advancing structured call and exact omissions", () => {
    const holders = Array.from({ length: 207 }, (_, id) => ({ address: `0x${id + 1}`, kind: "wallet" as const, amount_raw: String(id + 1) }));
    const first = capLiquidityHolders(holders, 0, "0x2::sui::SUI", 0, "0xabc", 100_000);
    const second = capLiquidityHolders(holders, nextOffset(first), "0x2::sui::SUI", 0, "0xabc", 100_000);
    const third = capLiquidityHolders(holders, nextOffset(second), "0x2::sui::SUI", 0, "0xabc", 100_000);
    expect([...first.holders, ...second.holders, ...third.holders]).toEqual(holders);
    const firstCall = first.omitted?.next_call;
    expect(firstCall && "args" in firstCall ? firstCall.args.liquidity_holder_pool : null).toBe("0xabc");
    expect([first.omitted!.lists.holders.count, second.omitted!.lists.holders.count]).toEqual([107, 7]);
    expect(first.omitted!.lists.holders.from).toBe(100);
    expect(second.omitted!.lists.holders.from).toBe(200);
    expect(third.omitted).toBeUndefined();
    expect(holders.reduce((sum, row) => sum + Number(row.amount_raw), 0)).toBe(21528);
  });

  it("retains every flagged custodian even when they exceed the ordinary cap", () => {
    const custodians = Array.from({ length: 110 }, (_, id) => ({ address: `0x${id + 1}`, kind: "protocol_object" as const, amount_raw: "1" }));
    const wallets = Array.from({ length: 120 }, (_, id) => ({ address: `0x${id + 111}`, kind: "wallet" as const, amount_raw: "1" }));
    const all = [...custodians, ...wallets];
    const first = capLiquidityHolders(all, 0, "0x2::sui::SUI", 0, "0xabc", 100_000);
    expect(first.holders.slice(0, 110)).toEqual(custodians);
    expect(first.holders).toHaveLength(210);
    expect(first.omitted!.lists.holders.count).toBe(20);
    const second = capLiquidityHolders(all, nextOffset(first), "0x2::sui::SUI", 0, "0xabc", 100_000);
    expect([...first.holders, ...second.holders]).toEqual(all);
  });
});
