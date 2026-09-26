import { readFileSync } from "node:fs";
import { getNetwork } from "../config.js";

/**
 * Every coin on mainnet by symbol, synced into `src/data/coin-symbols.json` by
 * `npm run sync:coin-symbols` from each `CoinMetadata` and coin registry
 * `Currency`.
 *
 * A symbol cannot be answered live: the objects API has no symbol filter, so
 * the live fallback reads metadata in object-ID order until the symbol turns
 * up, and a bounded scan can miss every coin that uses it. Several coins
 * sharing a symbol is the normal case, and only a complete list can say so.
 *
 * Nothing here vouches for a coin. It records which coins claim a symbol, as
 * of `synced_at`: a coin published after that is missing, so every answer
 * drawn from it names the date.
 *
 * Mainnet only: coin types embed package IDs, which differ per network.
 */

/** `[type, decimals, name?, symbol?]`, encoded as `scripts/lib/coin-symbols-encode.mjs` documents. */
export type SymbolRow = [string, number, (string | null)?, string?];

export interface CoinSymbolsFile {
  synced_at: string;
  checkpoint: number;
  counts: { coins: number };
  max_rows_per_symbol: number;
  /** A list of rows, or only a count for a symbol more than `max_rows_per_symbol` coins use. */
  symbols: Record<string, SymbolRow[] | number>;
}

export interface IndexedCoin {
  coin_type: string;
  symbol: string;
  name: string;
  decimals: number;
}

export type SymbolLookup =
  | { status: "absent" }
  | { status: "listed"; coins: IndexedCoin[] }
  /** Too many coins use the symbol for the file to list them. */
  | { status: "count_only"; count: number };

/** A symbol more coins use than the index lists: its key and how many coins use it. */
export interface UnlistedSymbol {
  symbol: string;
  count: number;
}

/** What a caller cites when it answers from the index. */
export interface SymbolIndexInfo {
  synced_at: string;
  checkpoint: number;
  coins: number;
  max_rows_per_symbol: number;
}

export interface SymbolIndex {
  info: SymbolIndexInfo;
  /** Exact symbol, trimmed and case-insensitive. */
  lookup(symbol: string): SymbolLookup;
  /**
   * Coins whose symbol or name contains `query`, exact symbol matches first.
   * `exact` is the exact-symbol lookup, which also says when the symbol is too
   * common to be listed. `unlisted` holds the other symbols containing
   * `query` that are too common to list, most-used first: they keep no rows,
   * so their coins are in neither `coins` nor any name match.
   */
  search(query: string): { exact: SymbolLookup; coins: IndexedCoin[]; unlisted: UnlistedSymbol[] };
}

/** Inverse of `encodeCoinType` in the encoder. */
export function decodeCoinType(encoded: string, key: string): string {
  if (encoded.startsWith("0x")) return encoded;
  const sep = encoded.indexOf("::");
  const pkg = sep < 0 ? encoded : encoded.slice(0, sep);
  const mod = sep < 0 ? key : encoded.slice(sep + 2);
  return `0x${pkg}::${mod}::${mod.toUpperCase()}`;
}

function decodeRow(row: SymbolRow, key: string): IndexedCoin {
  const symbol = row[3] ?? key.toUpperCase();
  return { coin_type: decodeCoinType(row[0], key), symbol, name: row[2] ?? symbol, decimals: row[1] };
}

export function createSymbolIndex(file: CoinSymbolsFile): SymbolIndex {
  // A Map rather than the parsed object: a symbol such as "constructor" would
  // otherwise read Object.prototype's member.
  const bySymbol = new Map(Object.entries(file.symbols));
  const info: SymbolIndexInfo = {
    synced_at: file.synced_at,
    checkpoint: file.checkpoint,
    coins: file.counts.coins,
    max_rows_per_symbol: file.max_rows_per_symbol,
  };

  const lookupKey = (key: string): SymbolLookup => {
    const entry = bySymbol.get(key);
    if (entry === undefined) return { status: "absent" };
    if (typeof entry === "number") return { status: "count_only", count: entry };
    return { status: "listed", coins: entry.map((r) => decodeRow(r, key)) };
  };

  return {
    info,
    lookup: (symbol) => lookupKey(symbol.trim().toLowerCase()),
    search(query) {
      const q = query.trim().toLowerCase();
      const exact = lookupKey(q);
      const coins = exact.status === "listed" ? [...exact.coins] : [];
      const unlisted: UnlistedSymbol[] = [];
      if (!q) return { exact, coins, unlisted };
      for (const [key, entry] of bySymbol) {
        if (key === q) continue;
        const keyHit = key.includes(q);
        if (typeof entry === "number") {
          if (keyHit) unlisted.push({ symbol: key, count: entry });
          continue;
        }
        for (const row of entry) {
          if (keyHit || (row[2] ?? row[3] ?? key).toLowerCase().includes(q)) coins.push(decodeRow(row, key));
        }
      }
      unlisted.sort((a, b) => b.count - a.count);
      return { exact, coins, unlisted };
    },
  };
}

let shipped: SymbolIndex | null = null;

/**
 * The shipped index, or null off mainnet. Parsed on the first symbol lookup:
 * the file is about 13 MB and most sessions never resolve a symbol.
 */
export function symbolIndex(): SymbolIndex | null {
  if (getNetwork() !== "mainnet") return null;
  shipped ??= createSymbolIndex(
    JSON.parse(readFileSync(new URL("../data/coin-symbols.json", import.meta.url), "utf8")) as CoinSymbolsFile,
  );
  return shipped;
}
