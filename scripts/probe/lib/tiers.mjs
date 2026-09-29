/**
 * Which live checks a tier runs.
 *
 * `smoke`: one check per tool, plus every check marked `critical`.
 *
 * `affected`: the checks a change can reach. Changed files lead, through the
 * source import graph, to the tools whose registration reaches them, and
 * those to the checks that call them; changed case files bring all their
 * checks, and the critical checks always run. The tool map is derived from
 * the source: each `src/tools/*.ts` file's `.tool("name", …)` and
 * `.registerTool("name", …)` calls say which tools it registers, and its
 * imports (static, dynamic, `require` and `new URL(…, import.meta.url)`) say
 * which files those tools run. A file that `src/tools/index.ts` imports for
 * anything but a `register…Tools` function wraps every tool, so a change to
 * it, or to anything it imports, reaches them all. A change the map cannot
 * place (a source file nothing imports, the runner itself, the package
 * manifest or the compiler settings) reaches everything, and the full pass
 * runs.
 *
 * Everything but `changedFiles`, `readSources` and `probeSources` is pure;
 * `test/tiers.test.ts` covers it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

const ENTRY = "src/index.ts";
const TOOLS_INDEX = "src/tools/index.ts";

/** Files whose change invalidates every check: the runner, and how the server is built. */
const RUNNER = [
  /^package(-lock)?\.json$/,
  /^tsconfig(\.[\w-]+)?\.json$/,
  /^scripts\/probe\/case-pass\.mjs$/,
  /^scripts\/probe\/lib\//,
  /^scripts\/verify-live\.mjs$/,
];

