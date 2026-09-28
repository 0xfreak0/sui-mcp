import { describe, it, expect } from "vitest";
import { buildGraph, mapChanges, pickAffected, pickSmoke, probePlan } from "../scripts/probe/lib/tiers.mjs";

/** A small synthetic server source tree. */
const files = new Map<string, string>([
  ["src/index.ts", `import { registerAllTools } from "./tools/index.js";\nimport { registerPrompts } from "./prompts.js";`],
  [
    "src/tools/index.ts",
    `import { registerAlphaTools } from "./alpha.js";\nimport { registerBetaTools } from "./beta.js";\nimport { wrap, type Wrapped } from "./wrap.js";`,
  ],
  ["src/tools/wrap.ts", `import { resolveName } from "../utils/names.js";`],
  ["src/utils/names.ts", ""],
  ["src/prompts.ts", `import { shared } from "./utils/shared.js";`],
  ["src/tools/alpha.ts", `import { walk } from "../utils/walk.js";\nexport function registerAlphaTools(s) {\n  s.tool(\n    "alpha_one", "d", {}, h);\n  s.tool("alpha_two", "d", {}, h);\n}`],
  ["src/tools/beta.ts", `const { price } = await import("../utils/price.js");\nexport function registerBetaTools(s) { s.tool('beta_one', "d", {}, h); }`],
  ["src/utils/walk.ts", `import { shared } from "./shared.js";\nconst data = require("../data/table.json");`],
  ["src/utils/price.ts", `import { shared } from "./shared.js";\nconst u = new URL("../data/rates.json", import.meta.url);`],
  ["src/utils/shared.ts", ""],
  ["src/utils/orphan.ts", ""],
  ["src/data/table.json", ""],
  ["src/data/rates.json", ""],
]);
const graph = buildGraph(files);
const reach = (changed: string[], registered: string[] = []) => mapChanges(changed, graph, { registered });

describe("mapping changed files to tools", () => {
  it("follows imports, dynamic imports, require and import.meta.url to the tools that register them", () => {
    expect([...reach(["src/utils/walk.ts"]).tools].sort()).toEqual(["alpha_one", "alpha_two"]);
    expect([...reach(["src/data/table.json"]).tools].sort()).toEqual(["alpha_one", "alpha_two"]);
    expect([...reach(["src/data/rates.json"]).tools]).toEqual(["beta_one"]);
    expect([...reach(["src/utils/shared.ts"]).tools].sort()).toEqual(["alpha_one", "alpha_two", "beta_one"]);
    expect(reach(["src/utils/shared.ts"]).full).toBeNull();
  });

  it("maps a tool file to only the tools it registers", () => {
    expect([...reach(["src/tools/beta.ts"]).tools]).toEqual(["beta_one"]);
  });

  it("runs everything for machinery that wraps every tool, and what it imports", () => {
    expect(reach(["src/tools/wrap.ts"]).full).not.toBeNull();
    expect(reach(["src/utils/names.ts"]).full).not.toBeNull();
    expect(reach(["src/tools/index.ts"]).full).not.toBeNull();
    expect(reach(["src/index.ts"]).full).not.toBeNull();
  });

  it("runs everything for a source file nothing imports, and for the runner or the build", () => {
    expect(reach(["src/utils/orphan.ts"]).full).not.toBeNull();
    for (const f of ["package.json", "package-lock.json", "tsconfig.json", "scripts/probe/case-pass.mjs", "scripts/probe/lib/case-eval.mjs"])
      expect(reach([f]).full, f).not.toBeNull();
  });

  it("runs everything when a listed tool has no registration the scan can find", () => {
    expect(reach(["src/utils/walk.ts"], ["alpha_one", "alpha_two", "beta_one", "gamma"]).full).not.toBeNull();
  });

  it("reaches no tool from a file only the server entry uses, or from docs and tests", () => {
    const r = reach(["src/prompts.ts", "README.md", "test/x.test.ts"]);
    expect(r.full).toBeNull();
    expect(r.tools.size).toBe(0);
  });

  it("collects changed case files, probe scripts and detector labels", () => {
    const r = reach(["cases/incidents/demo-2025.json", "scripts/probe/surface-pass.mjs", "cases/detectors.json"]);
    expect([...r.cases]).toEqual(["cases/incidents/demo-2025.json"]);
    expect([...r.scripts]).toEqual(["scripts/probe/surface-pass.mjs"]);
    expect(r.detectorLabels).toBe(true);
    expect(r.full).toBeNull();
  });
});

