#!/usr/bin/env node
/**
 * Regenerate `src/data/deposit-labels.json`: exchange DEPOSIT addresses inferred
 * from the exchange wallets `src/data/disclosed-labels.json` already names.
 *
 * For each Sui mainnet `cex` wallet in the disclosed set, the latest pages of
 * its transactions give the addresses that paid into it, and the addresses
 * among its counterparties that render like another one (lookalikes). The
 * wallet's own latest transactions say whether it is deposit-shaped itself;
 * such a wallet is never a sweep target. Each sender, and every address the
 * previous file labelled, has its own latest transactions read and is kept
 * only when `inferDepositLabel` (src/utils/deposit-labels.ts) reads them as a
 * deposit address of that exchange and `sponsorRejection` clears its sweep
 * sponsors, each measured once with `measureFanout`. An address a disclosed
 * or curated label names, an object or package, a curated protocol address,
 * and an address sweeping to two exchanges are never labelled. A label names
 * the exchange only.
 *
 * Imports the built server (dist/), so `npm run sync:labels` builds first.
 *
 *   npm run sync:labels -- --exclude FILE | --no-exclude [--pages N]
 *     [--max-candidates N] [--concurrency N] [--state PATH] [--fresh]
 *
 *   --exclude         a text file; every 0x+64-hex address in it is dropped
 *                     before anything is read, so it is never read, stored in
 *                     the progress file or counted per exchange (addresses
 *                     private to a case never ship). Required, or
 *                     --no-exclude, when the previous file excluded any.
 *   --no-exclude      run without an exclusion list
 *   --pages           pages of 50 transactions read per exchange wallet (default 10)
 *   --max-candidates  senders scanned per exchange, in wallet then arrival order (default 1000)
 *   --concurrency     candidate scans in flight (default 4)
 *   --state           progress file, written owner-only; a run on the same day
 *                     with the same bounds and rule inputs resumes from it
 *                     (default: <tmpdir>/sui-mcp-sync-deposit-labels.json)
 *   --fresh           ignore the progress file
 *
 * Output order is stable: labels by key, exchanges by name, counts by reason.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// The dist modules read the network when they load.
process.env.SUI_NETWORK = "mainnet";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "src/data/deposit-labels.json");
const TODAY = new Date().toISOString().slice(0, 10);
const PREFIX = "sui:mainnet:";
const SPONSOR_FANOUT_TRANSACTIONS = 300;

const { values: flags } = parseArgs({
  options: {
    pages: { type: "string", default: "10" },
    "max-candidates": { type: "string", default: "1000" },
    concurrency: { type: "string", default: "4" },
    state: { type: "string", default: join(tmpdir(), "sui-mcp-sync-deposit-labels.json") },
    fresh: { type: "boolean", default: false },
    exclude: { type: "string" },
    "no-exclude": { type: "boolean", default: false },
  },
});
const positive = (name) => {
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got ${flags[name]}`);
  return n;
};
const bounds = { pages: positive("pages"), max_candidates: positive("max-candidates") };
const concurrency = positive("concurrency");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const previous = existsSync(OUT) ? readJson(OUT) : { labels: {} };

// Fail closed: a file built with an exclusion list is never rebuilt without one
// unless the caller says so.
if (flags.exclude && flags["no-exclude"]) throw new Error("--exclude and --no-exclude are exclusive");
if ((previous.method?.excluded_addresses ?? 0) > 0 && !flags.exclude && !flags["no-exclude"]) {
  throw new Error(
    `${OUT} was built with an exclusion list (${previous.method.excluded_addresses} addresses left out). ` +
      "Pass --exclude FILE with that list, or --no-exclude to build without one.",
  );
}
const excluded = new Set(
  flags.exclude ? (readFileSync(flags.exclude, "utf8").match(/0x[0-9a-fA-F]{64}/g) ?? []).map((a) => a.toLowerCase()) : [],
);

const {
  inferDepositLabel,
  inboundSenders,
  isDepositShaped,
  lookalikeSuspects,
  objectsAmong,
  readWalletPage,
  sponsorRejection,
  MIN_SWEEPS,
  EVIDENCE_TXS,
} = await import(join(root, "dist/utils/deposit-labels.js"));
const { readDepositPattern, scanForDeposit } = await import(join(root, "dist/utils/deposit.js"));
const { measureFanout } = await import(join(root, "dist/utils/fanout.js"));
const { isCuratedProtocol } = await import(join(root, "dist/protocols/registry.js"));
const { normalizeSuiAddress } = await import("@mysten/sui/utils");

const disclosed = readJson(join(root, "src/data/disclosed-labels.json"));
const curated = readJson(join(root, "src/data/labeled-addresses.json"));

// Every Sui address a disclosed or curated label names; none is relabelled.
const labelled = new Set();
for (const key of [...Object.keys(disclosed.labels ?? {}), ...Object.keys(curated.labels ?? {})]) {
  if (key.startsWith(PREFIX)) labelled.add(normalizeSuiAddress(key.slice(PREFIX.length)));
  else if (!key.includes(":")) labelled.add(normalizeSuiAddress(key));
}

// Disclosed exchange wallet -> exchange.
const exchangeWallets = new Map(
  Object.entries(disclosed.labels ?? {})
    .filter(([key, v]) => key.startsWith(PREFIX) && v.category === "cex" && v.entity)
    .map(([key, v]) => [normalizeSuiAddress(key.slice(PREFIX.length)), v.entity])
    .sort(([a], [b]) => a.localeCompare(b)),
);
const exchanges = [...new Set(exchangeWallets.values())].sort();

// ---------------------------------------------------------------------------
// Progress, so an interrupted run continues where it stopped.
// ---------------------------------------------------------------------------

// Reused only on the same day, for the same bounds and the same rule inputs:
// a result read under another rule, or days ago, is not this run's result.
const ruleHash = createHash("sha256");
for (const f of [
  "dist/utils/deposit-labels.js",
  "dist/utils/deposit.js",
  "dist/utils/sponsor-gas.js",
  "dist/utils/fanout.js",
  "dist/utils/address-lookalike.js",
  "src/data/disclosed-labels.json",
  "src/data/labeled-addresses.json",
  "src/data/protocols.json",
]) {
  ruleHash.update(readFileSync(join(root, f)));
}
const rule = ruleHash.digest("hex");
const fresh = () => ({ day: TODAY, bounds, rule, wallets: {}, candidates: {}, sponsors: {}, excluded_met: [] });
let state = !flags.fresh && existsSync(flags.state) ? readJson(flags.state) : fresh();
if (state.day !== TODAY || state.rule !== rule || JSON.stringify(state.bounds) !== JSON.stringify(bounds)) state = fresh();
// An address excluded now is dropped from what an earlier run of today kept.
for (const a of Object.keys(state.candidates)) if (excluded.has(a)) delete state.candidates[a];
for (const w of Object.values(state.wallets)) {
  w.senders = w.senders.filter((a) => !excluded.has(a));
  w.suspects = w.suspects.filter((a) => !excluded.has(a));
}
const save = () => {
  writeFileSync(flags.state, JSON.stringify(state), { mode: 0o600 });
  // `mode` applies only when the file is created.
  chmodSync(flags.state, 0o600);
};

// Distinct excluded addresses met as senders or previous labels, never read.
// The progress file keeps only their hashes, so a resumed run counts them too.
const excludedMet = new Set(state.excluded_met ?? []);
const keep = (a) => {
  if (!excluded.has(a)) return true;
  excludedMet.add(createHash("sha256").update(a).digest("hex"));
  state.excluded_met = [...excludedMet].sort();
  return false;
};

// ---------------------------------------------------------------------------
// 1. Every exchange wallet: who paid into it, its lookalikes, and whether it is
//    deposit-shaped itself.
// ---------------------------------------------------------------------------

let walletsRead = 0;
for (const [wallet, entity] of exchangeWallets) {
  if (state.wallets[wallet]) continue;
  const txs = [];
  let before = null;
  for (let page = 0; page < bounds.pages; page++) {
    const r = await readWalletPage(wallet, before);
    // Newest page first; within a page, newest last.
    txs.unshift(...r.txs);
    before = r.before;
    if (!before) break;
  }
  const own = readDepositPattern(await scanForDeposit(wallet, 50));
  state.wallets[wallet] = {
    entity,
    transactions: txs.length,
    window_complete: before === null,
    senders: inboundSenders([...txs].reverse(), wallet).filter(keep),
    suspects: [...lookalikeSuspects(txs, wallet)].filter((a) => !excluded.has(a)).sort(),
    deposit_shaped: isDepositShaped(own),
    sweeps_into: [...new Set(own.sweeps.filter((s) => s.full_balance === true).map((s) => s.destination))].sort(),
  };
  if (++walletsRead % 10 === 0) {
    save();
    console.log(`wallets: ${Object.keys(state.wallets).length}/${exchangeWallets.size}`);
  }
}
save();

const depositShaped = new Set([...exchangeWallets.keys()].filter((w) => state.wallets[w].deposit_shaped));
const ctx = {
  exchangeWallets,
  labelled,
  depositShaped,
  lookalikes: new Set(Object.values(state.wallets).flatMap((w) => w.suspects)),
  walletSweepsInto: new Map([...exchangeWallets.keys()].map((w) => [w, state.wallets[w].sweeps_into])),
};

// ---------------------------------------------------------------------------
// 2. Candidates per exchange, capped; the previous file's labels are re-read.
// ---------------------------------------------------------------------------

const perExchange = new Map(exchanges.map((e) => [e, { found: [], scanned: [] }]));
for (const [wallet, entity] of exchangeWallets) {
  // A sender into a deposit-shaped wallet pays a deposit address.
  if (depositShaped.has(wallet)) continue;
  for (const s of state.wallets[wallet].senders) {
    const a = normalizeSuiAddress(s);
    if (!labelled.has(a) && !exchangeWallets.has(a)) perExchange.get(entity).found.push(a);
  }
}
const toScan = new Set();
for (const [, p] of perExchange) {
  p.found = [...new Set(p.found)];
  p.scanned = p.found.slice(0, bounds.max_candidates);
  for (const a of p.scanned) toScan.add(a);
}
const recheck = Object.keys(previous.labels ?? {})
  .filter((k) => k.startsWith(PREFIX))
  .map((k) => normalizeSuiAddress(k.slice(PREFIX.length)))
  .filter(keep);
for (const a of recheck) toScan.add(a);

// ---------------------------------------------------------------------------
// 3. Each candidate's own history, through the deposit rule.
// ---------------------------------------------------------------------------

const queue = [...toScan].filter((a) => !state.candidates[a]);
const total = queue.length;
console.log(`candidates: ${toScan.size} (${recheck.length} from the previous file), ${total} left to read`);
let done = 0;
async function worker() {
  for (;;) {
    const address = queue.shift();
    if (!address) return;
    try {
      state.candidates[address] = inferDepositLabel(await scanForDeposit(address, 50), ctx);
    } catch (err) {
      // Left unset so the next run retries it.
      console.warn(`${address}: ${err.message}`);
    }
    if (++done % 25 === 0) {
      save();
      console.log(`read ${done}/${total}`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
save();

// ---------------------------------------------------------------------------
// 4. Sweep sponsors, each measured once; objects, packages and protocols.
// ---------------------------------------------------------------------------

const passing = [...toScan].filter((a) => state.candidates[a]?.kind === "deposit");
const sponsors = [
  ...new Set(
    passing.flatMap((a) => {
      const d = state.candidates[a].deposit;
      return d.sponsors.filter((s) => exchangeWallets.get(s) !== d.entity);
    }),
  ),
]
  .filter((s) => !(s in state.sponsors))
  .sort();
console.log(`sweep sponsors to measure: ${sponsors.length}`);
for (const s of sponsors) {
  try {
    state.sponsors[s] = (await measureFanout(s, SPONSOR_FANOUT_TRANSACTIONS)).sponsor_shape;
  } catch (err) {
    console.warn(`sponsor ${s}: ${err.message}`);
  }
  save();
}

// The next run rechecks only what this file labels, so a label left out
// because a read failed would be lost for good. Nothing is written until every
// candidate and every sponsor was read; a same-day rerun retries only those.
const unread = [...toScan].filter((a) => !state.candidates[a]);
const unmeasured = sponsors.filter((s) => !(s in state.sponsors));
if (unread.length > 0 || unmeasured.length > 0) {
  throw new Error(
    `${unread.length} candidate(s) could not be read and ${unmeasured.length} sponsor(s) could not be measured; ` +
      `nothing was written. Run again today to retry only those (progress is in ${flags.state}).`,
  );
}
const shapes = new Map(Object.entries(state.sponsors));
const objects = await objectsAmong(passing);

/** Final result per address: the rule's, then sponsors, objects and protocols. */
const final = new Map();
for (const a of toScan) {
  const c = state.candidates[a];
  if (!c) continue;
  if (c.kind !== "deposit") final.set(a, c);
  else if (objects.has(a)) final.set(a, { kind: "rejected", reason: "object" });
  else if (isCuratedProtocol(a)) final.set(a, { kind: "rejected", reason: "protocol" });
  else {
    const reason = sponsorRejection(c.deposit, shapes, exchangeWallets);
    final.set(a, reason ? { kind: "rejected", reason } : c);
  }
}

