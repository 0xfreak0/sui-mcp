import { EXTERNAL_HTTP_TIMEOUT_MS } from "../config.js";
import { normalizeCoinType } from "./coin-registry.js";
import { defiLlamaKey, fetchDefiLlamaHistory } from "./price-providers.js";
import type { PriceQuote } from "./price-providers.js";

export type RecentPriceSource = "coingecko" | "geckoterminal";
export interface OutOfRangePriceRequest { coin_type: string; at: number; source: RecentPriceSource }
export interface HistoricalMarketPrices {
  quotes: Map<string, Map<number, PriceQuote>>;
  /** Failed reads, even when another provider subsequently supplies the quote. */
  unanswered: Map<string, Set<number>>;
  /** Requests skipped before discovery because their dates cannot be served. */
  outOfRange: OutOfRangePriceRequest[];
}
const DAY = 86400;
const HOUR = 3600;
// Public API history bounds, checked before discovery or chart requests.
const HISTORY_DAYS: Record<RecentPriceSource, number> = { coingecko: 365, geckoterminal: 180 };
const GECKO = "https://api.geckoterminal.com/api/v2/networks/sui-network";
const MAX_CACHE = 512;
const cache = new Map<string, { expires: number; value: Promise<unknown> }>();

/** Tests only: isolate provider fixtures. Failed reads are never cached. */
export function resetRecentPriceCache(): void { cache.clear(); }

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
  const entry = { expires: Date.now() + 5 * 60_000, value: load() };
  cache.set(key, entry);
  entry.value.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return entry.value;
}

async function json(url: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS) });
  // A 429 or a non-JSON error is a failed read, never an absent coin.
  if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid price response");
  if (response.status === 404 && (body.error || body.errors)) return null;
  if (!response.ok || body.error || body.errors) throw new Error("Provider error");
  return body;
}

function samples(rows: unknown, source: RecentPriceSource, divisor: number, priceIndex: number, offset: number): PriceQuote[] {
  if (!Array.isArray(rows)) throw new Error("Missing historical samples");
  const out: PriceQuote[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== "number" || !Number.isFinite(row[0]) ||
      typeof row[priceIndex] !== "number" || !Number.isFinite(row[priceIndex]) || row[priceIndex] < 0) continue;
    out.push({ source, at: row[0] / divisor + offset, price: row[priceIndex] });
  }
  return out;
}

/** Normalize only the package address; Move module and struct names retain case. */
function matchesCoinType(providerType: unknown, coin: string): boolean {
  return typeof providerType === "string" && normalizeCoinType(providerType) === coin;
}

async function coinGeckoIdentity(coin: string): Promise<boolean> {
  return cached(`coingecko-identity:${coin}`, async () => {
    const body = await json(`https://api.coingecko.com/api/v3/coins/sui/contract/${encodeURIComponent(coin)}`);
    if (!body) return false;
    const platforms = body.platforms;
    if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) throw new Error("Missing contract identity");
    return matchesCoinType((platforms as Record<string, unknown>).sui, coin);
  });
}

async function coinGecko(coin: string, day: number, oldest: number, now: number): Promise<PriceQuote[]> {
  return cached(`coingecko:${coin}:${day}`, async () => {
    // CoinGecko's URL lookup folds case; its platform record must match first.
    if (!await coinGeckoIdentity(coin)) return [];
    const from = Math.max(oldest + 1, day - HOUR);
    const to = Math.min(now, day + DAY + HOUR);
    const body = await json(`https://api.coingecko.com/api/v3/coins/sui/contract/${encodeURIComponent(coin)}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`);
    return body ? samples(body.prices, "coingecko", 1000, 1, 0) : [];
  });
}

interface Pool {
  address: string;
  side: "base" | "quote";
  liquidity: number;
  complete: boolean;
}
interface PoolRow {
  attributes?: { address?: string; reserve_in_usd?: string };
  relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } };
}
async function mostLiquidPool(coin: string): Promise<Pool | null> {
  return cached(`pools:${coin}`, async () => {
    // GeckoTerminal's SUI lookup needs 0x2, not its zero-padded spelling.
    const key = coin.replace(/^0x0+([0-9a-f])/, "0x$1");
    let best: Pool | null = null;
    for (let page = 1; page <= 10; page++) {
      const body = await json(`${GECKO}/tokens/${encodeURIComponent(key)}/pools?sort=h24_volume_usd_liquidity_desc&page=${page}`);
      if (!body) return null;
      if (!Array.isArray(body.data)) throw new Error("Missing pools");
      for (const pool of body.data as PoolRow[]) {
        const side = (["base", "quote"] as const).find((s) => {
          const id = pool.relationships?.[`${s}_token`]?.data?.id;
          return id?.startsWith("sui-network_") && matchesCoinType(id.slice("sui-network_".length), coin);
        });
        const liquidity = Number(pool.attributes?.reserve_in_usd);
        const address = pool.attributes?.address;
        if (!side || !address || !Number.isFinite(liquidity) || liquidity <= 0) continue;
        if (!best || liquidity > best.liquidity) best = { address, side, liquidity, complete: false };
      }
      if (body.data.length < 20) { if (best) best.complete = true; break; }
    }
    return best;
  });
}

