#!/usr/bin/env node
/**
 * Regenerate `src/data/coin-symbols.json`: every coin on mainnet, keyed by its
 * symbol trimmed and lower-cased, with its decimals and name.
 *
 * `analyze_token` and `search_token` read it before anything else, because a
 * symbol cannot be answered live. The objects API has no symbol filter, so a
 * live lookup reads CoinMetadata in object-ID order until the symbol turns
 * up, and a scan bounded by a tool call's time covers only part of the coins.
 * This walk reads all of them once, offline.
 *
 * Sources: every `0x2::coin::CoinMetadata<T>`, and every
 * `0x2::coin_registry::Currency<T>`, which is the only metadata a coin created
 * through the registry has. Where both exist the registry's decimals and name
 * are kept, and a coin whose two records disagree on the symbol is indexed
 * under both.
 *
 * Size budget: `SIZE_BUDGET_BYTES`. The file ships in the npm tarball and is
 * parsed on the first symbol lookup, and nearly all of it is package IDs,
 * 32 random bytes per coin that no encoding compresses. The row format in
 * `scripts/lib/coin-symbols-encode.mjs` cuts what can be cut: no `0x`, module
 * and struct left out where the one-time-witness convention implies them,
 * names equal to the symbol left out and long ones cut to `NAME_MAX_CHARS`,
 * and no list at all for a symbol more than `MAX_ROWS_PER_SYMBOL` coins claim
 * (a few symbols, SUI among them, are claimed by so many coins that their
 * lists would be much of the file while identifying none of them). Over budget,
 * the script refuses to write rather than ship a file nobody sized; raise
 * the budget on purpose or lower `MAX_ROWS_PER_SYMBOL`.
 *
 * Coins published after the walk are not in the file. Tools say so and name
 * `synced_at`, and a symbol the file lacks still falls back to the live scan.
 *
 *   npm run sync:coin-symbols
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSymbolIndex, MAX_ROWS_PER_SYMBOL, NAME_MAX_CHARS } from "./lib/coin-symbols-encode.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "src/data/coin-symbols.json");
const GRAPHQL = process.env.SUI_GRAPHQL_URL ?? "https://graphql.mainnet.sui.io/graphql";
const TIMEOUT_MS = 30_000;
const ATTEMPTS = 6;
const SIZE_BUDGET_BYTES = 14_000_000;
/** A walk that returns fewer coins than the last one was cut short: coins are not deleted. */
const MIN_FRACTION_OF_PREVIOUS = 0.95;
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

async function gql(query, variables = {}) {
  let lastError;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const res = await fetch(GRAPHQL, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "sui-analytics-mcp sync-coin-symbols" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.errors) throw new Error(body.errors.map((e) => e.message).join("; "));
      return body.data;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`GraphQL failed ${ATTEMPTS} times: ${lastError?.message ?? lastError}`);
}

/** Records without numeric decimals, left out and listed rather than guessed at. */
const malformed = [];

/**
 * Every object of `type`, with its symbol, name and decimals. `extract`
 * rather than `json`: a page of whole CoinMetadata is several times larger,
 * most of it descriptions and inline icons.
 */
