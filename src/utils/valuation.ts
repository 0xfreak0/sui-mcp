import { buildPythFeedMap } from "../discovery.js";
import { fetchPythPrices, parsePythPrice } from "../tools/prices.js";

/**
 * Decimals for common Sui coins, keyed by short symbol. Used to convert raw
 * on-chain amounts to human units for USD valuation and display. Unknown coins
 * fall back to 9 (Sui's default) — documented as best-effort; Pyth-priced coins
 * (the ones that get a USD value at all) are all covered here.
 */
export const KNOWN_DECIMALS: Record<string, number> = {
  SUI: 9, USDC: 6, USDT: 6, DEEP: 6, CETUS: 9, NS: 6,
  WAL: 9, BUCK: 9, NAVX: 9, SCA: 9, BLUE: 9, WETH: 8,
  WBTC: 8, IKA: 9, UP: 6,
};

export const DEFAULT_DECIMALS = 9;

/** Short symbol from a full coin type (`0x2::sui::SUI` → `SUI`). */
export function symbolOf(coinType: string): string {
  const parts = coinType.split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : coinType;
}

/** Decimals for a coin type, from the known map, else the default. */
export function decimalsForCoinType(coinType: string): number {
  return KNOWN_DECIMALS[symbolOf(coinType)] ?? DEFAULT_DECIMALS;
}

/** Convert a raw amount to human units (may lose sub-cent precision on huge values — fine for USD estimates). */
export function toHumanAmount(raw: bigint | string, decimals: number): number {
  const v = typeof raw === "bigint" ? raw : BigInt(raw);
  const abs = v < 0n ? -v : v;
  return Number(abs) / 10 ** decimals;
}

/**
 * USD value of a raw coin amount at a given unit price. Pure; sign is dropped
 * (callers care about magnitude of a flow). Returns 0 when price is unknown.
 */
export function usdValue(raw: bigint | string, decimals: number, priceUsd: number | null | undefined): number {
  if (priceUsd == null || !Number.isFinite(priceUsd)) return 0;
  return toHumanAmount(raw, decimals) * priceUsd;
}

/** Format a USD number for human summaries ($1.23, $4.2K, $3.1M, $1.2B). */
export function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "$0";
  if (abs < 0.01) return "<$0.01";
  if (abs < 1_000) return `$${value.toFixed(2)}`;
  if (abs < 1_000_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (abs < 1_000_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${(value / 1_000_000_000).toFixed(1)}B`;
}

/**
 * Resolve USD prices for a set of coin types at a point in time (or latest if
 * `unixTs` is omitted), via Pyth historical oracle data. Returns a map of coin
 * type → USD price; coins without a Pyth feed are simply absent. Never throws —
 * pricing is best-effort enrichment, not a hard dependency of tracing.
 */
export async function priceUsdAtTime(
  coinTypes: string[],
  unixTs?: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = [...new Set(coinTypes)];
  if (uniq.length === 0) return out;
  try {
    const { feedIds, reverseMap } = await buildPythFeedMap(uniq);
    if (feedIds.length === 0) return out;
    const prices = await fetchPythPrices(feedIds, unixTs);
    if (!prices) return out;
    for (const [feedId, entry] of prices) {
      const price = parsePythPrice(entry);
      for (const ct of reverseMap.get(feedId) ?? []) out.set(ct, price);
    }
  } catch {
    // Best-effort: pricing failures must not break a trace.
  }
  return out;
}
