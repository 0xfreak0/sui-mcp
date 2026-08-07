import { describe, it, expect } from "vitest";
import {
  aggregateEvents,
  readNumericPath,
  suggestValueFields,
} from "../src/utils/aggregate.js";

const ev = (sender: string, type: string, data?: unknown) => ({ sender, type, data });

describe("readNumericPath", () => {
  it("reads a top-level number", () => {
    expect(readNumericPath({ amount: 42 }, "amount")).toBe(42);
  });

  // Move u64s do not survive JSON as numbers, so string amounts are the norm.
  it("reads numeric strings", () => {
    expect(readNumericPath({ amount: "1250" }, "amount")).toBe(1250);
  });

  it("walks a dotted path", () => {
    expect(readNumericPath({ event: { deposit_value: "500" } }, "event.deposit_value")).toBe(500);
  });

  // Null, not 0 — a silent zero deflates a total and looks like a real answer.
  it("returns null rather than zero for anything unreadable", () => {
    expect(readNumericPath({ a: "abc" }, "a")).toBeNull();
    expect(readNumericPath({ a: "" }, "a")).toBeNull();
    expect(readNumericPath({ a: null }, "a")).toBeNull();
    expect(readNumericPath({ a: {} }, "a")).toBeNull();
    expect(readNumericPath({ a: 1 }, "b")).toBeNull();
    expect(readNumericPath(null, "a")).toBeNull();
    expect(readNumericPath({ a: Infinity }, "a")).toBeNull();
  });

  it("does not walk through a non-object mid-path", () => {
    expect(readNumericPath({ a: 5 }, "a.b")).toBeNull();
  });
});

describe("aggregateEvents", () => {
  it("counts events per group", () => {
    const r = aggregateEvents(
      [ev("0xa", "T"), ev("0xa", "T"), ev("0xb", "T")],
      { groupBy: "sender" },
    );
    expect(r.groups).toEqual([
      { key: "0xa", event_count: 2, value_sum: null, missing_value_count: 0 },
      { key: "0xb", event_count: 1, value_sum: null, missing_value_count: 0 },
    ]);
    expect(r.distinct_keys).toBe(2);
  });

  it("groups by event type when asked", () => {
    const r = aggregateEvents(
      [ev("0xa", "Deposit"), ev("0xb", "Deposit"), ev("0xa", "Borrow")],
      { groupBy: "event_type" },
    );
    expect(r.groups[0]).toMatchObject({ key: "Deposit", event_count: 2 });
  });

  it("sums a named field and applies the scale", () => {
    // USD cents -> dollars, the shape protocols actually emit.
    const r = aggregateEvents(
      [ev("0xa", "T", { v: "100000" }), ev("0xa", "T", { v: "50000" })],
      { groupBy: "sender", valueField: "v", valueScale: 100 },
    );
    expect(r.groups[0].value_sum).toBe(1500);
  });

  // Ranking by count when a value was requested would bury one large mover
  // under a bot making thousands of dust calls.
  it("ranks by value when a value field is given, not by count", () => {
    const r = aggregateEvents(
      [
        ...Array.from({ length: 50 }, () => ev("0xdust", "T", { v: "1" })),
        ev("0xwhale", "T", { v: "1000000" }),
      ],
      { groupBy: "sender", valueField: "v" },
    );
    expect(r.groups[0].key).toBe("0xwhale");
  });

  it("ranks by count when no value field is given", () => {
    const r = aggregateEvents(
      [ev("0xa", "T"), ev("0xb", "T"), ev("0xb", "T")],
      { groupBy: "sender" },
    );
    expect(r.groups[0].key).toBe("0xb");
  });

  it("counts unreadable values instead of treating them as zero", () => {
    const r = aggregateEvents(
      [ev("0xa", "T", { v: "100" }), ev("0xa", "T", { other: 1 })],
      { groupBy: "sender", valueField: "v" },
    );
    expect(r.groups[0].value_sum).toBe(100);
    expect(r.groups[0].missing_value_count).toBe(1);
  });

  it("reports events with no group key rather than dropping them", () => {
    const r = aggregateEvents(
      [ev("0xa", "T"), { sender: null, type: "T" }],
      { groupBy: "sender" },
    );
    expect(r.ungrouped_count).toBe(1);
    expect(r.events_aggregated).toBe(1);
  });

  it("truncates to top N but still reports the true distinct count", () => {
    const many = Array.from({ length: 30 }, (_, i) => ev(`0x${i}`, "T"));
    const r = aggregateEvents(many, { groupBy: "sender", top: 5 });
    expect(r.groups).toHaveLength(5);
    // Losing this would make a top-5 view look like the whole population.
    expect(r.distinct_keys).toBe(30);
  });

  it("treats a zero scale as no scaling rather than dividing by zero", () => {
    const r = aggregateEvents([ev("0xa", "T", { v: "10" })], {
      groupBy: "sender",
      valueField: "v",
      valueScale: 0,
    });
    expect(r.groups[0].value_sum).toBe(10);
  });

  it("handles an empty input", () => {
    const r = aggregateEvents([], { groupBy: "sender" });
    expect(r.groups).toEqual([]);
    expect(r.distinct_keys).toBe(0);
  });
});

describe("suggestValueFields", () => {
  it("finds numeric and numeric-string fields", () => {
    expect(suggestValueFields({ a: 1, b: "2", c: "hello" })).toEqual(["a", "b"]);
  });

  it("descends into nested objects with dotted paths", () => {
    // Real shape: AlphaLend wraps its payload under `event`.
    expect(suggestValueFields({ event: { deposit_value: "500", market_id: "3" } })).toEqual([
      "event.deposit_value",
      "event.market_id",
    ]);
  });

  it("ignores arrays, which are not summable scalars", () => {
    expect(suggestValueFields({ xs: [1, 2, 3], n: 5 })).toEqual(["n"]);
  });

  it("returns nothing for non-objects", () => {
    expect(suggestValueFields(null)).toEqual([]);
    expect(suggestValueFields("x")).toEqual([]);
  });
});