async function geckoTerminal(coin: string, day: number, oldest: number, now: number): Promise<PriceQuote[]> {
  const pool = await mostLiquidPool(coin);
  if (!pool) return [];
  return cached(`geckoterminal:${coin}:${pool.address}:${day}`, async () => {
    const before = Math.min(Math.floor(now / HOUR) * HOUR, day + DAY + HOUR);
    const body = await json(`${GECKO}/pools/${encodeURIComponent(pool.address)}/ohlcv/hour?aggregate=1&before_timestamp=${before}&limit=26&currency=usd&token=${pool.side}&include_empty_intervals=false`);
    if (!body) return [];
    const data = body.data as { attributes?: { ohlcv_list?: unknown } } | undefined;
    // OHLCV timestamps are candle starts in seconds. Close prices belong to
    // the end of a completed hour; never label them with the opening time.
    return samples(data?.attributes?.ohlcv_list, "geckoterminal", 1, 4, HOUR)
      .filter((q) => q.at! <= now && q.at! - HOUR >= oldest && q.at! >= day - HOUR && q.at! <= day + DAY + HOUR)
      .map((q) => ({ ...q, market: { pool_address: pool.address, candle_start: q.at! - HOUR, candle_end: q.at!, pool_scan_complete: pool.complete } }));
  });
}

/** One chart per coin/day, bounded concurrency, shared with point valuations. */
export async function fetchRecentHistory(requests: Map<string, number[]>, source: RecentPriceSource): Promise<HistoricalMarketPrices> {
  const quotes = new Map<string, Map<number, PriceQuote>>();
  const unanswered = new Map<string, Set<number>>();
  const outOfRange: OutOfRangePriceRequest[] = [];
  const now = Math.floor(Date.now() / 1000);
  const oldest = now - HISTORY_DAYS[source] * DAY;
  const groups = new Map<string, { coin: string; day: number; targets: Array<{ coin: string; time: number }> }>();
  for (const [coin, times] of requests) {
    const canonical = defiLlamaKey(coin)?.slice(4);
    if (!canonical) continue;
    for (const time of new Set(times)) {
      // A complete hourly candle cannot be read right on the retention edge.
      if (!Number.isFinite(time)) continue;
      if (time < oldest + (source === "geckoterminal" ? HOUR : 1) || time > now) {
        outOfRange.push({ coin_type: coin, at: time, source });
        continue;
      }
      const day = Math.floor(time / DAY) * DAY;
      const key = `${canonical}:${day}`;
      const group = groups.get(key) ?? { coin: canonical, day, targets: [] };
      group.targets.push({ coin, time });
      groups.set(key, group);
    }
  }
  const jobs = [...groups.values()];
  for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(async (group) => {
    try {
      const values = await (source === "coingecko" ? coinGecko : geckoTerminal)(group.coin, group.day, oldest, now);
      for (const { coin, time } of group.targets) {
        let nearest: PriceQuote | undefined;
        for (const quote of values) {
          if (quote.at! > now || Math.abs(quote.at! - time) > HOUR) continue;
          if (!nearest || Math.abs(quote.at! - time) < Math.abs(nearest.at! - time)) nearest = quote;
        }
        if (!nearest) continue;
        const found = quotes.get(coin) ?? new Map<number, PriceQuote>();
        found.set(time, nearest);
        quotes.set(coin, found);
      }
    } catch {
      for (const { coin, time } of group.targets) {
        const failed = unanswered.get(coin) ?? new Set<number>();
        failed.add(time);
        unanswered.set(coin, failed);
      }
    }
  }));
  return { quotes, unanswered, outOfRange };
}

/** DefiLlama first, then keyless recent history, never a current-price endpoint. */
export async function fetchHistoricalMarketPrices(requests: Map<string, number[]>): Promise<HistoricalMarketPrices> {
  const unanswered = new Map<string, Set<number>>();
  const outOfRange: OutOfRangePriceRequest[] = [];
  const quotes = await fetchDefiLlamaHistory(requests, unanswered);
  for (const source of ["coingecko", "geckoterminal"] as const) {
    const missing = new Map<string, number[]>();
    for (const [coin, times] of requests) {
      const rest = times.filter((t) => !quotes.get(coin)?.has(t));
      if (rest.length) missing.set(coin, rest);
    }
    const result = await fetchRecentHistory(missing, source);
    outOfRange.push(...result.outOfRange);
    for (const [coin, values] of result.quotes) {
      const target = quotes.get(coin) ?? new Map<number, PriceQuote>();
      for (const [time, quote] of values) target.set(time, quote);
      quotes.set(coin, target);
    }
    for (const [coin, times] of result.unanswered) {
      const target = unanswered.get(coin) ?? new Set<number>();
      for (const time of times) target.add(time);
      unanswered.set(coin, target);
    }
  }
  return { quotes, unanswered, outOfRange };
}