type Check = { id: string; tool: string; critical?: true; known_defect?: string };
const entry = (rel: string, checks: Check[]) => ({ rel, c: { checks } });
const ids = (picked: Array<{ checks: Check[] }>) => picked.flatMap((p) => p.checks.map((c) => c.id));

const cases = [
  entry("cases/incidents/a.json", [
    { id: "a1", tool: "alpha_one", known_defect: "wrong total" },
    { id: "a2", tool: "alpha_one" },
    { id: "a3", tool: "beta_one", critical: true },
  ]),
  entry("cases/incidents/b.json", [
    { id: "b1", tool: "beta_one" },
    { id: "b2", tool: "gamma", known_defect: "missing" },
    { id: "b3", tool: "alpha_two" },
  ]),
];

describe("smoke tier", () => {
  it("runs each tool's first check that is not a known defect, plus the critical ones", () => {
    expect(ids(pickSmoke(cases))).toEqual(["a2", "a3", "b2", "b3"]);
  });
});

describe("affected tier", () => {
  it("runs checks calling a reached tool, all of a changed case, and the critical ones", () => {
    const r = { full: null, tools: new Set(["alpha_two"]), cases: new Set(["cases/incidents/a.json"]) };
    expect(ids(pickAffected(cases, r))).toEqual(["a1", "a2", "a3", "b3"]);
  });

  it("runs only the critical checks when the change reaches no tool", () => {
    expect(ids(pickAffected(cases, { full: null, tools: new Set(), cases: new Set() }))).toEqual(["a3"]);
  });

  it("runs every check when the change reaches everything", () => {
    expect(ids(pickAffected(cases, { full: "package.json", tools: new Set(), cases: new Set() }))).toHaveLength(6);
  });
});

describe("probe scripts per tier", () => {
  const probes = new Map([
    ["surface-pass.mjs", `await s.call("tool_x", {}); await s.call("tool_y", {});`],
    ["gap-pass.mjs", `await call("tool_y", {}); await call("tool_z", {});`],
    ["adversarial.mjs", `await s.call("tool_w", {});`],
    ["case-pass.mjs", ""],
    ["detector-pass.mjs", ""],
  ]);
  const tools = ["tool_w", "tool_x", "tool_y", "tool_z", "alpha_one"];
  const caseTools = new Set(["alpha_one"]);

  it("smoke covers every tool with no case check with the fewest scripts, and names what nothing covers", () => {
    const smoke = probePlan("smoke", { tools, caseTools, probes });
    expect([...smoke!.plan.keys()].sort()).toEqual(["gap-pass.mjs", "surface-pass.mjs"]);
    expect(smoke!.uncovered).toEqual(["tool_w"]);
  });

  it("affected runs changed scripts, every script calling a reached probe-only tool, and detector-pass for its tools", () => {
    const r = { full: null, tools: new Set(["tool_y", "alpha_one", "analyze_attack_tx"]), cases: new Set(), scripts: new Set<string>(), detectorLabels: false };
    const plan = probePlan("affected", { tools, caseTools, probes, reach: r, detectorTools: ["analyze_attack_tx", "decode_ptb"] });
    expect([...plan!.plan.keys()].sort()).toEqual(["detector-pass.mjs", "gap-pass.mjs", "surface-pass.mjs"]);
  });

  it("affected leaves out scripts whose tools a case check already covers", () => {
    const r = { full: null, tools: new Set(["alpha_one"]), cases: new Set(), scripts: new Set(["scripts/probe/adversarial.mjs"]), detectorLabels: false };
    const plan = probePlan("affected", { tools, caseTools, probes, reach: r });
    expect([...plan!.plan.keys()]).toEqual(["adversarial.mjs"]);
  });

  it("affected defers to the full tier when the change reaches everything", () => {
    const r = { full: "package.json", tools: new Set(), cases: new Set(), scripts: new Set(), detectorLabels: false };
    expect(probePlan("affected", { tools, caseTools, probes, reach: r })).toBeNull();
  });
});