/** Import-like references in a source file, as written. */
const SPECIFIERS = [
  /\bimport\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[\w*{}\s,]+\s+from\s+["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bnew URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
];

const REGISTRATION = /\.(?:tool|registerTool)\(\s*(["'`])([a-z0-9_]+)\1/g;

/** Every file under `src/`, as repo-relative posix paths, with its text. */
export function readSources(root) {
  const files = new Map();
  const walk = (rel) => {
    for (const name of readdirSync(join(root, rel))) {
      const child = posix.join(rel, name);
      if (statSync(join(root, child)).isDirectory()) walk(child);
      else files.set(child, /\.(ts|mts|js|mjs)$/.test(name) ? readFileSync(join(root, child), "utf8") : "");
    }
  };
  walk("src");
  return files;
}

/** Resolve a relative specifier from `from` to a file in `files`, or null. */
function resolve(files, from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const candidates = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.mjs$/, ".mts"), `${base}.ts`, `${base}/index.ts`];
  return candidates.find((c) => files.has(c)) ?? null;
}

/**
 * The import graph of `files` (path to text), the tools each registration
 * file registers, and the files that `src/tools/index.ts` imports for its own
 * wrapping of every tool.
 */
export function buildGraph(files) {
  const imports = new Map();
  for (const [file, text] of files) {
    const deps = new Set();
    for (const re of SPECIFIERS) for (const m of text.matchAll(re)) {
      const target = resolve(files, file, m[1]);
      if (target && target !== file) deps.add(target);
    }
    imports.set(file, deps);
  }

  const registers = new Map();
  for (const [file, text] of files) {
    if (!/^src\/tools\/[^/]+\.ts$/.test(file)) continue;
    const names = [...text.matchAll(REGISTRATION)].map((m) => m[2]);
    if (names.length) registers.set(file, new Set(names));
  }

  // tools/index.ts imports `registerXTools` from each registration file; any
  // other name it imports is machinery that every tool runs through.
  const shared = new Set();
  const indexText = files.get(TOOLS_INDEX) ?? "";
  for (const m of indexText.matchAll(/\bimport\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
    if (m[1]) continue;
    const names = m[2].split(",").map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean);
    const target = resolve(files, TOOLS_INDEX, m[3]);
    if (target && names.some((n) => !/^register\w*Tools$/.test(n))) shared.add(target);
  }
  return { imports, registers, shared };
}

/** Every file reachable from `starts` through `imports`, the starts included. */
function closure(imports, starts) {
  const seen = new Set(starts);
  const stack = [...starts];
  while (stack.length) for (const dep of imports.get(stack.pop()) ?? []) if (!seen.has(dep)) (seen.add(dep), stack.push(dep));
  return seen;
}

/**
 * Map changed files to what they can affect.
 *
 * Returns `full` (the reason every check must run) or null; `tools`, the
 * registered tools the change reaches; `cases`, changed case files; `scripts`,
 * changed probe scripts; `detectorLabels`, whether cases/detectors.json
 * changed; and `notes`, one line per changed file saying where it led.
 */
export function mapChanges(changed, graph, { registered = [] } = {}) {
  const { imports, registers, shared } = graph;
  const allTools = new Set([...registers.values()].flatMap((s) => [...s]));
  // A listed tool the scan found no registration for is placed nowhere, so
  // any source change must count as reaching it.
  const unplaced = registered.filter((t) => !allTools.has(t));
  const sharedFiles = new Set([ENTRY, TOOLS_INDEX, ...closure(imports, [...shared])]);
  const reachable = closure(imports, [ENTRY]);
  const perFile = new Map([...registers.keys()].map((file) => [file, closure(imports, [file])]));

  const out = { full: null, tools: new Set(), cases: new Set(), scripts: new Set(), detectorLabels: false, notes: [] };
  const everything = (file, why) => {
    out.full ??= `${file}: ${why}`;
    out.notes.push(`${file}: ${why}`);
  };
  for (const file of changed) {
    if (RUNNER.some((re) => re.test(file))) {
      everything(file, "the runner or the build changed");
      continue;
    }
    if (/^cases\/incidents\/[^/]+\.json$/.test(file)) {
      out.cases.add(file);
      out.notes.push(`${file}: every check in this case`);
      continue;
    }
    if (file === "cases/detectors.json") {
      out.detectorLabels = true;
      out.notes.push(`${file}: the detector labels`);
      continue;
    }
    if (/^scripts\/probe\/[^/]+\.mjs$/.test(file)) {
      out.scripts.add(file);
      out.notes.push(`${file}: this probe script`);
      continue;
    }
    if (!file.startsWith("src/")) continue;
    if (sharedFiles.has(file)) {
      everything(file, "every tool is registered through it");
      continue;
    }
    if (unplaced.length) {
      everything(file, `no registration found for ${unplaced.join(", ")}`);
      continue;
    }
    const hit = [];
    for (const [reg, files] of perFile) if (files.has(file)) for (const t of registers.get(reg)) hit.push(t);
    if (hit.length) {
      for (const t of hit) out.tools.add(t);
      out.notes.push(`${file}: ${hit.length} tool(s)`);
    } else if (reachable.has(file)) out.notes.push(`${file}: no tool reaches it`);
    else everything(file, "nothing imports it, so its reach is unknown");
  }
  return out;
}

/** Files changed in `range` (anything `git diff` takes), deletions left out: their importers changed too. */
export function changedFiles(range, root) {
  const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=d", range, "--"], { cwd: root, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

/** The affected set for `range` in the repo at `root`. */
export function affectedBy(range, root, { registered = [] } = {}) {
  if (!existsSync(join(root, TOOLS_INDEX))) throw new Error(`${TOOLS_INDEX} is missing`);
  return mapChanges(changedFiles(range, root), buildGraph(readSources(root)), { registered });
}

/** Probe scripts under `dir` and their text, keyed by file name. */
export function probeSources(dir) {
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => [f, readFileSync(join(dir, f), "utf8")]),
  );
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a probe script calls `tool`: the rule test/live-coverage.test.ts
 * uses to credit a probe with a tool's live coverage.
 */
export function callsTool(src, tool) {
  return new RegExp(`\\b\\w*[Cc]all\\w*\\(\\s*(["'\`])${escapeRe(tool)}\\1`).test(src);
}

/** `cases` (`[{ rel, c }]`) cut down to the checks `keep(check, rel)` accepts, dropping empty cases. */
function cut(cases, keep) {
  return cases
    .map((entry) => ({ ...entry, checks: entry.c.checks.filter((ck) => keep(ck, entry.rel)) }))
    .filter(({ checks }) => checks.length > 0);
}

/**
 * The smoke tier: each tool's first check that is not a known defect (its
 * first check when all are), plus every critical check. `cases` is
 * `[{ rel, c }]` in run order, and the result keeps that order.
 */
export function pickSmoke(cases) {
  const perTool = new Map();
  for (const { c } of cases)
    for (const ck of c.checks) {
      const first = perTool.get(ck.tool);
      if (!first || (first.known_defect && !ck.known_defect)) perTool.set(ck.tool, ck);
    }
  const chosen = new Set(perTool.values());
  return cut(cases, (ck) => ck.critical === true || chosen.has(ck));
}

/**
 * The affected tier: checks calling a tool `reach` (from `mapChanges`)
 * reached, every check of a changed case file, and every critical check; all
 * of them when `reach.full` is set.
 */
export function pickAffected(cases, reach) {
  if (reach.full) return cut(cases, () => true);
  return cut(cases, (ck, rel) => ck.critical === true || reach.tools.has(ck.tool) || reach.cases.has(rel));
}

/** Probe scripts that prove input handling, not answers: never credited with a tool (see test/live-coverage.test.ts). */
export const NOT_COVERAGE = new Set(["adversarial.mjs"]);

/**
 * Probe scripts that check tools' answers on random subjects against chain
 * truth read another way, with the tools each one checks. A case check
 * replays a fixed incident and never draws the rare states these samples
 * do, so such a script runs in the affected tier whenever one of its tools
 * is reached, whether a case check names that tool or not.
 * `test/tiers.test.ts` holds each list equal to the tools its script calls.
 */
export const ORACLE_PROBES = {
  "oracle-pass.mjs": ["analyze_package", "get_transaction", "get_upgrade_history", "trace_object_history"],
};

/**
 * The probe scripts besides case-pass that a tier runs, each with why.
 *
 * `smoke`: the fewest scripts (chosen greedily, most uncovered tools first)
 * that call every tool no case check names, so each tool gets a live check.
 * `affected`: each changed probe script; each script that calls a reached
 * tool no case check names; each of `oracles` (script to the tools it
 * checks, `ORACLE_PROBES` by default) whose tools were reached; and
 * detector-pass when a tool it scores was reached or its labels changed.
 * Returns null for `affected` when `reach.full` is set: the full pass runs.
 *
 * `probes` maps script file names to their text; `caseTools` holds the tools
 * case checks name; `detectorTools` the tools detector-pass scores.
 */
export function probePlan(tier, { tools, caseTools, probes, reach = null, detectorTools = [], oracles = ORACLE_PROBES }) {
  const credited = new Map();
  for (const [file, src] of probes)
    if (!NOT_COVERAGE.has(file) && file !== "case-pass.mjs") credited.set(file, new Set(tools.filter((t) => callsTool(src, t))));

  if (tier === "smoke") {
    const left = new Set(tools.filter((t) => !caseTools.has(t)));
    const plan = new Map();
    while (left.size) {
      let best = null;
      let bestCount = 0;
      for (const [file, calls] of credited) {
        const count = [...calls].filter((t) => left.has(t)).length;
        if (count > bestCount) (best = file), (bestCount = count);
      }
      if (!best) break;
      const covered = [...credited.get(best)].filter((t) => left.has(t));
      for (const t of covered) left.delete(t);
      plan.set(best, `the only live check of ${covered.length} tool(s) with no case check: ${covered.join(", ")}`);
    }
    return { plan, uncovered: [...left] };
  }

  if (reach.full) return null;
  const plan = new Map();
  for (const rel of reach.scripts) {
    const file = rel.slice("scripts/probe/".length);
    if (file !== "case-pass.mjs") plan.set(file, "the script changed");
  }
  const probeOnly = [...reach.tools].filter((t) => !caseTools.has(t));
  for (const [file, calls] of credited) {
    const hit = probeOnly.filter((t) => calls.has(t));
    if (hit.length && !plan.has(file)) plan.set(file, `calls reached tool(s) with no case check: ${hit.join(", ")}`);
  }
  for (const [file, checked] of Object.entries(oracles)) {
    const hit = checked.filter((t) => reach.tools.has(t));
    if (hit.length && !plan.has(file)) plan.set(file, `checks reached tool(s) against chain truth: ${hit.join(", ")}`);
  }
  const scored = detectorTools.filter((t) => reach.tools.has(t));
  if (!plan.has("detector-pass.mjs") && (reach.detectorLabels || scored.length))
    plan.set("detector-pass.mjs", reach.detectorLabels ? "cases/detectors.json changed" : `scores reached tool(s): ${scored.join(", ")}`);
  return { plan, uncovered: [] };
}

