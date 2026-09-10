import { buildPythFeedMap } from "../discovery.js";
import { verifiedCoin } from "./coin-registry.js";
import { pythApiKey } from "./price-providers.js";
import { fetchPythPrices, parsePythPrice } from "../tools/prices.js";

/**
 * Decimals for common Sui coins, keyed by short symbol.
 *
 * **Kept only as a last-resort fallback, never as identification.** Keying a
 * scale on the struct name is how a coin whose type merely ends `::sui::SUI`
 * inherited real SUI's 9 decimals. Measured on mainnet: of 289 unverified
 * coins whose struct name matches one of these symbols, 47 declare different
 * decimals — a fake SUI with 0 would have reported every amount 10^9 out.
 *
 * The registry is consulted first and answers by coin TYPE, which is the
 * identity. This map only softens the failure when nothing knows the coin.
 */
export const KNOWN_DECIMALS: Record<string, number> = {
  SUI: 9, USDC: 6, USDT: 6, DEEP: 6, CETUS: 9, NS: 6,
  WAL: 9, BUCK: 9, NAVX: 9, SCA: 9, BLUE: 9, WETH: 8,
  WBTC: 8, IKA: 9, UP: 6,
};

export const DEFAULT_DECIMALS = 9;

/**
 * Short symbol from a full coin type (`0x2::sui::SUI` → `SUI`).
 *
 * This is the struct name and nothing more. It is not an identifier: 585
 * mainnet coins end `::SUI`. Use {@link displayCoin} anywhere a reader will
 * see it.
 */
export function symbolOf(coinType: string): string {
  const parts = coinType.split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : coinType;
}

export interface CoinScale {
  decimals: number;
  /**
   * `registry` means a curated list vouches for this exact coin type and
   * supplied its decimals. `assumed` means nothing does, and the amount was
   * scaled by a guess — which the caller must pass on rather than absorb.
   */
  source: "registry" | "assumed";
}

/**
 * The decimal scale for a coin type, and how much that scale is worth.
 *
 * Resolved by TYPE against the verified registry. Only when nothing knows the
 * coin does it fall back to the symbol map, and it says so — an amount scaled
 * by a guess is not the same claim as one scaled by a known decimals value,
 * and 16% of imitators on mainnet declare a different scale from the coin they
 * imitate.
 */
export function coinScale(coinType: string): CoinScale {
  const known = verifiedCoin(coinType);
  if (known?.decimals !== null && known?.decimals !== undefined) {
    return { decimals: known.decimals, source: "registry" };
  }
  return {
    decimals: KNOWN_DECIMALS[symbolOf(coinType)] ?? DEFAULT_DECIMALS,
    source: "assumed",
  };
}

/** Decimals only, for callers that have already handled the scale's provenance. */
export function decimalsForCoinType(coinType: string): number {
  return coinScale(coinType).decimals;
}

export interface CoinDisplay {
  coin_type: string;
  symbol: string;
  /** A curated list vouches for this exact coin type. */
  verified: boolean;
}

/**
 * How to name a coin in output.
 *
 * The symbol is still shown for an unverified coin — hiding it would make
 * results unreadable — but `verified: false` says it is a claim made by
 * whoever minted the coin rather than an identification, and the full type is
 * always carried so two coins called SUI stay distinguishable.
 */
export function displayCoin(coinType: string): CoinDisplay {
  const known = verifiedCoin(coinType);
  return {
    coin_type: coinType,
    symbol: known?.symbol ?? symbolOf(coinType),
    verified: known !== null,
  };
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

/**
 * The dominant recipient's total USD inflow for a hop, given per-change positive
 * inflows `{address, usd}`. We group by address and take the MAX (not the sum)
 * so a swap's input+output legs — which credit two different addresses (the
 * actor and the pool) — aren't double-counted, while a plain transfer still
 * reports the recipient's gain. Returns 0 when there are no positive inflows.
 */
export function dominantInflowUsd(inflows: Array<{ address: string; usd: number }>): number {
  const byAddress = new Map<string, number>();
  for (const { address, usd } of inflows) {
    if (usd > 0) byAddress.set(address, (byAddress.get(address) ?? 0) + usd);
  }
  return byAddress.size ? Math.max(...byAddress.values()) : 0;
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
/** A USD price and the Pyth publish time it was actually sampled at. */
export interface PricePoint {
  /** USD unit price. */
  price: number;
  /** Unix seconds of the Pyth update this price came from. */
  publishTime: number;
}

export async function priceUsdAtTime(
  coinTypes: string[],
  unixTs?: number,
): Promise<Map<string, PricePoint>> {
  const out = new Map<string, PricePoint>();
  const uniq = [...new Set(coinTypes)];
  if (uniq.length === 0) return out;
  try {
    // Historical pricing is Pyth-only and Pyth now needs a key. Without one,
    // skip straight out instead of walking the feed map to make a request that
    // will be refused.
    if (!pythApiKey()) return out;
    const { feedIds, reverseMap } = await buildPythFeedMap(uniq);
    if (feedIds.length === 0) return out;
    const prices = await fetchPythPrices(feedIds, unixTs);
    if (!prices) return out;
    for (const [feedId, entry] of prices) {
      const point: PricePoint = { price: parsePythPrice(entry), publishTime: entry.price.publish_time };
      for (const ct of reverseMap.get(feedId) ?? []) out.set(ct, point);
    }
  } catch {
    // Best-effort: pricing failures must not break a trace.
  }
  return out;
}

// Beyond this gap between a price's Pyth publish time and the block time, the
// nearest available price is too stale to trust as the transaction-time value
// (illiquid feed, or a gap in Pyth history). We still report it, but flag it.
export const PRICE_STALE_THRESHOLD_SEC = 3600;
