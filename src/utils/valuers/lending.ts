/**
 * Reads the lending and margin readers share: keyed dynamic-field lookups and
 * owned-object listings at a checkpoint, the BCS keys those lookups take, and
 * pricing legs at a protocol's own oracle price with a provider cross-check.
 */

import { gqlQuery } from "../../clients/graphql.js";
import { priceCoinTypes, readObjects, SUI_TYPE, type ObjectState } from "./common.js";
import { suiPerLst } from "./lst.js";
import { getNetwork } from "../../config.js";
import { PRICE_STALE_THRESHOLD_SEC, displayCoin, pricingScale, toHumanAmount, type HistoricalPrices } from "../valuation.js";
import type { AssetSide, ValuationContext, ValuedAsset, ValuedPosition, ValuerResult, ValueTier } from "../position-value.js";

/** Oracle and provider prices further apart than this are both reported. */
export const PRICE_CHECK_PCT = 2;

/** 1e18, the scale of Suilend's `Decimal` and AlphaLend's `Number`. */
export const WAD = 10n ** 18n;
/** 1e27, NAVI's ray. */
export const RAY = 10n ** 27n;

/* ------------------------------------------------------------------ *
 * Short-lived read cache
 * ------------------------------------------------------------------ */

const memoCache = new Map<string, { at: number; value: Promise<unknown> }>();

/**
 * One read shared by concurrent callers. A read at a checkpoint never
 * changes, so it is kept for `ttlMs` like the latest state is; a failed read
 * is dropped at once so the next caller retries it.
 */
export function memo<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
  const full = `${getNetwork()}:${key}`;
  const hit = memoCache.get(full);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = read();
  memoCache.set(full, { at: Date.now(), value });
  value.catch(() => memoCache.delete(full));
  if (memoCache.size > 500) {
    for (const [k, v] of memoCache) if (Date.now() - v.at >= ttlMs) memoCache.delete(k);
  }
  return value;
}

/** Tests only. */
export function resetLendingMemo(): void {
  memoCache.clear();
}

/** How long protocol state read at the latest state is reused. */
const LATEST_TTL_MS = 30_000;
/** How long protocol state read at a checkpoint is reused. */
const CHECKPOINT_TTL_MS = 10 * 60_000;

export const ttlFor = (atCheckpoint?: string): number => (atCheckpoint === undefined ? LATEST_TTL_MS : CHECKPOINT_TTL_MS);
/** How long a protocol's table and object ids, which never change, are reused. */
export const TABLE_IDS_TTL_MS = 60 * 60_000;

/* ------------------------------------------------------------------ *
 * BCS keys for dynamic-field lookups
 * ------------------------------------------------------------------ */

export interface FieldKey {
  type: string;
  bcs: string;
}