// ---------------------------------------------------------------------------
// 5. The file.
// ---------------------------------------------------------------------------

const labels = {};
for (const a of [...toScan].sort()) {
  const c = final.get(a);
  if (c?.kind !== "deposit") continue;
  const d = c.deposit;
  labels[`${PREFIX}${a}`] = {
    label: `${d.entity} deposit address (inferred)`,
    category: "cex",
    entity: d.entity,
    evidence: "sweep-pattern",
    confidence: "medium",
    retrieved_at: TODAY,
    inferred_from: {
      swept_to: d.swept_to,
      sweep_count: d.sweep_count,
      evidence_txs: d.evidence_txs,
      first_sweep_at: d.first_sweep_at,
      last_sweep_at: d.last_sweep_at,
    },
  };
}

const sortedCounts = (entries) => Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
const exchangeRows = exchanges.map((entity) => {
  const walletKeys = [...exchangeWallets].filter(([, e]) => e === entity).map(([w]) => w);
  const wallets = walletKeys.map((w) => state.wallets[w]);
  const p = perExchange.get(entity);
  const rejected = new Map();
  let unread = 0;
  for (const a of p.scanned) {
    const c = final.get(a);
    if (!c) unread++;
    else if (c.kind === "rejected") rejected.set(c.reason, (rejected.get(c.reason) ?? 0) + 1);
  }
  return {
    entity,
    wallets: wallets.length,
    wallets_deposit_shaped: walletKeys.filter((w) => depositShaped.has(w)).length,
    wallet_transactions_read: wallets.reduce((n, w) => n + w.transactions, 0),
    wallets_read_to_first_transaction: wallets.filter((w) => w.window_complete).length,
    senders: p.found.length,
    senders_read: p.scanned.length - unread,
    senders_not_read: p.found.length - p.scanned.length + unread,
    rejected: sortedCounts(rejected),
    labels: Object.values(labels).filter((l) => l.entity === entity).length,
  };
});

