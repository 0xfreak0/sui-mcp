/**
 * Reading a collection's market: its active listings and its recent sales.
 *
 * The pricing rule is `nft-market.ts`; this file finds its inputs.
 *
 * ## Listings (the current state only)
 *
 *   - TradePort orderbook. One shared store keeps, per collection keyed by
 *     its `type_name` string, a big vector of listing ids ordered by an index
 *     whose high bits are the price, so the first entry of its leftmost leaf
 *     is the lowest listing. Each candidate is confirmed by reading its
 *     listing object, which is deleted when the listing is bought or
 *     cancelled.
 *   - TradePort kiosk listings from its earlier contract. Each is a
 *     `Listing<T>` object, so a collection's are enumerated by type. Its
 *     price is what the buyer pays, TradePort's commission included.
 *   - OriginByte. An `Orderbook<T, SUI>` holds every ask for the collection.
 *   - Kiosk listings made with `kiosk::list`. `ItemListed<T>` events name
 *     them, and each is confirmed by reading the kiosk's `Listing` field.
 *
 * Listings whose objects do not carry the collection type (BlueMove, and
 * TradePort's non-kiosk `listings` contract) cannot be found by collection
 * and are not read.
 *
 * ## Sales
 *
 * A sale mutates the shared object that settles it: the collection's
 * `TransferPolicy<T>` when a royalty is paid into it, its OriginByte
 * orderbook, or its entry in the TradePort orderbook. The transactions that
 * touched those objects, newest first, carry the collection's sales, and the
 * sale events registered in `nft-sale-events.json` (the sources
 * `get_nft_sales` reads) and `kiosk::ItemPurchased<T>` give each price. A sale
 * event that does not name the collection is joined to its item's type. A
 * collection with none of those objects has no market this server can find.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";
import { Budget, firstFunderOf } from "./edge-probe.js";
import { canonicalType, readSale } from "./nft-sales.js";
import {
  fundingExclusion,
  lowestListing,
  lowestOriginByteAsk,
  orderbookIndexPrice,
  MARKET_WINDOW_DAYS,
  saleExclusion,
  salesByTransaction,
  typeNameString,
  type MarketListing,
  type MarketSale,
} from "./nft-market.js";

const TRADEPORT_ORDERBOOK_PACKAGE = "0x06cefebb11191abd347654200a6fd8ae47fa97b54506e4e680db64dae54d0b12";
/** The TradePort orderbook's shared store, where every collection's listings are indexed. */
const TRADEPORT_ORDERBOOK_STORE = "0x3af0a94360253c80fbabe73f6832be0a49ddfc0b8772ccd5335f568cbc356da1";
const TRADEPORT_ORDERBOOK_KEY = `${TRADEPORT_ORDERBOOK_PACKAGE}::tradeport_orderbook::OrderbookKey`;
const TRADEPORT_KIOSK_LISTING = "0xec175e537be9e48f75fa6929291de6454d2502f1091feb22c0d26a22821bbf28::kiosk_listings::Listing";
const ORIGINBYTE_ORDERBOOK = "0x4e0629fa51a62b0c1d7c7b9fc89237ec5b6f630d7798ad3f06d820afb93a995a::orderbook::Orderbook";
const SUI_COIN = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const ITEM_PURCHASED = "0x0000000000000000000000000000000000000000000000000000000000000002::kiosk::ItemPurchased<";

export const LISTING_SOURCES = {
  tradeport: "TradePort orderbook",
  tradeportKiosk: "TradePort kiosk listing",
  originbyte: "OriginByte orderbook",
  kiosk: "Kiosk listing",
} as const;

/** The service caps a request at 5,000 bytes of query and variables together. */
const PAYLOAD_LIMIT = 4_600;
/** Orderbook entries read from the front of a collection's leftmost leaf, in case the first listings are gone. */
const ORDERBOOK_CANDIDATES = 5;
/** Pages of earlier-contract TradePort kiosk listings read per collection. They come in id order, not price order. */
const KIOSK_LISTING_PAGES = 8;
/** Recent `ItemListed<T>` events read per collection, and how many of the cheapest are confirmed live. */
const ITEM_LISTED_READ = 20;
const ITEM_LISTED_CONFIRM = 5;
/** Transactions read per page of a sale-settling object, and pages read at most. */
const SALE_TX_PAGE = 15;
const SALE_TX_PAGES = 3;
/** Transactions with a sale collected per collection before paging stops. */
const SALE_TXS_WANTED = 4;
/** Requests one read may spend on first-funder lookups for wash checks. */
const FUNDER_REQUESTS = 40;
/** A current market is read again after this long. */
const MARKET_CACHE_MS = 10 * 60_000;
const HISTORICAL_CACHE_MAX = 500;

