import { describe, it, expect } from "vitest";
import { diffLines, diffPackages } from "../src/utils/package-diff.js";

describe("diffLines", () => {
  it("reports zero changes for identical input", () => {
    const d = diffLines(["a", "b", "c"], ["a", "b", "c"]);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  it("counts added and removed lines", () => {
    const d = diffLines(["a", "b", "c"], ["a", "x", "c", "d"]);
    // b removed, x + d added
    expect(d.removed).toBe(1);
    expect(d.added).toBe(2);
    expect(d.unified).toContain("- b");
    expect(d.unified).toContain("+ x");
    expect(d.unified).toContain("+ d");
  });

  it("truncates the unified excerpt at maxUnified", () => {
    const a = Array.from({ length: 100 }, (_, i) => `old${i}`);
    const b = Array.from({ length: 100 }, (_, i) => `new${i}`);
    const d = diffLines(a, b, 10);
    expect(d.unified.length).toBe(10);
    expect(d.truncated).toBe(true);
  });

  it("falls back to a multiset delta for very large inputs", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `l${i}`);
    const b = [...a, "extra1", "extra2"];
    const d = diffLines(a, b);
    expect(d.truncated).toBe(true);
    expect(d.unified).toEqual([]);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(0);
  });
});

describe("diffPackages", () => {
  it("detects an identical package", () => {
    const from = new Map([["m", "line1\nline2"]]);
    const to = new Map([["m", "line1\nline2"]]);
    const d = diffPackages(from, to);
    expect(d.identical).toBe(true);
    expect(d.unchanged_count).toBe(1);
  });

  it("detects added and removed modules", () => {
    const from = new Map([["a", "x"], ["gone", "y"]]);
    const to = new Map([["a", "x"], ["new", "z"]]);
    const d = diffPackages(from, to);
    expect(d.added_modules).toEqual(["new"]);
    expect(d.removed_modules).toEqual(["gone"]);
    expect(d.identical).toBe(false);
  });

  it("detects a changed module and captures the diff — the malicious-upgrade signal", () => {
    const from = new Map([["vault", "public fun withdraw(cap: &AdminCap)\nreturn"]]);
    const to = new Map([["vault", "public fun withdraw(cap: &AdminCap)\npublic fun backdoor()\nreturn"]]);
    const d = diffPackages(from, to);
    expect(d.changed_modules).toHaveLength(1);
    expect(d.changed_modules[0].module).toBe("vault");
    expect(d.changed_modules[0].added_lines).toBe(1);
    expect(d.changed_modules[0].sample?.some((l) => l.includes("backdoor"))).toBe(true);
  });

  it("ignores cosmetic whitespace/line-ending differences", () => {
    const from = new Map([["m", "line1\nline2"]]);
    const to = new Map([["m", "line1  \r\nline2"]]);
    const d = diffPackages(from, to);
    expect(d.identical).toBe(true);
  });

  it("orders changed modules by churn (largest first)", () => {
    const from = new Map([
      ["small", "a\nb"],
      ["big", "a\nb\nc"],
    ]);
    const to = new Map([
      ["small", "a\nB"],
      ["big", "X\nY\nZ\nW"],
    ]);
    const d = diffPackages(from, to);
    expect(d.changed_modules[0].module).toBe("big");
  });
});
