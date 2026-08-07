import { describe, it, expect } from "vitest";
import { buildDeviationReport, type Candle } from "../src/utils/oracle-deviation.js";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

/** [openMs, open, high, low, close, volume] */
const candle = (i: number, close: number, volume = 100): Candle => [
  T0 + i * HOUR,
  close,
  close,
  close,
  close,
  volume,
];

const oracleFlat = (price: number) => () => ({ price, publishTime: 0 });

describe("buildDeviationReport", () => {
  it("reports zero deviation when oracle and market agree", () => {
    const r = buildDeviationReport([candle(0, 1)], oracleFlat(1), 1);
    expect(r.points[0].deviation_pct).toBe(0);
    expect(r.max_abs_deviation_pct).toBe(0);
    expect(r.flagged).toHaveLength(0);
  });

  it("signs deviation so direction is readable", () => {
    // Market above oracle is positive; below is negative.
    const above = buildDeviationReport([candle(0, 1.1)], oracleFlat(1), 1);
    expect(above.points[0].deviation_pct).toBeCloseTo(10, 4);

    const below = buildDeviationReport([candle(0, 0.9)], oracleFlat(1), 1);
    expect(below.points[0].deviation_pct).toBeCloseTo(-10, 4);
  });

  it("flags only points at or beyond the threshold", () => {
    const candles = [candle(0, 1.005), candle(1, 1.02), candle(2, 0.97)];
    const r = buildDeviationReport(candles, oracleFlat(1), 1);
    // 0.5% is under; 2% and -3% are over.
    expect(r.flagged.map((p) => p.market_price)).toEqual([1.02, 0.97]);
    expect(r.flagged_count ?? r.flagged.length).toBe(2);
  });

  it("finds the largest absolute deviation regardless of sign", () => {
    const candles = [candle(0, 1.02), candle(1, 0.94)];
    const r = buildDeviationReport(candles, oracleFlat(1), 1);
    expect(r.max_abs_deviation_pct).toBeCloseTo(6, 4);
    expect(r.max_deviation_at).toBe(new Date(T0 + HOUR).toISOString());
  });

  // The point of weighting: a big gap on a candle nobody traded is noise, and
  // treating it equally would hide a persistent bias on real volume.
  it("weights the mean by volume", () => {
    const candles = [candle(0, 1.10, 1), candle(1, 1.01, 999)];
    const r = buildDeviationReport(candles, oracleFlat(1), 1);
    // Unweighted mean would be ~5.5%; volume-weighted sits near 1%.
    expect(r.mean_deviation_pct).toBeLessThan(2);
    expect(r.mean_deviation_pct).toBeGreaterThan(0.9);
  });

  it("falls back to an unweighted mean when nothing traded", () => {
    const candles = [candle(0, 1.02, 0), candle(1, 1.04, 0)];
    const r = buildDeviationReport(candles, oracleFlat(1), 1);
    expect(r.mean_deviation_pct).toBeCloseTo(3, 4);
  });

  // A gap in oracle coverage during an incident is itself a finding, so these
  // points are kept with nulls rather than silently dropped.
  it("keeps candles that have no oracle price, as nulls", () => {
    const r = buildDeviationReport([candle(0, 1), candle(1, 1)], (ms) =>
      ms === T0 ? { price: 1, publishTime: 5 } : null, 1);
    expect(r.points).toHaveLength(2);
    expect(r.points[0].deviation_pct).toBe(0);
    expect(r.points[1].oracle_price).toBeNull();
    expect(r.points[1].deviation_pct).toBeNull();
  });

  it("returns null summaries when no candle has an oracle price", () => {
    const r = buildDeviationReport([candle(0, 1)], () => null, 1);
    expect(r.max_abs_deviation_pct).toBeNull();
    expect(r.mean_deviation_pct).toBeNull();
    expect(r.max_deviation_at).toBeNull();
    expect(r.flagged).toHaveLength(0);
  });

  // Bad oracle data must not masquerade as a 100% deviation, which would
  // outrank every real signal in the report.
  it("treats a non-positive oracle price as missing, not as total deviation", () => {
    const zero = buildDeviationReport([candle(0, 1)], oracleFlat(0), 1);
    expect(zero.points[0].deviation_pct).toBeNull();

    const negative = buildDeviationReport([candle(0, 1)], oracleFlat(-5), 1);
    expect(negative.points[0].deviation_pct).toBeNull();
  });

  it("carries the oracle publish time through for auditability", () => {
    const r = buildDeviationReport([candle(0, 1)], () => ({ price: 1, publishTime: 12345 }), 1);
    expect(r.points[0].oracle_publish_time).toBe(12345);
  });

  it("handles an empty candle series", () => {
    const r = buildDeviationReport([], oracleFlat(1), 1);
    expect(r.points).toEqual([]);
    expect(r.max_abs_deviation_pct).toBeNull();
  });
});
