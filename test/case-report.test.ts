import { describe, it, expect } from "vitest";
import { renderCaseReport } from "../src/utils/case-report.js";
import type { Finding } from "../src/utils/store.js";

const AT = Date.parse("2026-08-07T12:00:00Z");

const finding = (over: Partial<Finding> = {}): Finding => ({
  case_name: "case-1",
  title: "A thing was established",
  detail: null,
  confidence: null,
  addresses: [],
  evidence: [],
  created_at: AT,
  ...over,
});

describe("renderCaseReport", () => {
  it("titles the report with the case name", () => {
    const md = renderCaseReport({ caseName: "alphalend-sybil", findings: [finding()], generatedAt: AT });
    expect(md).toMatch(/^# alphalend-sybil\n/);
  });

  it("says so plainly when a case has no findings", () => {
    const md = renderCaseReport({ caseName: "empty", findings: [], generatedAt: AT });
    expect(md).toContain("No findings recorded");
  });

  // A reader skimming should hit the solid claims first, not encounter them in
  // whatever order they happened to be recorded.
  it("orders findings by confidence, highest first", () => {
    const md = renderCaseReport({
      caseName: "c",
      generatedAt: AT,
      findings: [
        finding({ title: "Speculative", confidence: "low", created_at: AT }),
        finding({ title: "Solid", confidence: "high", created_at: AT + 1000 }),
        finding({ title: "Middling", confidence: "medium", created_at: AT + 2000 }),
      ],
    });
    const order = ["Solid", "Middling", "Speculative"].map((t) => md.indexOf(t));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it("puts findings with no confidence after those that have one", () => {
    const md = renderCaseReport({
      caseName: "c",
      generatedAt: AT,
      findings: [finding({ title: "Unrated" }), finding({ title: "Rated", confidence: "low" })],
    });
    expect(md.indexOf("Rated")).toBeLessThan(md.indexOf("Unrated"));
  });

  it("renders evidence, which is what makes a finding checkable", () => {
    const md = renderCaseReport({
      caseName: "c",
      generatedAt: AT,
      findings: [finding({ evidence: ["23 of 25 share funder X", "fan-out 1,623"] })],
    });
    expect(md).toContain("**Evidence**");
    expect(md).toContain("- 23 of 25 share funder X");
    expect(md).toContain("- fan-out 1,623");
  });

  it("shortens addresses inline but keeps full ones in the appendix", () => {
    const long = "0xab73ad38c63f83eda02182422b545395be1d3caeb54b5869159a9f70b678cd56";
    const md = renderCaseReport({
      caseName: "c",
      generatedAt: AT,
      findings: [finding({ addresses: [long] })],
    });
    expect(md).toContain("0xab73ad38…78cd56");
    expect(md).toContain("## Appendix: full addresses");
    expect(md).toContain(long);
  });

  it("omits the appendix when asked", () => {
    const md = renderCaseReport({
      caseName: "c",
      generatedAt: AT,
      includeAppendix: false,
      findings: [finding({ addresses: ["0x" + "a".repeat(64)] })],
    });
    expect(md).not.toContain("Appendix");
  });

  it("de-duplicates addresses across findings in the summary count", () => {
    const a = "0x" + "1".repeat(64);
    const md = renderCaseReport({
      caseName: "c",
      generatedAt: AT,
      findings: [finding({ addresses: [a] }), finding({ addresses: [a] })],
    });
    expect(md).toContain("2 findings · 1 address ·");
  });

  it("pluralises the summary line correctly", () => {
    const md = renderCaseReport({ caseName: "c", generatedAt: AT, findings: [finding()] });
    expect(md).toContain("1 finding · 0 addresses ·");
  });

  it("includes a generation stamp so a report is reproducible", () => {
    const md = renderCaseReport({ caseName: "c", generatedAt: AT, findings: [finding()] });
    expect(md).toContain(new Date(AT).toISOString());
  });

  it("ends with a trailing newline, as a file should", () => {
    const md = renderCaseReport({ caseName: "c", generatedAt: AT, findings: [finding()] });
    expect(md.endsWith("\n")).toBe(true);
  });
});
