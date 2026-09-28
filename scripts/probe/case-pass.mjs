#!/usr/bin/env node
/**
 * Case pass: replay every investigation case file through the built server.
 *
 *   node scripts/probe/case-pass.mjs [--smoke | --affected <git-range>] [--jobs <n>]
 *                                    [--case <slug>] [--check <id>] [--summary <file>]
 *
 * Reads cases/incidents/*.json, plus every *.json in $SUI_CASES_DIR when set,
 * validates each against the contract in cases/README.md, runs each check's
 * tool call and evaluates its `expect` entries. A case gets its own server
 * and throwaway store (see `--jobs`). Every call's latency, size and
 * estimated tokens (chars / 4) are printed, with a total per case. A call
 * over the check's `timeout_s` (default 120), over its `max_chars`, or over
 * its tool's budget in lib/size-budget.mjs fails. The tools/list size is
 * printed for the default profile and for SUI_TOOLS=all. `--summary <file>`
 * also writes the tallies, the size and token totals per case, the wall time
 * and every call measured against its budget as JSON, which verify-live
 * prints in its closing summary.
 *
 * Every check runs by default. `--smoke` runs one check per tool plus the
 * checks marked `critical`; `--affected <git-range>` runs the checks a change
 * in that range can reach, plus the critical ones (see lib/tiers.mjs). Every
 * case file is validated in every tier. `--case` and `--check` narrow any
 * tier further.
 *
 * `--jobs <n>` runs up to n cases at once through one server, so they share
 * its request budget: the rate limit and in-flight cap it keeps per endpoint.
 * A case that calls a tool which writes the store gets a server of its own
 * and runs after the others, one at a time. Latency then includes waiting on
 * the shared budget, and a tool with a wall-clock budget answers less, so a
 * check that fails in the shared run runs again alone on a fresh server and
 * fails the run only if it fails there too.
 *
 * With `SUI_REPLAY_DIR` set, the server answers reads that cannot change from
 * the recordings there and records the rest of them as they go out (see
 * src/clients/replay.ts).
 *
 * A check marked `known_defect` that fails is reported as known and does not
 * fail the run. One that passes fails the run, so the marker gets removed.
 * Exits non-zero on any FAIL, any invalid case file, or a fixed known defect.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { startServer, ROOT } from "./lib/mcp-client.mjs";
import { budgetFor, kchars, tokens } from "./lib/size-budget.mjs";
import { DEFAULT_TIMEOUT_S, evaluate, resolveCheckPath, show, substitute, toResponse, validateCase } from "./lib/case-eval.mjs";
import { affectedBy, pickAffected, pickSmoke } from "./lib/tiers.mjs";

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith("--")) {
    console.error(`${flag} needs a value`);
    process.exit(2);
  }
  return v;
}
const onlyCase = argValue("--case");
const onlyCheck = argValue("--check");
const summaryPath = argValue("--summary");
const affectedRange = argValue("--affected");
const smoke = process.argv.includes("--smoke");
const jobsArg = argValue("--jobs");
const jobs = jobsArg === undefined ? 1 : Number(jobsArg);
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error("--jobs needs a whole number of cases to run at once, 1 or more");
  process.exit(2);
}
if (smoke && affectedRange) {
  console.error("--smoke and --affected pick checks differently; use one");
  process.exit(2);
}

if (!existsSync(join(ROOT, "dist", "index.js"))) {
  console.error("dist/ is missing; run `npm run build` first. The cases drive the built tools.");
  process.exit(1);
}

const started = Date.now();
const dirs = [join(ROOT, "cases", "incidents")];
if (process.env.SUI_CASES_DIR) dirs.push(process.env.SUI_CASES_DIR);
const files = [];
for (const dir of dirs) {
  if (!existsSync(dir)) {
    console.error(`No case directory at ${dir}.`);
    process.exit(1);
  }
  for (const f of readdirSync(dir).sort()) if (f.endsWith(".json")) files.push(join(dir, f));
}

// The registered tools, their input schemas and annotations, from the server itself.
const lister = await startServer({ name: "case-pass-list" });
const listed = await lister.rpc("tools/list", {});
lister.stop();
const tools = new Map((listed.result?.tools ?? []).map((t) => [t.name, t.inputSchema ?? null]));
const writesStore = new Set((listed.result?.tools ?? []).filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name));
const defaultLister = await startServer({ name: "case-pass-list-default", env: { SUI_TOOLS: "" } });
const defaultListed = await defaultLister.rpc("tools/list", {});
defaultLister.stop();
const listChars = (r) => JSON.stringify(r.result?.tools ?? []).length;
const toolsList = {};
for (const [label, key, r] of [["default profile", "default", defaultListed], ["SUI_TOOLS=all", "all", listed]]) {
  const chars = listChars(r);
  toolsList[key] = { tools: r.result?.tools?.length ?? 0, chars, tokens: tokens(chars) };
  console.log(`tools/list, ${label}: ${r.result?.tools?.length ?? 0} tools, ${kchars(chars)} chars ≈ ${kchars(tokens(chars))} tokens`);
}
if (tools.size === 0) {
  console.error("tools/list returned no tools.");
  process.exit(1);
}

const problems = [];
const cases = [];
const slugs = new Map();
for (const file of files) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    problems.push(`${file}: not valid JSON: ${err.message}`);
    continue;
  }
  const errors = validateCase(parsed, { tools, file: basename(file) });
  if (parsed?.slug && slugs.has(parsed.slug)) errors.push(`slug: "${parsed.slug}" is also used by ${slugs.get(parsed.slug)}`);
  if (parsed?.slug) slugs.set(parsed.slug, file);
  if (errors.length) {
    console.log(`\n!! ${file} breaks the case contract (cases/README.md):`);
    for (const e of errors) console.log(`     ${e}`);
    problems.push(`${file}: ${errors.length} contract error(s)`);
    continue;
  }
  cases.push({ file, rel: relative(ROOT, file).split(sep).join("/"), c: parsed });
}

let tier = "full";
let picked = cases.map((entry) => ({ ...entry, checks: entry.c.checks }));
if (smoke) {
  tier = "smoke";
  picked = pickSmoke(cases);
} else if (affectedRange) {
  let reach;
  try {
    reach = affectedBy(affectedRange, ROOT, { registered: [...tools.keys()] });
  } catch (err) {
    console.error(`--affected ${affectedRange}: ${String(err.message ?? err).split("\n")[0]}`);
    process.exit(2);
  }
  tier = reach.full ? "affected (full: the change reaches everything)" : "affected";
  console.log(`\nchanges in ${affectedRange}:`);
  for (const note of reach.notes) console.log(`   ${note}`);
  if (!reach.notes.length) console.log("   none that reach a check");
  if (!reach.full) console.log(`   ${reach.tools.size} tool(s) reached: ${[...reach.tools].sort().join(", ") || "none"}`);
  picked = pickAffected(cases, reach);
}

const selected = picked
  .filter(({ c }) => !onlyCase || c.slug === onlyCase)
  .map((entry) => ({ ...entry, checks: entry.checks.filter((ck) => !onlyCheck || ck.id === onlyCheck) }))
  .filter(({ checks }) => checks.length > 0);
if ((onlyCase || onlyCheck) && selected.length === 0) {
  console.error(`No valid case matches${onlyCase ? ` --case ${onlyCase}` : ""}${onlyCheck ? ` --check ${onlyCheck}` : ""}${tier === "full" ? "" : ` in the ${tier} tier`}.`);
  process.exit(2);
}
const allChecks = cases.reduce((n, { c }) => n + c.checks.length, 0);
const pickedChecks = selected.reduce((n, { checks }) => n + checks.length, 0);
console.log(`\ntier ${tier}: ${pickedChecks} of ${allChecks} check(s) in ${selected.length} case(s), ${jobs} at a time`);
if (process.env.SUI_REPLAY_DIR) console.log(`replaying fixed chain reads from ${process.env.SUI_REPLAY_DIR}`);

/** Run one case's checks in order on `server`; returns its printed lines and results. */
async function runCase({ c, checks }, server) {
  const lines = [`\n${c.slug}  ${c.title}`];
  const calls = [];
  const caseProblems = [];
  let caseChars = 0;
  for (const ck of checks) {
    const args = substitute(ck.args, c.subjects);
    if (tools.get(ck.tool)?.properties?.network && !Object.hasOwn(args, "network")) args.network = c.network;
    const timeoutS = ck.timeout_s ?? DEFAULT_TIMEOUT_S;
    const msg = await server.callRaw(ck.tool, args, timeoutS * 1000);
    const response = toResponse(msg);
    const chars = response.text.length;
    caseChars += chars;
    const budget = budgetFor(ck.tool, args);

    const failures = [];
    if (response.timedOut) failures.push(`timed out after ${timeoutS}s`);
    else {
      if (ck.max_chars !== undefined && chars > ck.max_chars) failures.push(`${chars} characters, over max_chars ${ck.max_chars}`);
      if (chars > budget) failures.push(`${chars} characters, over the ${ck.tool} budget of ${budget} (scripts/probe/lib/size-budget.mjs)`);
      for (const e of ck.expect) {
        const want = { ...e, ...(Object.hasOwn(e, "value") ? { value: substitute(e.value, c.subjects) } : {}) };
        const { ok, got } = evaluate(want, resolveCheckPath(response, e.path));
        if (!ok) failures.push(`${e.path === "" ? '""' : e.path} ${e.op}${Object.hasOwn(e, "value") ? ` ${show(want.value, 80)}` : ""}${e.op === "approx" ? ` ±${e.tolerance}` : ""}: got ${got}`);
      }
      if (failures.length && response.isError) failures.push(`the tool returned an error: ${show(response.text, 200)}`);
    }

    const status = failures.length === 0 ? (ck.known_defect ? "fixed" : "pass") : ck.known_defect ? "known" : "FAIL";
    calls.push({ case: c.slug, check: ck.id, tool: ck.tool, chars, tokens: tokens(chars), budget, ms: msg.ms, status, timed_out: Boolean(response.timedOut) });
    const label = { pass: "pass ", FAIL: "FAIL ", known: "known", fixed: "FIXED" }[status];
    lines.push(`   ${label}  ${ck.id.padEnd(28)} ${ck.tool.padEnd(28)} ${(msg.ms / 1000).toFixed(1).padStart(6)}s ${String(chars).padStart(8)} ch ≈${String(tokens(chars)).padStart(6)} tok`);
    if (status === "known") lines.push(`          known defect: ${ck.known_defect}`);
    if (status === "fixed") lines.push(`          passes now; remove known_defect ("${ck.known_defect}")`);
    if (status !== "pass") for (const f of failures) lines.push(`          ${f}`);
    if (status === "FAIL") caseProblems.push(`${c.slug}/${ck.id}: ${failures[0]}`);
    if (status === "fixed") caseProblems.push(`${c.slug}/${ck.id}: fixed, remove known_defect`);
  }
  lines.push(`   case ${c.slug}: ${checks.length} calls, ${kchars(caseChars)} chars ≈ ${kchars(tokens(caseChars))} tokens`);
  return { lines, calls, problems: caseProblems, chars: caseChars };
}

