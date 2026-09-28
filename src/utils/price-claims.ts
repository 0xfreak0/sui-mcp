/**
 * Prices a transaction states for coins, checked against a price provider.
 *
 * A protocol that values a coin writes or emits that value somewhere: an
 * event naming one coin next to its numbers, or a table row keyed by the
 * coin's type. No rule here reads a field name. A field is taken to be a
 * price only when, at one power of ten, it agrees with the provider's price
 * for most of the coins it is stated for; a coin whose number in that same
 * field is far from its provider price was then valued at a price the market
 * did not give it (another asset's feed, a key that signs any number, a
 * mapping to the wrong slot).
 *
 * Pure: the caller reads the rows and the provider prices.
 */

import { normalizeStructTag } from "@mysten/sui/utils";
import type { AttackEvent } from "./attack-analysis.js";
import type { CheckRun, PtbAnomaly } from "./ptb-anomalies.js";
import { numericFields } from "./state-delta.js";
import { PRICE_STALE_THRESHOLD_SEC, symbolOf, type PricePoint } from "./valuation.js";

/** One number a record states next to exactly one coin. */
export interface PriceClaim {
  /** `event`: an event's fields. `row`: a dynamic field keyed by the coin's type, at the transaction's output version. */
  source: "event" | "row";
  /** Event index, or the row's object id. */
  where: string;
  /** Event type or row type with type arguments dropped: the records a field is compared across. */
  group: string;
  path: string;
  coin: string;
  value: bigint;
}

/** A coin-keyed dynamic field read after the transaction. */
export interface KeyedRow {
  objectId: string;
  objectType: string | null;
  after: unknown;
}

const TYPE_TAG = /^(0x)?[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/;
/** Numbers at or above 2^127 are signed values stored unsigned, or "unset" sentinels. */
const SIGNED_OR_SENTINEL = 2n ** 127n;

function coinOf(s: string): string | null {
  if (!TYPE_TAG.test(s)) return null;
  try {
    return normalizeStructTag(s.startsWith("0x") ? s : `0x${s}`);
  } catch {
    return null;
  }
}

/** Coin types a record's string fields name, outside lists, to a shallow depth. */
function coinsNamed(json: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 3 || Array.isArray(json)) return out;
  if (typeof json === "string") {
    const c = coinOf(json);
    if (c) out.add(c);
  } else if (json && typeof json === "object") {
    for (const v of Object.values(json)) coinsNamed(v, out, depth + 1);
  }
  return out;
}

/** The single coin a generic event type is instantiated with, when it has one type argument and that is a plain struct. */
function coinOfTypeArg(type: string): string | null {
  const open = type.indexOf("<");
  if (open < 0 || !type.endsWith(">")) return null;
  const inner = type.slice(open + 1, -1);
  if (inner.includes("<") || inner.includes(",")) return null;
  return coinOf(inner.trim());
}

/**
 * Every number stated next to exactly one coin: in an event that names one
 * coin (in a field or as its only type argument), and in a dynamic field
 * keyed by a coin's type. A record naming two coins (a swap, a pair) is
 * skipped, since which coin a number is for is unknown.
 */
export function priceClaimsOf(events: AttackEvent[], rows: KeyedRow[] = []): PriceClaim[] {
  const out: PriceClaim[] = [];
  const push = (source: PriceClaim["source"], where: string, group: string, coin: string, json: unknown) => {
    for (const [path, value] of numericFields(json)) {
      if (value <= 0n || value >= SIGNED_OR_SENTINEL) continue;
      out.push({ source, where, group, path, coin, value });
    }
  };
  for (const e of events) {
    const named = coinsNamed(e.json);
    const coin = named.size === 1 ? [...named][0] : named.size === 0 ? coinOfTypeArg(e.type) : null;
    if (coin) push("event", String(e.index), e.type.split("<")[0], coin, e.json);
  }
  for (const r of rows) {
    const rec = r.after && typeof r.after === "object" ? (r.after as Record<string, unknown>) : null;
    const name = rec && typeof rec.name === "string" ? coinOf(rec.name) : null;
    if (!name || !rec) continue;
    push("row", r.objectId, (r.objectType ?? "row").split("<")[0], name, rec.value);
  }
  return out;
}

