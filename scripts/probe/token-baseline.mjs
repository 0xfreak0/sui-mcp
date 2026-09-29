#!/usr/bin/env node
/**
 * Context-cost baseline: what the tool definitions and the tools' answers
 * cost a model, in characters and estimated tokens (chars / 4, as in
 * lib/size-budget.mjs). It measures and never fails on a size; verify:live
 * does not run it.
 *
 *   node scripts/probe/token-baseline.mjs [--summary <case-pass.json> | --full] [--out <prefix>]
 *
 * Reports:
 *
 * 1. tools/list for each startup selection: `core`, `core` plus each other
 *    profile, and `all`, measured as case-pass measures it (the JSON of the
 *    listed tools). `enable_tools` names every tool that is off, so its
 *    entry is given per selection.
 * 2. Each tool's definition from the `SUI_TOOLS=all` listing: description,
 *    input schema and the whole entry, largest first.
 * 3. Each tool's answer size over case-pass calls: calls, median and max.
 *    A timed-out call has no answer to measure and is listed apart.
 * 4. The ten largest single answers, with their tool and args.
 *
 * Answer sizes come from a case-pass `--summary` file: the one `--summary`
 * names, or else a case-pass run this script starts (`--smoke`, or every
 * check with `--full`) with its output on stderr. Set `SUI_REPLAY_DIR` to
 * replay fixed chain reads in that run. A summary names each call by case
 * slug and check id; the args are read back from the case files and filled
 * in as case-pass fills them.
 *
 * `--out <prefix>` writes `<prefix>.json` and `<prefix>.md`, and keeps the
 * summary of a case-pass run it started as `<prefix>.case-pass.json`, which
 * `--summary` reads again. Without `--out` the Markdown goes to stdout.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startServer, ROOT } from "./lib/mcp-client.mjs";
import { tokens } from "./lib/size-budget.mjs";
import { substitute } from "./lib/case-eval.mjs";

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
const summaryArg = argValue("--summary");
const outPrefix = argValue("--out");
const full = process.argv.includes("--full");
if (summaryArg && full) {
  console.error("--summary reads a finished run; --full starts one. Pick one.");
  process.exit(2);
}

const dist = join(ROOT, "dist", "index.js");
if (!existsSync(dist)) {
  console.error("dist/index.js is missing: run `npm run build` first.");
  process.exit(1);
}
const { PROFILE_NAMES, PROFILES } = await import(pathToFileURL(join(ROOT, "dist", "tools", "profiles.js")).href);

// 1. tools/list per startup selection.
const selections = [["core"], ...PROFILE_NAMES.filter((p) => p !== "core").map((p) => ["core", p]), ["all"]];
const toolsList = [];
let allTools = [];
for (const picked of selections) {
  const env = picked.join(",");
  const server = await startServer({ name: `token-baseline-${picked.join("-")}`, env: { SUI_TOOLS: env } });
  const listed = await server.rpc("tools/list", {});
  server.stop();
  const list = listed.result?.tools;
  if (!Array.isArray(list) || list.length === 0) {
    console.error(`tools/list with SUI_TOOLS=${env} returned no tools: ${JSON.stringify(listed.error ?? listed).slice(0, 200)}`);
    process.exit(1);
  }
  const chars = JSON.stringify(list).length;
  const enableTools = list.find((t) => t.name === "enable_tools");
  toolsList.push({
    selection: picked.join(" + "),
    sui_tools: env,
    tools: list.length,
    chars,
    tokens: tokens(chars),
    enable_tools_chars: enableTools ? JSON.stringify(enableTools).length : null,
  });
  if (env === "all") allTools = list;
}

// 2. Each tool's definition.
const profilesOf = (name) => PROFILE_NAMES.filter((p) => PROFILES[p].includes(name));
const definitions = allTools
  .map((t) => {
    const entry = JSON.stringify(t).length;
    return {
      tool: t.name,
      profiles: profilesOf(t.name),
      description_chars: (t.description ?? "").length,
      schema_chars: JSON.stringify(t.inputSchema ?? {}).length,
      entry_chars: entry,
      entry_tokens: tokens(entry),
    };
  })
  .sort((a, b) => b.entry_chars - a.entry_chars || a.tool.localeCompare(b.tool));

// 3 and 4. Answer sizes from a case-pass summary.
let summaryPath = summaryArg;
let scratch = null;
let source = summaryArg ? `case-pass summary ${summaryArg}` : null;
if (!summaryPath) {
  if (outPrefix) summaryPath = `${outPrefix}.case-pass.json`;
  else {
    scratch = mkdtempSync(join(tmpdir(), "token-baseline-"));
    summaryPath = join(scratch, "case-pass.json");
  }
  rmSync(summaryPath, { force: true });
  const tierArgs = full ? [] : ["--smoke"];
  source =
    `case-pass ${full ? "(every check)" : "--smoke"}, one case at a time` +
    (process.env.SUI_REPLAY_DIR ? `, replaying fixed reads from ${process.env.SUI_REPLAY_DIR}` : ", every read live") +
    (scratch ? "" : `; summary kept as ${summaryPath}`);
  console.error(`running ${source}; its output follows on stderr`);
  // stdout goes to our stderr, so stdout carries only the report.
  const run = spawnSync(process.execPath, [join(ROOT, "scripts", "probe", "case-pass.mjs"), ...tierArgs, "--summary", summaryPath], {
    cwd: ROOT,
    stdio: ["ignore", 2, 2],
  });
  // A failed check still measured its answer; only a missing summary stops the report.
  if (!existsSync(summaryPath)) {
    console.error(`case-pass exited ${run.status} and wrote no summary`);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
  }
}
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
if (scratch) rmSync(scratch, { recursive: true, force: true });

// Case files by slug, from the same directories case-pass reads.
const caseDirs = [join(ROOT, "cases", "incidents"), ...(process.env.SUI_CASES_DIR ? [process.env.SUI_CASES_DIR] : [])];
const casesBySlug = new Map();
for (const dir of caseDirs)
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (c?.slug) casesBySlug.set(c.slug, c);
    } catch {
      // case-pass reports an unreadable case file; it has no calls here.
    }
  }
const schemaOf = new Map(allTools.map((t) => [t.name, t.inputSchema ?? null]));
/** The args case-pass sent for one check, or null when its case file is not here. */
function argsOf(slug, checkId, tool) {
  const c = casesBySlug.get(slug);
  const ck = c?.checks?.find((k) => k.id === checkId);
  if (!ck) return null;
  const args = substitute(ck.args, c.subjects);
  if (schemaOf.get(tool)?.properties?.network && !Object.hasOwn(args, "network")) args.network = c.network;
  return args;
}