/** A case on a server of its own, stopped afterwards. */
async function runAlone(entry) {
  const server = await startServer({ name: `case-${entry.c.slug}`, replay: true });
  try {
    return await runCase(entry, server);
  } finally {
    server.stop();
  }
}

// Results print in case order as they complete, so a parallel run reads like a serial one.
const results = new Array(selected.length);
let printed = 0;
function settle(i, result) {
  results[i] = result;
  while (printed < results.length && results[printed]) for (const line of results[printed++].lines) console.log(line);
}

if (jobs === 1) {
  for (let i = 0; i < selected.length; i++) settle(i, await runAlone(selected[i]));
} else {
  const isolated = [];
  const pooled = [];
  selected.forEach((entry, i) => (entry.checks.some((ck) => writesStore.has(ck.tool)) ? isolated : pooled).push(i));
  if (pooled.length) {
    const shared = await startServer({ name: "case-pass-shared", replay: true });
    try {
      let next = 0;
      const worker = async () => {
        while (next < pooled.length) {
          const i = pooled[next++];
          settle(i, await runCase(selected[i], shared));
        }
      };
      await Promise.all(Array.from({ length: Math.min(jobs, pooled.length) }, worker));
    } finally {
      shared.stop();
    }
  }
  for (const i of isolated) settle(i, await runAlone(selected[i]));

  // A check that failed while the cases shared the budget runs again alone:
  // a tool with a wall-clock budget answers less under contention, and a
  // parallel run must not fail a check a serial run passes. It counts as
  // failed only if it fails again.
  const retry = pooled
    .map((i) => [i, selected[i].checks.filter((ck) => results[i].calls.some((call) => call.check === ck.id && call.status === "FAIL"))])
    .filter(([, checks]) => checks.length > 0);
  if (retry.length) {
    const n = retry.reduce((sum, [, checks]) => sum + checks.length, 0);
    console.log(`\nre-running alone the ${n} check(s) that failed while ${jobs} cases shared the budget:`);
  }
  for (const [i, checks] of retry) {
    const again = await runAlone({ ...selected[i], checks });
    for (const line of again.lines) console.log(line);
    const slug = selected[i].c.slug;
    for (const call of again.calls) {
      const at = results[i].calls.findIndex((c) => c.check === call.check);
      results[i].calls[at] = { ...call, under_jobs: results[i].calls[at].status };
    }
    results[i].problems = [...results[i].problems.filter((p) => !checks.some((ck) => p.startsWith(`${slug}/${ck.id}: `))), ...again.problems];
  }
}

