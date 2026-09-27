#!/usr/bin/env node
/**
 * Detector pass: score the anomaly detectors on a labelled set of mainnet
 * transactions, so a rule fitted to one incident is judged on the others and
 * on ordinary traffic its author never saw before it ships.
 *
 *   node scripts/probe/detector-pass.mjs [--json] [--split tuning|holdout]
 *                                        [--only positives|negatives]
 *                                        [--incident <id>] [--digest <digest>]
 *                                        [--write-ceilings]
 *
 * Reads cases/detectors.json (format in cases/README.md): exploit and attack
 * transactions from cases/incidents labelled positive, and ordinary mainnet
 * transactions labelled negative, each in one of two splits. `tuning` holds
 * what rule authors looked at: the incidents the rules were designed from or
 * tuned with, and the negatives they cleared. `holdout` holds incidents added
 * after the rules were written and a random sample of negatives drawn
 * afterwards, none of which they saw. Every transaction goes through
 * analyze_attack_tx, decode_ptb by digest, and decode_ptb on its own BCS
 * (`decode_ptb_bytes`, the pre-sign mode, which sees no effects).
 *
 * The report gives, per tool and anomaly code, the true positives, the false
 * positives and their rate on each split, and a leave-one-out table: for each
 * incident, which detectors fire on it and which of those neither were
 * designed from it nor were tuned while it was labelled, and for each
 * detector whether it detects only the incident it was designed from. Each
 * holdout incident is listed with every medium or high flag on each of its
 * positives, so a reader can judge whether a flag names the flaw or only
 * the loss.
 *
 * Exits 1 when a tuning negative gets a medium or high flag that
 * `accepted_fps` does not list, when an accepted false positive no longer
 * fires (remove it), when a positive loses a `detected_by` detection, or when
 * a tool call fails. Holdout negatives are gated by rate: on a run of the
 * whole holdout split, a kind whose medium-or-high count differs from its
 * `holdout_ceilings` count fails, up (a regression) or down (lower the
 * ceiling). `--write-ceilings` records the measured counts as the new
 * ceilings after a clean run of the whole holdout split; a rise recorded
 * that way needs its reason in the commit.
 *
 * `--split` runs one split's positives and negatives. `--json` prints the
 * whole report as JSON on stdout and progress on stderr.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, gql, ROOT } from "./lib/mcp-client.mjs";
import { SPLITS, TOOLS, ceilingsFrom, flagsOf, scoreRun, validateLabels } from "./lib/detector-eval.mjs";

const argv = process.argv.slice(2);
function argValue(flag, allowed) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--") || (allowed && !allowed.includes(v))) {
    console.error(`${flag} needs a value${allowed ? `: ${allowed.join(" or ")}` : ""}`);
    process.exit(2);
  }
  return v;
}
const asJson = argv.includes("--json");
const writeCeilings = argv.includes("--write-ceilings");
const only = argValue("--only", ["positives", "negatives"]);
const onlySplit = argValue("--split", SPLITS);
const onlyIncident = argValue("--incident");
const onlyDigest = argValue("--digest");
const log = asJson ? (...a) => console.error(...a) : (...a) => console.log(...a);
const CALL_TIMEOUT_MS = 180_000;

if (!existsSync(join(ROOT, "dist", "index.js"))) {
  console.error("dist/ is missing; run `npm run build` first. The detector pass drives the built tools.");
  process.exit(1);
}

const set = JSON.parse(readFileSync(join(ROOT, "cases", "detectors.json"), "utf8"));
const caseSlugs = new Set(
  readdirSync(join(ROOT, "cases", "incidents"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5)),
);
const invalid = validateLabels(set, { caseSlugs });
if (invalid.length) {
  console.error("cases/detectors.json is invalid:");
  for (const e of invalid) console.error(`  - ${e}`);
  process.exit(1);
}

const picked = [
  ...(only === "negatives" ? [] : set.positives.filter((p) => !onlySplit || p.split === onlySplit).map((p) => ({ ...p, label: `positive ${p.split}` }))),
  ...(only === "positives" ? [] : set.negatives.filter((n) => !onlySplit || n.split === onlySplit).map((n) => ({ ...n, label: n.split }))),
].filter((e) => (!onlyIncident || e.incident === onlyIncident) && (!onlyDigest || e.digest === onlyDigest));
if (!picked.length) {
  console.error("No labelled transaction matches the filters.");
  process.exit(2);
}

const server = await startServer({ name: "detector-pass" });
const transient = (msg) => /timed out|429|rate|fetch failed|ECONNRESET|503|502|UNAVAILABLE|DEADLINE|Unexpected token/i.test(msg);

/** Retry once after a transient failure. Returns `{ value }` or `{ error }`. */
async function retried(what, fn) {
  for (let attempt = 1; ; attempt++) {
    let error;
    try {
      const r = await fn();
      if (r.error === undefined) return r;
      error = r.error;
    } catch (err) {
      error = String(err?.message ?? err);
    }
    if (attempt >= 2 || !transient(error)) return { error: `${what} failed: ${error}` };
    await new Promise((res) => setTimeout(res, 5000));
  }
}

