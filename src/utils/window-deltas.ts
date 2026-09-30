import { valueDeltas, type ValuedCoin, type ValuedDeltas } from "./attack-analysis.js";
import { WindowAmounts, type WindowPrices } from "./window-prices.js";

export interface TimedDeltas { at: number | null; deltas: Map<string, bigint> }
export interface CoveredCoin extends ValuedCoin {
  priced_raw: { in: string; out: string };
  unpriced_raw: { in: string; out: string };
  stale_priced_raw?: { in: string; out: string };
}
export interface WindowDeltas extends ValuedDeltas { coins: CoveredCoin[] }

/** Net USD legs after pricing, retaining missing debits and credits separately. */
export function valueWindowDeltas(legs: TimedDeltas[], prices: WindowPrices): WindowDeltas {
  const amounts = new WindowAmounts(prices);
  const display = new Map<string, ValuedCoin>();
  for (const { at, deltas } of legs) {
    const points = new Map([...deltas.keys()].flatMap((coin) => {
      const point = prices.point(coin, at);
      return point ? [[coin, point] as const] : [];
    }));
    for (const coin of valueDeltas(deltas, points).coins) {
      const existing = display.get(coin.coin_type);
      if (existing) existing.amount_human += coin.amount_human;
      else display.set(coin.coin_type, { ...coin });
    }
    amounts.addMap(deltas, at);
  }
  const coins: CoveredCoin[] = [];
  const unpriced: string[] = [];
  let net = 0;
  let gained = 0;
  for (const [coin, v] of amounts.values) {
    const meta = display.get(coin);
    if (!meta) continue;
    if (v.unpricedIn || v.unpricedOut) unpriced.push(coin);
    net += v.usd;
    gained += Math.max(0, v.usd);
    coins.push({ ...meta, amount: v.raw.toString(), usd: v.priced ? Math.round(v.usd * 100) / 100 : null,
      priced_raw: { in: v.pricedIn.toString(), out: v.pricedOut.toString() },
      unpriced_raw: { in: v.unpricedIn.toString(), out: v.unpricedOut.toString() },
      ...(v.staleIn || v.staleOut ? { stale_priced_raw: { in: v.staleIn.toString(), out: v.staleOut.toString() } } : {}) });
  }
  coins.sort((a, b) => Math.abs(b.usd ?? 0) - Math.abs(a.usd ?? 0));
  return { coins, usd_net: Math.round(net * 100) / 100, usd_gained: Math.round(gained * 100) / 100, unpriced };
}
