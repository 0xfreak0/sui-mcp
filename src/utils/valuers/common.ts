/**
 * Helpers the position readers share: when a valuation is for, reading
 * protocol objects at that point, and turning raw legs into a priced
 * position.
 */

import { gqlQuery } from "../../clients/graphql.js";
import { getNetwork } from "../../config.js";
import { normalizeCoinType } from "../coin-registry.js";
import {
  prefetchCoinScale,
  priceUsdAtTime,
  pricingScale,
  toHumanAmount,
  type HistoricalPrices,
} from "../valuation.js";
import type { AssetSide, ValuationContext, ValuedAsset, ValuedPosition, ValueTier } from "../position-value.js";

export const SUI_TYPE = normalizeCoinType("0x2::sui::SUI")!;

/**
 * Keys per multi-get. The service caps a request at 50 keys and 5,000 bytes
 * with its variables; a key with a checkpoint or version is about 95 bytes.
 */
const MULTI_GET_MAX = 40;

interface CheckpointMeta {
  epoch: number;
  timestampSec: number;
}

const checkpointCache = new Map<string, Promise<CheckpointMeta | null>>();

/** Epoch and time of one checkpoint; null when the service does not know it. */
export function checkpointMeta(seq: string | number): Promise<CheckpointMeta | null> {
  const key = `${getNetwork()}:${seq}`;
  let hit = checkpointCache.get(key);
  if (!hit) {
    hit = gqlQuery<{ checkpoint: { timestamp: string; epoch: { epochId: number } | null } | null }>(
      `query($s: UInt53!) { checkpoint(sequenceNumber: $s) { timestamp epoch { epochId } } }`,
      { s: Number(seq) },
    ).then((d) =>
      d.checkpoint?.epoch
        ? { epoch: d.checkpoint.epoch.epochId, timestampSec: Math.floor(Date.parse(d.checkpoint.timestamp) / 1000) }
        : null,
    );
    hit.catch(() => checkpointCache.delete(key));
    checkpointCache.set(key, hit);
  }
  return hit;
}

/** Checkpoints asked for in one multi-get. */
const CHECKPOINTS_PER_REQUEST = 50;

/**
 * Warm `checkpointMeta` for many checkpoints in batched requests, so a scan
 * valuing objects at a hundred checkpoints does not ask for each alone. A
 * failed batch leaves its checkpoints to be read one by one.
 */
export async function prefetchCheckpoints(seqs: Array<string | number>): Promise<void> {
  const network = getNetwork();
  const missing = [...new Set(seqs.map(Number))].filter((n) => Number.isSafeInteger(n) && n >= 0 && !checkpointCache.has(`${network}:${n}`));
  for (let i = 0; i < missing.length; i += CHECKPOINTS_PER_REQUEST) {
    const chunk = missing.slice(i, i + CHECKPOINTS_PER_REQUEST);
    const read = gqlQuery<{ multiGetCheckpoints: Array<{ sequenceNumber: number; timestamp: string; epoch: { epochId: number } | null } | null> }>(
      `query($k: [UInt53!]!) { multiGetCheckpoints(keys: $k) { sequenceNumber timestamp epoch { epochId } } }`,
      { k: chunk },
    );
    chunk.forEach((n, j) => {
      const hit = read.then((d) => {
        const c = d.multiGetCheckpoints[j];
        return c?.epoch ? { epoch: c.epoch.epochId, timestampSec: Math.floor(Date.parse(c.timestamp) / 1000) } : null;
      });
      hit.catch(() => checkpointCache.delete(`${network}:${n}`));
      checkpointCache.set(`${network}:${n}`, hit);
    });
    await read.catch(() => undefined);
  }
}

/** Unix seconds the valuation is for; undefined means now. */
export async function valuationTime(ctx: ValuationContext): Promise<number | undefined> {
  if (ctx.atTime !== undefined) return ctx.atTime;
  if (ctx.atCheckpoint === undefined) return undefined;
  return (await checkpointMeta(ctx.atCheckpoint))?.timestampSec;
}

