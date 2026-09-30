import { getNetwork } from "../config.js";
import { fetchDefiLlamaHistory, pythApiKey } from "./price-providers.js";
import { displayCoin, prefetchCoinScale, priceUsdAtTime, pricingScale, toHumanAmount, type PricePoint as BasePricePoint } from "./valuation.js";

type PricePoint = BasePricePoint & { stale?: boolean };
const DAY = 86400;
const HOUR = 3600;
const MAX_DAYS = 366;
const MAX_QUOTES = 4096;
const cache = new Map<string, PricePoint>();
/** Tests only: isolate independent historical-price fixtures. */
export function resetWindowPriceCache(): void { cache.clear(); }
const priceHour = (time: number | null): number | null => time !== null && Number.isFinite(time) ? Math.floor(time / HOUR) * HOUR : null;
export interface PriceRequest { at: number | null; coins: Iterable<string> }
export interface WindowPrices {
  point: (coin: string, at: number | null) => PricePoint | undefined;
  basis: {
    method: "fixed_time" | "hourly_utc" | "daily_median_time"; at?: string; approximate: boolean; sources: string[];
    requested_coin_hours: number; requested_coin_samples: number; priced_coin_samples: number;
    missing_coin_samples: Array<{ coin_type: string; samples: number; first_at: string; last_at: string }>;
    unknown_time_transactions: number; budget_skipped_coin_samples: number; partial: boolean;
    meaning: string; priced_as?: Record<string, string>;
    stale_quotes?: Array<{ coin_type: string; offset_sec: number }>;
    continue_with?: { from?: string; to?: string; action: string };
  };
}