export function normalizeAddress(address: string): string {
  return `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

export const u8Key = (n: number): FieldKey => ({ type: "u8", bcs: Buffer.from([n]).toString("base64") });

export function u64Key(n: bigint | number | string): FieldKey {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return { type: "u64", bcs: b.toString("base64") };
}

export const addressKey = (address: string): FieldKey => ({
  type: "address",
  bcs: Buffer.from(normalizeAddress(address).slice(2), "hex").toString("base64"),
});

export const idKey = (id: string): FieldKey => ({ type: "0x2::object::ID", bcs: addressKey(id).bcs });

function uleb128(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

/**
 * A `0x1::type_name::TypeName` key: the type's name as Move spells it, with a
 * 64-hex address and no `0x`.
 */
export function typeNameKey(typeName: string): FieldKey {
  const bytes = Buffer.from(typeNameString(typeName), "ascii");
  return { type: "0x1::type_name::TypeName", bcs: Buffer.concat([Buffer.from(uleb128(bytes.length)), bytes]).toString("base64") };
}

/** A coin type as `TypeName` spells it: every address padded to 64 hex, no `0x`. */
function typeNameString(coinType: string): string {
  return coinType.replace(/0x([0-9a-fA-F]{1,64})(?=::)/g, (_m, hex: string) => hex.toLowerCase().padStart(64, "0"));
}

/** A `TypeName` or ascii type string from Move JSON as a `0x`-prefixed coin type. */
export function coinTypeOf(name: unknown): string | null {
  const raw = typeof name === "string" ? name : typeof (name as { name?: unknown })?.name === "string" ? (name as { name: string }).name : null;
  if (!raw) return null;
  return raw.replace(/(^|[<,\s])(?:0x)?([0-9a-fA-F]{64})(?=::)/g, (_m, pre: string, hex: string) => `${pre}0x${hex.toLowerCase()}`);
}

/* ------------------------------------------------------------------ *
 * Keyed dynamic-field reads
 * ------------------------------------------------------------------ */

/** GraphQL's cap on keys in one multi-get. */
const KEYS_PER_ALIAS = 50;
/** Aliased parents per request, inside the service's limit of 21 aliased reads. */
const ALIASES_PER_QUERY = 20;
/**
 * Bytes of query text and variables one request may carry. The service
 * refuses a payload over 5,000 bytes, variables included.
 */
export const PAYLOAD_BUDGET = 4_400;
/** Room left beside one parent's keys for its alias's query text and variables, when its keys are split. */
const ALIAS_OVERHEAD = 400;

/**
 * Items split into runs whose summed `size` stays within `budget` and whose
 * length stays within `maxCount`. An item larger than the budget goes alone.
 */
export function chunkByBytes<T>(items: T[], size: (item: T) => number, budget: number, maxCount: number): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const s = size(item);
    if (chunk.length > 0 && (bytes + s > budget || chunk.length >= maxCount)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(item);
    bytes += s;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export interface FieldRead {
  parent: string;
  keys: FieldKey[];
  /** Dynamic object fields, whose values are objects of their own, rather than plain dynamic fields. */
  objects?: boolean;
}

type FieldValue = { value: { json?: unknown; contents?: { json?: unknown } | null } | null } | null;
type FieldsResponse = Record<string, Record<string, FieldValue[] | undefined> | null>;

interface FieldPart {
  read: number;
  offset: number;
  parent: string;
  keys: FieldKey[];
  objects: boolean;
}

interface PendingFields {
  calls: Array<{ reads: FieldRead[]; resolve: (rows: Array<Array<unknown | null>>) => void; reject: (err: unknown) => void }>;
}

const pendingFields = new Map<string, PendingFields>();

/**
 * Values of dynamic fields (or, for a read marked `objects`, the JSON of
 * dynamic object fields) by key, one array per read in key order, null where
 * the field does not exist. Read as of `atCheckpoint` when given.
 *
 * Calls made in the same turn of the event loop for the same state are sent
 * together, since request count is what a rate limit charges: valuing the
 * several positions one transaction moved costs one read per round, not one
 * per position. If the combined read fails, each call is retried alone so one
 * bad read cannot fail the others.
 */
export function readFields(reads: FieldRead[], atCheckpoint?: string): Promise<Array<Array<unknown | null>>> {
  const key = `${getNetwork()}:${atCheckpoint ?? "latest"}`;
  let batch = pendingFields.get(key);
  if (!batch) {
    const created: PendingFields = { calls: [] };
    batch = created;
    pendingFields.set(key, created);
    setTimeout(() => {
      pendingFields.delete(key);
      readFieldsNow(
        created.calls.flatMap((c) => c.reads),
        atCheckpoint,
      ).then(
        (rows) => {
          let at = 0;
          for (const c of created.calls) {
            c.resolve(rows.slice(at, at + c.reads.length));
            at += c.reads.length;
          }
        },
        () => {
          for (const c of created.calls) readFieldsNow(c.reads, atCheckpoint).then(c.resolve, c.reject);
        },
      );
    }, 0);
  }
  const target = batch;
  return new Promise((resolve, reject) => target.calls.push({ reads, resolve, reject }));
}

const pendingObjects = new Map<string, { ids: Set<string>; read: Promise<Map<string, ObjectState>> }>();

/**
 * `readObjects`, with the calls made in the same turn of the event loop for
 * the same state sent as one multi-get, for the reason `readFields` batches.
 */
export function readObjectsBatched(ids: string[], atCheckpoint?: string): Promise<Map<string, ObjectState>> {
  const key = `${getNetwork()}:${atCheckpoint ?? "latest"}`;
  let batch = pendingObjects.get(key);
  if (!batch) {
    const created = { ids: new Set<string>(), read: Promise.resolve(new Map<string, ObjectState>()) };
    created.read = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      pendingObjects.delete(key);
      return readObjects([...created.ids], atCheckpoint);
    });
    batch = created;
    pendingObjects.set(key, created);
  }
  for (const id of ids) batch.ids.add(id);
  return batch.read;
}

async function readFieldsNow(reads: FieldRead[], atCheckpoint?: string): Promise<Array<Array<unknown | null>>> {
  // Each parent's keys are cut into aliases that fit the payload on their
  // own, then aliases are packed into requests.
  const keyBytes = (k: FieldKey) => JSON.stringify(k).length + 1;
  const parts: FieldPart[] = [];
  reads.forEach((r, read) => {
    let offset = 0;
    for (const keys of chunkByBytes(r.keys, keyBytes, PAYLOAD_BUDGET - ALIAS_OVERHEAD, KEYS_PER_ALIAS)) {
      parts.push({ read, offset, parent: normalizeAddress(r.parent), keys, objects: r.objects === true });
      offset += keys.length;
    }
  });
  const out = reads.map((r) => new Array<unknown | null>(r.keys.length).fill(null));
  const cp = atCheckpoint === undefined ? null : Number(atCheckpoint);
  // Requests are packed by their serialized size, measured, not estimated:
  // an alias's text and variables differ with its index and key types.
  const batches: FieldPart[][] = [];
  let batch: FieldPart[] = [];
  for (const part of parts) {
    if (batch.length > 0 && (batch.length >= ALIASES_PER_QUERY || fieldsRequestBytes([...batch, part], cp) > PAYLOAD_BUDGET)) {
      batches.push(batch);
      batch = [];
    }
    batch.push(part);
  }
  if (batch.length > 0) batches.push(batch);
  for (const b of batches) {
    const { query, vars } = fieldsRequest(b, cp);
    const d = await gqlQuery<FieldsResponse>(query, vars);
    b.forEach((p, j) => {
      const got = d[`a${j}`]?.[fieldOf(p)] ?? [];
      got.forEach((f, k) => {
        out[p.read][p.offset + k] = f?.value?.json ?? f?.value?.contents?.json ?? null;
      });
    });
  }
  return out;
}

const fieldOf = (p: FieldPart) => (p.objects ? "multiGetDynamicObjectFields" : "multiGetDynamicFields");

/** One aliased field-read request for a batch of parts. */
function fieldsRequest(batch: FieldPart[], cp: number | null): { query: string; vars: Record<string, unknown> } {
  const decl = batch.map((_p, j) => `$p${j}: SuiAddress!, $k${j}: [DynamicFieldName!]!`).join(", ");
  const body = batch
    .map(
      (p, j) =>
        `a${j}: address(address: $p${j}, atCheckpoint: $cp) { ${fieldOf(p)}(keys: $k${j}) { value { ... on MoveValue { json } ... on MoveObject { contents { json } } } } }`,
    )
    .join(" ");
  const vars: Record<string, unknown> = { cp };
  batch.forEach((p, j) => {
    vars[`p${j}`] = p.parent;
    vars[`k${j}`] = p.keys;
  });
  return { query: `query($cp: UInt53, ${decl}) { ${body} }`, vars };
}

/** Bytes the service counts for a request: its JSON body, query and variables. */
function fieldsRequestBytes(batch: FieldPart[], cp: number | null): number {
  const { query, vars } = fieldsRequest(batch, cp);
  return Buffer.byteLength(JSON.stringify({ query, variables: vars }));
}

/** The top-level type arguments of a generic type, e.g. `["A", "B<C>"]` for `X<A, B<C>>`. */
export function typeArgs(type: string): string[] {
  const open = type.indexOf("<");
  if (open < 0 || !type.endsWith(">")) return [];
  const inner = type.slice(open + 1, -1);
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
  return args;
}

const OF_TYPE_QUERY = `query($type: String!, $cp: UInt53, $after: String) {
  objects(first: 50, after: $after, filter: { type: $type }) {
    pageInfo { hasNextPage endCursor }
    nodes { address objectAt(checkpoint: $cp) { version asMoveObject { contents { type { repr } json } } } }
  }
}`;

interface OfTypePage {
  objects: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ address: string; objectAt: { version: number; asMoveObject: { contents: { type: { repr: string }; json: Record<string, unknown> } | null } | null } | null }>;
  };
}

/**
 * Every live object of a protocol type (every instantiation, for a generic
 * type named without parameters), each as it was at `atCheckpoint` when
 * given. One created after the checkpoint has no state there and is left
 * out. For protocol singletons and registries, which are few and never
 * deleted.
 */
export function objectsOfType(type: string, atCheckpoint: string | undefined): Promise<OwnedState[]> {
  return memo(`of-type:${type}:${atCheckpoint ?? "latest"}`, ttlFor(atCheckpoint), async () => {
    const out: OwnedState[] = [];
    let after: string | null = null;
    for (;;) {
      const d: OfTypePage = await gqlQuery<OfTypePage>(OF_TYPE_QUERY, { type, cp: atCheckpoint === undefined ? null : Number(atCheckpoint), after });
      for (const n of d.objects.nodes) {
        const c = n.objectAt?.asMoveObject?.contents;
        if (c) out.push({ object_id: n.address, version: String(n.objectAt!.version), type: c.type.repr, json: c.json });
      }
      if (!d.objects.pageInfo.hasNextPage) return out;
      after = d.objects.pageInfo.endCursor;
      if (!after) return out;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Owned objects, now or at a checkpoint
 * ------------------------------------------------------------------ */

export interface OwnedState {
  object_id: string;
  version: string;
  type: string;
  json: Record<string, unknown> | null;
}

/** Objects of one type an owner holds, read before the listing is reported as partial. */
const MAX_OWNED = 200;

const OWNED_QUERY = `query($owner: SuiAddress!, $type: String!, $cp: UInt53, $after: String) {
  address(address: $owner, atCheckpoint: $cp) {
    objects(first: 50, after: $after, filter: { type: $type }) {
      pageInfo { hasNextPage endCursor }
      nodes { address version contents { type { repr } json } }
    }
  }
}`;

interface OwnedPage {
  address: {
    objects: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ address: string; version: number; contents: { type: { repr: string }; json: Record<string, unknown> } | null }>;
    } | null;
  } | null;
}

/**
 * Every object of a type (every instantiation, for a generic type named
 * without parameters) the owner holds, as of `atCheckpoint` when given.
 * Throws when the service cannot list the owner's objects at that
 * checkpoint, which it can only do inside its consistent range.
 */
export async function listOwned(owner: string, type: string, atCheckpoint?: string): Promise<{ objects: OwnedState[]; complete: boolean }> {
  const objects: OwnedState[] = [];
  let after: string | null = null;
  for (;;) {
    const d: OwnedPage = await gqlQuery<OwnedPage>(OWNED_QUERY, {
      owner: normalizeAddress(owner),
      type,
      cp: atCheckpoint === undefined ? null : Number(atCheckpoint),
      after,
    });
    const conn = d.address?.objects;
    if (!conn) return { objects, complete: true };
    for (const n of conn.nodes) {
      objects.push({ object_id: n.address, version: String(n.version), type: n.contents?.type.repr ?? type, json: n.contents?.json ?? null });
    }
    if (!conn.pageInfo.hasNextPage) return { objects, complete: true };
    after = conn.pageInfo.endCursor;
    if (!after || objects.length >= MAX_OWNED) return { objects, complete: false };
  }
}

/**
 * Value every object of `type` the owner holds, one position reader call
 * each. A listing the service cannot give at the checkpoint, a listing cut
 * short, and an object whose position cannot be read are each named in
 * `unread`; none of them hides the positions that were read.
 */
export async function valueOwnedObjects(
  ctx: ValuationContext,
  name: string,
  type: string,
  valueOne: (obj: OwnedState) => Promise<ValuerResult>,
): Promise<ValuerResult> {
  let listing: { objects: OwnedState[]; complete: boolean };
  try {
    listing = await listOwned(ctx.owner, type, ctx.atCheckpoint);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      positions: [],
      unread: [{ what: `${name}: ${type}`, reason: `The owner's objects could not be listed${ctx.atCheckpoint ? ` at checkpoint ${ctx.atCheckpoint}` : ""}: ${why}` }],
    };
  }
  const results = await Promise.allSettled(listing.objects.map((o) => valueOne(o)));
  const out: ValuerResult = { positions: [], unread: [] };
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      out.positions.push(...r.value.positions);
      out.unread.push(...r.value.unread);
    } else {
      out.unread.push({ what: listing.objects[i].object_id, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    }
  });
  if (!listing.complete) {
    out.unread.push({ what: `${name}: ${type}`, reason: `Only the first ${listing.objects.length} of the owner's objects of this type were read.` });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Pricing at a protocol's oracle, cross-checked against providers
 * ------------------------------------------------------------------ */

export interface LendingLeg {
  coin_type: string;
  /** Base units of the coin. */
  amount: bigint;
  side: AssetSide;
  /** Decimals the protocol stores for the coin; the coin's own scale when absent. */
  decimals?: number;
  /** USD per whole unit at the protocol's own oracle; absent when it stores none for this coin. */
  oracle_price?: number | null;
  /** Unix seconds the oracle price was written, when the protocol records it. */
  oracle_at_s?: number;
  /**
   * The coin whose price feed the protocol uses for this one, when that is
   * another asset's. Its oracle price is then that asset's and is not used.
   */
  feed_of?: string;
  /** The issuer's SUI per unit, for a liquid-staking coin; set by {@link priceLendingLegs}. */
  lst?: { sui_per_lst: number; issuer: string };
  note?: string;
}

export interface LendingBase {
  protocol: string;
  kind: ValuedPosition["kind"];
  object_id: string | null;
  /** Name of the protocol's oracle as `price_source` reports it, e.g. "navi_oracle". */
  oracle: string;
  /** The protocol's own SUI price, which values a liquid-staking leg through its issuer's rate. */
  sui_oracle?: { price: number; at_s: number } | null;
  /** Unix seconds the valuation is for. */
  at_s: number;
  /** How the amounts were derived, as a sentence; how they were priced is appended. */
  method: string;
  health?: ValuedPosition["health"];
  /**
   * The protocol's own USD totals for the position's deposits and borrows,
   * and when it wrote them if it records that; compared with the legs by
   * {@link healthBasis}.
   */
  stored_totals?: StoredTotals;
  detail?: Record<string, unknown>;
}

/**
 * Provider prices for a position's legs, with every liquid-staking leg's
 * issuer rate attached (and SUI priced) so the leg is valued as SUI. A rate
 * that cannot be read leaves the leg to be priced as itself.
 */
export async function priceLendingLegs(legs: LendingLeg[], ctx: ValuationContext): Promise<HistoricalPrices> {
  const coins = [...new Set(legs.map((l) => l.coin_type))];
  const rates = new Map<string, { sui_per_lst: number; issuer: string }>();
  await Promise.all(
    coins.map(async (coin) => {
      const r = await suiPerLst(coin, ctx.atCheckpoint).catch(() => null);
      if (r && Number.isFinite(r.sui_per_lst) && r.sui_per_lst > 0) rates.set(coin, { sui_per_lst: r.sui_per_lst, issuer: r.issuer });
    }),
  );
  for (const leg of legs) {
    const rate = rates.get(leg.coin_type);
    if (rate) leg.lst = rate;
  }
  return priceCoinTypes(rates.size > 0 ? [...coins, SUI_TYPE] : coins, ctx);
}

/** A coin's symbol as the curated registry gives it, else from its type name. */
const coinSymbol = (coinType: string) => displayCoin(coinType).symbol;
const usdText = (n: number) => `$${n.toPrecision(6).replace(/\.?0+$/, "")}`;

/**
 * A position priced leg by leg, where a protocol's own oracle is trusted
 * only as far as a price provider confirms it:
 *
 * - An oracle price within {@link PRICE_CHECK_PCT} of the provider's values
 *   the leg, chain-derived.
 * - An oracle price further from it than that fails the check: the
 *   provider's price values the leg, both are reported in `price_check`, and
 *   the method says the check failed. A protocol's feed can be another
 *   asset's, and an oracle read inside an attack's checkpoint can be the
 *   manipulated price itself, however fresh.
 * - An oracle price no provider can confirm values the leg as an estimate
 *   (tier heuristic), which totals of priced value keep apart.
 * - A liquid-staking leg is valued as SUI at its issuer's rate, at the
 *   protocol's SUI price when it has one, since protocols often price such a
 *   coin at SUI's own feed.
 * - An oracle price taken from another asset's feed (`feed_of`) is not used.
 *
 * A leg neither prices, or whose decimals nothing vouches for, has no USD
 * and makes the net null. The tier is the weakest of its legs'.
 */
export function assembleLending(base: LendingBase, legs: LendingLeg[], prices: HistoricalPrices): ValuedPosition {
  const assets: ValuedAsset[] = [];
  const unpriced: string[] = [];
  const providerSources = new Set<string>();
  const failed: string[] = [];
  const unconfirmed: string[] = [];
  const lstNotes: string[] = [];
  let net = 0;
  let confirmed = 0;
  let tier: ValueTier = "chain-derived";
  const weaken = (t: ValueTier) => {
    if (t === "heuristic" || (t === "price-provider" && tier === "chain-derived")) tier = t;
  };
  const suiPoint = prices.points.get(SUI_TYPE) ?? null;
  for (const leg of legs) {
    const asset: ValuedAsset = { coin_type: leg.coin_type, amount: leg.amount.toString(), side: leg.side, usd: null };
    const notes: string[] = leg.note ? [leg.note] : [];
    let oracle = leg.feed_of === undefined && leg.oracle_price != null && Number.isFinite(leg.oracle_price) && leg.oracle_price > 0 ? leg.oracle_price : null;
    let oracleAt = leg.oracle_at_s;
    let oracleName = base.oracle;
    let point = prices.points.get(leg.coin_type) ?? null;
    if (leg.feed_of !== undefined && !leg.lst) notes.push(`${base.protocol} prices this coin with ${coinSymbol(leg.feed_of)}'s price feed, so its oracle price is not used.`);
    if (leg.lst) {
      const { sui_per_lst: rate, issuer } = leg.lst;
      oracle = base.sui_oracle ? base.sui_oracle.price * rate : null;
      oracleAt = base.sui_oracle?.at_s;
      oracleName = `${base.oracle} SUI price × ${issuer} rate`;
      // Without the coin's own provider price, the provider check is SUI's at the same rate.
      if (!point && suiPoint) point = { ...suiPoint, price: suiPoint.price * rate };
      lstNotes.push(`${coinSymbol(leg.coin_type)} is valued as SUI at ${issuer}'s rate of ${rate.toPrecision(6)} SUI per unit.`);
    }
    const oracleAge = oracle !== null && oracleAt ? base.at_s - oracleAt : 0;
    // How far the provider's price is above (+) or below (-) the oracle's, in percent.
    const diff = oracle !== null && point ? ((point.price - oracle) / oracle) * 100 : 0;
    const disagrees = Math.abs(diff) > PRICE_CHECK_PCT;
    const coinScale = pricingScale(leg.coin_type, point);
    const scale = leg.decimals ?? (coinScale.source === "assumed" ? null : coinScale.decimals);
    if (oracle !== null && point && disagrees) {
      asset.price_check = {
        oracle_price: oracle,
        provider_price: point.price,
        provider_source: point.source,
        diff_pct: Math.round(diff * 100) / 100,
        ...(oracleAge > PRICE_STALE_THRESHOLD_SEC ? { oracle_age_sec: oracleAge } : {}),
      };
    }
    if (leg.amount === 0n) {
      asset.usd = 0;
    } else if (scale === null) {
      unpriced.push(`${leg.coin_type}: its decimals are not known, so the amount cannot be scaled.`);
    } else if (oracle !== null && point && !disagrees) {
      asset.usd = toHumanAmount(leg.amount, scale) * oracle;
      asset.price_usd = oracle;
      asset.price_source = oracleName;
      confirmed++;
    } else if (point) {
      weaken("price-provider");
      asset.usd = toHumanAmount(leg.amount, scale) * point.price;
      asset.price_usd = point.price;
      asset.price_source = point.source;
      asset.price_sample = point;
      providerSources.add(`${point.source} at ${new Date(point.publishTime * 1000).toISOString()}`);
      if (oracle !== null) {
        failed.push(`${coinSymbol(leg.coin_type)} (${oracleName} ${usdText(oracle)} against ${point.source} ${usdText(point.price)}, ${Math.round(diff * 100) / 100}%)`);
      }
    } else if (oracle !== null) {
      weaken("heuristic");
      asset.usd = toHumanAmount(leg.amount, scale) * oracle;
      asset.price_usd = oracle;
      asset.price_source = oracleName;
      unconfirmed.push(coinSymbol(leg.coin_type));
      if (oracleAge > PRICE_STALE_THRESHOLD_SEC) notes.push(`The oracle price was written ${Math.round(oracleAge / 3600)} hours before the valuation time.`);
    } else {
      weaken("price-provider");
      const why = prices.unpriced.find((u) => u.coin_type === leg.coin_type)?.reason;
      unpriced.push(`${leg.coin_type}: ${base.oracle} gives no usable price for it${why ? ` and ${why.charAt(0).toLowerCase()}${why.slice(1)}` : " and no provider prices it."}`);
    }
    if (notes.length > 0) asset.note = notes.join(" ");
    if (asset.usd !== null) net += leg.side === "borrow" ? -asset.usd : asset.usd;
    assets.push(asset);
  }
  const notes: string[] = [...lstNotes];
  if (confirmed > 0) notes.push(`Legs are priced at ${base.oracle}'s stored price where a price provider confirms it within ${PRICE_CHECK_PCT}%.`);
  if (failed.length > 0) notes.push(`The oracle's price failed the provider check for ${failed.join("; ")}, so the provider's price values those legs.`);
  if (providerSources.size > 0) notes.push(`Provider prices used: ${[...providerSources].join(", ")}.`);
  if (unconfirmed.length > 0) {
    notes.push(`No provider prices ${unconfirmed.join(", ")}, so ${unconfirmed.length > 1 ? "their prices rest" : "its price rests"} on ${base.oracle} alone and the value is an estimate.`);
  }
  const position: ValuedPosition = {
    protocol: base.protocol,
    kind: base.kind,
    object_id: base.object_id,
    assets,
    usd_net: unpriced.length > 0 ? null : net,
    method: [base.method, ...notes].join(" "),
    tier,
  };
  if (unpriced.length > 0) position.unpriced_reason = unpriced.join(" ");
  if (base.health) position.health = base.health;
  if (base.stored_totals && unpriced.length === 0) {
    const sum = (borrow: boolean) => assets.reduce((n, a) => n + ((a.side === "borrow") === borrow ? (a.usd ?? 0) : 0), 0);
    const basis = healthBasis(base.stored_totals, { supply_usd: sum(false), borrow_usd: sum(true) });
    if (basis) position.health_basis = basis;
  }
  if (base.detail) position.detail = base.detail;
  return position;
}

/* ------------------------------------------------------------------ *
 * Health ratios and the basis of stored health figures
 * ------------------------------------------------------------------ */

/**
 * How each derived health ratio is made: the keys in `health` of its
 * numerator (what is borrowed, weighted as the protocol weighs it) and its
 * denominator (the limit). Every reader names its ratios the same, so a
 * consumer compares positions across protocols without knowing their fields.
 */
export interface HealthRatios {
  /** Borrows over the most the position may borrow; at 1 it can borrow or withdraw no more. */
  borrow_limit_used?: [string, string];
  /** Borrows over the level at which the position can be liquidated; past 1 it can be. */
  liquidation_threshold_used?: [string, string];
}

/**
 * `numerator / denominator` to 4 dp. Nothing borrowed is 0 whatever the
 * limit; a borrow against a zero or unknown limit is null, since no finite
 * ratio says how far over the limit that is.
 */
export function usedRatio(numerator: number | boolean | null | undefined, denominator: number | boolean | null | undefined): number | null {
  if (typeof numerator !== "number" || !Number.isFinite(numerator)) return null;
  if (numerator === 0) return 0;
  if (typeof denominator !== "number" || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/** `health` with each ratio of `ratios` computed from it, the ratios first. */
export function withHealthRatios(health: NonNullable<ValuedPosition["health"]>, ratios: HealthRatios): NonNullable<ValuedPosition["health"]> {
  const derived: NonNullable<ValuedPosition["health"]> = {};
  for (const [name, [num, den]] of Object.entries(ratios) as Array<[keyof HealthRatios, [string, string]]>) derived[name] = usedRatio(health[num], health[den]);
  return { ...derived, ...health };
}

export interface StoredTotals {
  deposits_usd: number | null;
  borrows_usd: number | null;
  /**
   * USD of collateral the protocol counts in `deposits_usd` but that is
   * reported as a row of its own, e.g. an LP position; the legs are compared
   * with the stored deposits after adding it.
   */
  supply_elsewhere_usd?: number;
  /** Unix seconds the protocol last wrote the figures, when it records that. */
  as_of_s?: number | null;
}

/** USD to the whole dollar with thousands separators, or to the cent below $100, so close figures stay distinguishable. */
export const dollars = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n) >= 100 ? Math.round(Math.abs(n)).toLocaleString("en-US") : Math.abs(n).toFixed(2)}`;

/**
 * Which figures to use for what, when the protocol's own USD totals and the
 * legs' USD disagree: on either side by more than {@link PRICE_CHECK_PCT} of
 * the larger figure, the tolerance within which an oracle price and a
 * provider's count as agreeing. They part when a leg is valued at a
 * provider's price in place of the protocol's (another asset's feed, a
 * failed check) or when the protocol last wrote its totals before interest
 * and prices moved. Liquidation follows the protocol's own figures, so they
 * measure distance to liquidation, while the legs say what the position is
 * worth. Null when they agree or a total is missing.
 */
export function healthBasis(stored: StoredTotals, legs: { supply_usd: number; borrow_usd: number }): string | null {
  const { deposits_usd: deposits, borrows_usd: borrows } = stored;
  if (deposits === null || borrows === null) return null;
  const elsewhere = stored.supply_elsewhere_usd ?? 0;
  const supply = legs.supply_usd + elsewhere;
  const apart = (a: number, b: number) => Math.abs(a - b) > (PRICE_CHECK_PCT / 100) * Math.max(Math.abs(a), Math.abs(b));
  if (!apart(deposits, supply) && !apart(borrows, legs.borrow_usd)) return null;
  const storedNet = deposits - borrows;
  const legsNet = supply - legs.borrow_usd;
  const asOf = stored.as_of_s ? new Date(stored.as_of_s * 1000).toISOString() : null;
  return (
    `The protocol's own figures${asOf ? `, as of its last refresh at ${asOf},` : ""} put deposits at ${dollars(deposits)} and borrows at ${dollars(borrows)} (net ${dollars(storedNet)}), ` +
    `against ${dollars(supply)}${elsewhere ? ` (${dollars(elsewhere)} of it collateral reported in its own row)` : ""} and ${dollars(legs.borrow_usd)} (net ${dollars(legsNet)}) at the legs' prices, a gap of ${dollars(Math.abs(legsNet - storedNet))}. ` +
    `Liquidation follows the protocol's figures at its own oracle prices, so use \`health\` for distance to liquidation${asOf ? " (its ratios are as of that refresh)" : ""} and \`usd\` for what the position is worth at market prices.`
  );
}

/* ------------------------------------------------------------------ *
 * Move JSON numbers
 * ------------------------------------------------------------------ */

/** An unsigned integer from Move JSON (u64 and wider render as strings). */
export function uint(v: unknown): bigint {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (v && typeof v === "object" && "value" in v) return uint((v as { value: unknown }).value);
  throw new Error(`expected an unsigned integer, got ${JSON.stringify(v)}`);
}

/** A fixed-point value as a float: `raw / 10^scale` or `raw / 2^bits` via `divisor`. */
export function fixed(raw: bigint, divisor: bigint): number {
  const whole = raw / divisor;
  const frac = raw % divisor;
  return Number(whole) + Number(frac) / Number(divisor);
}

/** `x * num / den`, floored, in bigint. */
export function mulDiv(x: bigint, num: bigint, den: bigint): bigint {
  return den === 0n ? 0n : (x * num) / den;
}

/** A GraphQL failure that means the state at the checkpoint cannot be read. */
export function isOutOfRange(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /consistent range|pruned|not available|outside .*range/i.test(msg);
}
