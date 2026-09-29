#!/usr/bin/env node
/**
 * Run the live checks against mainnet, in order, and fail loudly.
 *
 *   npm run build && npm run verify:live [-- --tier smoke|affected|full]
 *                                        [--range <git-range>] [--jobs <n>]
 *
 * The unit tests are offline by design — they pin real mainnet signatures and
 * shapes as fixtures so they stay fast and deterministic. That is exactly why
 * this exists: a fixture cannot notice that the chain, the SDK or the GraphQL
 * schema moved underneath it. It will keep passing against a stale copy of a
 * world that has changed.
 *
 * There are three moments when that matters, and they are the only times the
 * full pass needs running:
 *
 * 1. **After an `@mysten/sui` bump.** Signature parsing, protobuf field shapes
 *    and BCS key encoding all live in the SDK, and all fail silently — a
 *    changed key encoding returns null, which is indistinguishable from "not
 *    found".
 * 2. **After Mysten changes the GraphQL schema.** A renamed field makes a query
 *    return `null` rather than an error, so a tool quietly starts reporting
 *    less than it did.
 * 3. **Before cutting a release.**
 *
 * `--tier full` (the default) runs every script. `--tier affected` runs the
 * case checks a change can reach (`case-pass --affected`), each probe script
 * that changed or that calls a reached tool no case check names,
 * oracle-pass when a tool it checks was reached, and detector-pass when a
 * tool it scores was reached or its labels changed; `--range` is the change,
 * anything `git diff` takes, by default everything since this branch left
 * main, uncommitted work included. A change the file map cannot place runs
 * the full tier. `--tier smoke` runs `case-pass --smoke` and the fewest probe
 * scripts that reach every tool no case check names. `--jobs` goes to
 * case-pass. The choice of scripts is in scripts/probe/lib/tiers.mjs.
 *
 * `SUI_REPLAY_DIR` reaches case-pass, oracle-pass and detector-pass only;
 * every other script reads live.
 *
 * Deliberately NOT in CI. It needs the network and mainnet's current state, so
 * it would be flaky on a schedule nobody chose, and a flaky required check
 * teaches people to ignore failures.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sizeReport } from "./probe/lib/size-budget.mjs";
import { startServer } from "./probe/lib/mcp-client.mjs";
import { affectedBy, probePlan, probeSources } from "./probe/lib/tiers.mjs";
import { TOOLS as DETECTOR_TOOLS } from "./probe/lib/detector-eval.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
function argValue(flag, allowed) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--") || (allowed && !allowed.includes(v))) {
    console.error(`${flag} needs a value${allowed ? `: ${allowed.join(", ")}` : ""}`);
    process.exit(2);
  }
  return v;
}
const tier = argValue("--tier", ["smoke", "affected", "full"]) ?? "full";
const rangeArg = argValue("--range");
const jobs = argValue("--jobs");
if (rangeArg && tier !== "affected") {
  console.error("--range goes with --tier affected");
  process.exit(2);
}

if (!existsSync(join(root, "dist/index.js"))) {
  console.error("dist/ is missing — run `npm run build` first. These checks drive the built tools.");
  process.exit(1);
}

/**
 * Order matters. `dump-fixtures` first because it rewrites
 * `test/fixtures/signatures.json`: if the SDK's parse has drifted, the offline
 * tests fail immediately afterwards and say so, which is the loudest available
 * signal. The behavioural sweeps follow.
 */
const CHECKS = [
  ["probe/dump-fixtures", "regenerate signature fixtures from live mainnet"],
  ["probe/adversarial", "hostile and malformed input across every tool"],
  ["probe/investigation", "chained end-to-end investigation"],
  ["probe/full-case", "cross-tool consistency: two tools must not disagree about one fact"],
  ["probe/gap-pass", "paths the other sweeps do not reach"],
  ["probe/consistency-pass2", "each 1.13.0+ feature against an independent source of the same fact"],
  ["probe/incident-pass", "the incident tools on the Cetus and Nemo exploits, against raw chain reads"],
  ["probe/attribution-pass", "funding, clustering, multisig, event, history and holder tools, each against a raw chain read"],
  ["probe/surface-pass", "stateful, prompt, core, market and developer tools against raw chain reads, plus malformed input"],
  ["probe/case-pass", "every case in cases/incidents, against the answers its sources and the chain give"],
  ["probe/invariant-pass", "a seeded random sample of mainnet through the tools, against rules that hold for any input"],
  ["probe/oracle-pass", "random subjects from every era: swap labels, object ends and changes, mint authority, flows and cap owners against the chain read another way"],
  ["probe/detector-pass", "the anomaly detectors on labelled exploit and ordinary transactions: false positives, lost detections, leave one incident out"],
];
/** The scripts that read through SUI_REPLAY_DIR when it is set. */
const REPLAYING = new Set(["probe/case-pass", "probe/oracle-pass", "probe/detector-pass"]);