/** Within this factor of the provider price, a coin's number agrees with it: 5%. */
export const AGREE_FACTOR = 1.05;
/** At this factor from the provider price or more, a coin's number is off market: 5x. */
export const OFF_MARKET_FACTOR = 5;
/** Off by this factor or more reads high. */
const HIGH_FACTOR = 10;
/**
 * DefiLlama scores its agreement 0 to 1, 0.99 for its best-sourced prices; a
 * price below that tier (a coin priced from one thin market) does not judge
 * a coin.
 */
const MIN_CONFIDENCE = 0.95;

export interface OffMarketPrice {
  coin: string;
  source: PriceClaim["source"];
  where: string;
  group: string;
  path: string;
  /** The stated number at the field's scale, in USD. */
  stated_usd: number;
  provider_usd: number;
  provider: PricePoint["source"];
  /** Stated over provider: above 1 the coin was valued higher than the market. */
  factor: number;
  /** The power of ten the field agrees with the provider at. */
  scale: number;
  /** Other coins the same field states within {@link AGREE_FACTOR} of their provider price at that scale. */
  agreeing: string[];
}

/** A provider price fit to judge a coin by at `atSec`: fresh, and confident when the provider scores itself. */
function usable(p: PricePoint | undefined, atSec: number): p is PricePoint {
  if (!p || !(p.price > 0)) return false;
  if (Math.abs(p.publishTime - atSec) > PRICE_STALE_THRESHOLD_SEC) return false;
  return p.source !== "defillama" || p.confidence === undefined || p.confidence >= MIN_CONFIDENCE;
}

const log10Big = (v: bigint): number => {
  const s = v.toString();
  const head = Number(s.slice(0, 15));
  return Math.log10(head) + (s.length - Math.min(15, s.length));
};

/**
 * Per field (a group and a path), the power of ten at which the most coins'
 * numbers agree with their provider prices. The field counts as a price when
 * at least two coins agree at that scale and they are at least half of the
 * coins with a usable provider price it states. Each number in that field
 * {@link OFF_MARKET_FACTOR} or more from its coin's provider price is
 * reported, the largest per coin and field.
 */
export function offMarketPrices(claims: PriceClaim[], prices: Map<string, PricePoint>, atSec: number): OffMarketPrice[] {
  const byField = new Map<string, PriceClaim[]>();
  for (const c of claims) {
    const k = `${c.source} ${c.group} ${c.path}`;
    byField.set(k, [...(byField.get(k) ?? []), c]);
  }
  const agree = Math.log10(AGREE_FACTOR);
  const off = Math.log10(OFF_MARKET_FACTOR);
  const out: OffMarketPrice[] = [];
  for (const list of byField.values()) {
    const judged = list.flatMap((c) => {
      const p = prices.get(c.coin);
      return usable(p, atSec) ? [{ c, p, e: log10Big(c.value) - Math.log10(p.price) }] : [];
    });
    const priced = new Set(judged.map((j) => j.c.coin));
    if (priced.size < 2) continue;
    const byScale = new Map<number, Set<string>>();
    for (const j of judged) {
      const k = Math.round(j.e);
      if (Math.abs(j.e - k) <= agree) byScale.set(k, (byScale.get(k) ?? new Set()).add(j.c.coin));
    }
    const best = [...byScale].sort((a, b) => b[1].size - a[1].size || a[0] - b[0])[0];
    if (!best || best[1].size < 2 || best[1].size * 2 < priced.size) continue;
    const [scale, agreeing] = best;
    const worst = new Map<string, OffMarketPrice>();
    for (const j of judged) {
      const d = j.e - scale;
      if (Math.abs(d) < off) continue;
      const prev = worst.get(j.c.coin);
      if (prev && Math.abs(Math.log10(prev.factor)) >= Math.abs(d)) continue;
      worst.set(j.c.coin, {
        coin: j.c.coin,
        source: j.c.source,
        where: j.c.where,
        group: j.c.group,
        path: j.c.path,
        stated_usd: Number((j.p.price * 10 ** d).toPrecision(6)),
        provider_usd: Number(j.p.price.toPrecision(6)),
        provider: j.p.source,
        factor: Number((10 ** d).toPrecision(4)),
        scale,
        agreeing: [...agreeing].filter((c) => c !== j.c.coin),
      });
    }
    out.push(...worst.values());
  }
  // One line per coin and record kind: the farthest field.
  const perCoin = new Map<string, OffMarketPrice>();
  for (const o of out) {
    const k = `${o.coin} ${o.source} ${o.group}`;
    const prev = perCoin.get(k);
    if (!prev || Math.abs(Math.log10(o.factor)) > Math.abs(Math.log10(prev.factor))) perCoin.set(k, o);
  }
  return [...perCoin.values()].sort((a, b) => Math.abs(Math.log10(b.factor)) - Math.abs(Math.log10(a.factor)));
}

