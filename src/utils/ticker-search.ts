import { RetryableResponseError, retryingJson } from "../clients/graphql.js";
import { sui } from "../clients/grpc.js";
import { EXTERNAL_HTTP_TIMEOUT_MS, getNetwork } from "../config.js";
import { normalizeCoinType, resolveVerifiedSymbol, searchVerifiedCoins, vouchFor } from "./coin-registry.js";
import { guardiansFlagsForCoin, type GuardiansFlag } from "./guardians.js";

export type TickerProvider = "dexscreener" | "geckoterminal";
export type ProviderStatus = "ok" | "unavailable" | "rate_limited" | "skipped";

export interface TickerCandidate {
  coin_type: string;
  symbol: string;
  name: string;
  decimals: number;
  total_supply: string | null;
  liquidity_usd: number;
  pool_count: number;
  volume_24h: number | null;
  providers: TickerProvider[];
  verified: boolean;
  impostor_of?: string;
  flagged_by?: GuardiansFlag[];
  package_id: string;
  publisher_hint: string;
}

export interface LiveTickerSearch {
  candidates: TickerCandidate[];
  providers: Record<TickerProvider, ProviderStatus>;
  unavailable_providers: Array<{ provider: TickerProvider; reason: string }>;
  /** A provider hit its result cap without a complete fallback. */
  partial: boolean;
  /** Indexer candidates whose own on-chain metadata could not be checked. */
  unconfirmed: number;
  unconfirmed_reason?: string;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_CANDIDATES = 25;
const METADATA_CONCURRENCY = 5;
const TRANSPORT = {
  attempts: 1, baseDelayMs: 150, maxDelayMs: 500,
  timeoutMs: Math.min(EXTERNAL_HTTP_TIMEOUT_MS, 5000),
  concurrency: 4, rateLimit: null, service: "Ticker search provider",
};

interface PoolToken { address: string; symbol: string; name: string }
interface Pool { id: string; liquidity: number; volume: number | null; tokens: PoolToken[]; provider: TickerProvider }
interface IndexedCandidate { coin_type: string; pools: Map<string, { liquidity: number; volume: number | null }>; providers: Set<TickerProvider> }

function record(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function usd(value: unknown): number {
  const amount = Number(value);
  return value !== null && value !== undefined && value !== "" && Number.isFinite(amount) && amount > 0 ? amount : 0;
}
function coinType(value: unknown): string | null {
  return typeof value === "string" ? normalizeCoinType(value) : null;
}
function poolToken(value: unknown): PoolToken | null {
  const obj = record(value);
  const address = coinType(obj?.address);
  return address ? { address, symbol: string(obj?.symbol), name: string(obj?.name) } : null;
}

interface PoolPage { pools: Pool[]; truncated: boolean }

function dexPools(body: unknown): PoolPage {
  const pairs = record(body)?.pairs;
  if (!Array.isArray(pairs)) throw new RetryableResponseError("Invalid DexScreener search response");
  const pools: Pool[] = [];
  let hasOtherChain = false;
  for (const value of pairs) {
    const pair = record(value);
    if (pair?.chainId !== "sui") {
      hasOtherChain = true;
      continue;
    }
    const tokens = [poolToken(pair.baseToken), poolToken(pair.quoteToken)].filter((t): t is PoolToken => t !== null);
    const id = string(pair.pairAddress).toLowerCase();
    if (!id || !tokens.length) continue;
    const volume = record(pair.volume)?.h24;
    pools.push({ id, tokens, provider: "dexscreener", liquidity: usd(record(pair.liquidity)?.usd), volume: volume == null ? null : usd(volume) });
  }
  return { pools, truncated: pairs.length >= 30 && hasOtherChain };
}

function geckoPools(body: unknown): PoolPage {
  const result = record(body);
  const data = result?.data;
  if (!Array.isArray(data) || (data.length > 0 && !Array.isArray(result?.included))) {
    throw new RetryableResponseError("Invalid GeckoTerminal search response");
  }
  const included = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(result?.included) ? result.included : []) {
    const obj = record(item);
    if (obj && typeof obj.id === "string") included.set(obj.id, record(obj.attributes) ?? {});
  }
  const pools: Pool[] = [];
  for (const value of data) {
    const pool = record(value);
    const attrs = record(pool?.attributes);
    const relations = record(pool?.relationships);
    const id = string(attrs?.address || pool?.id).replace(/^sui-network_/, "").toLowerCase();
    if (!string(pool?.id).startsWith("sui-network_") || !id) continue;
    const tokens: PoolToken[] = [];
    for (const side of ["base_token", "quote_token"]) {
      const tokenId = string(record(record(relations?.[side])?.data)?.id);
      if (!tokenId.startsWith("sui-network_")) continue;
      const address = coinType(tokenId.slice("sui-network_".length));
      if (!address) continue;
      const meta = included.get(tokenId);
      tokens.push({ address, symbol: string(meta?.symbol), name: string(meta?.name) });
    }
    const volume = record(attrs?.volume_usd);
    pools.push({ id, tokens, provider: "geckoterminal", liquidity: usd(attrs?.reserve_in_usd), volume: volume?.h24 == null ? null : usd(volume.h24) });
  }
  return { pools, truncated: data.length >= 20 };
}

async function readPools(provider: TickerProvider, query: string): Promise<PoolPage> {
  const url = provider === "dexscreener"
    ? `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`
    : `https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(query)}&network=sui-network&include=base_token,quote_token`;
  return retryingJson(url, (body, status) => {
    if (status === 404) throw new Error(`${provider} returned HTTP 404`);
    return provider === "dexscreener" ? dexPools(body) : geckoPools(body);
  }, TRANSPORT);
}

async function search(query: string): Promise<LiveTickerSearch> {
  const providers: LiveTickerSearch["providers"] = { dexscreener: "skipped", geckoterminal: "skipped" };
  const unavailable_providers: LiveTickerSearch["unavailable_providers"] = [];
  const indexed = new Map<string, IndexedCandidate>();
  let dexTruncated = false;
  let geckoTruncated = false;
  const q = query.toLowerCase();
  for (const provider of ["dexscreener", "geckoterminal"] as const) {
    const terms = provider === "dexscreener" ? [query, `${query} SUI`] : [query];
    for (const term of terms) {
      try {
        const page = await readPools(provider, term);
        providers[provider] = "ok";
        if (provider === "dexscreener") dexTruncated ||= page.truncated;
        else geckoTruncated ||= page.truncated;
        for (const pool of page.pools) {
          for (const token of pool.tokens) {
            if (!token.symbol.toLowerCase().includes(q) && !token.name.toLowerCase().includes(q)) continue;
            let candidate = indexed.get(token.address);
            if (!candidate) {
              candidate = { coin_type: token.address, pools: new Map(), providers: new Set() };
              indexed.set(token.address, candidate);
            }
            candidate.providers.add(provider);
            const old = candidate.pools.get(pool.id);
            candidate.pools.set(pool.id, {
              liquidity: Math.max(old?.liquidity ?? 0, pool.liquidity),
              volume: pool.volume === null ? old?.volume ?? null : Math.max(old?.volume ?? 0, pool.volume),
            });
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        providers[provider] = /HTTP 429/.test(reason) ? "rate_limited" : "unavailable";
        unavailable_providers.push({ provider, reason });
        if (provider === "dexscreener") dexTruncated = true;
        // Once a provider fails, use the other rather than spending its limit.
        break;
      }
    }
    // GeckoTerminal shares an approximately 10-request/minute public limit
    // with historical pricing. Spend it only if DexScreener was incomplete.
    if (provider === "dexscreener" && indexed.size > 0 && !dexTruncated && providers.dexscreener === "ok") break;
  }
  const partial = geckoTruncated || (dexTruncated && providers.geckoterminal !== "ok");

  const top = [...indexed.values()]
    .sort((a, b) => liquidity(b) - liquidity(a) || a.coin_type.localeCompare(b.coin_type))
    .slice(0, MAX_CANDIDATES);
  // Verified symbol names are used only to flag a different *type* copying one;
  // neither the indexer's name nor its purported decimals vouch for an asset.
  const verifiedCoins = await searchVerifiedCoins(query);
  const verifiedBySymbol = new Map<string, string>();
  for (const coin of verifiedCoins) {
    const symbol = coin.symbol.toLowerCase();
    if (!verifiedBySymbol.has(symbol)) {
      const pinned = resolveVerifiedSymbol(coin.symbol);
      verifiedBySymbol.set(symbol, pinned.status === "resolved" ? pinned.coin.coin_type : coin.coin_type);
    }
  }
  const candidates: TickerCandidate[] = [];
  let unconfirmed = 0;
  let unconfirmed_reason: string | undefined;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(METADATA_CONCURRENCY, top.length) }, async () => {
    while (next < top.length) {
      const indexedCoin = top[next++];
      try {
        const { response } = await sui.stateService.getCoinInfo({ coinType: indexedCoin.coin_type });
        const meta = response.metadata;
        if (!meta?.symbol || meta.decimals == null) {
          unconfirmed++;
          unconfirmed_reason ??= "CoinInfo returned no complete on-chain metadata";
          continue;
        }
        if (!meta.symbol.toLowerCase().includes(q) && !(meta.name ?? "").toLowerCase().includes(q)) continue;
        const verified = vouchFor(indexedCoin.coin_type);
        const canonical = verifiedBySymbol.get(meta.symbol.toLowerCase());
        const package_id = indexedCoin.coin_type.split("::")[0];
        let liquidity_usd = 0;
        let volume_24h = 0;
        let hasVolume = false;
        for (const pool of indexedCoin.pools.values()) {
          liquidity_usd += pool.liquidity;
          if (pool.volume !== null) {
            volume_24h += pool.volume;
            hasVolume = true;
          }
        }
        const flagged_by = guardiansFlagsForCoin(indexedCoin.coin_type);
        candidates.push({
          coin_type: indexedCoin.coin_type,
          symbol: meta.symbol,
          name: meta.name ?? meta.symbol,
          decimals: meta.decimals,
          total_supply: response.treasury?.totalSupply?.toString() ?? null,
          liquidity_usd,
          pool_count: indexedCoin.pools.size,
          volume_24h: hasVolume ? volume_24h : null,
          providers: [...indexedCoin.providers],
          verified: verified !== null && verified !== "not-curated-here",
          ...(verified === null && canonical && normalizeCoinType(canonical) !== indexedCoin.coin_type ? { impostor_of: canonical } : {}),
          ...(flagged_by.length ? { flagged_by } : {}),
          package_id,
          publisher_hint: `Use identify_address on package ${package_id} to find its publisher, then get_wallet_packages on that publisher to pivot across deployed packages.`,
        });
      } catch (err) {
        unconfirmed++;
        unconfirmed_reason ??= err instanceof Error ? err.message : String(err);
      }
    }
  }));
  candidates.sort((a, b) => Number(b.verified) - Number(a.verified) ||
    Number(b.symbol.toLowerCase() === q) - Number(a.symbol.toLowerCase() === q) ||
    b.liquidity_usd - a.liquidity_usd || a.coin_type.localeCompare(b.coin_type));
  return { candidates, providers, unavailable_providers, partial, unconfirmed, ...(unconfirmed_reason ? { unconfirmed_reason } : {}) };
}

function liquidity(candidate: IndexedCandidate): number {
  let total = 0;
  for (const pool of candidate.pools.values()) total += pool.liquidity;
  return total;
}

const cache = new Map<string, { value: LiveTickerSearch; fetchedAt: number }>();
const inFlight = new Map<string, Promise<LiveTickerSearch>>();

/** Pool-backed mainnet candidates only; metadata is checked by exact coin type. */
export async function searchLiveTickers(query: string): Promise<LiveTickerSearch> {
  if (getNetwork() !== "mainnet") {
    return { candidates: [], providers: { dexscreener: "skipped", geckoterminal: "skipped" }, unavailable_providers: [], partial: false, unconfirmed: 0 };
  }
  const q = query.trim().toLowerCase();
  if (!q) return { candidates: [], providers: { dexscreener: "skipped", geckoterminal: "skipped" }, unavailable_providers: [], partial: false, unconfirmed: 0 };
  const key = `${getNetwork()}:${q}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.value;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = search(q).then((value) => {
    if (value.unavailable_providers.length === 0 && value.unconfirmed === 0 && !value.partial) {
      cache.set(key, { value, fetchedAt: Date.now() });
    }
    return value;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}