writeFileSync(
  OUT,
  JSON.stringify(
    {
      _comment:
        "GENERATED by scripts/sync-deposit-labels.mjs (npm run sync:labels); do not edit by hand. Exchange deposit addresses INFERRED from chain data, never disclosed by the exchange: each address swept its whole balance at least min_sweeps times into one wallet disclosed-labels.json names for the exchange, and every outflow in its latest 50 transactions was such a sweep (classify_deposit_address's likely verdict against that wallet). It was not a lookalike of another counterparty of the wallet, some customer paid it (not only its sweep sponsor, the exchange's own wallets, or where the swept-to wallet sweeps), each sweep sponsor was a relayer or a wallet of the same exchange, and the swept-to wallet was not deposit-shaped itself. A label names the exchange only. It ranks below every disclosed, curated, override and session label. inferred_from gives the wallet swept to, the sweeps counted in the window read, the latest sweep digests and the window's first and last sweep; retrieved_at is the day the address was read. An address missing here is not cleared: only the latest transactions of each exchange wallet were read (method), a deposit address swept fewer times is left out, and excluded_addresses were left out by an exclusion list before anything was read.",
      generated_at: TODAY,
      method: {
        evidence: "sweep-pattern",
        min_sweeps: MIN_SWEEPS,
        evidence_txs_kept: EVIDENCE_TXS,
        candidate_window_transactions: 50,
        wallet_pages: bounds.pages,
        wallet_page_transactions: 50,
        max_candidates_per_exchange: bounds.max_candidates,
        sponsor_fanout_transactions: SPONSOR_FANOUT_TRANSACTIONS,
        previous_labels_rechecked: recheck.length,
        excluded_addresses: excludedMet.size,
      },
      exchanges: exchangeRows,
      labels,
    },
    null,
    2,
  ) + "\n",
);
for (const r of exchangeRows) {
  console.log(`${r.entity}: ${r.labels} labels from ${r.senders_read}/${r.senders} senders (${JSON.stringify(r.rejected)})`);
}
// What became of the previous file's labels, on the console only.
const dropped = new Map();
for (const a of recheck) {
  const c = final.get(a);
  const why = !c ? "unread" : c.kind === "deposit" ? null : c.reason;
  if (why) dropped.set(why, (dropped.get(why) ?? 0) + 1);
}
console.log(`previous labels dropped: ${JSON.stringify(sortedCounts(dropped))}`);
console.log(`wrote ${Object.keys(labels).length} labels to ${OUT}`);
