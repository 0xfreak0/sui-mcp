import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registeredTools } from "./helpers/tool-names.js";
import { validateCase } from "../scripts/probe/lib/case-eval.mjs";
import { callsTool, NOT_COVERAGE } from "../scripts/probe/lib/tiers.mjs";

/**
 * Every tool must be exercised live against a known answer: called by a
 * probe in scripts/probe, or named as the `tool` of a check in a case file.
 * adversarial.mjs does not count. It calls every tool from tools/list with
 * malformed input, which proves input handling and says nothing about
 * whether an answer is right.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_DIR = join(ROOT, "scripts", "probe");
const CASE_DIR = join(ROOT, "cases", "incidents");

/**
 * Tools exempt from the gate, each with the reason. Empty while every tool
 * has a live check.
 */
const EXEMPT: Record<string, string> = {};

const tools = registeredTools().map((t) => t.name);

const probeSources = readdirSync(PROBE_DIR)
  .filter((f) => f.endsWith(".mjs") && !NOT_COVERAGE.has(f))
  .map((f) => readFileSync(join(PROBE_DIR, f), "utf8"));

const caseFiles = readdirSync(CASE_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, json: JSON.parse(readFileSync(join(CASE_DIR, f), "utf8")) }));

/** A call like `call("get_balance", …)`, `callRaw('get_balance'` or `server.call(\`get_balance\``. */
const calledInProbe = (tool: string) => probeSources.some((src) => callsTool(src, tool));

const caseTools = new Set<string>(caseFiles.flatMap(({ json }) => (json.checks ?? []).map((c: { tool?: string }) => c.tool)));

describe("live coverage", () => {
  it("every registered tool has a live check or a case", () => {
    const uncovered = tools.filter((t) => !EXEMPT[t] && !calledInProbe(t) && !caseTools.has(t));
    expect(
      uncovered,
      `${uncovered.length} tool(s) with no live check: ${uncovered.join(", ")}. ` +
        "add a live check in scripts/probe or a case in cases/incidents",
    ).toEqual([]);
  });

  it("exempts only tools that exist and would otherwise fail the gate", () => {
    for (const [tool, reason] of Object.entries(EXEMPT)) {
      expect(tools, `EXEMPT names ${tool}, which is not a registered tool`).toContain(tool);
      expect(reason.trim(), `EXEMPT ${tool} needs a reason`).not.toBe("");
      expect(calledInProbe(tool) || caseTools.has(tool), `${tool} is covered now; remove it from EXEMPT`).toBe(false);
    }
  });
});

describe("case files follow the contract in cases/README.md", () => {
  const known = new Map(tools.map((t) => [t, null]));
  it.each(caseFiles.map(({ file, json }) => [file, json] as const))("%s", (file, json) => {
    expect(validateCase(json, { tools: known, file })).toEqual([]);
  });
});
