#!/usr/bin/env node
/**
 * Regenerate `src/data/coins.json` — the curated list of coin types a symbol
 * is allowed to resolve to.
 *
 * Why this file has to exist at all: symbols on Sui are not identifiers. A
 * mainnet census found 15,000+ coins across 8,819 symbols, of which 1,827
 * collide — 585 coins claim the symbol `SUI`, 100 claim `DEEP`, 59 claim
 * `USDT`. The collisions are adversarial, not accidental: the impostors carry
 * names like "Sui v2 (migrate asset: suiv2.com)". Any lookup that scans coin
 * metadata and takes the first exact symbol match will eventually hand back a
 * phishing token, and it will look exactly like a correct answer.
 *
 * Source is Aftermath's verified list, which this server already depends on
 * for prices. It is checked in rather than fetched at runtime on purpose: a
 * registry that fetches at runtime fails open, and failing open here means
 * resolving `USDC` to whichever impostor is indexed first.
 *
 *   node scripts/sync-verified-coins.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "src/data/coins.json");
const VERIFIED = "https://aftermath.finance/api/coins/verified";
const METADATA = "https://aftermath.finance/api/coins/metadata";
const TIMEOUT_MS = 30_000;

/** Coins the list may omit but an investigation always meets. */
const ALWAYS = ["0x2::sui::SUI"];

function normalize(coinType) {
  const [pkg, ...rest] = coinType.trim().split("::");
  if (rest.length !== 2) return null;
  const hex = pkg.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{1,64}$/.test(hex)) return null;
  return `0x${hex.padStart(64, "0")}::${rest.join("::")}`;
}

async function json(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const listed = await json(VERIFIED);
const types = [...new Set([...listed, ...ALWAYS].map(normalize).filter(Boolean))].sort();
console.log(`verified list: ${listed.length} entries -> ${types.length} unique normalized types`);

// Metadata comes back positionally, so a short or reordered response would
// silently mislabel every coin after the gap. Checked rather than assumed.
const meta = await json(METADATA, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ coins: types }),
});
if (!Array.isArray(meta) || meta.length !== types.length) {
  throw new Error(
    `metadata is positional and came back ${Array.isArray(meta) ? meta.length : "non-array"} for ${types.length} coins; refusing to write a mislabelled registry`,
  );
}

const coins = [];
const skipped = [];
types.forEach((coin_type, i) => {
  const m = meta[i] ?? {};
  const symbol = String(m.symbol ?? "").trim();
  // A registry entry with no symbol cannot serve a symbol lookup, and would
  // only add weight to the file.
  if (!symbol) return skipped.push(coin_type);
  coins.push({
    coin_type,
    symbol,
    name: String(m.name ?? "").trim(),
    decimals: Number.isFinite(m.decimals) ? m.decimals : null,
  });
});

// A symbol that maps to two verified coins is still ambiguous, and shipping it
// would recreate the bug this file exists to prevent — just with a nicer
// source. Report so it can be resolved by hand rather than silently picked.
const bySymbol = new Map();
for (const c of coins) {
  const k = c.symbol.toUpperCase();
  bySymbol.set(k, [...(bySymbol.get(k) ?? []), c.coin_type]);
}
const ambiguous = [...bySymbol.entries()].filter(([, v]) => v.length > 1);

// `canonical` is hand-maintained and preserved across regeneration: it is the
// only judgement in this file, and it must not be silently reset by a sync.
let canonical = {};
try {
  canonical = JSON.parse(readFileSync(OUT, "utf8")).canonical ?? {};
} catch {
  // First run.
}

coins.sort((a, b) => a.coin_type.localeCompare(b.coin_type));
writeFileSync(
  OUT,
  `${JSON.stringify({ source: "aftermath/verified", canonical, coins }, null, 2)}\n`,
);

console.log(`wrote ${coins.length} coins to src/data/coins.json`);
if (skipped.length) console.log(`skipped ${skipped.length} without a symbol`);

const unresolved = ambiguous.filter(([sym]) => !canonical[sym]);
if (ambiguous.length) {
  console.log(`\nambiguous symbols in the verified set: ${ambiguous.length}, of which ${unresolved.length} have no canonical entry`);
  for (const [sym, list] of unresolved) {
    console.log(`  ${sym} (${list.length}):`);
    for (const t of list) console.log(`     ${t}`);
  }
  if (unresolved.length) {
    console.log(
      "\nThese resolve to CANDIDATES, not a coin. Add a `canonical` entry only\n" +
      "where you can say which one is meant — guessing here is the bug this\n" +
      "registry exists to prevent.",
    );
  }
}
