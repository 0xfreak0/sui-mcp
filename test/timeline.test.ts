import { describe, it, expect } from "vitest";
import { mergeTimelineEntries, parseTimeBound, type TimelineEntry } from "../src/utils/timeline.js";

function entry(digest: string, checkpoint: number | null, timestamp: string | null, involved: string[]): TimelineEntry {
  return { digest, checkpoint, timestamp, sender: null, status: "success", protocols: [], actions: [], token_flow: [], involved };
}

describe("parseTimeBound", () => {
  it("treats a bare integer as a checkpoint", () => {
    expect(parseTimeBound("78516493")).toEqual({ checkpoint: 78516493 });
  });
  it("treats an ISO date as a millisecond bound", () => {
    expect(parseTimeBound("2024-11-11T00:00:00Z")).toEqual({ ms: Date.parse("2024-11-11T00:00:00Z") });
  });
  it("returns empty for undefined / garbage", () => {
    expect(parseTimeBound(undefined)).toEqual({});
    expect(parseTimeBound("not-a-date")).toEqual({});
  });
});

describe("mergeTimelineEntries", () => {
  it("orders by checkpoint ascending", () => {
    const merged = mergeTimelineEntries(
      [entry("c", 30, "t", ["a"]), entry("a", 10, "t", ["a"]), entry("b", 20, "t", ["a"])],
      { limit: 10 },
    );
    expect(merged.map((e) => e.digest)).toEqual(["a", "b", "c"]);
  });

  it("de-dupes a tx across addresses and unions involved", () => {
    const merged = mergeTimelineEntries(
      [entry("shared", 5, "t", ["a"]), entry("shared", 5, "t", ["b"]), entry("solo", 6, "t", ["b"])],
      { limit: 10 },
    );
    expect(merged).toHaveLength(2);
    expect(merged[0].digest).toBe("shared");
    expect(merged[0].involved.sort()).toEqual(["a", "b"]);
  });

  it("windows by timestamp when bounds are given", () => {
    const merged = mergeTimelineEntries(
      [
        entry("old", 1, "2024-11-01T00:00:00Z", ["a"]),
        entry("in", 2, "2024-11-11T12:00:00Z", ["a"]),
        entry("new", 3, "2024-12-01T00:00:00Z", ["a"]),
      ],
      { fromMs: Date.parse("2024-11-10T00:00:00Z"), toMs: Date.parse("2024-11-12T00:00:00Z"), limit: 10 },
    );
    expect(merged.map((e) => e.digest)).toEqual(["in"]);
  });

  it("caps to the limit", () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry(`d${i}`, i, "t", ["a"]));
    expect(mergeTimelineEntries(entries, { limit: 5 })).toHaveLength(5);
  });

  it("sorts checkpoint-less entries last, deterministically by digest", () => {
    const merged = mergeTimelineEntries(
      [entry("z", null, "t", ["a"]), entry("m", null, "t", ["a"]), entry("has_cp", 1, "t", ["a"])],
      { limit: 10 },
    );
    expect(merged.map((e) => e.digest)).toEqual(["has_cp", "m", "z"]);
  });
});
