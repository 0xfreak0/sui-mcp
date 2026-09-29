#!/usr/bin/env node
/**
 * Regenerate `src/data/deposit-labels.json`: exchange DEPOSIT addresses inferred
 * from the exchange wallets `src/data/disclosed-labels.json` already names.
 *
 * For each Sui mainnet `cex` wallet in the disclosed set, the latest pages of
 * its transactions give the addresses that paid into it. Each such sender, and
 * every address the previous file labelled, has its own latest transactions
 * read and is kept only when `inferDepositLabel` (src/utils/deposit-labels.ts)
 * reads them as a deposit address of that exchange: at least two full-balance
 * sweeps, every sweep into one disclosed wallet of that exchange, no other kind of
 * outflow. An address a disclosed or curated label names, an object or package,
 * a curated protocol address, and an address sweeping to two exchanges are
 * never labelled. A label names the exchange only.
 *
 * Imports the built server (dist/), so `npm run sync:labels` builds first.
 *
 *   node scripts/sync-deposit-labels.mjs [--pages N] [--max-candidates N]
 *     [--concurrency N] [--state PATH] [--fresh]
 *
 *   --pages           pages of 50 transactions read per exchange wallet (default 10)
 *   --max-candidates  senders scanned per exchange, in wallet then arrival order (default 1000)
 *   --concurrency     candidate scans in flight (default 4)
 *   --state           progress file; a run with the same bounds resumes from it
 *                     (default: <tmpdir>/sui-mcp-sync-deposit-labels.json)
 *   --fresh           ignore the progress file
 *   --exclude         a text file; every 0x+64-hex address in it is left out of
 *                     the output (addresses private to a case never ship)
 *
 * Output order is stable: labels by key, exchanges by name, counts by reason.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const { values: flags } = parseArgs({
  options: {
    pages: { type: "string", default: "10" },
    "max-candidates": { type: "string", default: "1000" },
    concurrency: { type: "string", default: "4" },
    state: { type: "string", default: join(tmpdir(), "sui-mcp-sync-deposit-labels.json") },
    fresh: { type: "boolean", default: false },
    exclude: { type: "string" },
  },
});
const positive = (name) => {
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got ${flags[name]}`);
  return n;
};
const bounds = { pages: positive("pages"), max_candidates: positive("max-candidates") };
const concurrency = positive("concurrency");

const { inferDepositLabel, inboundSenders, objectsAmong, readWalletPage, MIN_SWEEPS, EVIDENCE_TXS } = await import(
  join(root, "dist/utils/deposit-labels.js")
);
const { scanForDeposit } = await import(join(root, "dist/utils/deposit.js"));
const { isCuratedProtocol } = await import(join(root, "dist/protocols/registry.js"));
const { normalizeSuiAddress } = await import("@mysten/sui/utils");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
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

// A progress file is reused only for the same bounds, rule code and disclosed
// set: a result read under another rule is not this rule's result.
const ruleHash = createHash("sha256")
  .update(readFileSync(join(root, "dist/utils/deposit-labels.js")))
  .update(readFileSync(join(root, "dist/utils/deposit.js")))
  .update(readFileSync(join(root, "src/data/disclosed-labels.json")))
  .digest("hex");
const fresh = () => ({ bounds, rule: ruleHash, wallets: {}, candidates: {} });
let state = !flags.fresh && existsSync(flags.state) ? readJson(flags.state) : fresh();
if (JSON.stringify(state.bounds) !== JSON.stringify(bounds) || state.rule !== ruleHash) state = fresh();
const save = () => writeFileSync(flags.state, JSON.stringify(state));

// ---------------------------------------------------------------------------
// 1. Every exchange wallet's latest pages, for who paid into it.
// ---------------------------------------------------------------------------

let walletsRead = 0;
for (const [wallet, entity] of exchangeWallets) {
  if (state.wallets[wallet]) continue;
  const senders = [];
  let transactions = 0;
  let before = null;
  for (let page = 0; page < bounds.pages; page++) {
    const r = await readWalletPage(wallet, before);
    transactions += r.txs.length;
    // Newest page first; within a page, newest last.
    senders.push(...inboundSenders([...r.txs].reverse(), wallet));
    before = r.before;
    if (!before) break;
  }
  state.wallets[wallet] = { entity, transactions, window_complete: before === null, senders: [...new Set(senders)] };
  if (++walletsRead % 10 === 0) {
    save();
    console.log(`wallets: ${Object.keys(state.wallets).length}/${exchangeWallets.size}`);
  }
}
save();

// ---------------------------------------------------------------------------
// 2. Candidates per exchange, capped; the previous file's labels are re-read.
// ---------------------------------------------------------------------------

const previous = existsSync(OUT) ? readJson(OUT) : { labels: {} };
const perExchange = new Map(exchanges.map((e) => [e, { found: [], scanned: [] }]));
for (const [wallet, entity] of exchangeWallets) {
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
  .map((k) => normalizeSuiAddress(k.slice(PREFIX.length)));
for (const a of recheck) toScan.add(a);

const excluded = new Set(
  flags.exclude ? (readFileSync(flags.exclude, "utf8").match(/0x[0-9a-fA-F]{64}/g) ?? []).map((a) => a.toLowerCase()) : [],
);

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
      const result = inferDepositLabel(await scanForDeposit(address, 50), exchangeWallets, labelled);
      state.candidates[address] = { ...result, read_at: TODAY };
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

// An object, a package or a curated protocol address is never a deposit address.
const inferred = [...toScan].filter((a) => state.candidates[a]?.kind === "deposit");
const objects = await objectsAmong(inferred);
for (const a of inferred) {
  if (objects.has(a)) state.candidates[a] = { kind: "rejected", reason: "object", read_at: TODAY };
  else if (isCuratedProtocol(a)) state.candidates[a] = { kind: "rejected", reason: "protocol", read_at: TODAY };
}
save();

// ---------------------------------------------------------------------------
// 4. The file.
// ---------------------------------------------------------------------------

const labels = {};
let excludedCount = 0;
for (const a of [...toScan].sort()) {
  const c = state.candidates[a];
  if (c?.kind !== "deposit") continue;
  if (excluded.has(a)) {
    excludedCount++;
    continue;
  }
  const d = c.deposit;
  labels[`${PREFIX}${a}`] = {
    label: `${d.entity} deposit address (inferred)`,
    category: "cex",
    entity: d.entity,
    evidence: "sweep-pattern",
    confidence: "medium",
    retrieved_at: c.read_at,
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
  const wallets = [...exchangeWallets].filter(([, e]) => e === entity).map(([w]) => state.wallets[w]);
  const p = perExchange.get(entity);
  const rejected = new Map();
  let unread = 0;
  for (const a of p.scanned) {
    const c = state.candidates[a];
    if (!c) unread++;
    else if (c.kind === "rejected") rejected.set(c.reason, (rejected.get(c.reason) ?? 0) + 1);
  }
  return {
    entity,
    wallets: wallets.length,
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
        "GENERATED by scripts/sync-deposit-labels.mjs (npm run sync:labels); do not edit by hand. Exchange deposit addresses INFERRED from chain data, never disclosed by the exchange: each address swept its whole balance at least min_sweeps times into one wallet disclosed-labels.json names for the exchange, and every outflow in its latest 50 transactions was such a sweep (classify_deposit_address's likely verdict against that wallet). A label names the exchange only. It ranks below every disclosed, curated, override and session label. inferred_from gives the wallet swept to, the sweeps counted in the window read, the latest sweep digests and the window's first and last sweep; retrieved_at is the day the address was read. An address missing here is not cleared: only the latest transactions of each exchange wallet were read (method), a deposit address swept fewer times is left out, and excluded_addresses were left out by an exclusion list.",
      generated_at: TODAY,
      method: {
        evidence: "sweep-pattern",
        min_sweeps: MIN_SWEEPS,
        evidence_txs_kept: EVIDENCE_TXS,
        candidate_window_transactions: 50,
        wallet_pages: bounds.pages,
        wallet_page_transactions: 50,
        max_candidates_per_exchange: bounds.max_candidates,
        previous_labels_rechecked: recheck.length,
        excluded_addresses: excludedCount,
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
console.log(`wrote ${Object.keys(labels).length} labels to ${OUT}`);
