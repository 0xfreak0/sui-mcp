/**
 * Pricing an NFT from its collection's market, as an estimate.
 *
 * Pure. The network half is `nft-market-read.ts`.
 *
 * ## The rule
 *
 * An item is worth the lower of its collection's floor (the lowest active
 * listing) and its last sale. A floor is what a seller asks and a sale is what
 * one buyer paid once, and each overstates on its own: a listing nobody takes,
 * a rare item sold above the rest. With only one of the two, that one is used.
 *
 * Both are held to a window of {@link MARKET_WINDOW_DAYS} days before the
 * valuation time. A sale older than that does not count. A live listing always
 * caps a counted sale, since anyone can buy at it, but it prices an item on
 * its own only when it was placed or repriced inside the window: a listing
 * that has sat unbought longer is an ask the market has not met, and one whose
 * time is not recorded cannot be shown to be current. With nothing left, the
 * item is unpriced.
 *
 * Listings are read at the current state only, so a valuation for a past time
 * rests on sales alone.
 *
 * Every value here is tier `heuristic`.
 *
 * ## Sales that do not count
 *
 * A zero price, and a sale whose two sides are the same address or the same
 * kiosk, or where one side's first funder is the other. The first-funder test
 * is the cheap half of a wash-trade check: one cached lookup per address.
 * Funding through an intermediary, or a transfer after the first, is not
 * looked for.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { canonicalType } from "./nft-sales.js";

/** How far before the valuation time a sale, or a listing standing alone, still prices an item. */
export const MARKET_WINDOW_DAYS = 30;
const MARKET_WINDOW_SEC = MARKET_WINDOW_DAYS * 86_400;

/** One active listing, from any source. */
export interface MarketListing {
  source: string;
  /** Asking price in MIST. */
  price_mist: string;
  /** When the listing was placed or last repriced; null when the source does not record it. */
  listed_at: string | null;
  listing_id?: string;
  nft_id?: string;
  seller?: string;
}

/** One sale of an item of the collection. */
export interface MarketSale {
  marketplace: string;
  /** Price in MIST. */
  price_mist: string;
  /** Time of the sale's transaction. */
  at: string;
  checkpoint: number;
  digest: string;
  nft_id: string;
  buyer?: string;
  seller?: string;
  buyer_kiosk_id?: string;
  seller_kiosk_id?: string;
  /** The seller is the transaction's signer, because the event names no seller. */
  seller_is_signer?: boolean;
}

function toBig(v: string | undefined | null): bigint | null {
  if (v === undefined || v === null || !/^\d+$/.test(v)) return null;
  return BigInt(v);
}

/** The cheapest listing with a positive price. A listing at zero is a transfer, never an ask. */
export function lowestListing(listings: readonly MarketListing[]): MarketListing | null {
  let best: MarketListing | null = null;
  let bestPrice = 0n;
  for (const l of listings) {
    const p = toBig(l.price_mist);
    if (p === null || p <= 0n) continue;
    if (!best || p < bestPrice) {
      best = l;
      bestPrice = p;
    }
  }
  return best;
}

const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && normalizeSuiAddress(a) === normalizeSuiAddress(b);

/** Why a sale does not show what an item is worth, judged from the sale alone; null when nothing says so. */
export function saleExclusion(sale: MarketSale): string | null {
  const p = toBig(sale.price_mist);
  if (p === null || p <= 0n) return "no price: a purchase at zero moves an item without paying for it";
  if (sameAddress(sale.buyer, sale.seller)) return "buyer and seller are the same address";
  if (sameAddress(sale.buyer_kiosk_id, sale.seller_kiosk_id)) return "bought from and into the same kiosk";
  return null;
}

/** Why a sale is a wash trade by who first funded whom; null when neither side first funded the other. */
export function fundingExclusion(
  sale: MarketSale,
  firstFunder: { buyer?: string | null; seller?: string | null },
): string | null {
  if (sameAddress(firstFunder.buyer, sale.seller)) return "the seller first funded the buyer";
  if (sameAddress(firstFunder.seller, sale.buyer)) return "the buyer first funded the seller";
  return null;
}

/**
 * Sales grouped by transaction, newest transaction first, each group cheapest
 * first. A sweep buys several items in one transaction, and its cheapest item
 * is the one that says what any item of the collection fetched.
 */
export function salesByTransaction(sales: readonly MarketSale[]): MarketSale[][] {
  const groups = new Map<string, MarketSale[]>();
  for (const s of sales) {
    const g = groups.get(s.digest);
    if (g) g.push(s);
    else groups.set(s.digest, [s]);
  }
  const price = (s: MarketSale) => toBig(s.price_mist) ?? 0n;
  return [...groups.values()]
    .map((g) => g.sort((a, b) => (price(a) < price(b) ? -1 : price(a) > price(b) ? 1 : 0)))
    .sort((a, b) => b[0].checkpoint - a[0].checkpoint);
}

