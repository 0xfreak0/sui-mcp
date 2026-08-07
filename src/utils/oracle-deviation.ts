/**
 * Compare an oracle's reported price against the price a market actually
 * traded at.
 *
 * Lending protocols liquidate on oracle prices. When the oracle and the book
 * disagree, positions are valued at a number nobody could have traded at — the
 * signature of a stale feed during volatility, a thin-liquidity manipulation
 * window, or an oracle being fed a price the market never printed. Establishing
 * that divergence, and exactly when it started and stopped, is usually the
 * first question in a liquidation post-mortem.
 *
 * Pure functions: the callers supply both series, so this is testable without
 * touching Pyth or the DeepBook indexer.
 */

/** One DeepBook candle: `[openTimeMs, open, high, low, close, volume]`. */
export type Candle = [number, number, number, number, number, number];

export interface DeviationPoint {
  /** Candle open time, ISO 8601. */
  time: string;
  timestamp_ms: number;
  /** Close price of the candle — what the market last traded at. */
  market_price: number;
  /** Oracle price nearest this candle, or null if none was available. */
  oracle_price: number | null;
  /** Unix seconds of the oracle update actually used. */
  oracle_publish_time: number | null;
  /** Signed percentage: positive means the market traded above the oracle. */
  deviation_pct: number | null;
  /** Base volume traded in the candle. Divergence on no volume is noise. */
  volume: number;
}

export interface DeviationReport {
  points: DeviationPoint[];
  /** Largest absolute deviation across the window, with its point. */
  max_abs_deviation_pct: number | null;
  max_deviation_at: string | null;
  /** Volume-weighted mean signed deviation — a persistent bias, not a spike. */
  mean_deviation_pct: number | null;
  /** Points whose absolute deviation exceeded the caller's threshold. */
  flagged: DeviationPoint[];
}

/**
 * Join a candle series to oracle prices and compute per-candle divergence.
 *
 * `oracleAt` is a lookup rather than a series because oracle updates do not
 * land on candle boundaries; the caller decides how to pick the nearest one.
 */
export function buildDeviationReport(
  candles: Candle[],
  oracleAt: (timestampMs: number) => { price: number; publishTime: number } | null,
  thresholdPct: number,
): DeviationReport {
  const points: DeviationPoint[] = candles.map((c) => {
    const [openMs, , , , close, volume] = c;
    const oracle = oracleAt(openMs);
    // Guard the divide: a zero or negative oracle price is bad data, not a
    // 100% deviation, and reporting it as one would bury the real signal.
    const deviation =
      oracle && oracle.price > 0 ? ((close - oracle.price) / oracle.price) * 100 : null;

    return {
      time: new Date(openMs).toISOString(),
      timestamp_ms: openMs,
      market_price: close,
      oracle_price: oracle?.price ?? null,
      oracle_publish_time: oracle?.publishTime ?? null,
      deviation_pct: deviation === null ? null : Number(deviation.toFixed(4)),
      volume,
    };
  });

  const withDeviation = points.filter(
    (p): p is DeviationPoint & { deviation_pct: number } => p.deviation_pct !== null,
  );

  let maxAbs: number | null = null;
  let maxAt: string | null = null;
  for (const p of withDeviation) {
    if (maxAbs === null || Math.abs(p.deviation_pct) > maxAbs) {
      maxAbs = Math.abs(p.deviation_pct);
      maxAt = p.time;
    }
  }

  // Volume-weighted: a 5% gap on a candle that traded nothing says less than a
  // 0.5% gap on the day's heaviest volume.
  const totalVolume = withDeviation.reduce((a, p) => a + p.volume, 0);
  const mean =
    withDeviation.length === 0
      ? null
      : totalVolume > 0
        ? withDeviation.reduce((a, p) => a + p.deviation_pct * p.volume, 0) / totalVolume
        : withDeviation.reduce((a, p) => a + p.deviation_pct, 0) / withDeviation.length;

  return {
    points,
    max_abs_deviation_pct: maxAbs === null ? null : Number(maxAbs.toFixed(4)),
    max_deviation_at: maxAt,
    mean_deviation_pct: mean === null ? null : Number(mean.toFixed(4)),
    flagged: withDeviation.filter((p) => Math.abs(p.deviation_pct) >= thresholdPct),
  };
}