async function walk(type, wrapper) {
  const query = `query($after: String) {
    objects(filter: { type: "${type}" }, first: 50, after: $after) {
      nodes { asMoveObject { contents {
        type { repr }
        s: extract(path: "symbol") { json }
        n: extract(path: "name") { json }
        d: extract(path: "decimals") { json }
      } } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const inner = new RegExp(`^0x0*2::${wrapper}<(.+)>$`);
  const out = [];
  let after = null;
  for (let page = 1; ; page++) {
    const { objects } = await gql(query, { after });
    for (const node of objects.nodes) {
      const c = node.asMoveObject?.contents;
      const coinType = c?.type?.repr?.match(inner)?.[1];
      if (!coinType) throw new Error(`unexpected type in the ${type} walk: ${c?.type?.repr}`);
      const symbol = typeof c.s?.json === "string" ? c.s.json : "";
      const decimals = c.d?.json;
      if (typeof decimals !== "number") {
        malformed.push(coinType);
        continue;
      }
      out.push({ coin_type: coinType, symbol, name: typeof c.n?.json === "string" ? c.n.json : symbol, decimals });
    }
    if (page % 100 === 0) process.stderr.write(`${type}: ${page} pages, ${out.length} objects\r`);
    if (!objects.pageInfo.hasNextPage) break;
    after = objects.pageInfo.endCursor;
  }
  process.stderr.write("\n");
  return out;
}

const started = Date.now();
const { checkpoint } = await gql(`{ checkpoint { sequenceNumber timestamp } }`);
const metadata = await walk("0x2::coin::CoinMetadata", "coin::CoinMetadata");
const currencies = await walk("0x2::coin_registry::Currency", "coin_registry::Currency");

// One entry per (coin, symbol). The registry wins decimals and name, and a
// symbol only CoinMetadata carries stays findable.
const byType = new Map();
for (const c of metadata) byType.set(c.coin_type, [c]);
let registryOnly = 0;
for (const c of currencies) {
  const legacy = byType.get(c.coin_type)?.[0];
  if (!legacy) registryOnly++;
  const entries = [c];
  if (legacy && legacy.symbol.trim().toLowerCase() !== c.symbol.trim().toLowerCase()) {
    entries.push({ ...legacy, name: c.name, decimals: c.decimals });
  }
  byType.set(c.coin_type, entries);
}
if (!byType.has(SUI)) throw new Error("the walk did not reach 0x2::sui::SUI; refusing to write");

if (existsSync(OUT)) {
  const previous = JSON.parse(readFileSync(OUT, "utf8")).counts?.coins ?? 0;
  if (byType.size < previous * MIN_FRACTION_OF_PREVIOUS) {
    throw new Error(`walk found ${byType.size} coins, the shipped file has ${previous}; refusing to write a shorter index`);
  }
}

const built = buildSymbolIndex([...byType.values()].flat());
const out = {
  _comment:
    "GENERATED by scripts/sync-coin-symbols.mjs from every 0x2::coin::CoinMetadata and 0x2::coin_registry::Currency on mainnet; do not edit by hand. Symbol (trimmed, lower-cased) -> rows [type, decimals, name?, symbol?] in the encoding scripts/lib/coin-symbols-encode.mjs documents, or a bare count for a symbol more than max_rows_per_symbol coins use. Nothing here vouches for a coin: anyone can publish one with any symbol. Coins published after `checkpoint` are missing.",
  network: "mainnet",
  synced_at: new Date().toISOString().slice(0, 10),
  checkpoint: Number(checkpoint.sequenceNumber),
  checkpoint_time: checkpoint.timestamp,
  counts: {
    coin_metadata: metadata.length,
    currency: currencies.length,
    registry_only: registryOnly,
    coins: byType.size,
    symbols: built.symbolCount,
    rows: built.rows,
    count_only_symbols: built.countOnly,
    left_out_without_decimals: malformed.length,
  },
  max_rows_per_symbol: MAX_ROWS_PER_SYMBOL,
  name_max_chars: NAME_MAX_CHARS,
  symbols: built.symbols,
};
const text = JSON.stringify(out) + "\n";
const bytes = Buffer.byteLength(text);
if (bytes > SIZE_BUDGET_BYTES) {
  throw new Error(`index is ${bytes} bytes, over the ${SIZE_BUDGET_BYTES}-byte budget; refusing to write`);
}
writeFileSync(OUT, text);
console.log(
  `checkpoint ${out.checkpoint}: ${byType.size} coins (${metadata.length} CoinMetadata, ${currencies.length} Currency, ` +
    `${registryOnly} registry-only), ${built.symbolCount} symbols, ${built.rows} rows, ${built.countOnly} count-only; ` +
    `${(bytes / 1e6).toFixed(2)} MB in ${Math.round((Date.now() - started) / 1000)}s`,
);
if (malformed.length) console.log(`left out ${malformed.length} without numeric decimals: ${malformed.slice(0, 10).join(", ")}`);
