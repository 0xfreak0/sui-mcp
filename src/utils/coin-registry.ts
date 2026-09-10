/**
 * Which coin a symbol is allowed to mean.
 *
 * **A symbol is not an identifier on Sui.** A mainnet census found 15,000+
 * coins across 8,819 symbols, 1,827 of them colliding: 585 coins claim `SUI`,
 * 100 claim `DEEP`, 59 claim `USDT`. The collisions are adversarial — the
 * impostors carry names like "Sui v2 (migrate asset: suiv2.com)".
 *
 * The full coin type is the identity and always wins. This module exists only
 * for the case where a caller supplies a bare symbol, where the type is
 * precisely the unknown.
 *
 * Nothing cheap separates a real coin from an impostor by inspection, which is
 * why this is a curated list rather than a rule. Measured against the fake
 * `USDC` the scan used to return:
 *
 * - **Supply** does not work: the impostor's is 10^16 against real USDC's
 *   2.8x10^14. Minting is free.
 * - **Module naming** does not work: `::usdc::USDC` looks native but costs a
 *   scammer nothing to copy.
 * - **A deny-list config** does not generalise: of USDC, USDT and WBTC, only
 *   USDC's issuer had registered one.
 *
 * So the rule is: resolve from the curated set, and where even that is
 * ambiguous, return candidates rather than pick. Guessing is the failure this
 * exists to prevent, and a wrong guess is indistinguishable from a right one
 * downstream.
 */

import { EXTERNAL_HTTP_TIMEOUT_MS } from "../config.js";
import registry from "../data/coins.json" with { type: "json" };

export interface RegistryCoin {
  coin_type: string;
  symbol: string;
  name: string;
  decimals: number | null;
}

interface RegistryFile {
  source: string;
  /** Hand-maintained: symbol -> the coin type meant, for ambiguous symbols. */
  canonical: Record<string, string>;
  coins: RegistryCoin[];
}

const data = registry as RegistryFile;

/** Padded lowercase form, so `0x2::sui::SUI` matches its canonical spelling. */
export function normalizeCoinType(coinType: string): string | null {
  const parts = coinType.trim().split("::");
  if (parts.length !== 3) return null;
  const hex = parts[0].replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{1,64}$/.test(hex)) return null;
  return `0x${hex.padStart(64, "0")}::${parts[1]}::${parts[2]}`;
}

const bySymbol = new Map<string, RegistryCoin[]>();
const byType = new Map<string, RegistryCoin>();
for (const coin of data.coins) {
  const type = normalizeCoinType(coin.coin_type);
  if (!type) continue;
  const entry = { ...coin, coin_type: type };
  byType.set(type, entry);
  const key = coin.symbol.toUpperCase();
  bySymbol.set(key, [...(bySymbol.get(key) ?? []), entry]);
}

/** Is this exact coin type on the verified list. */
export function isVerifiedCoin(coinType: string): boolean {
  const t = normalizeCoinType(coinType);
  return t !== null && byType.has(t);
}

export function verifiedCoin(coinType: string): RegistryCoin | null {
  const t = normalizeCoinType(coinType);
  return t ? (byType.get(t) ?? null) : null;
}

export type SymbolResolution =
  | { status: "resolved"; coin: RegistryCoin; via: "canonical" | "verified" | "live" }
  | { status: "ambiguous"; symbol: string; candidates: RegistryCoin[] }
  | { status: "unverified"; symbol: string };

/**
 * Resolve a bare symbol against the curated set.
 *
 * `ambiguous` is a real answer, not a failure: several *legitimate* coins share
 * `USDC` on Sui — Circle's native issue plus Wormhole and Celer bridged
 * versions — and picking one silently would misreport which asset moved. Seven
 * symbols in the verified set are ambiguous this way.
 *
 * `unverified` means the symbol is not curated at all. The caller may still
 * search on-chain, but must not present the result as though the symbol
 * identified it.
 */
export function resolveVerifiedSymbol(symbol: string): SymbolResolution {
  const key = symbol.trim().toUpperCase();

  const pinned = data.canonical[key];
  if (pinned) {
    const coin = verifiedCoin(pinned);
    if (coin) return { status: "resolved", coin, via: "canonical" };
  }

  const matches = bySymbol.get(key) ?? [];
  if (matches.length === 1) return { status: "resolved", coin: matches[0], via: "verified" };
  if (matches.length > 1) return { status: "ambiguous", symbol: key, candidates: matches };
  return { status: "unverified", symbol: key };
}

/** How many coins the registry holds. Used by the packaging tests. */
export function registrySize(): number {
  return byType.size;
}

// ---------------------------------------------------------------------------
// Live refresh
// ---------------------------------------------------------------------------

/**
 * The checked-in list goes stale: new legitimate coins launch continuously, and
 * a coin that launched after the last sync resolves as `unverified`. That is
 * the conservative answer rather than a wrong one — the caller can always pass
 * the full coin type, which never needed the registry — but it is inconvenient.
 *
 * So the live list is consulted too, under three rules that keep it from
 * becoming a hole:
 *
 * - **Additive only.** It can add coins the checked-in file lacks. It can never
 *   remove one or override a `canonical` pin. The reviewed file is the floor.
 * - **Fails closed.** A fetch that errors, times out or returns something
 *   unexpected leaves the registry exactly as shipped. The failure mode is
 *   "this new coin is unverified", never "this impostor is verified".
 * - **Marked.** A coin vouched for only by the live list reports
 *   `via: "live"`, so a reader can tell reviewed data from data fetched a
 *   moment ago.
 *
 * The distinction matters because the checked-in file is reviewed in a pull
 * request and the live one is whatever an endpoint returned. Both are Aftermath
 * saying the same thing; only one of them was read by a human first.
 */