/** Median leg-time samples per coin/hour, or per coin/day only over budget. */
export async function windowPrices(requests: PriceRequest[], fixedAt?: number): Promise<WindowPrices> {
  const wanted = new Map<number, Set<string>>();
  const legTimes = new Map<string, number[]>();
  let unknownTime = 0;
  for (const request of requests) {
    const requested = [...request.coins];
    if (requested.length === 0) continue;
    const day = fixedAt ?? priceHour(request.at);
    if (day === null) { unknownTime++; continue; }
    const coins = wanted.get(day) ?? new Set<string>();
    for (const coin of new Set(requested)) {
      coins.add(coin);
      if (fixedAt !== undefined) continue;
      const times = legTimes.get(coin) ?? [];
      times.push(request.at!);
      legTimes.set(coin, times);
    }
    wanted.set(day, coins);
  }
  const requestedHours = [...wanted.values()].reduce((sum, coins) => sum + coins.size, 0);
  const coarsened = fixedAt === undefined && requestedHours > MAX_QUOTES;
  const sampleSpan = coarsened ? DAY : HOUR;
  const sampleTimes = new Map<string, Map<number, number>>();
  if (fixedAt === undefined) {
    wanted.clear();
    for (const [coin, times] of legTimes) {
      const buckets = new Map<number, number[]>();
      for (const time of times) {
        const bucket = Math.floor(time / sampleSpan) * sampleSpan;
        const legs = buckets.get(bucket) ?? [];
        legs.push(time);
        buckets.set(bucket, legs);
      }
      const samples = new Map<number, number>();
      sampleTimes.set(coin, samples);
      for (const [bucket, legs] of buckets) {
        legs.sort((a, b) => a - b);
        const at = Math.floor(legs[Math.floor(legs.length / 2)]);
        samples.set(bucket, at);
        const coins = wanted.get(at) ?? new Set<string>();
        coins.add(coin);
        wanted.set(at, coins);
      }
    }
  }
  const points = new Map<number, Map<string, PricePoint>>();
  const pending = new Map<number, string[]>();
  const selectedCoins = new Set<string>();
  let selected = 0;
  let skipped = 0;
  const provider = pythApiKey() ? "pyth+defillama" : "defillama";
  const network = getNetwork();
  const selectedDays = new Set<number>();
  for (const [day, coins] of [...wanted].sort(([a], [b]) => b - a)) {
    selectedDays.add(Math.floor(day / DAY));
    const daily = new Map<string, PricePoint>();
    points.set(day, daily);
    for (const coin of coins) {
      if (selectedDays.size > MAX_DAYS || selected >= MAX_QUOTES) { skipped++; continue; }
      selected++;
      selectedCoins.add(coin);
      const cached = cache.get(`${network}:${provider}:${day}:${coin}`);
      if (cached) daily.set(coin, cached);
      else {
        const list = pending.get(day) ?? [];
        list.push(coin);
        pending.set(day, list);
      }
    }
  }
  const scalesReady = prefetchCoinScale(selectedCoins);
  if (pending.size === 1 || provider !== "defillama") {
    const days = [...pending];
    for (let i = 0; i < days.length; i += 4) await Promise.all(days.slice(i, i + 4).map(async ([day, coins]) => {
      const result = await priceUsdAtTime(coins, day);
      for (const [coin, point] of result.points) {
        points.get(day)!.set(coin, point);
      }
    }));
  } else if (pending.size) {
    const byCoin = new Map<string, number[]>();
    for (const [day, coins] of pending) for (const coin of coins) {
      const times = byCoin.get(coin) ?? [];
      times.push(day);
      byCoin.set(coin, times);
    }
    for (const [coin, samples] of await fetchDefiLlamaHistory(byCoin)) for (const [day, quote] of samples) {
      points.get(day)!.set(coin, { price: quote.price, publishTime: quote.at!, source: "defillama",
        ...(quote.decimals !== undefined ? { decimals: quote.decimals } : {}), ...(quote.priced_as ? { priced_as: quote.priced_as } : {}) });
    }
  }
  await scalesReady;
  const missing = new Map<string, { coin_type: string; samples: number; first_at: string; last_at: string }>();
  let priced = 0;
  const sources = new Set<string>();
  const pricedAs: Record<string, string> = {};
  const stale = new Map<string, number>();
  let firstMissing: number | undefined;
  for (const [day, coins] of wanted) for (const coin of coins) {
    let point = points.get(day)?.get(coin);
    if (point && (pricingScale(coin, point).source === "assumed" || !Number.isFinite(point.publishTime) || Math.abs(point.publishTime - day) > 2 * HOUR)) {
      points.get(day)!.delete(coin);
      point = undefined;
    }
    if (point) {
      const offset = point.publishTime - day;
      if (Math.abs(offset) > HOUR) {
        point.stale = true;
        if (Math.abs(offset) > Math.abs(stale.get(coin) ?? 0)) stale.set(coin, offset);
      }
      priced++;
      sources.add(point.source);
      if (point.priced_as) pricedAs[coin] = point.priced_as;
      const key = `${network}:${provider}:${day}:${coin}`;
      if (!cache.has(key)) {
        if (cache.size >= MAX_QUOTES) cache.delete(cache.keys().next().value!);
        cache.set(key, point);
      }
    } else {
      firstMissing = firstMissing === undefined ? day : Math.min(firstMissing, day);
      const date = new Date(day * 1000).toISOString();
      const row = missing.get(coin) ?? { coin_type: coin, samples: 0, first_at: date, last_at: date };
      row.samples++;
      if (date < row.first_at) row.first_at = date;
      if (date > row.last_at) row.last_at = date;
      missing.set(coin, row);
    }
  }
  const point = (coin: string, at: number | null) => {
    const hour = priceHour(at);
    const sample = fixedAt ?? (hour === null ? undefined : sampleTimes.get(coin)?.get(Math.floor(hour / sampleSpan) * sampleSpan));
    return points.get(sample ?? NaN)?.get(coin);
  };
  const continuationSpan = coarsened ? DAY : HOUR;
  const continuationStart = firstMissing === undefined ? undefined : Math.floor(firstMissing / continuationSpan) * continuationSpan;
  return {
    point,
    basis: {
      method: fixedAt !== undefined ? "fixed_time" : coarsened ? "daily_median_time" : "hourly_utc",
      ...(fixedAt !== undefined ? { at: new Date(fixedAt * 1000).toISOString() } : {}),
      approximate: true,
      sources: [...sources],
      ...(Object.keys(pricedAs).length ? { priced_as: pricedAs } : {}),
      requested_coin_hours: requestedHours,
      requested_coin_samples: [...wanted.values()].reduce((n, coins) => n + coins.size, 0),
      priced_coin_samples: priced,
      missing_coin_samples: [...missing.values()],
      unknown_time_transactions: unknownTime,
      ...(stale.size ? { stale_quotes: [...stale].map(([coin_type, offset_sec]) => ({ coin_type, offset_sec })) } : {}),
      budget_skipped_coin_samples: skipped,
      partial: missing.size > 0 || unknownTime > 0,
      meaning: (fixedAt !== undefined ? "Coin USD uses the requested fixed time" : coarsened
        ? "Quote budget exceeded: each coin/day uses its median leg time"
        : "Each coin/UTC-hour uses its median leg time") +
        ". Quotes within one hour are fresh; those over one and up to two hours are stale, listed in stale_quotes and stale_priced_raw. Older quotes, unknown decimals and timestamps are excluded. Not execution prices. Objects use their own methods.",
      ...(missing.size || unknownTime ? { continue_with: {
        ...(continuationStart !== undefined ? {
          from: new Date(continuationStart * 1000).toISOString(),
          to: new Date((continuationStart + continuationSpan) * 1000 - 1).toISOString(),
        } : {}),
        action: "Retry this missing interval separately; incident sender mode uses start/end. For digest mode, split digests by time. No current-price fallback.",
      } } : {}),
    },
  };
}

