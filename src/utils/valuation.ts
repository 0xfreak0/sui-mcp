import { buildPythFeedMap } from "../discovery.js";
import { isVerifiedCoin, verifiedCoin, vouchFor } from "./coin-registry.js";
import { fetchDefiLlama, pythApiKey, type DefiLlamaResult } from "./price-providers.js";
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
 *
 * Type arguments are kept, each named by its curated symbol where the list
 * has one: `0x5ffa…::vault::MagicCoin<0xdba3…::usdc::USDC>` is
 * `MagicCoin<USDC>`. Splitting the whole string on `::` instead named that
 * vault share `USDC>`, the asset it wraps.
 */
export function symbolOf(coinType: string): string {
  const open = coinType.indexOf("<");
  const base = open === -1 ? coinType : coinType.slice(0, open);
  const parts = base.split("::");
  const name = parts.length >= 3 ? parts[parts.length - 1] : base;
  if (open === -1 || !coinType.endsWith(">")) return name;

  // Split the arguments at top-level commas only: an argument can itself be
  // generic and contain commas.
  const inner = coinType.slice(open + 1, -1);
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "<") depth++;
    else if (inner[i] === ">") depth--;
    else if (inner[i] === "," && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return `${name}<${args.map((a) => verifiedCoin(a)?.symbol ?? symbolOf(a)).join(", ")}>`;
}

