#!/usr/bin/env node
/**
 * Compare regenerated data files with their committed copies and decide
 * whether the change is worth a release. Used by .github/workflows/data-sync.yml.
 *
 * Every sync stamps the run into its output: retrieval dates, the epoch and
 * checkpoint it read at, the upstream commit, a validator operation cap's
 * latest version. A weekly job that released whenever a file's bytes changed
 * would publish every Monday with nothing new in it. VOLATILE lists those
 * fields; they are ignored at any depth before comparing. They still ship, in
 * the next release that carries a real change.
 *
 * `stale` markers are ignored for the release decision too, so a source that
 * timed out once does not cut a release on its own, and reported separately so
 * a data PR says which sources were not reverified.
 *
 *   node scripts/data-sync-summary.mjs [--out summary.md] [--changelog note.md]
 *     [--github-output FILE] src/data/a.json ...
 *
 * Writes `material=true|false` to --github-output, a markdown summary to --out
 * and a one-line CHANGELOG bullet to --changelog.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export const VOLATILE = new Set([
  "generated_at", "retrieved_at", "synced_at", "data_as_of", "fetched_at",
  "checkpoint", "checkpoint_time", "epoch", "commit",
  // A monthly proof-of-reserves file has a new URL even when its addresses are unchanged.
  "snapshot", "source_url", "page_url", "document_url",
  // Bumped whenever a validator uses its operation cap, e.g. to set its gas price.
  "operation_cap_object_version", "operation_cap_source_tx", "operation_cap_source_tx_url",
  "stale", "stale_since", "stale_reason",
]);

const EXAMPLES = 5;

/** Drop volatile keys at any depth. */
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !VOLATILE.has(k)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Per top-level key: keyed collections report added/removed/changed keys,
 * lists report added/removed items, scalars report old → new. Volatile fields
 * are already gone, so anything reported here is a real change.
 */
export function diffData(before, after) {
  const a = stable(before ?? {});
  const b = stable(after ?? {});
  const changes = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key.startsWith("_") || same(a[key], b[key])) continue;
    // A collection missing on one side (a new file, a new section) diffs against an empty one.
    const empty = (v) => (Array.isArray(v) ? [] : v && typeof v === "object" ? {} : v);
    // Lists of records with an id (`sources`) diff by id, so an edited source reads as changed.
    const keyed = (v) => (Array.isArray(v) && v.length > 0 && v.every((e) => typeof e?.id === "string") ? Object.fromEntries(v.map((e) => [e.id, e])) : v);
    const ka = keyed(a[key]);
    const kb = keyed(b[key]);
    const x = ka === undefined ? empty(kb) : ka;
    const y = kb === undefined ? empty(ka) : kb;
    if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
      const added = Object.keys(y).filter((k) => !(k in x));
      const removed = Object.keys(x).filter((k) => !(k in y));
      const changed = Object.keys(y).filter((k) => k in x && !same(x[k], y[k]));
      changes.push({ key, added, removed, changed });
    } else if (Array.isArray(x) && Array.isArray(y)) {
      const xs = new Set(x.map((v) => JSON.stringify(v)));
      const ys = new Set(y.map((v) => JSON.stringify(v)));
      changes.push({ key, added: [...ys].filter((v) => !xs.has(v)), removed: [...xs].filter((v) => !ys.has(v)), changed: [] });
    } else {
      changes.push({ key, from: x, to: y });
    }
  }
  return changes;
}

/** Source ids (or the file itself) marked stale after the sync. */
export function staleSources(after) {
  const ids = (after?.sources ?? []).filter((s) => s?.stale).map((s) => s.id ?? "unnamed source");
  if (after?.stale === true && ids.length === 0) ids.push("whole file");
  return ids;
}

const short = (v) => (v === undefined ? "(none)" : typeof v === "string" ? v : JSON.stringify(v)).slice(0, 90);
const sample = (list) => list.slice(0, EXAMPLES).map((v) => `\`${short(v)}\``).join(", ") + (list.length > EXAMPLES ? ", …" : "");

export function describe(changes) {
  return changes.map((c) => {
    if ("from" in c) return `\`${c.key}\`: ${short(c.from)} → ${short(c.to)}`;
    const parts = [];
    if (c.added.length) parts.push(`+${c.added.length} (${sample(c.added)})`);
    if (c.removed.length) parts.push(`−${c.removed.length} (${sample(c.removed)})`);
    if (c.changed.length) parts.push(`~${c.changed.length} (${sample(c.changed)})`);
    return `\`${c.key}\`: ${parts.join(" ")}`;
  });
}

/** Counts only, for the CHANGELOG: `labels +2 −1 ~3`. */
export function tally(changes) {
  return changes.map((c) => {
    if ("from" in c) return `${c.key} updated`;
    const n = [c.added.length && `+${c.added.length}`, c.removed.length && `−${c.removed.length}`, c.changed.length && `~${c.changed.length}`];
    return `${c.key} ${n.filter(Boolean).join(" ")}`;
  }).join(", ");
}

function committed(path) {
  try {
    const text = execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function main(argv) {
  const opt = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const out = opt("--out");
  const changelog = opt("--changelog");
  const githubOutput = opt("--github-output");
  const files = argv;
  if (files.length === 0) throw new Error("usage: data-sync-summary.mjs [--out FILE] [--changelog FILE] [--github-output FILE] <data files>");

  let material = false;
  const lines = [];
  const tallies = [];
  const stale = [];
  for (const path of files) {
    const after = JSON.parse(readFileSync(path, "utf8"));
    const changes = diffData(committed(path), after);
    stale.push(...staleSources(after).map((id) => `${basename(path)}: ${id}`));
    if (changes.length === 0) continue;
    material = true;
    lines.push(`- **${basename(path)}**`, ...describe(changes).map((d) => `  - ${d}`));
    tallies.push(`\`${basename(path)}\` ${tally(changes)}`);
  }
  const md = [
    material ? "### Changed data" : "No data changed beyond retrieval dates, epochs and checkpoints.",
    ...lines,
    ...(stale.length ? ["", "### Not reverified this run (kept from the previous file, marked `stale`)", ...stale.map((s) => `- ${s}`)] : []),
  ].join("\n");
  if (out) writeFileSync(out, `${md}\n`);
  else console.log(md);
  if (changelog) {
    const staleNote = stale.length ? ` Not reverified, kept as \`stale\`: ${stale.join(", ")}.` : "";
    writeFileSync(changelog, `- **Data refresh.** ${tallies.join("; ") || "No material change"}.${staleNote}\n`);
  }
  if (githubOutput) appendFileSync(githubOutput, `material=${material}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