interface AmountValue { raw: bigint; pricedIn: bigint; pricedOut: bigint; staleIn: bigint; staleOut: bigint; unpricedIn: bigint; unpricedOut: bigint; usd: number; priced: boolean; decimals: number }
/** Sum signed, time-valued legs without netting away missing-price coverage. */
export class WindowAmounts {
  readonly values = new Map<string, AmountValue>();
  constructor(private readonly prices: WindowPrices) {}
  add(coin: string, raw: bigint, at: number | null) {
    const p = this.prices.point(coin, at);
    const decimals = pricingScale(coin, p).decimals;
    const v = this.values.get(coin) ?? { raw: 0n, pricedIn: 0n, pricedOut: 0n, staleIn: 0n, staleOut: 0n, unpricedIn: 0n, unpricedOut: 0n, usd: 0, priced: false, decimals };
    v.raw += raw;
    const magnitude = raw < 0n ? -raw : raw;
    if (p) {
      v.priced = true;
      v.usd += (raw < 0n ? -1 : 1) * toHumanAmount(raw, decimals) * p.price;
      if (p.stale) { if (raw < 0n) v.staleOut += magnitude; else v.staleIn += magnitude; }
      else if (raw < 0n) v.pricedOut += magnitude; else v.pricedIn += magnitude;
    } else if (raw < 0n) v.unpricedOut += magnitude; else v.unpricedIn += magnitude;
    this.values.set(coin, v);
  }
  addMap(amounts: Map<string, bigint>, at: number | null) { for (const [coin, raw] of amounts) this.add(coin, raw, at); }
  usd(coin: string) { const v = this.values.get(coin); return v?.priced ? v.usd : null; }
  totalUsd() { const rows = [...this.values.values()]; return rows.some((v) => v.priced) ? rows.reduce((s, v) => s + v.usd, 0) : null; }
  coverage(coin: string) {
    const v = this.values.get(coin);
    return v ? { priced_raw: { in: v.pricedIn.toString(), out: v.pricedOut.toString() }, unpriced_raw: { in: v.unpricedIn.toString(), out: v.unpricedOut.toString() },
      ...(v.staleIn || v.staleOut ? { stale_priced_raw: { in: v.staleIn.toString(), out: v.staleOut.toString() } } : {}) } : {};
  }
  amounts() {
    return [...this.values].map(([coin, v]) => ({ coin_type: coin, symbol: displayCoin(coin).symbol,
      amount: (v.raw < 0n ? -1 : 1) * toHumanAmount(v.raw, v.decimals),
      usd: v.priced ? Math.round(v.usd * 100) / 100 : null, ...this.coverage(coin) }));
  }
}