/** The epoch a valuation is for: the checkpoint's, else the current one. */
export async function valuationEpoch(ctx: ValuationContext): Promise<number> {
  if (ctx.atCheckpoint !== undefined) {
    const meta = await checkpointMeta(ctx.atCheckpoint);
    if (meta) return meta.epoch;
    throw new Error(`checkpoint ${ctx.atCheckpoint} is not known to the service`);
  }
  const d = await gqlQuery<{ epoch: { epochId: number } }>(`{ epoch { epochId } }`);
  return d.epoch.epochId;
}

export interface ObjectState {
  object_id: string;
  version: string;
  type: string;
  json: Record<string, unknown>;
  /** True when the state at the requested checkpoint could not be read and this is the latest. */
  current: boolean;
  /** Who held this version; read by `readObjectVersions` only. */
  owner?: { kind: "address" | "object" | "shared" | "immutable" | "other"; address: string | null };
}

interface GqlObject {
  address: string;
  version: number;
  owner?: { __typename?: string; address?: { address?: string } | null } | null;
  asMoveObject: { contents: { type: { repr: string }; json: Record<string, unknown> } | null } | null;
}

const MULTI_GET_OBJECTS = `query($keys: [ObjectKey!]!) {
  multiGetObjects(keys: $keys) { address version asMoveObject { contents { type { repr } json } } }
}`;

const MULTI_GET_OBJECTS_OWNED = `query($keys: [ObjectKey!]!) {
  multiGetObjects(keys: $keys) { address version owner { __typename ... on AddressOwner { address { address } } ... on ObjectOwner { address { address } } } asMoveObject { contents { type { repr } json } } }
}`;

async function multiGet(
  keys: Array<{ address: string; atCheckpoint?: number; version?: number }>,
  withOwner = false,
): Promise<Array<GqlObject | null>> {
  const out: Array<GqlObject | null> = [];
  for (let i = 0; i < keys.length; i += MULTI_GET_MAX) {
    const d = await gqlQuery<{ multiGetObjects: Array<GqlObject | null> }>(withOwner ? MULTI_GET_OBJECTS_OWNED : MULTI_GET_OBJECTS, {
      keys: keys.slice(i, i + MULTI_GET_MAX),
    });
    out.push(...d.multiGetObjects);
  }
  return out;
}

function toState(o: GqlObject | null, current: boolean): ObjectState | null {
  const c = o?.asMoveObject?.contents;
  if (!o || !c) return null;
  return { object_id: o.address, version: String(o.version), type: c.type.repr, json: c.json, current };
}

/**
 * Objects' Move JSON as of `atCheckpoint`, or their latest state without
 * one. An object the service cannot give at the checkpoint is read at its
 * latest state and marked `current`; one it cannot give at all is absent.
 * With `memo` (a call's `ctx.memo`), each object is read once per
 * checkpoint across the call.
 */
export async function readObjects(ids: string[], atCheckpoint?: string, memo?: ValuationContext["memo"]): Promise<Map<string, ObjectState>> {
  if (!memo) return readObjectsNow(ids, atCheckpoint);
  const keyOf = (id: string) => `object:${getNetwork()}:${atCheckpoint ?? "latest"}:${id}`;
  const unique = [...new Set(ids)];
  const missing = unique.filter((id) => !memo.has(keyOf(id)));
  if (missing.length > 0) {
    const read = readObjectsNow(missing, atCheckpoint);
    for (const id of missing) memo.set(keyOf(id), read.then((m) => m.get(id) ?? null));
    read.catch(() => {
      for (const id of missing) memo.delete(keyOf(id));
    });
  }
  const answers = unique.map((id) => [id, memo.get(keyOf(id)) as Promise<ObjectState | null>] as const);
  const out = new Map<string, ObjectState>();
  for (const [id, answer] of answers) {
    const state = await answer;
    if (state) out.set(id, state);
  }
  return out;
}

