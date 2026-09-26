#!/usr/bin/env node
/**
 * Case pass: replay every investigation case file through the built server.
 *
 *   node scripts/probe/case-pass.mjs [--case <slug>] [--check <id>]
 *
 * Reads cases/incidents/*.json, plus every *.json in $SUI_CASES_DIR when set,
 * validates each against the contract in cases/README.md, runs each check's
 * tool call and evaluates its `expect` entries. A case gets its own server
 * and throwaway store. Every call's latency and size is printed; a call over
 * the check's `timeout_s` (default 120) or over its `max_chars` fails.
 *
 * A check marked `known_defect` that fails is reported as known and does not
 * fail the run. One that passes fails the run, so the marker gets removed.
 * Exits non-zero on any FAIL, any invalid case file, or a fixed known defect.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { startServer, ROOT } from "./lib/mcp-client.mjs";
import { DEFAULT_TIMEOUT_S, evaluate, resolveCheckPath, show, substitute, toResponse, validateCase } from "./lib/case-eval.mjs";

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

if (!existsSync(join(ROOT, "dist", "index.js"))) {
  console.error("dist/ is missing; run `npm run build` first. The cases drive the built tools.");
  process.exit(1);
}

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

// The registered tools and their input schemas, from the server itself.
const lister = await startServer({ name: "case-pass-list" });
const listed = await lister.rpc("tools/list", {});
lister.stop();
const tools = new Map((listed.result?.tools ?? []).map((t) => [t.name, t.inputSchema ?? null]));
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
  cases.push({ file, c: parsed });
}

const selected = cases
  .filter(({ c }) => !onlyCase || c.slug === onlyCase)
  .map(({ file, c }) => ({ file, c, checks: c.checks.filter((ck) => !onlyCheck || ck.id === onlyCheck) }))
  .filter(({ checks }) => checks.length > 0);
if ((onlyCase || onlyCheck) && selected.length === 0) {
  console.error(`No valid case matches${onlyCase ? ` --case ${onlyCase}` : ""}${onlyCheck ? ` --check ${onlyCheck}` : ""}.`);
  process.exit(2);
}

const tally = { pass: 0, FAIL: 0, known: 0, fixed: 0 };

for (const { c, checks } of selected) {
  console.log(`\n${c.slug}  ${c.title}`);
  const server = await startServer({ name: `case-${c.slug}` });
  try {
    for (const ck of checks) {
      const args = substitute(ck.args, c.subjects);
      if (tools.get(ck.tool)?.properties?.network && !Object.hasOwn(args, "network")) args.network = c.network;
      const timeoutS = ck.timeout_s ?? DEFAULT_TIMEOUT_S;
      const msg = await server.callRaw(ck.tool, args, timeoutS * 1000);
      const response = toResponse(msg);
      const chars = response.text.length;

      const failures = [];
      if (response.timedOut) failures.push(`timed out after ${timeoutS}s`);
      else {
        if (ck.max_chars !== undefined && chars > ck.max_chars) failures.push(`${chars} characters, over max_chars ${ck.max_chars}`);
        for (const e of ck.expect) {
          const want = { ...e, ...(Object.hasOwn(e, "value") ? { value: substitute(e.value, c.subjects) } : {}) };
          const { ok, got } = evaluate(want, resolveCheckPath(response, e.path));
          if (!ok) failures.push(`${e.path === "" ? '""' : e.path} ${e.op}${Object.hasOwn(e, "value") ? ` ${show(want.value, 80)}` : ""}${e.op === "approx" ? ` ±${e.tolerance}` : ""}: got ${got}`);
        }
        if (failures.length && response.isError) failures.push(`the tool returned an error: ${show(response.text, 200)}`);
      }

      const status = failures.length === 0 ? (ck.known_defect ? "fixed" : "pass") : ck.known_defect ? "known" : "FAIL";
      tally[status]++;
      const label = { pass: "pass ", FAIL: "FAIL ", known: "known", fixed: "FIXED" }[status];
      console.log(`   ${label}  ${ck.id.padEnd(28)} ${ck.tool.padEnd(28)} ${(msg.ms / 1000).toFixed(1).padStart(6)}s ${String(chars).padStart(8)} ch`);
      if (status === "known") console.log(`          known defect: ${ck.known_defect}`);
      if (status === "fixed") console.log(`          passes now; remove known_defect ("${ck.known_defect}")`);
      if (status !== "pass") for (const f of failures) console.log(`          ${f}`);
      if (status === "FAIL") problems.push(`${c.slug}/${ck.id}: ${failures[0]}`);
      if (status === "fixed") problems.push(`${c.slug}/${ck.id}: fixed, remove known_defect`);
    }
  } finally {
    server.stop();
  }
}

const total = tally.pass + tally.FAIL + tally.known + tally.fixed;
console.log(`\n${"=".repeat(64)}`);
console.log(
  `${selected.length} case(s), ${total} check(s): ${tally.pass} pass, ${tally.FAIL} FAIL, ${tally.known} known defect, ${tally.fixed} fixed`,
);
if (problems.length) {
  console.log(`${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
}