export type EstimateBasis = "lower_of_floor_and_last_sale" | "floor" | "last_sale";

export interface UnitEstimate {
  /** Per item, in MIST; null when unpriced. */
  unit_mist: string | null;
  basis: EstimateBasis | null;
  /** A sale was found but is older than the window, so it did not count. */
  sale_stale: boolean;
  /** The floor was placed before the window or has no time, so it could not price an item alone. */
  floor_stale: boolean;
  unpriced_reason?: string;
}

/**
 * One item's value from its collection's floor and last counted sale, at
 * `asOfSec`. `floorRead` is false when listings were not read, which is the
 * case for any past valuation time.
 */
export function estimateUnit(
  floor: MarketListing | null,
  sale: MarketSale | null,
  opts: { asOfSec: number; floorRead: boolean; windowSec?: number },
): UnitEstimate {
  const windowSec = opts.windowSec ?? MARKET_WINDOW_SEC;
  const saleAt = sale ? Date.parse(sale.at) / 1000 : Number.NaN;
  const saleFresh = sale !== null && Number.isFinite(saleAt) && opts.asOfSec - saleAt <= windowSec;
  const listedAt = floor?.listed_at ? Date.parse(floor.listed_at) / 1000 : Number.NaN;
  const floorFresh = floor !== null && Number.isFinite(listedAt) && opts.asOfSec - listedAt <= windowSec;
  const f = floor ? toBig(floor.price_mist) : null;
  const s = saleFresh ? toBig(sale!.price_mist) : null;
  const stale = { sale_stale: sale !== null && !saleFresh, floor_stale: f !== null && f > 0n && !floorFresh };
  if (f !== null && f > 0n && s !== null) {
    return { unit_mist: (f < s ? f : s).toString(), basis: "lower_of_floor_and_last_sale", sale_stale: false, floor_stale: false };
  }
  if (f !== null && f > 0n && floorFresh) return { unit_mist: f.toString(), basis: "floor", ...stale };
  if (s !== null) return { unit_mist: s.toString(), basis: "last_sale", ...stale };
  const days = Math.round(windowSec / 86_400);
  const listing = !opts.floorRead
    ? "listings are read at the current state only, so none count for a past time"
    : !stale.floor_stale
      ? "no active listing was found"
      : Number.isFinite(listedAt)
        ? `the lowest listing was placed ${Math.floor((opts.asOfSec - listedAt) / 86_400)} days before the valuation time and has not sold, past the ${days}-day window`
        : "the lowest listing records no time, so it cannot be shown to be current";
  const sold = stale.sale_stale
    ? `the last counted sale was ${Math.floor((opts.asOfSec - saleAt) / 86_400)} days before the valuation time, past the ${days}-day window`
    : `no counted sale in the ${days} days before the valuation time`;
  return { unit_mist: null, basis: null, ...stale, unpriced_reason: `${listing}, and ${sold}` };
}

/**
 * The price in a TradePort orderbook index. An index is a u128 with its top
 * bit set, the price in MIST in the next 63 bits and a sequence number in the
 * low 64, so the orderbook's key order is price order.
 */
export function orderbookIndexPrice(index: string): bigint | null {
  const k = toBig(index);
  if (k === null) return null;
  return (k >> 64n) & ((1n << 63n) - 1n);
}

/**
 * A type as Move's `type_name` writes it, which is how marketplaces store a
 * collection in a key or an event field: every address 64 hex digits with no
 * `0x`, and type arguments joined by a bare comma.
 */
export function typeNameString(type: string): string {
  return canonicalType(type)
    .replace(/0x([0-9a-f]{64})/g, "$1")
    .replace(/,\s+/g, ",");
}

/**
 * The lowest ask in an OriginByte orderbook's `asks` crit-bit tree. Its outer
 * nodes (`o`) carry a price as `k` and the asks at that price as `v`.
 */
export function lowestOriginByteAsk(
  asks: unknown,
): { price_mist: string; nft_id?: string; owner?: string; kiosk_id?: string } | null {
  const outer = (asks as { o?: unknown } | null)?.o;
  if (!Array.isArray(outer)) return null;
  let best: { price: bigint; ask: Record<string, unknown> } | null = null;
  for (const node of outer) {
    const n = node as { k?: unknown; v?: unknown };
    const price = typeof n.k === "string" ? toBig(n.k) : null;
    if (price === null || price <= 0n || !Array.isArray(n.v) || n.v.length === 0) continue;
    if (!best || price < best.price) best = { price, ask: (n.v[0] ?? {}) as Record<string, unknown> };
  }
  if (!best) return null;
  const str = (k: string) => (typeof best!.ask[k] === "string" ? (best!.ask[k] as string) : undefined);
  return {
    price_mist: best.price.toString(),
    ...(str("nft_id") ? { nft_id: str("nft_id") } : {}),
    ...(str("owner") ? { owner: str("owner") } : {}),
    ...(str("kiosk_id") ? { kiosk_id: str("kiosk_id") } : {}),
  };
}
