import { describe, it, expect } from "vitest";
import { clampPageSize } from "../src/utils/pagination.js";

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