export interface ExcludedSale {
  digest: string;
  nft_id: string;
  price_mist: string;
  reason: string;
}

export interface CollectionMarket {
  collection: string;
  /** The lowest active listing across the sources read; null when none was found or listings were not read. */
  floor: MarketListing | null;
  /** False for a past valuation time: listings are read at the current state only. */
  floor_read: boolean;
  /** Active listings seen per source; `truncated` when the source had more than was read. */
  listings_seen: Record<string, { count: number; truncated?: boolean }>;
  /** The newest sale that counted, whatever its age. */
  last_sale: MarketSale | null;
  /** Newer sales left out, with why. */
  excluded_sales: ExcludedSale[];
  /** What the wash check covered for `last_sale`. */
  wash_check: string | null;
  /** Sales found through the collection's objects whose item type could not be read, so they were not counted. */
  sales_unattributed: number;
  /** A transfer policy, an orderbook, a listing or a sale was found. */
  has_market: boolean;
  not_read: Array<{ what: string; reason: string }>;
}

export interface MarketReadOptions {
  /** Unix seconds the valuation is for; paging for sales stops past the sale window before it. */
  asOfSec: number;
  /** A valuation for a past time: sales after `asOfSec` are dropped and listings are not read. */
  historical?: boolean;
  /** For a past valuation, read only transactions at or before this checkpoint. */
  atCheckpoint?: number;
}

interface QueryPart {
  decl: string;
  body: string;
  vars: Record<string, unknown>;
}

/**
 * Run one aliased part per item, packing as many into a request as the
 * payload cap allows. The returned object holds every part's aliases.
 */
async function batched<T>(items: readonly T[], part: (item: T, i: number) => QueryPart): Promise<Record<string, unknown>> {
  const parts = items.map(part);
  const chunks: QueryPart[][] = [];
  let current: QueryPart[] = [];
  let size = 0;
  for (const p of parts) {
    const s = p.decl.length + p.body.length + JSON.stringify(p.vars).length + 4;
    if (current.length > 0 && size + s > PAYLOAD_LIMIT) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += s;
  }
  if (current.length > 0) chunks.push(current);
  const results = await Promise.all(
    chunks.map((chunk) =>
      gqlQuery<Record<string, unknown>>(
        `query(${chunk.map((p) => p.decl).join(", ")}) {\n${chunk.map((p) => p.body).join("\n")}\n}`,
        Object.assign({}, ...chunk.map((p) => p.vars)),
      ),
    ),
  );
  return Object.assign({}, ...results);
}

const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};

/** BCS of an `OrderbookKey { nft_type: ascii::String }`. */
function orderbookKeyBcs(type: string): string {
  const s = Buffer.from(typeNameString(type), "utf8");
  return Buffer.concat([Buffer.from(uleb(s.length)), s]).toString("base64");
}

const u64Bcs = (n: string): string => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b.toString("base64");
};

/** BCS of a `kiosk::Listing { id, is_exclusive: false }`. */
const kioskListingBcs = (id: string): string =>
  Buffer.concat([Buffer.from(normalizeSuiAddress(id).slice(2), "hex"), Buffer.from([0])]).toString("base64");

interface Nodes<T> {
  nodes: T[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null; hasPreviousPage?: boolean; startCursor?: string | null };
}

interface ListingObject {
  address: string;
  asMoveObject?: { contents?: { json?: Record<string, unknown> } | null } | null;
  previousTransaction?: { effects?: { timestamp?: string | null } | null } | null;
}

