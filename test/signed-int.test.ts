import { describe, it, expect } from "vitest";
import { signedFieldReadings, signedReadings } from "../src/utils/signed-int.js";

const U256 = 2n ** 256n;

describe("signedReadings", () => {
  it("reads the top half of the u256 range only as a negative, and a narrower top half both ways", () => {
    expect(signedReadings(U256 - 10n ** 23n)).toEqual([-(10n ** 23n)]);
    expect(signedReadings(2n ** 64n - 1n)).toEqual([2n ** 64n - 1n, -1n]);
    expect(signedReadings(77038725000000000000n)).toEqual([77038725000000000000n]);
  });
});

describe("signedFieldReadings", () => {
  it("reads every u256 two's complement in decoded JSON by path, and nothing below the u256 top half", () => {
    // Aftermath Perpetuals' FilledMakerOrders and FilledTakerOrder fee fields.
    const json = {
      taker_fees: "34667426250000000",
      integrator_taker_fees: (U256 - 7703872500000000000000000n).toString(),
      events: [{ fees: (U256 - 2887500000000000000n).toString(), filled_size: "750000" }],
      wrapping_u128: (2n ** 128n - 5n).toString(),
    };
    expect(signedFieldReadings(json)).toEqual({ integrator_taker_fees: "-7703872500000000000000000", "events.0.fees": "-2887500000000000000" });
    expect(signedFieldReadings({ amount: "5" })).toBeNull();
  });
});
