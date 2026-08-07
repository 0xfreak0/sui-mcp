import { describe, it, expect } from "vitest";
import { summarizeBook, round } from "../src/utils/orderbook.js";

describe("summarizeBook", () => {
  // Shape matches the indexer: [price, quantity] strings, best price first.
  const bids: [string, string][] = [
    ["0.67324", "617.1"],
    ["0.67318", "1515.3"],
  ];
  const asks: [string, string][] = [
    ["0.67347", "360"],
    ["0.6735", "240"],
  ];

  it("takes best bid and ask from the top of each ladder", () => {
    const s = summarizeBook(bids, asks);
    expect(s.best_bid).toBe(0.67324);
    expect(s.best_ask).toBe(0.67347);
  });

  it("computes spread and expresses it in basis points of the mid", () => {
    const s = summarizeBook(bids, asks);
    expect(s.spread).toBeCloseTo(0.00023, 8);
    expect(s.mid).toBeCloseTo(0.673355, 8);
    // 0.00023 / 0.673355 * 10000 ≈ 3.42 bps
    expect(s.spread_bps).toBeCloseTo(3.416, 2);
  });

  it("sums depth across all returned levels, not just the top", () => {
    const s = summarizeBook(bids, asks);
    expect(s.bid_depth).toBeCloseTo(2132.4, 6);
    expect(s.ask_depth).toBe(600);
  });

  it("reports imbalance as a signed ratio", () => {
    const s = summarizeBook(bids, asks);
    // Far more resting bid size, so strongly positive.
    expect(s.imbalance).toBeGreaterThan(0.5);
    expect(s.imbalance).toBeLessThanOrEqual(1);
  });

  it("gives imbalance 0 for a balanced book", () => {
    const s = summarizeBook([["1", "100"]], [["2", "100"]]);
    expect(s.imbalance).toBe(0);
  });

  // A one-sided book is a real state during volatility. Reporting spread 0
  // would read as "perfectly tight" rather than "nothing is offered".
  it("returns nulls rather than zeros when one side is empty", () => {
    const noAsks = summarizeBook(bids, []);
    expect(noAsks.best_ask).toBeNull();
    expect(noAsks.spread).toBeNull();
    expect(noAsks.spread_bps).toBeNull();
    expect(noAsks.mid).toBeNull();
    expect(noAsks.bid_depth).toBeCloseTo(2132.4, 6);
    // Depth is still known on the side that exists, so imbalance is defined.
    expect(noAsks.imbalance).toBe(1);
  });

  it("handles a completely empty book", () => {
    const s = summarizeBook([], []);
    expect(s.best_bid).toBeNull();
    expect(s.best_ask).toBeNull();
    expect(s.bid_depth).toBe(0);
    expect(s.imbalance).toBeNull();
  });

  it("treats unparseable quantities as zero rather than NaN", () => {
    const s = summarizeBook([["1", "abc"]], [["2", "10"]]);
    expect(s.bid_depth).toBe(0);
    expect(Number.isNaN(s.imbalance)).toBe(false);
  });
});

describe("round", () => {
  it("rounds to the requested precision", () => {
    expect(round(3.14159265, 4)).toBe(3.1416);
  });
  it("passes through null and non-finite values", () => {
    expect(round(null)).toBeNull();
    expect(round(Infinity)).toBeNull();
    expect(round(NaN)).toBeNull();
  });
});
