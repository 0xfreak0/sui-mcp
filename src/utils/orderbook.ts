/**
 * Derived metrics for a central limit order book.
 *
 * The raw book is just two price ladders; what an analyst actually wants is the
 * spread, the mid, and how lopsided the resting liquidity is. Kept pure and
 * separate from the indexer client so it can be tested without network access.
 */

export interface BookSummary {
  best_bid: number | null;
  best_ask: number | null;
  /** Absolute quote-currency spread, or null if either side is empty. */
  spread: number | null;
  /** Spread in basis points of the mid — comparable across price levels. */
  spread_bps: number | null;
  mid: number | null;
  /** Total base quantity resting on each side of the returned depth. */
  bid_depth: number;
  ask_depth: number;
  /**
   * (bids - asks) / (bids + asks) over the returned depth. Ranges -1 to 1;
   * positive means more resting bid size. Only meaningful relative to the
   * `depth` requested, since it summarises the levels fetched, not the book.
   */
  imbalance: number | null;
}

type Level = [string, string];

const sumSize = (levels: Level[]) =>
  levels.reduce((acc, [, qty]) => acc + (Number(qty) || 0), 0);

export function summarizeBook(bids: Level[], asks: Level[]): BookSummary {
  const bestBid = bids.length ? Number(bids[0][0]) : null;
  const bestAsk = asks.length ? Number(asks[0][0]) : null;

  const bidDepth = sumSize(bids);
  const askDepth = sumSize(asks);
  const total = bidDepth + askDepth;

  // A one-sided book has no mid and no spread; reporting 0 would read as
  // "perfectly tight" rather than "there is nothing on one side".
  const bothSides = bestBid !== null && bestAsk !== null;
  const mid = bothSides ? (bestBid + bestAsk) / 2 : null;
  const spread = bothSides ? bestAsk - bestBid : null;

  return {
    best_bid: bestBid,
    best_ask: bestAsk,
    spread,
    spread_bps: spread !== null && mid ? (spread / mid) * 10_000 : null,
    mid,
    bid_depth: bidDepth,
    ask_depth: askDepth,
    imbalance: total > 0 ? (bidDepth - askDepth) / total : null,
  };
}

/** Round for display without pretending to more precision than a price has. */
export function round(value: number | null, dp = 6): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(dp));
}
