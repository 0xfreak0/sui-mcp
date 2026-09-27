import { describe, it, expect } from "vitest";
import { foldSwaps, type SwapRow } from "../src/utils/swap-fold.js";

const swap = (event: number, over: Partial<SwapRow> = {}): SwapRow => ({
  event,
  event_type: "0x9::market::SwapEvent",
  pool: "0xp1",
  protocol: "Nemo",
  a_to_b: true,
  amount_in: "10",
  amount_out: "7",
  coin_in: "0x2::sui::SUI",
  coin_out: "PT0x2::sui::SUI",
  price_before: 1,
  price_after: 1,
  price_change_pct: 0,
  price_basis: "sqrt_price",
  ...over,
});

describe("foldSwaps", () => {
  it("folds identical swaps into one row that accounts for every event and amount", () => {
    const rows = foldSwaps([swap(3), swap(5, { amount_out: "8", price_after: 2 }), swap(9, { pool: "0xp2" }), swap(12, { amount_out: "9" })]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pool: "0xp1", coin_in: "0x2::sui::SUI", coin_out: "PT0x2::sui::SUI", count: 3, events: [3, 5, 12], amount_in: "30", amount_out: "24", price_before: 1, price_after: 1, price_change_pct: 0 });
    expect(rows[1]).toEqual(swap(9, { pool: "0xp2" }));
  });

  it("keeps each swap's price move when they differ, and an unknown amount stays unknown", () => {
    const [row] = foldSwaps([swap(1, { price_change_pct: -1 }), swap(2, { price_change_pct: -99.9, amount_out: null })]);
    expect(row).toMatchObject({ price_change_pcts: [-1, -99.9], amount_out: null, amount_in: "20" });
    expect(row).not.toHaveProperty("price_change_pct");
  });

  it("never folds opposite directions or different coins together", () => {
    expect(foldSwaps([swap(1), swap(2, { a_to_b: false }), swap(3, { coin_out: "0x2::coin::X" })])).toHaveLength(3);
  });

  it("never folds swaps whose direction and coins are unknown", () => {
    const unknown = { a_to_b: null, coin_in: null, coin_out: null };
    const rows = foldSwaps([swap(1, { ...unknown, amount_in: "1000000000000" }), swap(2, { ...unknown, amount_in: "3000000000" })]);
    expect(rows.map((r) => r.amount_in)).toEqual(["1000000000000", "3000000000"]);
  });
});
