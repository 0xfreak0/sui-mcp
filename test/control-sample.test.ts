import { describe, it, expect } from "vitest";
import { sampleControl } from "../src/utils/control-sample.js";

const pool = (n: number) => Array.from({ length: n }, (_, i) => `0x${i}`);

describe("sampleControl", () => {
  it("draws the requested number of distinct addresses", () => {
    const r = sampleControl(pool(100), 25, { seed: 1 });
    expect(r.addresses).toHaveLength(25);
    expect(new Set(r.addresses).size).toBe(25);
    expect(r.undersampled).toBe(false);
  });

  it("only ever returns members of the pool", () => {
    const p = pool(50);
    const r = sampleControl(p, 10, { seed: 7 });
    for (const a of r.addresses) expect(p).toContain(a);
  });

  // A control that cannot be redrawn cannot be checked by whoever reads the
  // report, which is most of the reason to have one.
  it("is reproducible for a given seed", () => {
    const a = sampleControl(pool(200), 20, { seed: 42 });
    const b = sampleControl(pool(200), 20, { seed: 42 });
    expect(a.addresses).toEqual(b.addresses);
  });

  it("gives a different draw for a different seed", () => {
    const a = sampleControl(pool(200), 20, { seed: 1 });
    const b = sampleControl(pool(200), 20, { seed: 2 });
    expect(a.addresses).not.toEqual(b.addresses);
  });

  // Contaminating the control with the cohort is the one mistake that makes the
  // comparison actively misleading rather than merely weak.
  it("excludes the cohort under test", () => {
    const cohort = ["0x1", "0x2", "0x3"];
    const r = sampleControl(pool(20), 17, { exclude: cohort, seed: 3 });
    for (const c of cohort) expect(r.addresses).not.toContain(c);
    expect(r.population_size).toBe(17);
  });

  // A pool built from event senders repeats an address once per event. Without
  // de-duplication a busy wallet is drawn far more often than a quiet one,
  // which is exactly the activity bias random sampling is meant to remove.
  it("de-duplicates the pool so activity does not raise selection odds", () => {
    const skewed = [...Array(500).fill("0xbusy"), "0xquiet1", "0xquiet2"];
    const r = sampleControl(skewed, 3, { seed: 5 });
    expect(r.population_size).toBe(3);
    expect(r.addresses.sort()).toEqual(["0xbusy", "0xquiet1", "0xquiet2"]);
  });

  it("reports undersampling rather than silently returning fewer", () => {
    const r = sampleControl(pool(5), 25, { seed: 1 });
    expect(r.addresses).toHaveLength(5);
    expect(r.requested).toBe(25);
    expect(r.population_size).toBe(5);
    expect(r.undersampled).toBe(true);
  });

  it("handles an empty pool", () => {
    const r = sampleControl([], 10, { seed: 1 });
    expect(r.addresses).toEqual([]);
    expect(r.undersampled).toBe(true);
  });

  it("handles a pool fully consumed by exclusions", () => {
    const r = sampleControl(["0xa", "0xb"], 5, { exclude: ["0xa", "0xb"], seed: 1 });
    expect(r.addresses).toEqual([]);
    expect(r.population_size).toBe(0);
  });

  it("marks an unseeded draw as such rather than inventing a seed", () => {
    expect(sampleControl(pool(10), 3).seed).toBeNull();
  });

  // Bias check: over many seeds every member of a small pool should appear.
  // A shuffle that favoured one end would leave some never drawn.
  it("draws across the whole pool rather than favouring one end", () => {
    const seen = new Set<string>();
    for (let s = 0; s < 200; s++) {
      for (const a of sampleControl(pool(10), 2, { seed: s }).addresses) seen.add(a);
    }
    expect(seen.size).toBe(10);
  });
});