/** One tool's flags on one transaction. */
async function run(tool, digest) {
  let args = { digest };
  if (tool === "decode_ptb_bytes") {
    const bcs = await retried("reading the transaction's BCS", async () => {
      const bytes = (await gql("query($d:String!){ transaction(digest:$d){ transactionBcs } }", { d: digest })).transaction?.transactionBcs;
      return bytes ? { value: bytes } : { error: "the chain returned no transactionBcs" };
    });
    if (bcs.error) return bcs;
    args = { transaction_bcs: bcs.value };
  }
  return retried(tool, async () => {
    const r = await server.call(tool === "decode_ptb_bytes" ? "decode_ptb" : tool, args, CALL_TIMEOUT_MS);
    const error = r._error ?? (r._isError ? String(r._text ?? r.error ?? "tool error").slice(0, 300) : undefined);
    return error === undefined ? { value: flagsOf(tool, r) } : { error };
  });
}

const SHORT = { analyze_attack_tx: "atk", decode_ptb: "ptb", decode_ptb_bytes: "bcs" };
const results = new Map();
const t0 = Date.now();
let i = 0;
for (const e of picked) {
  i++;
  const flags = [];
  const errors = [];
  const ms = [];
  for (const tool of TOOLS) {
    const t = Date.now();
    const r = await run(tool, e.digest);
    ms.push(Date.now() - t);
    if (r.error) errors.push(r.error);
    else flags.push(...r.value);
  }
  results.set(e.digest, { flags, errors });
  const shown = flags.filter((f) => f.severity !== "info").map((f) => `${SHORT[f.tool]}:${f.code}@${f.severity}`);
  const label = { "positive tuning": "POS", "positive holdout": "PHD", tuning: "tun", holdout: "HLD" }[e.label];
  log(
    `${String(i).padStart(3)}/${picked.length} ${label} ${e.digest.padEnd(44)} ${(e.incident ?? e.protocol).slice(0, 22).padEnd(22)} ${ms.map((m) => `${(m / 1000).toFixed(1)}s`).join("/")}  ${errors.length ? `ERROR ${errors.join("; ").slice(0, 160)}` : shown.join(" ") || "-"}`,
  );
}
server.stop();

const report = scoreRun(set, results);
let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
} catch {
  // Not a git checkout; the report still names the package version.
}
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

if (writeCeilings) {
  const ceilings = ceilingsFrom(report, `${version} ${commit ?? ""}, ${new Date().toISOString().slice(0, 10)}`.trim());
  const otherFailures = report.failures.filter((f) => !f.startsWith("holdout rate"));
  if (!ceilings) console.error("--write-ceilings needs a run of the whole holdout split; nothing written.");
  else if (otherFailures.length) console.error("--write-ceilings needs a run with no other failures; nothing written.");
  else {
    const path = join(ROOT, "cases", "detectors.json");
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.holdout_ceilings = ceilings;
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
    report.failures = otherFailures;
    for (const k of report.holdout_gate.kinds) k.status = "recorded";
    console.error(`Wrote holdout_ceilings for ${Object.keys(ceilings.kinds).length} kinds to cases/detectors.json.`);
  }
}
const full = {
  generated_at: new Date().toISOString(),
  build: { version, commit },
  filters: { only: only ?? null, split: onlySplit ?? null, incident: onlyIncident ?? null, digest: onlyDigest ?? null },
  elapsed_s: Math.round((Date.now() - t0) / 1000),
  ...report,
};

