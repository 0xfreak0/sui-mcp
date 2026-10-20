import { describe, it, expect } from "vitest";
import { clampPageSize, orderedPage } from "../src/utils/pagination.js";

describe("orderedPage", () => {
  const info = { hasNextPage: true, endCursor: "last", hasPreviousPage: true, startCursor: "first" };
  it("ends a list when a read returns nothing and hands its own cursor back", () => {
    // The service answers a read from a list's last cursor, or from a cursor
    // outside the filter's checkpoint window, this way.
    expect(orderedPage([], info, "oldest", "last")).toEqual({ nodes: [], has_next_page: false, next_cursor: "last" });
    expect(orderedPage([], info, "newest", "first")).toEqual({ nodes: [], has_next_page: false, next_cursor: null });
  });
  it("continues a read that returned nothing but moved the cursor", () => {
    expect(orderedPage([], info, "oldest", "earlier")).toEqual({ nodes: [], has_next_page: true, next_cursor: "last" });
    expect(orderedPage([], info, "newest", "later")).toEqual({ nodes: [], has_next_page: true, next_cursor: "first" });
  });
});

describe("clampPageSize", () => {
  it("returns default for undefined", () => {
    expect(clampPageSize(undefined)).toBe(50);
  });

  it("returns default for zero", () => {
    expect(clampPageSize(0)).toBe(50);
  });

  it("returns default for negative", () => {
    expect(clampPageSize(-1)).toBe(50);
  });

  it("passes through normal values", () => {
    expect(clampPageSize(25)).toBe(25);
  });

  it("clamps at max", () => {
    expect(clampPageSize(1001)).toBe(1000);
  });

  it("allows max exactly", () => {
    expect(clampPageSize(1000)).toBe(1000);
  });

  it("allows 1", () => {
    expect(clampPageSize(1)).toBe(1);
  });
});
