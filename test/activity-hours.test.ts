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
    // Every day and most hours — the rate matters as much as the flatness, and
    // this fixture originally ran at 1.3 a day, which is a person who uses a
    // wallet occasionally rather than a script.
    const flat: string[] = [];
    for (let d = 0; d < 300; d++) for (const h of [1, 5, 9, 13, 17, 21]) flat.push(iso(d, h));
    const r = activityHours(flat)!;
    expect(r.concentration).toBeLessThan(0.35);
    expect(r.always_on).toBe(true);
    expect(r.automation_indicated).toBe(true);
    expect(r.utc_offset_estimate).toBeNull();
    expect(r.reading).toContain("automated");
  });

  it("does NOT call a rarely-used wallet automated", () => {
    // Found on a real mainnet wallet: 120 transactions over 292 days, 0.4 a
    // day, flat clock — and it was labelled automated. It could not have looked
    // otherwise. A 24/7 script and an occasional person produce the same R, and
    // at that rate the flatness carries no information at all.
    const sparse: string[] = [];
    for (let i = 0; i < 120; i++) sparse.push(iso(Math.floor((i * 292) / 120), (i * 7) % 24));
    const r = activityHours(sparse)!;
    expect(r.concentration).toBeLessThan(0.35);
    expect(r.transactions_per_day!).toBeLessThan(3);
    expect(r.always_on).toBe(false);
    expect(r.automation_indicated).toBe(false);
    expect(r.reading).toContain("could not look otherwise");
  });

  it("still calls a BUSY flat wallet automated", () => {
    // The distinction is rate: at this volume a person keeping ordinary hours
    // would have left a shape, so its absence means something.
    const bot: string[] = [];
    for (let d = 0; d < 60; d++) for (let h = 0; h < 24; h += 2) bot.push(iso(d, h));
    const r = activityHours(bot)!;
    expect(r.transactions_per_day!).toBeGreaterThan(3);
    expect(r.always_on).toBe(true);
    expect(r.automation_indicated).toBe(true);
  });

  it("names the scheduled-job alternative when one hour holds most activity", () => {
    // A person's day spreads over several hours. Nearly everything inside one
    // hour fits a cron line equally well, and a scheduled job has no timezone —
    // a reader given only a region will not think of that themselves.
    const tight: string[] = [];
    for (let d = 0; d < 38; d++) {
      for (let k = 0; k < 6; k++) tight.push(iso(d, 19));
      tight.push(iso(d, 16));
      tight.push(iso(d, 0));
    }
    const r = activityHours(tight)!;
    expect(r.utc_offset_estimate).not.toBeNull();
    expect(r.reading).toContain("cron line");
  });

  it("does not cry cron over an ordinary working day", () => {
    const spread: string[] = [];
    for (let d = 0; d < 40; d++) for (const h of [13, 15, 17, 19]) spread.push(iso(d, h));
    const r = activityHours(spread)!;
    expect(r.utc_offset_estimate).not.toBeNull();
    expect(r.reading).not.toContain("cron line");
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
