import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkpointChain } from "./helpers/service-shapes.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { checkpointBracket, resolveWindow, toFilterBound } = await import("../src/utils/checkpoint-time.js");

const T0 = Date.parse("2023-04-13T00:00:00Z");
const LATEST = 5_000_000;

/**
 * Uneven production: a slow era (1s per checkpoint) then a fast one (200ms),
 * and a run of checkpoints sharing one timestamp. Interpolation across the
 * change lands far from the target, which is what the bisection fallback is for.
 */
const uneven = (seq: number) => {
  if (seq <= 1_000_000) return T0 + seq * 1000;
  const base = T0 + 1_000_000 * 1000;
  const fast = seq - 1_000_000;
  // Checkpoints 2,000,000–2,000,009 share a stamp.
  if (seq >= 2_000_000 && seq < 2_000_010) return base + (2_000_000 - 1_000_000) * 200;
  return base + fast * 200;
};

beforeEach(() => {
  mockGqlQuery.mockReset();
  const chain = checkpointChain(LATEST, uneven);
  mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => chain(q, v));
});

describe("checkpointBracket", () => {
  it("returns the adjacent checkpoints either side of a time", async () => {
    for (const target of [T0 + 12_345_678, uneven(3_210_987) + 37, uneven(1_000_000) + 1]) {
      const b = await checkpointBracket(target);
      expect(b.before && b.atOrAfter).toBeTruthy();
      expect(b.atOrAfter!.seq - b.before!.seq).toBe(1);
      expect(b.before!.ms).toBeLessThan(target);
      expect(b.atOrAfter!.ms).toBeGreaterThanOrEqual(target);
    }
  });

  it("puts a shared timestamp wholly after the edge, so no checkpoint at that time is dropped", async () => {
    const b = await checkpointBracket(uneven(2_000_000));
    expect(b.atOrAfter!.seq).toBe(2_000_000);
    expect(b.before!.seq).toBe(1_999_999);
  });

  it("has nothing after a time later than the latest checkpoint", async () => {
    const b = await checkpointBracket(uneven(LATEST) + 60_000);
    expect(b.before!.seq).toBe(LATEST);
    expect(b.atOrAfter).toBeNull();
  });
});

describe("toFilterBound", () => {
  it("keeps a transaction stamped exactly at either edge inside the window", async () => {
    const t = new Date(uneven(3_000_000)).toISOString();
    const after = await toFilterBound(t, "after");
    const before = await toFilterBound(t, "before");
    // afterCheckpoint and beforeCheckpoint are exclusive: 3,000,000 is inside both.
    expect(after!.checkpoint).toBe(2_999_999);
    expect(before!.checkpoint).toBe(3_000_001);
  });

  it("passes a checkpoint number through without a request", async () => {
    expect(await toFilterBound("148148900", "after")).toEqual({ checkpoint: 148148900, resolved_from: "checkpoint" });
    expect(await toFilterBound(148148900, "before")).toEqual({ checkpoint: 148148900, resolved_from: "checkpoint" });
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("leaves a window end past the latest checkpoint unbounded", async () => {
    const b = await toFilterBound(new Date(uneven(LATEST) + 60_000).toISOString(), "before");
    expect(b!.checkpoint).toBeNull();
  });
});

describe("resolveWindow", () => {
  it("rejects an unparseable bound before making any request", async () => {
    await expect(resolveWindow("yesterday", undefined)).rejects.toThrow(/Could not parse 'yesterday'/);
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });
});