const LIVE_URL = "https://aftermath.finance/api/coins/verified";
const LIVE_METADATA_URL = "https://aftermath.finance/api/coins/metadata";
const LIVE_TTL_MS = 6 * 60 * 60 * 1000;

let liveFetchedAt = 0;
let liveInFlight: Promise<void> | null = null;

/** Coins present in the live list but not the checked-in one. */
const liveOnly = new Map<string, RegistryCoin>();
const liveOnlyBySymbol = new Map<string, RegistryCoin[]>();

/** Disable with SUI_DISABLE_LIVE_COIN_LIST=1 to pin behaviour to the repo file. */
function liveEnabled(): boolean {
  return process.env.SUI_DISABLE_LIVE_COIN_LIST !== "1";
}

async function fetchLive(): Promise<void> {
  const timeout = AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS);
  const listRes = await fetch(LIVE_URL, { signal: timeout });
  if (!listRes.ok) throw new Error(`verified list HTTP ${listRes.status}`);
  const listed: unknown = await listRes.json();
  if (!Array.isArray(listed)) throw new Error("verified list is not an array");

  const fresh = [...new Set(listed.map((t) => normalizeCoinType(String(t))).filter(Boolean))]
    .filter((t): t is string => t !== null)
    .filter((t) => !byType.has(t));
  if (fresh.length === 0) return;

  const metaRes = await fetch(LIVE_METADATA_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ coins: fresh }),
    signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
  });
  if (!metaRes.ok) throw new Error(`metadata HTTP ${metaRes.status}`);
  const meta: unknown = await metaRes.json();
  // Positional, so a short response would mislabel every coin after the gap.
  // Refusing beats importing a registry whose symbols point at the wrong types.
  if (!Array.isArray(meta) || meta.length !== fresh.length) {
    throw new Error("metadata length does not match the requested coins");
  }

  liveOnly.clear();
  liveOnlyBySymbol.clear();
  fresh.forEach((coin_type, i) => {
    const m = (meta[i] ?? {}) as { symbol?: unknown; name?: unknown; decimals?: unknown };
    const symbol = String(m.symbol ?? "").trim();
    if (!symbol) return;
    const entry: RegistryCoin = {
      coin_type,
      symbol,
      name: String(m.name ?? "").trim(),
      decimals: typeof m.decimals === "number" ? m.decimals : null,
    };
    liveOnly.set(coin_type, entry);
    const key = symbol.toUpperCase();
    liveOnlyBySymbol.set(key, [...(liveOnlyBySymbol.get(key) ?? []), entry]);
  });
}

/**
 * Refresh the live layer if it is stale. Never throws and never blocks a second
 * caller into a duplicate fetch.
 */
export async function refreshLiveCoins(): Promise<void> {
  if (!liveEnabled()) return;
  if (Date.now() - liveFetchedAt < LIVE_TTL_MS) return;
  if (liveInFlight) return liveInFlight;
  liveInFlight = (async () => {
    try {
      await fetchLive();
      liveFetchedAt = Date.now();
    } catch {
      // Fails closed: the checked-in registry stands unchanged. Retried after
      // the TTL rather than on every call, so an outage does not become a
      // request amplifier.
      liveFetchedAt = Date.now();
    } finally {
      liveInFlight = null;
    }
  })();
  return liveInFlight;
}

/** Reset the live layer. Tests only. */
export function resetLiveCoins(): void {
  liveOnly.clear();
  liveOnlyBySymbol.clear();
  liveFetchedAt = 0;
}

export type CoinVouch = "verified" | "canonical" | "live" | null;

/** Which list vouches for this coin type, if any. */
export function vouchFor(coinType: string): CoinVouch {
  const t = normalizeCoinType(coinType);
  if (!t) return null;
  if (byType.has(t)) return "verified";
  if (liveOnly.has(t)) return "live";
  return null;
}

/**
 * Symbol resolution including the live layer.
 *
 * The checked-in registry is consulted first and its answer wins outright: a
 * symbol that is already `resolved` or `ambiguous` there is not reopened by
 * live data, so a fetched list can never turn an ambiguous symbol into a
 * confident one.
 */
export async function resolveSymbolWithLive(symbol: string): Promise<SymbolResolution> {
  const stat = resolveVerifiedSymbol(symbol);
  if (stat.status !== "unverified") return stat;

  await refreshLiveCoins();
  const matches = liveOnlyBySymbol.get(symbol.trim().toUpperCase()) ?? [];
  if (matches.length === 1) return { status: "resolved", coin: matches[0], via: "live" };
  if (matches.length > 1) {
    return { status: "ambiguous", symbol: symbol.trim().toUpperCase(), candidates: matches };
  }
  return stat;
}
