import { describe, it, expect } from "vitest";

/**
 * The portfolio total sums `value_usd`, and an unpriced holding contributes
 * nothing. Measured on three mainnet wallets: 1 of 3, 46 of 50 and 5 of 15
 * holdings had no price. The middle one reported $1.86 for a wallet holding
 * fifty coins — a number that reads as a portfolio value rather than as four
 * coins out of fifty.
 *
 * These pin the arithmetic and the wording independently of the network.
 */
type Holding = { value_usd?: number | null; verified?: boolean };

const summarize = (holdings: Holding[]) => {
  const priced = holdings.filter((h) => h.value_usd != null);
  const unpriced = holdings.length - priced.length;
  const unverifiedUnpriced = holdings.filter(
    (h) => h.value_usd == null && h.verified === false,
  ).length;
  return {
    total: Math.round(priced.reduce((s, h) => s + (h.value_usd ?? 0), 0) * 100) / 100,
    priced: priced.length,
    unpriced,
    unverifiedUnpriced,
    verified: holdings.filter((h) => h.verified === true).length,
  };
};

describe("wallet overview totals", () => {
  it("sums only what could be priced", () => {
    const r = summarize([
      { value_usd: 1.45, verified: true },
      { value_usd: 0.41, verified: true },
      { value_usd: null, verified: false },
    ]);
    expect(r.total).toBe(1.86);
    expect(r.priced).toBe(2);
    expect(r.unpriced).toBe(1);
  });

  /** An unpriced holding must never be counted as zero-valued. */
  it("does not let a missing price masquerade as no value", () => {
    const withUnpriced = summarize([{ value_usd: 10 }, { value_usd: null }]);
    const withoutIt = summarize([{ value_usd: 10 }]);
    expect(withUnpriced.total).toBe(withoutIt.total);
    // Same number, but the counts make the difference visible.
    expect(withUnpriced.unpriced).toBe(1);
    expect(withoutIt.unpriced).toBe(0);
  });

  /**
   * No market price AND nothing vouching for the coin is the usual shape of a
   * spam or impersonation token — the same reasoning `pickFundingTx` uses when
   * it treats an unpriced coin as spam at any size.
   */
  it("counts holdings that are both unpriced and unverified", () => {
    const r = summarize([
      { value_usd: 1, verified: true },
      { value_usd: null, verified: false },
      { value_usd: null, verified: false },
      { value_usd: null, verified: true },
    ]);
    expect(r.unpriced).toBe(3);
    // The verified-but-unpriced one is a different case: possibly newly listed.
    expect(r.unverifiedUnpriced).toBe(2);
    expect(r.verified).toBe(2);
  });

  it("reports a fully priced wallet without qualification", () => {
    const r = summarize([{ value_usd: 5, verified: true }]);
    expect(r.unpriced).toBe(0);
    expect(r.unverifiedUnpriced).toBe(0);
  });
});