type ObjectKey = { address: string; atCheckpoint?: number };

/** Keys asked for in the current tick, sent together as one multi-get. */
let pending: Array<{ keys: ObjectKey[]; resolve: (r: Array<GqlObject | null>) => void; reject: (e: unknown) => void }> = [];

/**
 * A multi-get shared with every other read asked for in the same tick,
 * whatever checkpoint each key names: readers valuing many objects at many
 * checkpoints at once cost one request per batch, not one per read.
 */
function coalescedGet(keys: ObjectKey[]): Promise<Array<GqlObject | null>> {
  return new Promise((resolve, reject) => {
    if (pending.length === 0) {
      queueMicrotask(() => {
        const batch = pending;
        pending = [];
        const all = batch.flatMap((b) => b.keys);
        multiGet(all).then(
          (got) => {
            let at = 0;
            for (const b of batch) {
              b.resolve(got.slice(at, at + b.keys.length));
              at += b.keys.length;
            }
          },
          // One failing key fails the combined request; each caller retries alone.
          () => {
            for (const b of batch) multiGet(b.keys).then(b.resolve, b.reject);
          },
        );
      });
    }
    pending.push({ keys, resolve, reject });
  });
}

async function readObjectsNow(ids: string[], atCheckpoint?: string): Promise<Map<string, ObjectState>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, ObjectState>();
  const at = atCheckpoint === undefined ? undefined : Number(atCheckpoint);
  const first = await coalescedGet(unique.map((address) => (at === undefined ? { address } : { address, atCheckpoint: at })));
  const missing: string[] = [];
  first.forEach((o, i) => {
    const state = toState(o, false);
    if (state) out.set(unique[i], state);
    else if (at !== undefined) missing.push(unique[i]);
  });
  if (missing.length > 0) {
    const latest = await multiGet(missing.map((address) => ({ address })));
    latest.forEach((o, i) => {
      const state = toState(o, true);
      if (state) out.set(missing[i], state);
    });
  }
  return out;
}

const OWNER_KIND: Record<string, NonNullable<ObjectState["owner"]>["kind"]> = {
  AddressOwner: "address",
  ObjectOwner: "object",
  Shared: "shared",
  Immutable: "immutable",
};

/**
 * Objects' Move JSON and holder at exact versions, keyed `id@version`; a
 * version the service cannot give is absent.
 */
export async function readObjectVersions(keys: Array<{ object_id: string; version: string }>): Promise<Map<string, ObjectState>> {
  const unique = [...new Map(keys.map((k) => [`${k.object_id}@${k.version}`, k])).values()];
  const got = await multiGet(
    unique.map((k) => ({ address: k.object_id, version: Number(k.version) })),
    true,
  );
  const out = new Map<string, ObjectState>();
  got.forEach((o, i) => {
    const state = toState(o, false);
    if (!state) return;
    if (o?.owner) state.owner = { kind: OWNER_KIND[o.owner.__typename ?? ""] ?? "other", address: o.owner.address?.address ?? null };
    out.set(`${unique[i].object_id}@${unique[i].version}`, state);
  });
  return out;
}

/** "as of checkpoint N" or "at the latest state", for a method sentence. */
export function stateNote(ctx: ValuationContext, current: boolean): string {
  if (ctx.atCheckpoint === undefined) return "at the latest state";
  return current
    ? `at the latest state, because the state at checkpoint ${ctx.atCheckpoint} could not be read`
    : `as of checkpoint ${ctx.atCheckpoint}`;
}

/**
 * Prices for coin types at the valuation time, with their decimals warmed.
 * With `ctx.memo`, each coin is asked for once per time across the call.
 */
