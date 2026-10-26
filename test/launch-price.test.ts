import { describe, expect, it } from "vitest";
import { suiAtLaunchPrice } from "../src/utils/launch-price.js";

const Q64 = 1n << 64n;

describe("launch-token dust valuation", () => {
  it("values transferred tokens using the curve's raw SUI/token reserves", () => {
    expect(suiAtLaunchPrice(1_000_000n, { sui_reserve: "2000000000", token_reserve: "1000000" }, "curve", null)).toBe(2_000_000_000n);
    expect(suiAtLaunchPrice(1n, { sui_reserve: "0", token_reserve: "1000000" }, "curve", null)).toBeNull();
  });

  it("uses the graduated pool's on-chain Q64.64 price for either coin order", () => {
    expect(suiAtLaunchPrice(100n, { current_sqrt_price: (2n * Q64).toString() }, "pool", true)).toBe(400n);
    expect(suiAtLaunchPrice(400n, { current_sqrt_price: (2n * Q64).toString() }, "pool", false)).toBe(100n);
    expect(suiAtLaunchPrice(10n, { coin_a: "10", coin_b: "50" }, "pool", true)).toBe(50n);
    expect(suiAtLaunchPrice(10n, {}, "pool", null)).toBeNull();
  });
});
