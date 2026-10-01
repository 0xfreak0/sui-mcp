import { getNetwork } from "../config.js";
import { pythApiKey, type ProviderUnavailable, type PriceSource } from "./price-providers.js";
import { withPriceProviderCall } from "./price-call-context.js";
import { fetchHistoricalMarketPrices } from "./recent-prices.js";
import type { OutOfRangePriceRequest, RecentPriceSource } from "./recent-prices.js";
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
    price_samples: Array<{ coin_type: string; requested_at: number; source?: string; price_usd: number; price_time: number; price_offset_sec: number; market?: BasePricePoint["market"] }>;
    missing_coin_samples: Array<{ coin_type: string; samples: number; first_at: string; last_at: string; request_failed_samples?: number }>;
    out_of_range_coin_samples: Array<{ coin_type: string; source: RecentPriceSource; samples: number; first_at: string; last_at: string }>;
    out_of_range_sources: Array<{ source: RecentPriceSource; samples: number; coins: number; first_at: string; last_at: string }>;
    provider_unavailable: ProviderUnavailable[];
    unknown_time_transactions: number; budget_skipped_coin_samples: number; partial: boolean;
    meaning: string; priced_as?: Record<string, string>;
    stale_quotes?: Array<{ coin_type: string; offset_sec: number }>;
    continue_with?: { from?: string; to?: string; action: string };
  };
}

/** Median leg-time samples per coin/hour, or per coin/day only over budget. */
export async function windowPrices(requests: PriceRequest[], fixedAt?: number): Promise<WindowPrices> {
  return withPriceProviderCall(() => readWindowPrices(requests, fixedAt));
}

async function readWindowPrices(requests: PriceRequest[], fixedAt?: number): Promise<WindowPrices> {
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
  const failed = new Map<string, Set<number>>();
  const outOfRange: OutOfRangePriceRequest[] = [];
  const selectedCoins = new Set<string>();
  const unavailable = new Map<PriceSource, ProviderUnavailable>();
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
      for (const row of result.provider_unavailable) {
        const previous = unavailable.get(row.source);
        unavailable.set(row.source, { ...row, samples: (previous?.samples ?? 0) + row.samples });
      }
      for (const row of result.unpriced) {
        if (row.code === "provider_unavailable") {
          const times = failed.get(row.coin_type) ?? new Set<number>();
          times.add(day);
          failed.set(row.coin_type, times);
        }
        for (const source of row.out_of_range_sources ?? []) outOfRange.push({ coin_type: row.coin_type, at: day, source });
      }
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
    const result = await fetchHistoricalMarketPrices(byCoin);
    for (const row of result.provider_unavailable) unavailable.set(row.source, row);
    for (const [coin, times] of result.unanswered) failed.set(coin, times);
    outOfRange.push(...result.outOfRange);
    for (const [coin, samples] of result.quotes) for (const [day, quote] of samples) {
      if (quote.source === "aftermath") continue;
      points.get(day)!.set(coin, { price: quote.price, publishTime: quote.at!, price_offset_sec: quote.at! - day, source: quote.source,
        ...(quote.decimals !== undefined ? { decimals: quote.decimals } : {}), ...(quote.priced_as ? { priced_as: quote.priced_as } : {}),
        ...(quote.market ? { market: quote.market } : {}) });
    }
  }
  await scalesReady;
  const rangeCoverage = new Map<string, WindowPrices["basis"]["out_of_range_coin_samples"][number]>();
  for (const { coin_type, source, at } of outOfRange) {
    const key = `${source}:${coin_type}`;
    const date = new Date(at * 1000).toISOString();
    const row = rangeCoverage.get(key) ?? { coin_type, source, samples: 0, first_at: date, last_at: date };
    row.samples++;
    if (date < row.first_at) row.first_at = date;
    if (date > row.last_at) row.last_at = date;
    rangeCoverage.set(key, row);
  }
  const sourceCoverage = new Map<RecentPriceSource, WindowPrices["basis"]["out_of_range_sources"][number]>();
  for (const { source, samples, first_at, last_at } of rangeCoverage.values()) {
    const row = sourceCoverage.get(source) ?? { source, samples: 0, coins: 0, first_at, last_at };
    row.samples += samples;
    row.coins++;
    if (first_at < row.first_at) row.first_at = first_at;
    if (last_at > row.last_at) row.last_at = last_at;
    sourceCoverage.set(source, row);
  }
  const missing = new Map<string, WindowPrices["basis"]["missing_coin_samples"][number]>();
  const priceSamples: WindowPrices["basis"]["price_samples"] = [];
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
      priceSamples.push({ coin_type: coin, requested_at: day, source: point.source, price_usd: point.price,
        price_time: point.publishTime, price_offset_sec: offset, ...(point.market ? { market: point.market } : {}) });
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
      if (failed.get(coin)?.has(day)) row.request_failed_samples = (row.request_failed_samples ?? 0) + 1;
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
      // With one provider, basis.sources supplies the common source for every sample.
      price_samples: sources.size === 1 ? priceSamples.map(({ source: _source, ...sample }) => sample) : priceSamples,
      missing_coin_samples: [...missing.values()],
      out_of_range_coin_samples: [...rangeCoverage.values()],
      out_of_range_sources: [...sourceCoverage.values()],
      provider_unavailable: [...unavailable.values()],
      unknown_time_transactions: unknownTime,
      ...(stale.size ? { stale_quotes: [...stale].map(([coin_type, offset_sec]) => ({ coin_type, offset_sec })) } : {}),
      budget_skipped_coin_samples: skipped,
      partial: missing.size > 0 || unknownTime > 0,
      meaning: "USD estimates use provider quotes " + (fixedAt !== undefined ? "near the requested fixed time" : coarsened
        ? "near transaction times: each coin/UTC-day at its median movement time (quote budget exceeded)"
        : "near transaction times: each coin/UTC-hour at its median movement time") +
        ". Quotes over 1h through 2h away are stale (stale_quotes, stale_priced_raw); older quotes, unknown decimals and times are excluded. Not execution prices. Objects use their own methods.",
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

