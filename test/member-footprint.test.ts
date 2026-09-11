import { describe, it, expect } from "vitest";
import { summarizeFootprints, type MemberFootprint } from "../src/utils/member-footprint.js";

const fp = (n: number, active: number): MemberFootprint[] =>
  Array.from({ length: n }, (_, i) => ({
    address: `0xm${i}`,
    has_sent: i < active,
    has_activity: i < active,
  }));

/**
 * Measured over four mainnet governance multisigs: 13 of 19 members had no
 * on-chain footprint at all, and one 3-of-6 had none whatsoever. Cold keys are
 * not missing data — they are what deliberate key hygiene looks like, and they
 * bound what else can be asked.
 */
describe("summarizeFootprints", () => {
  it("reads a committee of cold keys as hygiene, not as a gap", () => {
    const s = summarizeFootprints(fp(6, 0));
    expect(s.shape).toBe("all_cold");
    expect(s.note).toMatch(/deliberate key hygiene/i);
    expect(s.note).not.toMatch(/suspicious/i);
  });

  /**
   * The inverted case. Keys that are also everyday wallets carry every exposure
   * their owner's browsing does, and are the shape one operator's alts produce.
   */
  it("flags a committee of active wallets as broader exposure", () => {
    const s = summarizeFootprints(fp(3, 3));
    expect(s.shape).toBe("all_active");
    expect(s.note).toMatch(/everyday wallet|active wallets/i);
    expect(s.note).toMatch(/independent parties/i);
  });

  it("points at the active members in a mixed committee", () => {
    const s = summarizeFootprints(fp(7, 3));
    expect(s.shape).toBe("mixed");
    expect(s.cold_members).toBe(4);
    expect(s.active_members).toBe(3);
  });

  /**
   * Every relational signal compares one address against another, so one active
   * member has nothing to be compared with. Saying "no two members share a
   * funder" about addresses with no transactions would manufacture a finding
   * from an absence.
   */
  it("refuses independence analysis below two active members", () => {
    expect(summarizeFootprints(fp(6, 0)).independence_analysable).toBe(false);
    expect(summarizeFootprints(fp(3, 1)).independence_analysable).toBe(false);
    expect(summarizeFootprints(fp(3, 2)).independence_analysable).toBe(true);
  });

  it("says why independence could not be assessed", () => {
    expect(summarizeFootprints(fp(6, 0)).note).toMatch(/none have any/i);
    expect(summarizeFootprints(fp(3, 1)).note).toMatch(/only one does/i);
    expect(summarizeFootprints(fp(3, 2)).note).not.toMatch(/cannot be assessed/i);
  });

  it("reads singular counts correctly", () => {
    expect(summarizeFootprints(fp(3, 1)).note).toContain("1 is also an active wallet");
  });

  it("claims nothing with no members", () => {
    const s = summarizeFootprints([]);
    expect(s.shape).toBe("unknown");
    expect(s.independence_analysable).toBe(false);
  });
});
