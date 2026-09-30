import { getNetwork } from "../config.js";
import { fetchDefiLlamaHistory, pythApiKey } from "./price-providers.js";
import { displayCoin, prefetchCoinScale, priceUsdAtTime, pricingScale, toHumanAmount, type PricePoint } from "./valuation.js";

const DAY = 86400;
const MAX_DAYS = 366;
const MAX_QUOTES = 4096;
const cache = new Map<string, PricePoint>();
/** Tests only: isolate independent historical-price fixtures. */
export function resetWindowPriceCache(): void { cache.clear(); }
export const priceDay = (time: number | null): number | null => time !== null && Number.isFinite(time) ? Math.floor(time / DAY) * DAY : null;
export interface PriceRequest { at: number | null; coins: Iterable<string> }
export interface WindowPrices {
  point: (coin: string, at: number | null) => PricePoint | undefined;
  basis: {
    method: "fixed_time" | "daily_utc"; at?: string; approximate: boolean; sources: string[];
    requested_coin_days: number; priced_coin_days: number;
    missing_coin_days: Array<{ coin_type: string; days: number; first_day: string; last_day: string }>;
    unknown_time_transactions: number; budget_skipped_coin_days: number; partial: boolean;
    meaning: string; priced_as?: Record<string, string>;
    continue_with?: { from?: string; to?: string; action: string };
  };
}

/** UTC-day samples shared across every valuation in one report. */
export async function windowPrices(requests: PriceRequest[], fixedAt?: number): Promise<WindowPrices> {
  const wanted = new Map<number, Set<string>>();
  let unknownTime = 0;
  for (const request of requests) {
    const requested = [...request.coins];
    if (requested.length === 0) continue;
    const day = fixedAt ?? priceDay(request.at);
    if (day === null) { unknownTime++; continue; }
    const coins = wanted.get(day) ?? new Set<string>();
    for (const coin of requested) coins.add(coin);
    wanted.set(day, coins);
  }
  const points = new Map<number, Map<string, PricePoint>>();
  const pending = new Map<number, string[]>();
  const selectedCoins = new Set<string>();
  let selected = 0;
  let skipped = 0;
  const provider = pythApiKey() ? "pyth+defillama" : "defillama";
  const network = getNetwork();
  for (const [index, [day, coins]] of [...wanted].sort(([a], [b]) => b - a).entries()) {
    const daily = new Map<string, PricePoint>();
    points.set(day, daily);
    for (const coin of coins) {
      if (index >= MAX_DAYS || selected >= MAX_QUOTES) { skipped++; continue; }
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
        if (Math.abs(point.publishTime - day) <= 3600) points.get(day)!.set(coin, point);
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
  const missing = new Map<string, { coin_type: string; days: number; first_day: string; last_day: string }>();
  let priced = 0;
  const sources = new Set<string>();
  const pricedAs: Record<string, string> = {};
  let firstMissing: number | undefined;
  for (const [day, coins] of wanted) for (const coin of coins) {
    let point = points.get(day)?.get(coin);
    if (point && pricingScale(coin, point).source === "assumed") {
      points.get(day)!.delete(coin);
      point = undefined;
    }
    if (point) {
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
      const date = new Date(day * 1000).toISOString().slice(0, 10);
      const row = missing.get(coin) ?? { coin_type: coin, days: 0, first_day: date, last_day: date };
      row.days++;
      if (date < row.first_day) row.first_day = date;
      if (date > row.last_day) row.last_day = date;
      missing.set(coin, row);
    }
  }
  const point = (coin: string, at: number | null) => points.get(fixedAt ?? priceDay(at) ?? NaN)?.get(coin);
  return {
    point,
    basis: {
      method: fixedAt !== undefined ? "fixed_time" : "daily_utc",
      ...(fixedAt !== undefined ? { at: new Date(fixedAt * 1000).toISOString() } : {}),
      approximate: true,
      sources: [...sources],
      ...(Object.keys(pricedAs).length ? { priced_as: pricedAs } : {}),
      requested_coin_days: [...wanted.values()].reduce((n, coins) => n + coins.size, 0),
      priced_coin_days: priced,
      missing_coin_days: [...missing.values()],
      unknown_time_transactions: unknownTime,
      budget_skipped_coin_days: skipped,
      partial: missing.size > 0 || unknownTime > 0,
      meaning: (fixedAt !== undefined ? "Coin USD uses the requested fixed time" : "Coin USD sums use each transaction's UTC-day midnight quote") +
        " (within one hour), not execution prices. Missing prices, known decimals or timestamps are excluded; priced/unpriced raw amounts show coverage. Objects use their own stated methods.",
      ...(missing.size || unknownTime ? { continue_with: {
        ...(firstMissing !== undefined ? {
          from: new Date(firstMissing * 1000).toISOString(),
          to: new Date((firstMissing + DAY) * 1000 - 1).toISOString(),
        } : {}),
        action: "Retry this missing day separately; incident sender mode uses start/end. For digest mode, split the digests by date. Missing timestamps require transaction reads; no current-price fallback.",
      } } : {}),
    },
  };
}

interface AmountValue { raw: bigint; pricedIn: bigint; pricedOut: bigint; unpricedIn: bigint; unpricedOut: bigint; usd: number; priced: boolean; decimals: number }
/** Sum signed, time-valued legs without netting away missing-price coverage. */
export class WindowAmounts {
  readonly values = new Map<string, AmountValue>();
  constructor(private readonly prices: WindowPrices) {}
  add(coin: string, raw: bigint, at: number | null) {
    const p = this.prices.point(coin, at);
    const decimals = pricingScale(coin, p).decimals;
    const v = this.values.get(coin) ?? { raw: 0n, pricedIn: 0n, pricedOut: 0n, unpricedIn: 0n, unpricedOut: 0n, usd: 0, priced: false, decimals };
    v.raw += raw;
    const magnitude = raw < 0n ? -raw : raw;
    if (p) {
      v.priced = true;
      v.usd += (raw < 0n ? -1 : 1) * toHumanAmount(raw, decimals) * p.price;
      if (raw < 0n) v.pricedOut += magnitude; else v.pricedIn += magnitude;
    } else if (raw < 0n) v.unpricedOut += magnitude; else v.unpricedIn += magnitude;
    this.values.set(coin, v);
  }
  addMap(amounts: Map<string, bigint>, at: number | null) { for (const [coin, raw] of amounts) this.add(coin, raw, at); }
  usd(coin: string) { const v = this.values.get(coin); return v?.priced ? v.usd : null; }
  totalUsd() { const rows = [...this.values.values()]; return rows.some((v) => v.priced) ? rows.reduce((s, v) => s + v.usd, 0) : null; }
  coverage(coin: string) {
    const v = this.values.get(coin);
    return v ? { priced_raw: { in: v.pricedIn.toString(), out: v.pricedOut.toString() }, unpriced_raw: { in: v.unpricedIn.toString(), out: v.unpricedOut.toString() } } : {};
  }
  amounts() {
    return [...this.values].map(([coin, v]) => ({ coin_type: coin, symbol: displayCoin(coin).symbol,
      amount: (v.raw < 0n ? -1 : 1) * toHumanAmount(v.raw, v.decimals),
      usd: v.priced ? Math.round(v.usd * 100) / 100 : null, ...this.coverage(coin) }));
  }
}