export interface CoinScale {
  decimals: number;
  /**
   * `registry` means a curated list vouches for this exact coin type and
   * supplied its decimals. `price_provider` means the service that priced the
   * coin reported the decimals its price is per, so amount and price agree.
   * `assumed` means nothing does, and the amount was scaled by a guess, which
   * the caller must pass on rather than absorb.
   */
  source: "registry" | "price_provider" | "assumed";
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

/**
 * The scale to value an amount at, given the price that will multiply it.
 *
 * A price is per whole token at the provider's own decimals, so when the
 * curated registry does not know the coin, the provider's decimals are the
 * ones that make amount × price correct. Registry decimals still win: they
 * were reviewed, and the provider's were read from whatever the minter wrote.
 */
export function pricingScale(coinType: string, point?: { decimals?: number } | null): CoinScale {
  const scale = coinScale(coinType);
  if (scale.source === "registry" || point?.decimals === undefined) return scale;
  return { decimals: point.decimals, source: "price_provider" };
}

export interface CoinDisplay {
  coin_type: string;
  symbol: string;
  /**
   * A curated list vouches for this exact coin type. Null where no list covers
   * the network at all — neither a claim nor a denial.
   */
  verified: boolean | null;
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
  const vouch = vouchFor(coinType);
  return {
    coin_type: coinType,
    symbol: known?.symbol ?? symbolOf(coinType),
    // Null rather than false where no curated list covers the network: a
    // legitimate testnet asset must not be marked the way an impersonation
    // token is.
    verified: vouch === "not-curated-here" ? null : known !== null,
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

/** A USD price and the time of the sample it came from. */
export interface PricePoint {
  /** USD unit price. */
  price: number;
  /** Unix seconds of the sample this price came from. */
  publishTime: number;
  source: "pyth" | "defillama";
  /** DefiLlama's 0-1 agreement score, or Pyth's USD confidence interval. */
  confidence?: number;
  /** Decimals the price is per, when the provider reports them. */
  decimals?: number;
}

/** A coin that has no price, and why. A missing price is never a zero. */
export interface UnpricedCoin {
  coin_type: string;
  /** `request_failed` says nothing about the coin; the others are answers. */
  code: "not_listed" | "request_failed" | "type_parameters" | "no_oracle_price";
  reason: string;
}

export interface HistoricalPrices {
  points: Map<string, PricePoint>;
  unpriced: UnpricedCoin[];
}

export type HistoricalSource = "pyth" | "defillama";

/**
 * Why each coin without a price has none. Pure, so the wording a report rests
 * on is tested rather than assumed.
 *
 * The three DefiLlama outcomes are different findings: a failed request says
 * nothing about the coin, a coin type with type parameters cannot be asked
 * about, and an answered request with no entry means DefiLlama had no price
 * near that second.
 */
export function explainUnpriced(
  coinTypes: string[],
  points: Map<string, PricePoint>,
  ctx: { sources: ReadonlyArray<HistoricalSource>; pythKey: boolean; llama: DefiLlamaResult | null },
): UnpricedCoin[] {
  const out: UnpricedCoin[] = [];
  for (const coinType of new Set(coinTypes)) {
    if (points.has(coinType)) continue;
    const verified = isVerifiedCoin(coinType);
    const pythNote = !ctx.sources.includes("pyth")
      ? ""
      : !verified
        ? " Pyth is never asked about it: its feeds are matched by symbol, and this coin is not on the verified list, so a Pyth price would be the price of whatever real coin shares its symbol."
        : !ctx.pythKey
          ? " Pyth was not asked: no PYTH_API_KEY is set."
          : " Pyth returned no price for it.";
    let code: UnpricedCoin["code"];
    let reason: string;
    if (!ctx.sources.includes("defillama") || !ctx.llama) {
      code = "no_oracle_price";
      reason = `No oracle price.${pythNote}`;
    } else if (ctx.llama.unanswered.has(coinType)) {
      code = "request_failed";
      reason = `The DefiLlama request failed, which says nothing about whether the coin had a price.${pythNote}`;
    } else if (ctx.llama.unsupported.has(coinType)) {
      code = "type_parameters";
      reason = `DefiLlama cannot be asked about this coin type: it has type parameters or is not a well-formed coin type.${pythNote}`;
    } else {
      code = "not_listed";
      reason = `DefiLlama has no price for this exact coin type near that time.${pythNote}`;
    }
    out.push({ coin_type: coinType, code, reason: reason.trim() });
  }
  return out;
}

/**
 * USD prices for a set of coin types at a point in time (or now if `unixTs`
 * is omitted). Never throws: pricing is enrichment, not a hard dependency.
 *
 * Pyth is preferred when PYTH_API_KEY is set, and only for coins the curated
 * registry verifies: Pyth feeds are matched by symbol, so an impostor would get
 * the real coin's price. Everything else goes to DefiLlama, which needs no key
 * and keys on the full coin type, so it prices each coin as itself or not at
 * all.
 *
 * `sources` narrows the providers. `compare_oracle_price` asks for Pyth alone,
 * since comparing a market against a market aggregate is not an oracle check.
 */
export async function priceUsdAtTime(
  coinTypes: string[],
  unixTs?: number,
  opts: { sources?: ReadonlyArray<HistoricalSource> } = {},
): Promise<HistoricalPrices> {
  const sources = opts.sources ?? ["pyth", "defillama"];
  const points = new Map<string, PricePoint>();
  const uniq = [...new Set(coinTypes)];
  if (uniq.length === 0) return { points, unpriced: [] };
  const pythKey = pythApiKey() !== null;

  if (sources.includes("pyth") && pythKey) {
    try {
      const verified = uniq.filter((ct) => isVerifiedCoin(ct));
      const { feedIds, reverseMap } = await buildPythFeedMap(verified);
      const prices = feedIds.length > 0 ? await fetchPythPrices(feedIds, unixTs) : null;
      for (const [feedId, entry] of prices ?? []) {
        const point: PricePoint = {
          price: parsePythPrice(entry),
          publishTime: entry.price.publish_time,
          source: "pyth",
          confidence: Number(entry.price.conf) * 10 ** entry.price.expo,
        };
        for (const ct of reverseMap.get(feedId) ?? []) points.set(ct, point);
      }
    } catch {
      // Best-effort: whatever Pyth could not answer falls through to DefiLlama.
    }
  }

  let llama: DefiLlamaResult | null = null;
  if (sources.includes("defillama")) {
    const rest = uniq.filter((ct) => !points.has(ct));
    if (rest.length > 0) {
      llama = await fetchDefiLlama(rest, unixTs);
      for (const [ct, q] of llama.quotes) {
        points.set(ct, {
          price: q.price,
          publishTime: q.at ?? unixTs ?? Math.floor(Date.now() / 1000),
          source: "defillama",
          ...(q.confidence !== undefined ? { confidence: q.confidence } : {}),
          ...(q.decimals !== undefined ? { decimals: q.decimals } : {}),
        });
      }
    }
  }

  return { points, unpriced: explainUnpriced(uniq, points, { sources, pythKey, llama }) };
}

// Beyond this gap between a price's sample time and the block time, the
// nearest available price is too far away to trust as the transaction-time
// value (illiquid coin, or a gap in the provider's history). It is still
// reported, and flagged.
export const PRICE_STALE_THRESHOLD_SEC = 3600;