export const PRICE_CHECK: CheckRun = {
  code: "price-off-market",
  rule: `a coin's price stated in an event or coin-keyed row is ${OFF_MARKET_FACTOR}x from its provider price, in a field within ${Math.round((AGREE_FACTOR - 1) * 100)}% of it for 2+ coins and half of them; high at ${HIGH_FACTOR}x`,
};

/** The `price-off-market` anomaly: high at {@link HIGH_FACTOR}x or more either way, medium from {@link OFF_MARKET_FACTOR}x. */
export function priceAnomaly(found: OffMarketPrice[]): PtbAnomaly | null {
  if (!found.length) return null;
  const top = Math.max(...found.map((o) => Math.abs(Math.log10(o.factor))));
  const coins = [...new Set(found.map((o) => o.coin))];
  return {
    severity: top >= Math.log10(HIGH_FACTOR) ? "high" : "medium",
    code: "price-off-market",
    title: `States a price for ${coins.length === 1 ? symbolOf(coins[0]) : `${coins.length} coins`} ${OFF_MARKET_FACTOR}x or more from the provider price, in a field that agrees with the provider for other coins`,
    detail:
      `An event naming one coin, or a table row keyed by a coin's type, carries a number that at one power of ten matches a price provider's price for other coins within ${Math.round((AGREE_FACTOR - 1) * 100)}% (so the field holds prices), while for this coin it is ${OFF_MARKET_FACTOR}x or more away. Whatever read that price valued the coin as another asset, or at a price someone chose: a feed mapped to the wrong asset, an oracle key that signs any number, or a price set and restored within the transaction. The provider price is a third-party figure at the block time; check the feed or slot the protocol resolves the coin to with get_object, and the oracle's write path with get_move_function. High at ${HIGH_FACTOR}x or more.`,
    evidence: found.slice(0, 10).map(
      (o) =>
        `${o.coin} stated at $${o.stated_usd} (${o.source === "event" ? `event ${o.where}` : `row ${o.where}`}, ${o.group.split("::").slice(1).join("::")} ${o.path} at 10^${o.scale}), ${o.factor >= 1 ? `${o.factor.toPrecision(3)}x its provider price` : `1/${(1 / o.factor).toPrecision(3)} of its provider price`} ($${o.provider_usd}, ${o.provider}); the same field agrees for ${o.agreeing.slice(0, 3).map(symbolOf).join(", ")}${o.agreeing.length > 3 ? ` and ${o.agreeing.length - 3} more` : ""}`,
    ),
  };
}
