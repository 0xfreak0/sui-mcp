import { describe, it, expect } from "vitest";
import { activityHours } from "../src/utils/activity-hours.js";

const iso = (day: number, hour: number) => new Date(Date.UTC(2026, 0, 1 + day, hour, 30)).toISOString();
/** `n` timestamps at one hour, one per day, so the span is real. */
const at = (hour: number, n: number) => Array.from({ length: n }, (_, i) => iso(i, hour));

describe("activityHours", () => {
  it("flags a burst as automated on RATE, without reading the clock", () => {
    // 17 of 20 sampled active senders did 400 transactions inside a single day.
    // A burst has no daily rhythm, so the circadian test cannot see it — it
    // would otherwise be dismissed as "not enough data" when it is in fact the
    // clearest automation signal available.
    const burst = Array.from({ length: 400 }, (_, i) => iso(0, (i % 6) + 9));
    const r = activityHours(burst)!;
    expect(r.transactions_per_day).toBeGreaterThan(200);
    expect(r.automation_indicated).toBe(true);
    expect(r.always_on).toBe(false); // it is fast, not flat
    expect(r.utc_offset_estimate).toBeNull();
    expect(r.reading).toContain("No person does that by hand");
  });

  it("flags a flat clock over a long span as automated", () => {
    // The other automation population: measured at R 0.03-0.06 over ~298 days.
    const flat: string[] = [];
    for (let d = 0; d < 300; d += 3) for (const h of [2, 7, 13, 19]) flat.push(iso(d, h));
    const r = activityHours(flat)!;
    expect(r.concentration).toBeLessThan(0.35);
    expect(r.always_on).toBe(true);
    expect(r.automation_indicated).toBe(true);
    expect(r.utc_offset_estimate).toBeNull();
    expect(r.reading).toContain("automated");
  });

  it("estimates a region when a real rhythm is present, and hedges it", () => {
    const human: string[] = [];
    for (let d = 0; d < 60; d++) for (const h of [13, 15, 17, 19]) human.push(iso(d, h));
    const r = activityHours(human)!;
    expect(r.concentration).toBeGreaterThan(0.35);
    expect(r.automation_indicated).toBe(false);
    expect(r.utc_offset_estimate).not.toBeNull();
    expect(r.region_estimate).toBeTruthy();
    // A region, never a city, and the innocent explanation is named.
    expect(r.reading).toContain("REGION, not a city");
    expect(r.reading).toContain("share a timezone");
  });

  it("handles the wrap at midnight, which a quiet-window scan could not", () => {
    // Active 22:00-02:00 UTC. Hours 23 and 0 are adjacent on a circle; a linear
    // scan treats them as opposite ends and lands on the wrong peak.
    const night: string[] = [];
    for (let d = 0; d < 60; d++) for (const h of [22, 23, 0, 1]) night.push(iso(d, h));
    const r = activityHours(night)!;
    expect(r.concentration).toBeGreaterThan(0.35);
    // Peak sits near midnight, not near noon.
    expect(r.peak_hour_utc! > 22 || r.peak_hour_utc! < 2).toBe(true);
  });

  it("refuses a reading when the sample is thin or brief", () => {
    expect(activityHours(at(12, 10))!.utc_offset_estimate).toBeNull();
    const oneDay = Array.from({ length: 40 }, (_, i) => iso(0, i % 24));
    const r = activityHours(oneDay)!;
    expect(r.utc_offset_estimate).toBeNull();
    expect(r.always_on).toBe(false); // absence of evidence, not evidence of automation
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
});
