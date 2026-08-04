import { describe, it, expect } from "vitest";
import {
  decimalsForCoinType,
  formatUsd,
  symbolOf,
  toHumanAmount,
  usdValue,
} from "../src/utils/valuation.js";

describe("symbolOf / decimalsForCoinType", () => {
  it("extracts the symbol and known decimals", () => {
    expect(symbolOf("0x2::sui::SUI")).toBe("SUI");
    expect(decimalsForCoinType("0x2::sui::SUI")).toBe(9);
    expect(decimalsForCoinType("0xabc::coin::USDC")).toBe(6);
  });
  it("falls back to 9 decimals for unknown coins", () => {
    expect(decimalsForCoinType("0xdead::weird::ZZZ")).toBe(9);
  });
});

describe("toHumanAmount", () => {
  it("scales raw amounts by decimals and drops sign", () => {
    expect(toHumanAmount("1000000000", 9)).toBe(1); // 1 SUI
    expect(toHumanAmount("-2500000", 6)).toBe(2.5); // 2.5 USDC, abs
  });
});

describe("usdValue", () => {
  it("multiplies human amount by price", () => {
    // 5 SUI @ $2 = $10
    expect(usdValue("5000000000", 9, 2)).toBeCloseTo(10, 6);
  });
  it("returns 0 when price is unknown", () => {
    expect(usdValue("5000000000", 9, null)).toBe(0);
    expect(usdValue("5000000000", 9, undefined)).toBe(0);
    expect(usdValue("5000000000", 9, NaN)).toBe(0);
  });
  it("uses magnitude regardless of sign", () => {
    expect(usdValue("-5000000000", 9, 2)).toBeCloseTo(10, 6);
  });
});

describe("formatUsd", () => {
  it("formats across magnitudes", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(4200)).toBe("$4.2K");
    expect(formatUsd(3_100_000)).toBe("$3.1M");
    expect(formatUsd(1_200_000_000)).toBe("$1.2B");
  });
});
