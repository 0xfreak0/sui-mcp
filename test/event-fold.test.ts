import { describe, it, expect } from "vitest";
import { foldEvents, type EventRow } from "../src/utils/event-fold.js";

const swap = (amount: string, positive: boolean, pool = "0xpool"): EventRow => ({
  package_id: "0xp",
  module: "market",
  event_type: "0xp::market::SwapEvent",
  sender: "0xs",
  parsed: { market: pool, expiry: "17", pt: { value: amount, positive } },
});

describe("foldEvents", () => {
  it("folds events that differ only in amounts, with totals, bounds and every index", () => {
    const { rows, folded } = foldEvents([swap("10", false), swap("30", false), { ...swap("5", true), event_type: "0xp::m::Other" }, swap("20", false)]);
    expect(folded).toBe(3);
    expect(rows.map((r) => r.index)).toEqual([0, 2]);
    expect(rows[0]).toMatchObject({
      count: 3,
      indices: [0, 1, 3],
      parsed: { market: "0xpool", expiry: "17", pt: { positive: false } },
      varying: { "pt.value": { total: "60", min: "10", max: "30" } },
    });
    expect(rows[1]).toEqual({ index: 2, ...swap("5", true), event_type: "0xp::m::Other" });
  });

  it("never folds opposite signs, other pools or other senders together", () => {
    const { rows, folded } = foldEvents([swap("1", false), swap("1", true), swap("1", false, "0xother"), { ...swap("1", false), sender: "0xt" }]);
    expect(folded).toBe(0);
    expect(rows).toHaveLength(4);
  });

  it("keeps a shared amount as a field, and totals huge values exactly", () => {
    const big = "27670116110564327424000000000000";
    const { rows } = foldEvents([swap(big, false), swap(big, false)]);
    expect(rows[0]).toMatchObject({ count: 2, parsed: { pt: { value: big, positive: false } }, varying: {} });
    const { rows: summed } = foldEvents([swap(big, false), swap("1", false)]);
    expect((summed[0] as { varying: Record<string, { total: string }> }).varying["pt.value"].total).toBe("27670116110564327424000000000001");
  });

  it("keeps u8-u32 JSON numbers in the key, so events for different reserves or chains never fold", () => {
    const borrow = (reserve: number, amount: string): EventRow => ({ ...swap(amount, false), event_type: "0xp::lending::BorrowEvent", parsed: { reserve, amount } });
    const { rows, folded } = foldEvents([borrow(0, "5000000000000"), borrow(1, "2000000"), borrow(0, "3000000")]);
    expect(folded).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ count: 2, parsed: { reserve: 0 }, varying: { amount: { total: "5000003000000" } } });
    expect(rows[1]).toMatchObject({ index: 1, parsed: { reserve: 1, amount: "2000000" } });
  });
});
