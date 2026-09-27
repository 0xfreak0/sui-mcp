import { buildPythFeedMap } from "../discovery.js";
import { isVerifiedCoin, verifiedCoin, vouchFor } from "./coin-registry.js";
import { fetchDefiLlama, pythApiKey, type DefiLlamaResult } from "./price-providers.js";
import { fetchPythPrices, parsePythPrice } from "../tools/prices.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";
import { isNotFound } from "./errors.js";

/**
 * Decimals for common Sui coins, keyed by short symbol.
 *
 * **Kept only as a last-resort fallback, never as identification.** Keying a
 * scale on the struct name gives any coin whose type merely ends `::sui::SUI`
 * real SUI's 9 decimals, and many unverified coins that share a symbol here
 * declare different decimals. A fake SUI with 0 would report every amount
 * 10^9 out.
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
 * This is the struct name and nothing more, and many unrelated coins share
 * it. Use {@link displayCoin} anywhere a reader will see it.
 *
 * Type arguments are kept, each named by its curated symbol where the list
 * has one: `0x5ffa…::vault::MagicCoin<0xdba3…::usdc::USDC>` is
 * `MagicCoin<USDC>`. The base is split on `::` apart from its arguments, so a
 * wrapper is never named after the asset it wraps.
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
   * supplied its decimals. `coin_metadata` means nothing curated does, but a
   * live read of the coin's own on-chain `CoinMetadata` did, from the coin's
   * own publish. `price_provider` means the service that priced the
   * coin reported the decimals its price is per, so amount and price agree.
   * `assumed` means nothing does, and the amount was scaled by a guess, which
   * the caller must pass on rather than absorb.
   */
  source: "registry" | "coin_metadata" | "price_provider" | "assumed";
}

/**
 * Live-read decimals for a coin type, keyed `network:coinType`. Populated only
 * by {@link prefetchCoinScale}; `coinScale` itself never blocks on the network,
 * so a coin type nobody prefetched still falls through to the symbol guess.
 */
const liveDecimals = new Map<string, number | null>();
const liveDecimalsInFlight = new Map<string, Promise<void>>();

/**
 * One GraphQL request's share of coins: the service answers at most 21
 * lookups that each read the store in one request, and refuses a body over
 * 5,000 bytes, so coin types go inline and a batch stops at whichever limit
 * it meets first.
 */
const METADATA_BATCH_COINS = 20;
const METADATA_BATCH_BYTES = 4_500;

/**
 * Unread coins from which one GraphQL request per batch replaces one gRPC
 * read per coin. An ordinary transaction or wallet page touches a handful of
 * coins, which read as fast either way; a meme-coin drain touches hundreds,
 * and under a request rate limit the number of requests is the latency.
 */
const METADATA_BATCH_MIN = 10;

/** One aliased `coinMetadata` field, the coin type inline as a string literal. */
const metadataField = (index: number, coinType: string) => `c${index}:coinMetadata(coinType:${JSON.stringify(coinType)}){decimals}`;