// case-pass writes its sizes and token counts here for the closing summary.
const scratch = mkdtempSync(join(tmpdir(), "verify-live-"));
const caseSummary = join(scratch, "case-pass.json");
const caseArgs = ["--summary", caseSummary, ...(jobs ? ["--jobs", jobs] : [])];

/** Where this branch left main (or origin/main), for `--tier affected` without `--range`. */
function branchBase() {
  for (const base of ["main", "origin/main"]) {
    try {
      return execFileSync("git", ["merge-base", base, "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      // No such branch here; try the next.
    }
  }
  console.error("--tier affected needs --range: this checkout has neither main nor origin/main to start from");
  process.exit(2);
}

/** Scripts to run, in CHECKS order, each with its extra arguments and why it runs. */
async function plan() {
  const all = CHECKS.map(([script, what]) => ({ script, what, args: script === "probe/case-pass" ? caseArgs : [] }));
  if (tier === "full") return { runs: all, notes: [] };

  const lister = await startServer({ name: "verify-live-list" });
  const tools = ((await lister.rpc("tools/list", {})).result?.tools ?? []).map((t) => t.name);
  lister.stop();
  const caseDir = join(root, "cases", "incidents");
  const caseTools = new Set(
    readdirSync(caseDir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => JSON.parse(readFileSync(join(caseDir, f), "utf8")).checks.map((c) => c.tool)),
  );
  const probes = probeSources(join(root, "scripts", "probe"));
  const notes = [];

  let chosen;
  let caseTier;
  if (tier === "smoke") {
    const { plan: scripts, uncovered } = probePlan("smoke", { tools, caseTools, probes });
    chosen = scripts;
    caseTier = ["--smoke"];
    if (uncovered.length) notes.push(`no live check reaches: ${uncovered.join(", ")}`);
  } else {
    const range = rangeArg ?? branchBase();
    let reach;
    try {
      reach = affectedBy(range, root, { registered: tools });
    } catch (err) {
      console.error(`--range ${range}: ${String(err.message ?? err).split("\n")[0]}`);
      process.exit(2);
    }
    notes.push(`changes in ${rangeArg ?? `${range.slice(0, 12)} (where this branch left main) to the working tree`}:`);
    for (const note of reach.notes) notes.push(`  ${note}`);
    if (!reach.notes.length) notes.push("  none that reach a live check");
    const scripts = probePlan("affected", { tools, caseTools, probes, reach, detectorTools: DETECTOR_TOOLS });
    if (!scripts) {
      notes.push(`running the full tier: ${reach.full}`);
      return { runs: all, notes };
    }
    chosen = scripts.plan;
    caseTier = ["--affected", range];
  }
  const runs = all
    .filter(({ script }) => script === "probe/case-pass" || chosen.has(`${script.slice("probe/".length)}.mjs`))
    .map((run) =>
      run.script === "probe/case-pass"
        ? { ...run, args: [...caseTier, ...caseArgs] }
        : { ...run, why: chosen.get(`${run.script.slice("probe/".length)}.mjs`) },
    );
  return { runs, notes };
}

const run = (script, args) =>
  new Promise((resolve) => {
    const env = { ...process.env };
    if (!REPLAYING.has(script)) delete env.SUI_REPLAY_DIR;
    const p = spawn(process.execPath, [join(root, "scripts", `${script}.mjs`), ...args], { cwd: root, stdio: "inherit", env });
    p.on("close", (code) => resolve(code ?? 1));
  });

const { runs, notes } = await plan();
console.log(`verify:live, tier ${tier}: ${runs.length} of ${CHECKS.length} scripts`);
for (const note of notes) console.log(`  ${note}`);

let failed = 0;
for (const { script, what, args, why } of runs) {
  console.log(`\n${"=".repeat(70)}\n${script} — ${what}${why ? `\n(${why})` : ""}\n${"=".repeat(70)}`);
  const code = await run(script, args);
  if (code !== 0) {
    failed++;
    console.error(`\n!! ${script} exited ${code}`);
  }
}

console.log(`\n${"=".repeat(70)}`);
console.log("case-pass output size against the budgets in scripts/probe/lib/size-budget.mjs (tokens ≈ chars / 4)");
if (existsSync(caseSummary)) for (const line of sizeReport(JSON.parse(readFileSync(caseSummary, "utf8")))) console.log(`  ${line}`);
else console.log("  not measured: case-pass wrote no summary");
rmSync(scratch, { recursive: true, force: true });
console.log("=".repeat(70));
if (failed) {
  console.error(`${failed} of ${runs.length} live checks failed.`);
  console.error("Run `npm test` next: a drifted fixture shows up there as a parse mismatch.");
  process.exit(1);
}
console.log(`All ${runs.length} live checks in the ${tier} tier passed.`);
if (runs.some(({ script }) => script === "probe/dump-fixtures"))
  console.log("Now run `npm test` — the regenerated fixtures must still derive to their own addresses.");
