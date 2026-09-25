#!/usr/bin/env node
/**
 * Investigation regression: does this build still find everything the last one did?
 *
 * The most reliable test of an investigation tool is running real cases and
 * comparing against what it found before. Unit tests cannot do this — they
 * assert against fixtures, and the bugs that matter are the ones where a fact
 * the tool used to report quietly stops appearing.
 *
 * Two such shipped in one day: SuiNS aliases were resolved and then dropped on
 * the way into the response, and a transaction's protocols came back empty
 * because only Move calls were consulted and not events. Both are "something we
 * used to know is now missing", which is exactly what this catches.
 *
 * ## The assertion is a subset, not equality
 *
 * Chain state moves. New transactions arrive, old ones are pruned, prices
 * change. Demanding an identical result would fail on every run and teach
 * everyone to ignore it. So:
 *
 *   - a fact in the baseline that is NOT found now  -> FAIL, this is a regression
 *   - a fact found now that is not in the baseline  -> reported, not a failure
 *
 * New findings are the point of an upgrade. Losing old ones never is.
 *
 * ## Cases live outside the repo
 *
 * Real investigations concern real people, and the addresses in them should not
 * be committed. `SUI_CASES_FILE` points at a JSON file you keep privately, the
 * same arrangement `SUI_LABELS_FILE` uses for attribution: the mechanism ships,
 * the data does not. `cases/public-example.json` ships so the harness is
 * runnable by anyone, including CI, without touching anyone's real work.
 *
 * Usage:
 *   node scripts/investigation-regression.mjs                 # check against baseline
 *   node scripts/investigation-regression.mjs --update        # accept current as baseline
 *   SUI_CASES_FILE=~/cases.json node scripts/investigation-regression.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const casesPath = process.env.SUI_CASES_FILE
  ? resolve(process.env.SUI_CASES_FILE.replace(/^~/, process.env.HOME ?? "~"))
  : join(root, "cases", "public-example.json");
const baselinePath = casesPath.replace(/\.json$/, ".baseline.json");
const update = process.argv.includes("--update");

if (!existsSync(casesPath)) {
  console.error(`No cases file at ${casesPath}. Set SUI_CASES_FILE, or see cases/public-example.json.`);
  process.exit(2);
}

const { registerAllTools } = await import(join(root, "dist/tools/index.js"));
const tools = new Map();
// Tools register through registerTool, and registerAllTools hooks the protocol
// server's request handler to explain calls to disabled tools, so the stand-in
// needs both.
registerAllTools({
  tool: (name, _d, _s, handler) => tools.set(name, handler),
  registerTool: (name, _config, handler) => tools.set(name, handler),
  server: { setRequestHandler() {} },
});

/** Run a tool and parse its JSON payload. Never throws — a failure is a finding. */
async function call(name, args) {
  const handler = tools.get(name);
  if (!handler) return { __error: `no such tool: ${name}` };
  try {
    const res = await handler(args);
    const text = res?.content?.at(-1)?.text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return { __error: text.slice(0, 200) };
    }
  } catch (err) {
    return { __error: String(err?.message ?? err).slice(0, 200) };
  }
}

/**
 * Reduce a case to the facts that should never disappear.
 *
 * Deliberately excluded: query counts, timings, confidence labels and anything
 * priced. Those are expected to move, and comparing them would bury a real
 * regression in noise.
 */
async function factsFor(c) {
  const facts = new Set();
  const add = (kind, value) => facts.add(`${kind}\t${value}`);

  for (const address of c.addresses ?? []) {
    // First funding is permanent: the inflow that made a wallet exist cannot change.
    const f = await call("find_funding_source", { address, max_hops: c.max_hops ?? 4, measure_fanout: false });
    for (const step of f.chain ?? []) add("funded_by", `${step.address} <- ${step.funded_by}`);
    for (const l of [f.origin, ...(f.chain ?? []).flatMap((s) => [s.address_label, s.funder_label])]) {
      if (!l) continue;
      if (l.name) add("name", `${l.address} = ${l.name}`);
      for (const h of l.names_held ?? []) add("name_held", `${l.address} = ${h.name}`);
    }

    // Cluster membership should only ever grow as signals improve.
    const w = await call("build_wallet_edges", { addresses: [address], expand: true });
    for (const cl of w.clusters ?? []) for (const m of cl.members ?? []) add("clustered_with", `${address} ~ ${m.address}`);
    for (const e of w.edges ?? []) for (const t of e.signal_types ?? []) add("edge", `${e.wallet_a} ~ ${e.wallet_b} [${t}]`);
  }

  for (const digest of c.digests ?? []) {
    const t = await call("get_transaction", { digest });
    for (const p of t.protocols ?? []) add("protocol", `${digest} = ${p}`);
    for (const e of t.events ?? []) add("event_type", `${digest} = ${e.event_type}`);
  }

  return facts;
}

const cases = JSON.parse(readFileSync(casesPath, "utf8")).cases ?? [];
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
const current = {};
let lost = 0;
let gained = 0;

for (const c of cases) {
  process.stderr.write(`  running ${c.name} ...\n`);
  const facts = [...(await factsFor(c))].sort();
  current[c.name] = facts;

  const before = new Set(baseline[c.name] ?? []);
  const now = new Set(facts);
  const missing = [...before].filter((f) => !now.has(f));
  const added = [...now].filter((f) => !before.has(f));

  console.log(`\n${c.name}: ${facts.length} facts (${added.length} new, ${missing.length} lost)`);
  for (const m of missing) console.log(`  LOST   ${m.replace("\t", ": ")}`);
  for (const a of added.slice(0, 12)) console.log(`  new    ${a.replace("\t", ": ")}`);
  if (added.length > 12) console.log(`  new    ... and ${added.length - 12} more`);
  lost += missing.length;
  gained += added.length;
}

if (update) {
  writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
  console.log(`\nBaseline updated: ${baselinePath}`);
  process.exit(0);
}

console.log(`\n${gained} new facts, ${lost} lost.`);
if (lost > 0) {
  console.log("A lost fact means this build no longer finds something a previous one did.");
  console.log("Investigate before releasing. If the loss is correct — a signal was deliberately");
  console.log("removed, say — re-run with --update to accept the new baseline.");
  process.exit(1);
}
console.log("No regressions. New findings are gains; accept them with --update.");
