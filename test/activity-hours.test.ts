import { describe, it, expect } from "vitest";
import { activityHours } from "../src/utils/activity-hours.js";

/** `n` timestamps at `hour` UTC, spread one per day so the span is real. */
function at(hour: number, n: number, dayOffset = 0): string[] {
  return Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1 + dayOffset + i, hour, 30)).toISOString(),
  );
}

describe("activityHours", () => {
  it("refuses a reading when the sample is thin", () => {
    const r = activityHours(at(12, 10))!;
    expect(r.utc_offset_estimate).toBeNull();
    expect(r.reading).toContain("Not enough");
  });

  it("refuses a reading when everything happened in one day", () => {
    // 11 of 14 sampled active wallets did 500 transactions inside a day. A
    // burst has no daily rhythm to read, and reporting one would be invention.
    const sameDay = Array.from({ length: 200 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 1, i % 24, 0)).toISOString(),
    );
    const r = activityHours(sameDay)!;
    expect(r.span_days).toBeLessThan(7);
    expect(r.utc_offset_estimate).toBeNull();
    expect(r.reading).toContain("Not enough");
  });

  it("calls an even distribution automation rather than inventing a timezone", () => {
    // Two of three long-lived wallets measured at ~30% quiet share against a
    // 33% flat baseline. That is no rhythm, and saying so is the finding.
    const flat: string[] = [];
    for (let d = 0; d < 30; d++) for (let h = 0; h < 24; h += 2) flat.push(...at(h, 1, d));
    const r = activityHours(flat)!;
    expect(r.utc_offset_estimate).toBeNull();
    expect(r.reading).toContain("automation");
    expect(r.quiet_share).toBeGreaterThan(0.2);
  });

  it("estimates an offset when the gap is real, and hedges it", () => {
    // Active 12:00-20:00 UTC, silent otherwise: a pronounced gap centred on
    // 04:00 UTC, so local 03:00 sits about UTC-1.
    const busy: string[] = [];
    for (let d = 0; d < 40; d++) for (const h of [12, 14, 16, 18, 20]) busy.push(...at(h, 1, d));
    const r = activityHours(busy)!;
    expect(r.utc_offset_estimate).not.toBeNull();
    expect(r.quiet_share).toBeLessThan(0.2);
    // The claim is bounded on purpose: a longitude, not a country.
    expect(r.reading).toContain("LONGITUDE");
    expect(r.reading).toContain("Corroborate");
  });

  it("skips unparseable timestamps rather than counting them at midnight", () => {
    // Date.parse of junk is NaN; treating it as 0 would invent activity at
    // 00:00 UTC and drag every reading toward the same answer.
    const r = activityHours([...at(9, 60), null, undefined, "not a date"])!;
    expect(r.sample_size).toBe(60);
    expect(r.histogram[0]).toBe(0);
    expect(r.histogram[9]).toBe(60);
  });

  it("returns null when there is nothing to read", () => {
    expect(activityHours([])).toBeNull();
    expect(activityHours([null, "nonsense"])).toBeNull();
  });

  it("reports the histogram even when it refuses a reading", () => {
    // The distribution is still evidence; only the inference is withheld.
    const r = activityHours(at(3, 12))!;
    expect(r.histogram[3]).toBe(12);
    expect(r.utc_offset_estimate).toBeNull();
  });
});