const tally = { pass: 0, FAIL: 0, known: 0, fixed: 0 };
const calls = results.flatMap((r) => r.calls);
for (const call of calls) tally[call.status]++;
for (const r of results) problems.push(...r.problems);
const caseChars = results.map((r) => r.calls.reduce((n, call) => n + call.chars, 0));
const perCase = selected.map(({ c, checks }, i) => ({ case: c.slug, calls: checks.length, chars: caseChars[i], tokens: tokens(caseChars[i]) }));
const totalChars = caseChars.reduce((n, chars) => n + chars, 0);

const total = tally.pass + tally.FAIL + tally.known + tally.fixed;
const wallS = (Date.now() - started) / 1000;
console.log(`\n${"=".repeat(64)}`);
console.log(
  `${selected.length} case(s), ${total} check(s): ${tally.pass} pass, ${tally.FAIL} FAIL, ${tally.known} known defect, ${tally.fixed} fixed`,
);
console.log(`${total} calls, ${kchars(totalChars)} chars ≈ ${kchars(tokens(totalChars))} tokens, ${wallS.toFixed(0)}s wall time`);
if (problems.length) {
  console.log(`${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
}
if (summaryPath)
  writeFileSync(
    summaryPath,
    `${JSON.stringify(
      {
        tier,
        cases: selected.length,
        checks: total,
        tally,
        chars: totalChars,
        tokens: tokens(totalChars),
        wall_s: wallS,
        tools_list: toolsList,
        per_case: perCase,
        calls,
        problems,
      },
      null,
      2,
    )}\n`,
  );