/** Coin types split into GraphQL requests within {@link METADATA_BATCH_COINS} and {@link METADATA_BATCH_BYTES}. */
function metadataBatches(coinTypes: string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const coinType of coinTypes) {
    const size = JSON.stringify(metadataField(batch.length, coinType)).length;
    if (batch.length > 0 && (batch.length >= METADATA_BATCH_COINS || bytes + size > METADATA_BATCH_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(coinType);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** One gRPC `CoinMetadata` read into the cache. */
function readDecimalsGrpc(key: string, coinType: string): Promise<void> {
  return sui.stateService
    .getCoinInfo({ coinType })
    .then(({ response }) => {
      const decimals = response.metadata?.decimals;
      liveDecimals.set(key, decimals ?? null);
    })
    .catch((err) => {
      if (isNotFound(err)) liveDecimals.set(key, null);
      // Else: transient. Leave uncached so the next prefetch retries it.
    });
}

/**
 * Read one batch of coins' decimals in one GraphQL request. A coin the
 * service answers null for has no metadata, the answer gRPC gives as
 * NOT_FOUND, and is cached as such. Every coin of a request that failed is
 * read over gRPC instead.
 */
async function readDecimalsBatch(network: string, coinTypes: string[]): Promise<void> {
  let data: Record<string, { decimals?: number | null } | null>;
  try {
    data = await gqlQuery(`{ ${coinTypes.map((t, i) => metadataField(i, t)).join(" ")} }`);
  } catch {
    await Promise.all(coinTypes.map((coinType) => readDecimalsGrpc(`${network}:${coinType}`, coinType)));
    return;
  }
  coinTypes.forEach((coinType, i) => {
    const decimals = data[`c${i}`]?.decimals;
    liveDecimals.set(`${network}:${coinType}`, typeof decimals === "number" ? decimals : null);
  });
}

/**
 * Warm {@link coinScale}'s live-metadata tier for these coin types, so the
 * synchronous calls that follow resolve a coin's real decimals instead of
 * guessing 9.
 *
 * Tools that format amounts read a coin's `CoinMetadata` decimals through
 * this cache, the same value `analyze_token` reads directly, so one coin
 * gets one scale.
 *
 * Skips anything the curated registry already answers (no network call
 * needed) and anything already cached, so calling this with mostly-known
 * coins (SUI, USDC, …) costs nothing. A coin with no `CoinMetadata` (a
 * genuine gRPC NOT_FOUND, or a successful response with no `metadata` field)
 * is cached as `null`, so a second call in the same session does not
 * re-request it; the symbol guess still applies for it. A transient failure
 * (a timeout, which `retryingFetch` does not retry, or 429/5xx after retries
 * run out) is left uncached instead: caching it as `null` would say "this
 * coin has no metadata" for the rest of the process from one bad request,
 * silently pinning an assumed-9 guess for a coin whose real decimals a later
 * call might have read successfully.
 */
export async function prefetchCoinScale(coinTypes: Iterable<string>): Promise<void> {
  const network = getNetwork();
  const unique = [...new Set(coinTypes)].filter((t) => !verifiedCoin(t) && !liveDecimals.has(`${network}:${t}`));
  const pending = unique.map((t) => liveDecimalsInFlight.get(`${network}:${t}`)).filter((p): p is Promise<void> => p !== undefined);
  const toFetch = unique.filter((t) => !liveDecimalsInFlight.has(`${network}:${t}`));
  const reads: Array<{ coins: string[]; read: Promise<void> }> =
    toFetch.length >= METADATA_BATCH_MIN
      ? metadataBatches(toFetch).map((coins) => ({ coins, read: readDecimalsBatch(network, coins) }))
      : toFetch.map((coinType) => ({ coins: [coinType], read: readDecimalsGrpc(`${network}:${coinType}`, coinType) }));
  for (const { coins, read } of reads) {
    const done = read.finally(() => {
      for (const coinType of coins) liveDecimalsInFlight.delete(`${network}:${coinType}`);
    });
    for (const coinType of coins) liveDecimalsInFlight.set(`${network}:${coinType}`, done);
    pending.push(done);
  }
  await Promise.all(pending);
}

/** Tests only: forget every live-read decimals value. */
export function resetLiveCoinScale(): void {
  liveDecimals.clear();
  liveDecimalsInFlight.clear();
}

/**
 * The decimal scale for a coin type, and how much that scale is worth.
 *
 * Resolved by type against the verified registry, then against a live
 * `CoinMetadata` read if {@link prefetchCoinScale} warmed one for it. Only
 * when neither knows the coin does it fall back to the symbol map, and it
 * says so: an amount scaled by a guess is a weaker claim than one scaled by
 * a known decimals value, and an imitator can declare a different scale
 * from the coin it imitates.
 */
export function coinScale(coinType: string): CoinScale {
  const known = verifiedCoin(coinType);
  if (known?.decimals !== null && known?.decimals !== undefined) {
    return { decimals: known.decimals, source: "registry" };
  }
  const live = liveDecimals.get(`${getNetwork()}:${coinType}`);
  if (live !== null && live !== undefined) {
    return { decimals: live, source: "coin_metadata" };
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
 * A price is per whole token at the provider's own decimals, so when neither
 * the curated registry nor a live `CoinMetadata` read knows the coin, the
 * provider's decimals are the ones that make amount × price correct. Registry
 * and on-chain-metadata decimals still win: one was reviewed, and the other is
 * the coin's own publish. The provider's were read from whatever the minter
 * wrote, same as the coin's metadata, but on someone else's schedule and with
 * no guarantee it still matches.
 */
export function pricingScale(coinType: string, point?: { decimals?: number } | null): CoinScale {
  const scale = coinScale(coinType);
  if (scale.source === "registry" || scale.source === "coin_metadata" || point?.decimals === undefined) return scale;
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
 * The value one hop moved, given each priced balance change as `{address,
 * usd}` with the change's sign. Each address's inflows are summed, and
 * separately its outflows, and the largest of those totals is the hop's value.
 *
 * The largest, not the sum: a swap credits the actor and the pool, and a
 * transfer debits the sender what it credits the recipient, so adding legs
 * counts the same value twice. Outflows count because value can leave with no
 * recipient on Sui: a bridge burn debits the sender and credits only a fee
 * collector, so inflows alone would value a 100,000 USDC exit at its fee.
 * Returns 0 when nothing priced moved.
 */
export function dominantFlowUsd(flows: Array<{ address: string; usd: number }>): number {
  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();
  for (const { address, usd } of flows) {
    if (usd > 0) inflow.set(address, (inflow.get(address) ?? 0) + usd);
    else if (usd < 0) outflow.set(address, (outflow.get(address) ?? 0) - usd);
  }
  return Math.max(0, ...inflow.values(), ...outflow.values());
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
  /** Provider id of the asset priced, when it is not the coin itself (a Sui Bridge token priced as its Ethereum asset). */
  priced_as?: string;
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
          ...(q.priced_as ? { priced_as: q.priced_as } : {}),
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