if (asJson) {
  console.log(JSON.stringify(full, null, 2));
} else {
  const pct = (x) => (x === null ? "-" : `${(x * 100).toFixed(1)}%`);
  const c = report.counts;
  const splits = SPLITS.filter((s) => c.splits[s].negatives > 0);
  log(`\n${"=".repeat(78)}`);
  log(`${c.positives} positives across ${c.incidents} incidents. Build ${version} ${commit ?? ""}.`);
  for (const s of SPLITS.filter((s) => c.splits[s].positives > 0))
    log(
      `${s} positives: ${c.splits[s].positives_detected} of ${c.splits[s].positives} detected, ${c.splits[s].incidents_detected} of ${c.splits[s].incidents} incidents.`,
    );
  for (const s of splits)
    log(
      `${s}: ${c.splits[s].negatives} negatives; ${c.splits[s].with_medium_high} with a medium or high flag, ${c.splits[s].with_any_flag} with any flag, ${c.splits[s].failures} failing.`,
    );

  log("\nPer detector (medium and high count as detections; info only in FPany)");
  log(
    `  ${"kind".padEnd(46)} ${"TP".padStart(3)} ${"oth".padStart(3)}  ${splits.map((s) => `${`FP ${s}`.padStart(13)} ${"rate".padStart(6)} ${"any".padStart(4)}`).join("  ")}  origin+tuned -> detects [held out]`,
  );
  for (const k of report.kinds) {
    const origin = k.origin_incidents === null ? "?" : k.origin_incidents.join(",") || "none";
    const tuned = k.tuned_with?.length ? ` +tuned(${k.tuned_with.length})` : "";
    const onlyO = k.only_on_origin === null ? "" : k.only_on_origin ? "  ONLY ORIGIN" : "";
    log(
      `  ${k.kind.padEnd(46)} ${String(k.true_positives).padStart(3)} ${String(k.other_positive_hits).padStart(3)}  ${splits
        .map((s) => `${String(k.fp[s].medium_high).padStart(13)} ${pct(k.fp[s].rate_medium_high).padStart(6)} ${String(k.fp[s].any).padStart(4)}`)
        .join("  ")}  ${origin}${tuned} -> ${k.detects_incidents.join(",") || "-"}${k.held_out_detects.length ? ` [${k.held_out_detects.join(",")}]` : ""}${onlyO}`,
    );
  }

  const gate = report.holdout_gate;
  log(`\nHoldout gate: medium-or-high count per kind against holdout_ceilings (${gate.measured_on ?? "none recorded"}), ${gate.negatives} negatives`);
  if (!gate.ran) log("  not judged: the run did not cover every holdout negative");
  for (const k of gate.kinds)
    log(
      `  ${k.kind.padEnd(46)} ceiling ${String(k.ceiling).padStart(3)} (${pct(k.ceiling_rate).padStart(6)})  measured ${k.measured === null ? "  -" : String(k.measured).padStart(3)} (${pct(k.measured_rate).padStart(6)})  ${k.status}`,
    );

  log("\nLeave one out, per incident (held out = detectors neither designed from it nor tuned while it was labelled)");
  for (const inc of report.incidents) {
    log(`  ${inc.incident.padEnd(28)} ${inc.positives_detected}/${inc.positives} detected${inc.split === "holdout" ? "  (holdout incident)" : ""}`);
    log(`    detected by: ${inc.detected_by.join(", ") || "NOTHING"}`);
    log(`    held out:    ${inc.held_out_detected_by.join(", ") || "none"}`);
    log(`    per tool:    ${TOOLS.map((t) => `${t} ${inc.detected_by_tool[t] ? "yes" : "no"}`).join(", ")}`);
    if (inc.other_flags.length) log(`    other flags: ${inc.other_flags.join(", ")}`);
  }

  const heldOutIncidents = report.incidents.filter((inc) => inc.split === "holdout");
  if (heldOutIncidents.length) {
    log("\nHoldout incidents: every medium or high flag per positive (detected = a reviewed detected_by entry matched)");
    for (const inc of heldOutIncidents) {
      log(`  ${inc.incident}  ${inc.positives_detected}/${inc.positives} detected`);
      for (const p of report.positives.filter((p) => p.incident === inc.incident)) {
        log(`    ${p.digest.padEnd(44)} ${p.detected ? "detected" : "missed  "}  ${p.role}`);
        for (const f of p.flag_details) {
          log(`      ${f.kind}@${f.severity}: ${f.text.slice(0, f.text.indexOf(" | ") >= 0 ? f.text.indexOf(" | ") : 160)}`);
          for (const ev of f.evidence.slice(0, 3)) log(`        ${ev.slice(0, 240)}`);
          if (f.evidence.length > 3) log(`        and ${f.evidence.length - 3} more evidence line(s) in --json`);
        }
        if (!p.flag_details.length) log("      no medium or high flag");
      }
    }
  }

  if (report.notes.length) {
    log("\nNotes");
    for (const n of report.notes) log(`  - ${n}`);
  }
  log(`\n${"=".repeat(78)}`);
  if (report.failures.length) {
    log(`${report.failures.length} FAILURE(S):`);
    for (const f of report.failures) log(`  - ${f}`);
  } else log("no failures");
}
if (report.failures.length) process.exitCode = 1;