interface SaleTx {
  digest: string;
  sender?: { address?: string } | null;
  effects?: {
    timestamp?: string | null;
    checkpoint?: { sequenceNumber?: number | string } | null;
    events?: { nodes: Array<{ contents?: { type?: { repr?: string }; json?: unknown } | null }> } | null;
  } | null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** Working state for one collection while its market is read. */
interface Reading {
  type: string;
  policies: string[];
  orderbooks: string[];
  /** The collection's entry in the TradePort orderbook store, a dynamic field's object id. */
  tradeportField: string | null;
  listings: MarketListing[];
  market: CollectionMarket;
}

/**
 * What marks a type as traded or shown as an item: the objects its sales
 * settle against, and whether it has a Display. None of these depends on the
 * valuation time, so one read serves every checkpoint a scan asks about.
 */
export interface CollectionPresence {
  policies: string[];
  orderbooks: string[];
  /** The collection's entry in the TradePort orderbook store, a dynamic field's object id. */
  tradeport_field: string | null;
  display: boolean;
  /** Why presence could not be read. A presence with any is not cached. */
  unread: Array<{ what: string; reason: string }>;
}

const presenceCache = new Map<string, { at: number; value: Promise<CollectionPresence> }>();
const marketCache = new Map<string, { at: number; value: Promise<CollectionMarket> }>();

/** Test seam: forget every cached presence and market. */
export function clearMarketCache(): void {
  presenceCache.clear();
  marketCache.clear();
}

/** Each type's presence, read once per type and cached for {@link MARKET_CACHE_MS}. */
export async function collectionPresence(types: string[]): Promise<Map<string, CollectionPresence>> {
  const network = getNetwork();
  const now = Date.now();
  const pending = new Map<string, Promise<CollectionPresence>>();
  const missing: string[] = [];
  for (const t of new Set(types.map((x) => canonicalType(x)))) {
    const hit = presenceCache.get(`${network}:${t}`);
    if (hit && now - hit.at < MARKET_CACHE_MS) pending.set(t, hit.value);
    else missing.push(t);
  }
  if (missing.length > 0) {
    const read = readPresence(missing);
    for (const t of missing) {
      const key = `${network}:${t}`;
      const value = read.then((m) => m.get(t)!);
      value.then(
        (p) => {
          if (p.unread.length > 0) presenceCache.delete(key);
        },
        () => presenceCache.delete(key),
      );
      presenceCache.set(key, { at: now, value });
      pending.set(t, value);
    }
  }
  const out = new Map<string, CollectionPresence>();
  for (const [t, p] of pending) out.set(t, await p);
  return out;
}

async function readPresence(types: string[]): Promise<Map<string, CollectionPresence>> {
  const out = new Map<string, CollectionPresence>(
    types.map((t) => [t, { policies: [], orderbooks: [], tradeport_field: null, display: false, unread: [] }]),
  );
  try {
    const d = await batched(types, (t, i) => ({
      decl: `$p${i}: String!, $o${i}: String!, $d${i}: String!, $t${i}: [DynamicFieldName!]!`,
      body: `p${i}: objects(filter: { type: $p${i} }, first: 5) { nodes { address } }
o${i}: objects(filter: { type: $o${i} }, first: 3) { nodes { address } }
d${i}: objects(filter: { type: $d${i} }, first: 1) { nodes { address } }
t${i}: address(address: "${TRADEPORT_ORDERBOOK_STORE}") { multiGetDynamicFields(keys: $t${i}) { address } }`,
      vars: {
        [`p${i}`]: `0x2::transfer_policy::TransferPolicy<${t}>`,
        [`o${i}`]: `${ORIGINBYTE_ORDERBOOK}<${t}, ${SUI_COIN}>`,
        [`d${i}`]: `0x2::display::Display<${t}>`,
        [`t${i}`]: [{ type: TRADEPORT_ORDERBOOK_KEY, bcs: orderbookKeyBcs(t) }],
      },
    }));
    const ids = (v: unknown) => ((v as Nodes<{ address: string }> | undefined)?.nodes ?? []).map((n) => n.address);
    types.forEach((t, i) => {
      const p = out.get(t)!;
      p.policies = ids(d[`p${i}`]);
      p.orderbooks = ids(d[`o${i}`]);
      p.display = ids(d[`d${i}`]).length > 0;
      p.tradeport_field = ((d[`t${i}`] as { multiGetDynamicFields?: Array<{ address?: string } | null> } | null)?.multiGetDynamicFields ?? [])[0]?.address ?? null;
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    for (const p of out.values()) p.unread.push({ what: "transfer policies, orderbooks and Display", reason });
  }
  return out;
}

/**
 * The market of each collection type. Reads are cached per type, so the
 * concurrent callers of one request share one read.
 */
export async function collectionMarkets(types: string[], opts: MarketReadOptions): Promise<Map<string, CollectionMarket>> {
  const network = getNetwork();
  const at = !opts.historical ? "latest" : opts.atCheckpoint !== undefined ? `cp${opts.atCheckpoint}` : `t${opts.asOfSec}`;
  const now = Date.now();
  const wanted = [...new Set(types.map((t) => canonicalType(t)))];
  const pending = new Map<string, Promise<CollectionMarket>>();
  const missing: string[] = [];
  for (const t of wanted) {
    const hit = marketCache.get(`${network}:${at}:${t}`);
    if (hit && (opts.historical || now - hit.at < MARKET_CACHE_MS)) pending.set(t, hit.value);
    else missing.push(t);
  }
  if (missing.length > 0) {
    const read = readMarkets(missing, opts);
    for (const t of missing) {
      const key = `${network}:${at}:${t}`;
      const value = read.then((m) => m.get(t)!);
      value.catch(() => marketCache.delete(key));
      marketCache.set(key, { at: now, value });
      pending.set(t, value);
    }
    if (marketCache.size > HISTORICAL_CACHE_MAX) {
      for (const [key, entry] of marketCache) {
        if (now - entry.at >= MARKET_CACHE_MS) marketCache.delete(key);
      }
    }
  }
  const out = new Map<string, CollectionMarket>();
  for (const [t, p] of pending) out.set(t, await p);
  return out;
}

async function readMarkets(types: string[], opts: MarketReadOptions): Promise<Map<string, CollectionMarket>> {
  const current = !opts.historical;
  const presence = await collectionPresence(types);
  const readings: Reading[] = types.map((type) => {
    const p = presence.get(type)!;
    return {
      type,
      policies: p.policies,
      orderbooks: p.orderbooks,
      tradeportField: p.tradeport_field,
      listings: [],
      market: {
        collection: type,
        floor: null,
        floor_read: current,
        listings_seen: {},
        last_sale: null,
        excluded_sales: [],
        wash_check: null,
        sales_unattributed: 0,
        has_market: false,
        not_read: [...p.unread],
      },
    };
  });

  const tasks: Array<Promise<void>> = [readSales(readings, opts)];
  if (current) {
    tasks.push(
      guard(readings, LISTING_SOURCES.tradeport, () => readTradeportFloor(readings)),
      guard(readings, `${LISTING_SOURCES.tradeportKiosk}s and kiosk listings`, () => readKioskListings(readings)),
      guard(readings, LISTING_SOURCES.originbyte, () => readOriginByteAsks(readings)),
    );
  }
  await Promise.all(tasks);

  const out = new Map<string, CollectionMarket>();
  for (const r of readings) {
    const m = r.market;
    m.floor = current ? lowestListing(r.listings) : null;
    m.has_market =
      r.policies.length > 0 || r.orderbooks.length > 0 || r.tradeportField !== null || r.listings.length > 0 || m.last_sale !== null;
    out.set(r.type, m);
  }
  return out;
}

/** Run one listing source, recording a failure on every collection rather than hiding it as "no listing". */
async function guard(readings: Reading[], what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    for (const r of readings) r.market.not_read.push({ what, reason });
  }
}

interface BigVector {
  id: string;
  depth: number;
  root: string;
  length: number;
}

/** Each entry's big vector as it stands now: its shape changes with every listing. */
async function readTradeportVectors(readings: Reading[]): Promise<Map<Reading, BigVector>> {
  const d = await batched(readings, (r, i) => ({
    decl: `$t${i}: [DynamicFieldName!]!`,
    body: `t${i}: address(address: "${TRADEPORT_ORDERBOOK_STORE}") { multiGetDynamicFields(keys: $t${i}) { value { ... on MoveValue { json } } } }`,
    vars: { [`t${i}`]: [{ type: TRADEPORT_ORDERBOOK_KEY, bcs: orderbookKeyBcs(r.type) }] },
  }));
  const out = new Map<Reading, BigVector>();
  readings.forEach((r, i) => {
    const json = ((d[`t${i}`] as { multiGetDynamicFields?: Array<{ value?: { json?: Record<string, unknown> } | null } | null> } | null)?.multiGetDynamicFields ?? [])[0]?.value?.json;
    const id = str(json?.id);
    if (!json || !id) return;
    out.set(r, { id, depth: Number(json.depth ?? 0), root: String(json.root_id ?? "0"), length: Number(json.length ?? 0) });
  });
  return out;
}

/** Walk each collection's TradePort big vector to its leftmost leaf and confirm its cheapest live listing. */
async function readTradeportFloor(readings: Reading[]): Promise<void> {
  const withEntry = readings.filter((r) => r.tradeportField !== null);
  if (withEntry.length === 0) return;
  const vectors = await readTradeportVectors(withEntry);
  type Walk = { r: Reading; vector: BigVector; slice: string; depth: number };
  let walks: Walk[] = [...vectors]
    .filter(([, v]) => v.length > 0)
    .map(([r, vector]) => ({ r, vector, slice: vector.root, depth: vector.depth }));
  const leaves: Array<{ r: Reading; length: number; entries: Array<{ price: bigint | null; listing: string }> }> = [];
  while (walks.length > 0) {
    const d = await batched(walks, (w, i) => ({
      decl: `$s${i}: DynamicFieldName!`,
      body: `s${i}: address(address: "${w.vector.id}") { dynamicField(name: $s${i}) { value { ... on MoveValue { json } } } }`,
      vars: { [`s${i}`]: { type: "u64", bcs: u64Bcs(w.slice) } },
    }));
    const next: Walk[] = [];
    walks.forEach((w, i) => {
      const json = (d[`s${i}`] as { dynamicField?: { value?: { json?: { keys?: unknown; vals?: unknown } } } | null } | null)?.dynamicField?.value?.json;
      const keys = Array.isArray(json?.keys) ? (json!.keys as string[]) : [];
      const vals = Array.isArray(json?.vals) ? (json!.vals as string[]) : [];
      if (vals.length === 0) {
        w.r.market.not_read.push({ what: LISTING_SOURCES.tradeport, reason: `slice ${w.slice} of the collection's orderbook could not be read` });
        return;
      }
      if (w.depth > 0) next.push({ ...w, slice: String(vals[0]), depth: w.depth - 1 });
      else {
        leaves.push({
          r: w.r,
          length: w.vector.length,
          entries: vals.slice(0, ORDERBOOK_CANDIDATES).map((listing, j) => ({ price: orderbookIndexPrice(String(keys[j])), listing: String(listing) })),
        });
      }
    });
    walks = next;
  }
  const ids = [...new Set(leaves.flatMap((l) => l.entries.map((e) => e.listing)))];
  const objects = await readListingObjects(ids);
  for (const { r, length, entries } of leaves) {
    r.market.listings_seen[LISTING_SOURCES.tradeport] = { count: length };
    const live = entries.find((e) => objects.has(normalizeSuiAddress(e.listing)));
    if (!live) {
      r.market.not_read.push({
        what: LISTING_SOURCES.tradeport,
        reason: `the ${entries.length} cheapest orderbook entries point at listings that no longer exist`,
      });
      continue;
    }
    const obj = objects.get(normalizeSuiAddress(live.listing))!;
    const json = obj.asMoveObject?.contents?.json ?? {};
    const price = str(json.price) ?? live.price?.toString();
    if (!price) continue;
    r.listings.push({
      source: LISTING_SOURCES.tradeport,
      price_mist: price,
      listed_at: obj.previousTransaction?.effects?.timestamp ?? null,
      listing_id: normalizeSuiAddress(live.listing),
      ...(str(json.nft_id) ? { nft_id: str(json.nft_id) } : {}),
      ...(str(json.seller) ? { seller: str(json.seller) } : {}),
    });
  }
}

/** Live listing objects by id, with the transaction that last wrote each. Absent ids no longer exist. */
async function readListingObjects(ids: string[]): Promise<Map<string, ListingObject>> {
  const out = new Map<string, ListingObject>();
  for (let i = 0; i < ids.length; i += 40) {
    const d = await gqlQuery<{ multiGetObjects: Array<ListingObject | null> }>(
      `query($keys: [ObjectKey!]!) { multiGetObjects(keys: $keys) { address asMoveObject { contents { json } } previousTransaction { effects { timestamp } } } }`,
      { keys: ids.slice(i, i + 40).map((address) => ({ address })) },
    );
    for (const o of d.multiGetObjects ?? []) if (o?.address) out.set(normalizeSuiAddress(o.address), o);
  }
  return out;
}

/**
 * The earlier TradePort kiosk-listing objects, and `kiosk::list` listings
 * confirmed live. Only collections with a transfer policy are asked: a kiosk
 * item cannot be bought without one.
 */
async function readKioskListings(readings: Reading[]): Promise<void> {
  const kiosked = readings.filter((r) => r.policies.length > 0);
  if (kiosked.length === 0) return;
  const d = await batched(kiosked, (r, i) => ({
    decl: `$k${i}: String!, $l${i}: String!`,
    body: `k${i}: objects(filter: { type: $k${i} }, first: 50) { nodes { address asMoveObject { contents { json } } previousTransaction { effects { timestamp } } } pageInfo { hasNextPage endCursor } }
l${i}: events(filter: { type: $l${i} }, last: ${ITEM_LISTED_READ}) { nodes { timestamp contents { json } } }`,
    vars: { [`k${i}`]: `${TRADEPORT_KIOSK_LISTING}<${r.type}>`, [`l${i}`]: `0x2::kiosk::ItemListed<${r.type}>` },
  }));
  const confirm: Array<{ r: Reading; kiosk: string; id: string; at: string | null }> = [];
  await Promise.all(
    kiosked.map(async (r, i) => {
      let page = d[`k${i}`] as Nodes<ListingObject> | undefined;
      let pages = 1;
      let count = 0;
      for (;;) {
        for (const o of page?.nodes ?? []) {
          const json = o.asMoveObject?.contents?.json ?? {};
          const price = str(json.price);
          if (!price) continue;
          count++;
          r.listings.push({
            source: LISTING_SOURCES.tradeportKiosk,
            price_mist: price,
            listed_at: o.previousTransaction?.effects?.timestamp ?? null,
            listing_id: o.address,
            ...(str(json.nft_id) ? { nft_id: str(json.nft_id) } : {}),
            ...(str(json.seller) ? { seller: str(json.seller) } : {}),
          });
        }
        const more = page?.pageInfo?.hasNextPage && page.pageInfo.endCursor;
        if (!more) break;
        if (pages >= KIOSK_LISTING_PAGES) {
          r.market.listings_seen[LISTING_SOURCES.tradeportKiosk] = { count, truncated: true };
          return queueListed(r, d[`l${i}`], confirm);
        }
        const next = await gqlQuery<{ objects: Nodes<ListingObject> }>(
          `query($t: String!, $after: String) { objects(filter: { type: $t }, first: 50, after: $after) { nodes { address asMoveObject { contents { json } } previousTransaction { effects { timestamp } } } pageInfo { hasNextPage endCursor } } }`,
          { t: `${TRADEPORT_KIOSK_LISTING}<${r.type}>`, after: page!.pageInfo!.endCursor },
        );
        page = next.objects;
        pages++;
      }
      if (count > 0) r.market.listings_seen[LISTING_SOURCES.tradeportKiosk] = { count };
      queueListed(r, d[`l${i}`], confirm);
    }),
  );
  if (confirm.length === 0) return;
  const live = await batched(confirm, (c, i) => ({
    decl: `$n${i}: [DynamicFieldName!]!`,
    body: `n${i}: address(address: "${normalizeSuiAddress(c.kiosk)}") { multiGetDynamicFields(keys: $n${i}) { value { ... on MoveValue { json } } } }`,
    vars: { [`n${i}`]: [{ type: "0x2::kiosk::Listing", bcs: kioskListingBcs(c.id) }] },
  }));
  confirm.forEach((c, i) => {
    const field = ((live[`n${i}`] as { multiGetDynamicFields?: Array<{ value?: { json?: unknown } } | null> } | null)?.multiGetDynamicFields ?? [])[0];
    const price = str(field?.value?.json);
    if (!price) return;
    const seen = (c.r.market.listings_seen[LISTING_SOURCES.kiosk] ??= { count: 0 });
    seen.count++;
    c.r.listings.push({ source: LISTING_SOURCES.kiosk, price_mist: price, listed_at: c.at, nft_id: c.id });
  });
}

/** The cheapest recent `ItemListed<T>` items, queued to be confirmed live. */
function queueListed(
  r: Reading,
  events: unknown,
  confirm: Array<{ r: Reading; kiosk: string; id: string; at: string | null }>,
): void {
  const latest = new Map<string, { kiosk: string; price: bigint; at: string | null }>();
  for (const n of (events as Nodes<{ timestamp?: string | null; contents?: { json?: Record<string, unknown> } }> | undefined)?.nodes ?? []) {
    const j = n.contents?.json ?? {};
    const id = str(j.id);
    const kiosk = str(j.kiosk);
    const price = str(j.price);
    if (!id || !kiosk || !price || !/^\d+$/.test(price)) continue;
    latest.set(id, { kiosk, price: BigInt(price), at: n.timestamp ?? null });
  }
  [...latest.entries()]
    .filter(([, v]) => v.price > 0n)
    .sort((a, b) => (a[1].price < b[1].price ? -1 : a[1].price > b[1].price ? 1 : 0))
    .slice(0, ITEM_LISTED_CONFIRM)
    .forEach(([id, v]) => confirm.push({ r, kiosk: v.kiosk, id, at: v.at }));
}

/** The lowest ask in each OriginByte orderbook of a collection. Asks carry no time. */
async function readOriginByteAsks(readings: Reading[]): Promise<void> {
  for (const r of readings) {
    for (const id of r.orderbooks) {
      const d = await gqlQuery<{ object: { asMoveObject?: { contents?: { json?: { asks?: unknown } } } } | null }>(
        `query($a: SuiAddress!) { object(address: $a) { asMoveObject { contents { json } } } }`,
        { a: id },
      );
      const asks = d.object?.asMoveObject?.contents?.json?.asks;
      const outer = (asks as { o?: unknown[] } | undefined)?.o;
      const count = Array.isArray(outer) ? outer.reduce<number>((s, n) => s + (Array.isArray((n as { v?: unknown }).v) ? ((n as { v: unknown[] }).v.length) : 0), 0) : 0;
      const seen = (r.market.listings_seen[LISTING_SOURCES.originbyte] ??= { count: 0 });
      seen.count += count;
      const low = lowestOriginByteAsk(asks);
      if (low) {
        r.listings.push({
          source: LISTING_SOURCES.originbyte,
          price_mist: low.price_mist,
          listed_at: null,
          listing_id: id,
          ...(low.nft_id ? { nft_id: low.nft_id } : {}),
          ...(low.owner ? { seller: low.owner } : {}),
        });
      }
    }
  }
}

/** One sale read out of a transaction, before its collection is known for sure. */
interface RawSale {
  sale: MarketSale;
  nft_type?: string;
  signer?: string;
}

/** The sales in one transaction: registered sale events and `kiosk::ItemPurchased<T>`, one per item. */
function salesInTransaction(tx: SaleTx): RawSale[] {
  const at = tx.effects?.timestamp;
  const checkpoint = Number(tx.effects?.checkpoint?.sequenceNumber ?? 0);
  if (!at || !checkpoint) return [];
  const signer = str(tx.sender?.address);
  const byItem = new Map<string, RawSale>();
  for (const ev of tx.effects?.events?.nodes ?? []) {
    const repr = ev.contents?.type?.repr;
    const json = ev.contents?.json;
    if (!repr || !json || typeof json !== "object") continue;
    let raw: RawSale | null = null;
    if (repr.startsWith(ITEM_PURCHASED) && repr.endsWith(">")) {
      const j = json as Record<string, unknown>;
      const id = str(j.id);
      const price = str(j.price);
      if (!id || !price) continue;
      raw = {
        sale: { marketplace: "Kiosk", price_mist: price, at, checkpoint, digest: tx.digest, nft_id: id, ...(str(j.kiosk) ? { seller_kiosk_id: str(j.kiosk) } : {}) },
        nft_type: canonicalType(repr.slice(ITEM_PURCHASED.length, -1)),
      };
    } else {
      const s = readSale(repr, json);
      if (!s || s.price === undefined) continue;
      raw = {
        sale: {
          marketplace: s.marketplace,
          price_mist: s.price,
          at,
          checkpoint,
          digest: tx.digest,
          nft_id: s.nft_id,
          ...(s.buyer ? { buyer: s.buyer } : {}),
          ...(s.seller ? { seller: s.seller } : {}),
          ...(s.buyer_kiosk_id ? { buyer_kiosk_id: s.buyer_kiosk_id } : {}),
          ...(s.seller_kiosk_id ? { seller_kiosk_id: s.seller_kiosk_id } : {}),
        },
        ...(s.nft_type ? { nft_type: s.nft_type } : {}),
      };
    }
    raw.signer = signer;
    const key = normalizeSuiAddress(raw.sale.nft_id);
    const prior = byItem.get(key);
    // A marketplace's own event names more of the sale than the kiosk's.
    if (!prior || prior.sale.marketplace === "Kiosk") {
      byItem.set(key, { ...raw, nft_type: raw.nft_type ?? prior?.nft_type, sale: { ...prior?.sale, ...raw.sale } });
    }
  }
  return [...byItem.values()];
}

/**
 * Each collection's recent sales, found through the transactions that
 * touched the objects its trades settle against, then the newest one that
 * survives the wash checks.
 */
async function readSales(readings: Reading[], opts: MarketReadOptions): Promise<void> {
  const windowStart = opts.asOfSec - MARKET_WINDOW_DAYS * 86_400;
  type Index = { r: Reading; object: string; before: string | null; done: boolean };
  const indexes: Index[] = readings.flatMap((r) =>
    [...r.policies, ...r.orderbooks, ...(r.tradeportField ? [r.tradeportField] : [])].map((object) => ({ r, object, before: null, done: false })),
  );
  const found = new Map<Reading, Map<string, RawSale>>();
  for (const r of readings) found.set(r, new Map());
  const txsWithSales = (r: Reading) => new Set([...found.get(r)!.values()].map((s) => s.sale.digest)).size;

  for (let page = 0; page < SALE_TX_PAGES; page++) {
    const open = indexes.filter((x) => !x.done && txsWithSales(x.r) < SALE_TXS_WANTED);
    if (open.length === 0) break;
    let d: Record<string, unknown>;
    try {
      d = await batched(open, (x, i) => ({
        decl: `$f${i}: TransactionFilter!, $c${i}: String`,
        body: `x${i}: transactions(filter: $f${i}, last: ${SALE_TX_PAGE}, before: $c${i}) { pageInfo { hasPreviousPage startCursor } nodes { digest sender { address } effects { timestamp checkpoint { sequenceNumber } events(first: 50) { nodes { contents { type { repr } json } } } } } }`,
        vars: {
          [`f${i}`]: { affectedObject: x.object, ...(opts.historical && opts.atCheckpoint !== undefined ? { beforeCheckpoint: opts.atCheckpoint + 1 } : {}) },
          [`c${i}`]: x.before,
        },
      }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      for (const x of open) x.r.market.not_read.push({ what: `sales through ${x.object}`, reason });
      break;
    }
    open.forEach((x, i) => {
      const conn = d[`x${i}`] as Nodes<SaleTx> | undefined;
      const nodes = conn?.nodes ?? [];
      for (const tx of nodes) {
        for (const raw of salesInTransaction(tx)) found.get(x.r)!.set(`${raw.sale.digest}:${normalizeSuiAddress(raw.sale.nft_id)}`, raw);
      }
      const oldest = nodes[0]?.effects?.timestamp;
      const pastWindow = oldest !== undefined && oldest !== null && Date.parse(oldest) / 1000 < windowStart;
      if (!conn?.pageInfo?.hasPreviousPage || !conn.pageInfo.startCursor || pastWindow) x.done = true;
      else x.before = conn.pageInfo.startCursor;
    });
  }

  // Sales whose event did not name the collection are joined to their item's type.
  const unknown = [...new Set([...found.values()].flatMap((m) => [...m.values()].filter((s) => !s.nft_type).map((s) => normalizeSuiAddress(s.sale.nft_id))))];
  const itemTypes = new Map<string, string>();
  try {
    for (let i = 0; i < unknown.length; i += 40) {
      const d = await gqlQuery<{ multiGetObjects: Array<{ address?: string; asMoveObject?: { contents?: { type?: { repr?: string } } } | null } | null> }>(
        `query($keys: [ObjectKey!]!) { multiGetObjects(keys: $keys) { address asMoveObject { contents { type { repr } } } } }`,
        { keys: unknown.slice(i, i + 40).map((address) => ({ address })) },
      );
      for (const o of d.multiGetObjects ?? []) {
        const t = o?.asMoveObject?.contents?.type?.repr;
        if (o?.address && t) itemTypes.set(normalizeSuiAddress(o.address), canonicalType(t));
      }
    }
  } catch (err) {
    for (const r of readings) r.market.not_read.push({ what: "item types of sales that do not name their collection", reason: err instanceof Error ? err.message : String(err) });
  }

  const budget = new Budget(FUNDER_REQUESTS);
  for (const r of readings) {
    const sales: MarketSale[] = [];
    for (const raw of found.get(r)!.values()) {
      const type = raw.nft_type ?? itemTypes.get(normalizeSuiAddress(raw.sale.nft_id));
      if (type === undefined) {
        r.market.sales_unattributed++;
        continue;
      }
      if (type !== r.type) continue;
      if (opts.historical && Date.parse(raw.sale.at) / 1000 > opts.asOfSec) continue;
      const sale = { ...raw.sale };
      // A sale is signed by one of its two sides. When the event names no
      // seller and the signer is not the buyer, the signer is the seller.
      if (!sale.seller && raw.signer && sale.buyer && normalizeSuiAddress(raw.signer) !== normalizeSuiAddress(sale.buyer)) {
        sale.seller = raw.signer;
        sale.seller_is_signer = true;
      }
      if (!sale.buyer && raw.signer && (!sale.seller || normalizeSuiAddress(raw.signer) !== normalizeSuiAddress(sale.seller))) {
        sale.buyer = raw.signer;
      }
      sales.push(sale);
    }
    await pickLastSale(r.market, sales, budget);
  }
}

/** The newest transaction's cheapest sale that passes the wash checks, trying older ones when it fails. */
async function pickLastSale(market: CollectionMarket, sales: MarketSale[], budget: Budget): Promise<void> {
  for (const group of salesByTransaction(sales)) {
    for (const sale of group) {
      const plain = saleExclusion(sale);
      if (plain) {
        market.excluded_sales.push({ digest: sale.digest, nft_id: sale.nft_id, price_mist: sale.price_mist, reason: plain });
        continue;
      }
      const [buyerFunder, sellerFunder] = await Promise.all([
        sale.buyer ? firstFunderOf(normalizeSuiAddress(sale.buyer), budget) : Promise.resolve(null),
        sale.seller ? firstFunderOf(normalizeSuiAddress(sale.seller), budget) : Promise.resolve(null),
      ]);
      const funded = fundingExclusion(sale, { buyer: buyerFunder?.funder, seller: sellerFunder?.funder });
      if (funded) {
        market.excluded_sales.push({ digest: sale.digest, nft_id: sale.nft_id, price_mist: sale.price_mist, reason: funded });
        continue;
      }
      const checked = ["zero price", "same address", "same kiosk"];
      const gaps: string[] = [];
      if (!sale.seller) gaps.push("The sale names no seller, so only the buyer side was checked.");
      else if (sale.seller_is_signer) gaps.push("The seller is the transaction signer, because the event names none.");
      if ((sale.buyer && buyerFunder === null) || (sale.seller && sellerFunder === null)) {
        gaps.push("A first funder could not be read, so the funding check is incomplete.");
      } else checked.push("either side first funding the other");
      market.wash_check = [`Checked: ${checked.join(", ")}.`, ...gaps].join(" ");
      market.last_sale = sale;
      return;
    }
  }
}