const median = (sorted) => {
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const measured = summary.calls.filter((c) => !c.timed_out);
const timedOut = summary.calls.filter((c) => c.timed_out).map((c) => ({ tool: c.tool, case: c.case, check: c.check }));
const byTool = new Map();
for (const c of measured) byTool.set(c.tool, [...(byTool.get(c.tool) ?? []), c]);
const perTool = [...byTool]
  .map(([tool, calls]) => {
    const sizes = calls.map((c) => c.chars).sort((a, b) => a - b);
    const top = calls.reduce((a, b) => (b.chars > a.chars ? b : a));
    const med = median(sizes);
    const total = sizes.reduce((n, s) => n + s, 0);
    return {
      tool,
      calls: calls.length,
      median_chars: med,
      median_tokens: tokens(med),
      max_chars: top.chars,
      max_tokens: tokens(top.chars),
      max_call: `${top.case}/${top.check}`,
      total_chars: total,
    };
  })
  .sort((a, b) => b.max_chars - a.max_chars || a.tool.localeCompare(b.tool));
const notMeasured = allTools.map((t) => t.name).filter((name) => !byTool.has(name)).sort();
const largest = [...measured]
  .sort((a, b) => b.chars - a.chars)
  .slice(0, 10)
  .map((c) => ({ tool: c.tool, case: c.case, check: c.check, chars: c.chars, tokens: c.tokens, budget: c.budget, status: c.status, args: argsOf(c.case, c.check, c.tool) }));
const measuredChars = measured.reduce((n, c) => n + c.chars, 0);

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const report = {
  generated_at: new Date().toISOString(),
  version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  commit: git("rev-parse", "HEAD"),
  uncommitted_changes: git("status", "--porcelain", "--untracked-files=no") !== "",
  token_estimate: "chars / 4",
  tools_list: toolsList,
  tool_definitions: definitions,
  outputs: {
    source,
    tier: summary.tier,
    cases: summary.cases,
    calls: summary.calls.length,
    tally: summary.tally,
    measured_calls: measured.length,
    measured_chars: measuredChars,
    measured_tokens: tokens(measuredChars),
    timed_out: timedOut,
    per_tool: perTool,
    tools_not_called: notMeasured,
    largest,
  },
};

// Markdown.
const n = (v) => v.toLocaleString("en-US");
const md = [];
md.push(`# Token baseline, sui-analytics-mcp ${report.version}`, "");
md.push(
  `Commit \`${report.commit.slice(0, 12)}\`${report.uncommitted_changes ? " with uncommitted changes" : ""}, measured ${report.generated_at}. ` +
    "Tokens are estimated as characters / 4.",
  "",
);
md.push("## tools/list per startup selection", "", "| Selection | `SUI_TOOLS` | Tools | Chars | ≈ Tokens | `enable_tools` chars |", "|---|---|--:|--:|--:|--:|");
for (const s of toolsList)
  md.push(`| ${s.selection} | \`${s.sui_tools}\` | ${s.tools} | ${n(s.chars)} | ${n(s.tokens)} | ${s.enable_tools_chars === null ? "not listed" : n(s.enable_tools_chars)} |`);
md.push("");
md.push(
  "## Tool definitions, largest first",
  "",
  "From the `SUI_TOOLS=all` listing. Description is the text's length, Schema the input schema's JSON, and Entry the tool's whole JSON object in tools/list. " +
    "The `enable_tools` row is its `all` entry; the table above gives it per selection.",
  "",
  "| Tool | Profiles | Description | Schema | Entry | ≈ Tokens |",
  "|---|---|--:|--:|--:|--:|",
);
for (const d of definitions)
  md.push(`| \`${d.tool}\` | ${d.profiles.join(", ") || "always on"} | ${n(d.description_chars)} | ${n(d.schema_chars)} | ${n(d.entry_chars)} | ${n(d.entry_tokens)} |`);
md.push("");
const o = report.outputs;
md.push(
  "## Answer size per tool, over case-pass calls",
  "",
  `Source: ${o.source}. Tier \`${o.tier}\`, ${o.cases} case(s), ${o.calls} call(s) (${o.tally.pass} pass, ${o.tally.FAIL} FAIL, ${o.tally.known} known defect, ${o.tally.fixed} fixed). ` +
    `${o.measured_calls} measured, ${n(o.measured_chars)} chars ≈ ${n(o.measured_tokens)} tokens. Sorted by the largest call.`,
  "",
  "| Tool | Calls | Median chars | ≈ Tokens | Max chars | ≈ Tokens | Largest call |",
  "|---|--:|--:|--:|--:|--:|---|",
);
for (const t of o.per_tool)
  md.push(`| \`${t.tool}\` | ${t.calls} | ${n(t.median_chars)} | ${n(t.median_tokens)} | ${n(t.max_chars)} | ${n(t.max_tokens)} | ${t.max_call} |`);
md.push("");
if (o.timed_out.length) md.push(`Timed out, no answer measured: ${o.timed_out.map((c) => `\`${c.tool}\` (${c.case}/${c.check})`).join(", ")}.`, "");
md.push(
  o.tools_not_called.length
    ? `Listed tools no measured call reached (${o.tools_not_called.length}): ${o.tools_not_called.map((t) => `\`${t}\``).join(", ")}.`
    : "Every listed tool has a measured call.",
  "",
);
md.push("## Ten largest single answers", "", "| # | Tool | Call | Chars | ≈ Tokens | Budget | Args |", "|--:|---|---|--:|--:|--:|---|");
largest.forEach((c, i) => {
  const args = c.args === null ? "case file not found" : `\`${JSON.stringify(c.args).replaceAll("|", "\\|")}\``;
  md.push(`| ${i + 1} | \`${c.tool}\` | ${c.case}/${c.check} | ${n(c.chars)} | ${n(c.tokens)} | ${n(c.budget)} | ${args} |`);
});
md.push("");
const markdown = md.join("\n");

if (outPrefix) {
  writeFileSync(`${outPrefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${outPrefix}.md`, markdown);
  console.error(`wrote ${outPrefix}.json and ${outPrefix}.md`);
} else process.stdout.write(markdown);