export async function priceCoinTypes(coinTypes: string[], ctx: ValuationContext): Promise<HistoricalPrices> {
  const unique = [...new Set(coinTypes)];
  const time = await valuationTime(ctx);
  const ask = async (coins: string[]) => {
    await prefetchCoinScale(coins).catch(() => undefined);
    return priceUsdAtTime(coins, time);
  };
  const memo = ctx.memo;
  if (!memo) return ask(unique);
  const keyOf = (coin: string) => `price:${getNetwork()}:${time ?? "now"}:${coin}`;
  const missing = unique.filter((c) => !memo.has(keyOf(c)));
  if (missing.length > 0) {
    const asked = ask(missing);
    for (const c of missing) memo.set(keyOf(c), asked);
    // A failed request says nothing about the coins; the next caller asks again.
    asked.then(
      (r) => {
        for (const u of r.unpriced) if (u.code === "request_failed") memo.delete(keyOf(u.coin_type));
      },
      () => {
        for (const c of missing) memo.delete(keyOf(c));
      },
    );
  }
  // Taken now: a failed request's entries are dropped once it settles.
  const answers = new Map(unique.map((c) => [c, memo.get(keyOf(c)) as Promise<HistoricalPrices>]));
  const points: HistoricalPrices["points"] = new Map();
  const unpriced: HistoricalPrices["unpriced"] = [];
  for (const c of unique) {
    const r = await answers.get(c)!;
    const point = r.points.get(c);
    if (point) points.set(c, point);
    else unpriced.push(...r.unpriced.filter((u) => u.coin_type === c));
  }
  return { points, unpriced };
}

export interface Leg {
  coin_type: string;
  amount: bigint;
  side: AssetSide;
}

export interface PositionBase {
  protocol: string | null;
  kind: ValuedPosition["kind"];
  object_id: string | null;
  /** How the amounts were derived; the price source is appended. */
  method: string;
  detail?: Record<string, unknown>;
}

/**
 * A priced position from raw legs. The net is null when any leg with a
 * non-zero amount has no price, and `unpriced_reason` names those coins.
 * The tier is `price-provider`: the amounts are read from chain, the USD
 * rests on a provider's price.
 */
export function assemblePosition(base: PositionBase, legs: Leg[], prices: HistoricalPrices, tier: ValueTier = "price-provider"): ValuedPosition {
  const assets: ValuedAsset[] = [];
  let net = 0;
  const unpriced: string[] = [];
  const sources = new Set<string>();
  for (const leg of legs) {
    const point = prices.points.get(leg.coin_type);
    let usd: number | null = null;
    if (leg.amount === 0n) usd = 0;
    else if (point) {
      usd = toHumanAmount(leg.amount, pricingScale(leg.coin_type, point).decimals) * point.price;
      sources.add(`${point.source} at ${new Date(point.publishTime * 1000).toISOString()}`);
    } else unpriced.push(leg.coin_type);
    // Borrows are owed, so they subtract from the net.
    if (usd !== null) net += leg.side === "borrow" ? -usd : usd;
    assets.push({ coin_type: leg.coin_type, amount: leg.amount.toString(), side: leg.side, usd,
      ...(point && leg.amount !== 0n ? { price_sample: point } : {}) });
  }
  const priceNote = sources.size > 0 ? ` Priced by ${[...sources].join(", ")}.` : "";
  const position: ValuedPosition = {
    protocol: base.protocol,
    kind: base.kind,
    object_id: base.object_id,
    assets,
    usd_net: unpriced.length > 0 ? null : net,
    method: `${base.method}${priceNote}`,
    tier,
  };
  if (unpriced.length > 0) {
    const reasons = prices.unpriced.filter((u) => unpriced.includes(u.coin_type)).map((u) => `${u.coin_type}: ${u.reason}`);
    position.unpriced_reason = reasons.length > 0 ? reasons.join(" ") : `No price for ${unpriced.join(", ")}.`;
  }
  if (base.detail) position.detail = base.detail;
  return position;
}

/** A u64/u128 field from Move JSON, which renders them as strings. */
export function bigField(v: unknown): bigint | null {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}
