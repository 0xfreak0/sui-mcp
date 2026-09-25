import { describe, it, expect } from "vitest";
import {
  decimalsForCoinType,
  dominantFlowUsd,
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

describe("dominantFlowUsd", () => {
  const atk = "0xattacker";
  const pool = "0xpool";

  it("sums multiple coins credited to the same recipient (drain origin)", () => {
    // Attacker receives SUI ($24.16M) + HASUI ($44.23M) in one tx.
    expect(
      dominantFlowUsd([
        { address: atk, usd: 24155583.53 },
        { address: atk, usd: 44228001.15 },
      ]),
    ).toBeCloseTo(68383584.68, 2);
  });

  it("does NOT double-count a swap's input+output legs (different addresses)", () => {
    // Actor receives $100 output; pool receives $100 input — max, not sum.
    expect(dominantFlowUsd([{ address: atk, usd: 100 }, { address: pool, usd: 100 }])).toBe(100);
    // The actor's own debit and credit are the same value, not twice it.
    expect(dominantFlowUsd([{ address: atk, usd: -100 }, { address: atk, usd: 99.5 }])).toBe(100);
  });

  it("values a plain transfer by what moved, not sender plus recipient", () => {
    expect(dominantFlowUsd([{ address: "0xsender", usd: -50.01 }, { address: "0xrecipient", usd: 50 }])).toBe(50.01);
  });

  it("values a bridge burn by what the sender sent, not by the fee its collector got", () => {
    // Nemo's CCTP exit 9ZzZ6C8m…: the attacker sent 100,000 USDC, 99,990 was
    // burned (no recipient on Sui) and a fee collector received 10 USDC.
    expect(
      dominantFlowUsd([
        { address: atk, usd: -99993.4 },
        { address: atk, usd: -1.21 },
        { address: "0xfee", usd: 10 },
      ]),
    ).toBeCloseTo(99994.61, 2);
  });

  it("returns 0 when nothing priced moved", () => {
    expect(dominantFlowUsd([])).toBe(0);
    expect(dominantFlowUsd([{ address: atk, usd: 0 }])).toBe(0);
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