interface AmountValue {
  raw: bigint; pricedIn: bigint; pricedOut: bigint; staleIn: bigint; staleOut: bigint;
  unpricedIn: bigint; unpricedOut: bigint; usd: number; priced: boolean; decimals: number;
  sources: Map<string, { in: bigint; out: bigint }>;
}
/** Sum signed, time-valued legs without netting away missing-price coverage. */
export class WindowAmounts {
  readonly values = new Map<string, AmountValue>();
  constructor(private readonly prices: WindowPrices) {}
  add(coin: string, raw: bigint, at: number | null) {
    const p = this.prices.point(coin, at);
    const decimals = pricingScale(coin, p).decimals;
    const v = this.values.get(coin) ?? { raw: 0n, pricedIn: 0n, pricedOut: 0n, staleIn: 0n, staleOut: 0n, unpricedIn: 0n, unpricedOut: 0n, usd: 0, priced: false, decimals, sources: new Map<string, { in: bigint; out: bigint }>() };
    v.raw += raw;
    const magnitude = raw < 0n ? -raw : raw;
    if (p) {
      v.priced = true;
      const source = v.sources.get(p.source) ?? { in: 0n, out: 0n };
      if (raw < 0n) source.out += magnitude; else source.in += magnitude;
      v.sources.set(p.source, source);
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
    if (!v) return {};
    const stale = v.staleIn || v.staleOut ? { stale_priced_raw: { in: v.staleIn.toString(), out: v.staleOut.toString() } } : {};
    const priced_by_source = [...v.sources].map(([source, raw]) => ({ source, raw: { in: raw.in.toString(), out: raw.out.toString() } }));
    if (!v.unpricedIn && !v.unpricedOut) {
      return { raw: { in: (v.pricedIn + v.staleIn).toString(), out: (v.pricedOut + v.staleOut).toString() }, priced_by_source, ...stale };
    }
    return { priced_raw: { in: v.pricedIn.toString(), out: v.pricedOut.toString() },
      unpriced_raw: { in: v.unpricedIn.toString(), out: v.unpricedOut.toString() }, priced_by_source, ...stale };
  }
  amounts() {
    return [...this.values].map(([coin, v]) => ({ coin_type: coin, symbol: displayCoin(coin).symbol,
      amount: (v.raw < 0n ? -1 : 1) * toHumanAmount(v.raw, v.decimals),
      usd: v.priced ? Math.round(v.usd * 100) / 100 : null, ...this.coverage(coin) }));
  }
}
