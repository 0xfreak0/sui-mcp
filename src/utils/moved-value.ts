/**
 * USD value of the non-coin objects a transaction moved into or out of
 * addresses: a StakedSui, an LP position, a lending cap, a vault receipt,
 * an NFT. Coins are balance changes and valued elsewhere.
 *
 * An object counts for the address it left (transferred, deleted, wrapped)
 * at its input version, and for the address it reached (transferred,
 * created, unwrapped, appeared) at its output version. Its value is read at
 * the transaction's checkpoint where the readers can, and each row's method
 * says when the state used was the latest instead.
 */

import "./valuers/index.js";
import type { GrpcTypes, SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { archive, sui } from "../clients/grpc.js";
import { getNetworkConfig } from "../config.js";
import { readerFor, valueObjects, type ValuedAsset, type ValuedPosition, type ValuerResult } from "./position-value.js";
import { prefetchCheckpoints, priceCoinTypes, readObjectVersions, type ObjectState } from "./valuers/common.js";
import { pricingScale } from "./valuation.js";
import { readGrpcObjectChanges, type ObjectMovement } from "./object-flow.js";

export interface MovedObject {
  object_id: string;
  type: string;
  /** Address it left, when an address held it directly. */
  from: string | null;
  /** Address it reached, when an address holds it directly. */
  to: string | null;
  /** Version whose state is valued: the output version when it has one, else the input. */
  version: string | null;
  /** For an object its holder kept but the transaction changed: the input version, valued too. */
  before_version?: string;
  /**
   * The input version of an object whose previous holder the chain did not
   * record (`appeared`): that version's holder is read to decide whether it
   * moved or was only changed in place.
   */
  prior_version?: string;
  /** Moved into or out of another object, or from a holder that cannot be read: listed, never counted. */
  custody?: Custody;
}

/**
 * Why a row stays out of every total. `wrapped` and `unwrapped`: the object
 * went into or came out of another object (a farm, a vault, collateral), so
 * its holder still owns it through that object. `prior_holder_unknown`: the
 * chain did not record who held it before, and that version could not be
 * read as an address's.
 */
export type Custody = "wrapped" | "unwrapped" | "prior_holder_unknown";

export interface MovedObjectValue {
  object_id: string;
  type: string;
  from: string | null;
  to: string | null;
  protocol: string | null;
  kind: ValuedPosition["kind"];
  /**
   * Its value; for an object changed in place, the change in value, signed.
   * Null when a leg has no price.
   */
  usd: number | null;
  /** The holder kept it and `usd` is the change in its value. */
  changed_in_place?: true;
  /** For a kept object, its value after the transaction; null when unpriced. */
  usd_after?: number | null;
  /** Listed for what it is worth, and kept out of every total. */
  custody?: Custody;
  /**
   * What the object holds per coin, raw and signed (borrows negative): for a
   * moved object at the version valued, for a kept one the change. Lets a
   * caller match coins paid out against the positions they came from.
   */
  coin_amounts?: Array<{ coin_type: string; amount: string }>;
  /** Other transactions of the same checkpoint that changed this kept position; its change is counted once, here. */
  same_checkpoint_digests?: string[];
  /** A heuristic value (an NFT estimate), which totals keep apart from priced value. */
  estimate: boolean;
  tier: ValuedPosition["tier"];
  method: string;
  unpriced_reason?: string;
}

export interface MovedValues {
  rows: MovedObjectValue[];
  /** Objects a reader handles whose value could not be read, with the reason. */
  unread: ValuerResult["unread"];
}

const FROM_KINDS: ReadonlyArray<ObjectMovement["kind"]> = ["transferred", "deleted", "wrapped"];
const TO_KINDS: ReadonlyArray<ObjectMovement["kind"]> = ["transferred", "created", "unwrapped", "appeared"];
const COIN_OBJECT = /^0x0*2::coin::Coin</;
const CUSTODY_KINDS: Partial<Record<ObjectMovement["kind"], Custody>> = { wrapped: "wrapped", unwrapped: "unwrapped" };

export interface ChangedObjectRef {
  objectId: string;
  objectType?: string | null;
  inputVersion?: string | null;
  outputVersion?: string | null;
  /** The address that held it both before and after. */
  heldBy?: string | null;
}

/**
 * Whether two sides of a kept object were read the same way: their methods
 * agree once checkpoint numbers and the reader's own price notes are set
 * aside, since both sides are priced at one set of prices and the before
 * side is read at the previous checkpoint. The method is then stated once.
 */
function sameReading(after: string, before: string): boolean {
  const norm = (m: string) => m.replace(/checkpoint \d+/g, "checkpoint").replace(/ (Priced by|Provider prices used:) .*$/s, "");
  return norm(after) === norm(before);
}

/**
 * The movements that took a valued object into or out of an address, with
 * the version to value, and the valued objects an address kept while the
 * transaction changed them (a position it added to or drew from). Objects no
 * reader values are left out, and so are kept objects only a broad reader
 * values, whose value a change in place does not move. `specificOnly`
 * leaves out moved objects only a broad reader values (NFT estimates).
 */
export function movedObjects(movements: ObjectMovement[], objects: ChangedObjectRef[], specificOnly = false): MovedObject[] {
  const byId = new Map(objects.map((o) => [normalizeSuiAddress(o.objectId), o]));
  const out: MovedObject[] = [];
  for (const m of movements) {
    if (!m.type || readerFor(m.type, specificOnly) === null) continue;
    const from = FROM_KINDS.includes(m.kind) && m.from?.kind === "address" && m.from.address ? normalizeSuiAddress(m.from.address) : null;
    const to = TO_KINDS.includes(m.kind) && m.to?.kind === "address" && m.to.address ? normalizeSuiAddress(m.to.address) : null;
    if ((!from && !to) || from === to) continue;
    const v = byId.get(normalizeSuiAddress(m.object_id));
    const custody = CUSTODY_KINDS[m.kind];
    // An object whose previous holder went unrecorded is resolved from its
    // input version when there is one; with none it cannot be.
    const prior = m.kind === "appeared" ? (v?.inputVersion ?? null) : null;
    out.push({
      object_id: normalizeSuiAddress(m.object_id),
      type: m.type,
      from,
      to,
      version: (to ? v?.outputVersion : v?.inputVersion) ?? v?.inputVersion ?? null,
      ...(custody ? { custody } : {}),
      ...(prior ? { prior_version: prior } : {}),
      ...(m.kind === "appeared" && !prior ? { custody: "prior_holder_unknown" as const } : {}),
    });
  }
  for (const o of objects) {
    if (!o.heldBy || !o.objectType || !o.inputVersion || !o.outputVersion) continue;
    // A coin's change is a balance change, counted as a coin already.
    if (COIN_OBJECT.test(o.objectType)) continue;
    if (readerFor(o.objectType, true) === null) continue;
    const holder = normalizeSuiAddress(o.heldBy);
    out.push({
      object_id: normalizeSuiAddress(o.objectId),
      type: o.objectType,
      from: holder,
      to: holder,
      version: o.outputVersion,
      before_version: o.inputVersion,
    });
  }
  return out;
}

/** Objects valued per transaction; the rest are listed as unread. */
const MAX_OBJECTS_PER_TX = 50;

interface OneValue {
  protocol: string | null;
  kind: ValuedPosition["kind"] | null;
  usd: number | null;
  assets: ValuedAsset[];
  estimate: boolean;
  tier: ValuedPosition["tier"] | null;
  method: string;
  unpriced_reason?: string;
}

/**
 * The change in a kept position's value with both sides priced at one set of
 * prices: `prices` (USD per raw unit) where given, else each coin's price on
 * the after side, else on the before side. Borrows subtract. Null when a
 * coin with a non-zero amount on either side has no price.
 */
/** Raw amounts per coin a set of legs holds, borrows negative. */
function legAmounts(assets: ValuedAsset[], sign: 1n | -1n, into: Map<string, bigint>): Map<string, bigint> {
  for (const a of assets) {
    if (!/^-?\d+$/.test(a.amount)) continue;
    const raw = BigInt(a.amount) * (a.side === "borrow" ? -1n : 1n) * sign;
    into.set(a.coin_type, (into.get(a.coin_type) ?? 0n) + raw);
  }
  return into;
}

export function keptDelta(after: ValuedAsset[], before: ValuedAsset[], prices: Map<string, number> = new Map()): number | null {
  const unit = new Map(prices);
  for (const legs of [after, before]) {
    for (const a of legs) {
      const raw = Number(a.amount);
      if (!unit.has(a.coin_type) && a.usd !== null && raw > 0) unit.set(a.coin_type, Math.abs(a.usd) / raw);
    }
  }
  let delta = 0;
  for (const [legs, sign] of [
    [after, 1],
    [before, -1],
  ] as const) {
    for (const a of legs) {
      const raw = Number(a.amount);
      if (raw === 0) continue;
      const price = unit.get(a.coin_type);
      if (price === undefined) return null;
      delta += sign * (a.side === "borrow" ? -1 : 1) * raw * price;
    }
  }
  return delta;
}

/**
 * Value moved objects as of `checkpoint`, one row per object a reader
 * valued, priced at `atTime` (Unix seconds) when given and at the
 * checkpoint's time otherwise.
 */
export async function valueMovedObjects(
  moved: MovedObject[],
  checkpoint: string | null,
  atTime?: number,
  memo: Map<string, Promise<unknown>> = new Map(),
  /** Object states already read, keyed `id@version`. */
  known: Map<string, ObjectState> = new Map(),
): Promise<MovedValues> {
  const readVersions = async (keys: Array<{ object_id: string; version: string }>) => {
    const out = new Map<string, ObjectState>();
    const missing = keys.filter((k) => {
      const hit = known.get(`${k.object_id}@${k.version}`);
      if (hit) out.set(`${k.object_id}@${k.version}`, hit);
      return !hit;
    });
    if (missing.length > 0) for (const [k, v] of await readObjectVersions(missing)) out.set(k, v);
    return out;
  };
  const unread: MovedValues["unread"] = [];
  for (const m of moved.slice(MAX_OBJECTS_PER_TX)) {
    unread.push({ what: m.object_id, reason: `past the first ${MAX_OBJECTS_PER_TX} valued objects of this transaction` });
  }
  const readable = moved.slice(0, MAX_OBJECTS_PER_TX).filter((m) => {
    if (m.version !== null) return true;
    unread.push({ what: m.object_id, reason: "the transaction did not record the object's version" });
    return false;
  });
  if (readable.length === 0) return { rows: [], unread };
  const priorStates = await readVersions(
    readable.filter((m) => m.prior_version).map((m) => ({ object_id: m.object_id, version: m.prior_version! })),
  );
  // An object that appeared with no recorded holder: the same address held
  // it before (changed in place), another address did (a transfer), or no
  // address did (it came out of another object), which is only listed.
  for (const m of readable) {
    if (!m.prior_version) continue;
    const owner = priorStates.get(`${m.object_id}@${m.prior_version}`)?.owner;
    const holder = owner?.kind === "address" && owner.address ? normalizeSuiAddress(owner.address) : null;
    if (holder && holder === m.to) {
      m.from = holder;
      m.before_version = m.prior_version;
    } else if (holder) m.from = holder;
    else m.custody = owner?.kind === "object" ? "unwrapped" : "prior_holder_unknown";
  }
  const states = await readVersions(
    readable.flatMap((m) => [
      { object_id: m.object_id, version: m.version! },
      ...(m.before_version ? [{ object_id: m.object_id, version: m.before_version }] : []),
    ]),
  );
  // Null only for a state that could not be read or a reader that listed
  // something unread; a reader that read it and found no position values it
  // at zero (an empty obligation before a first deposit, or after a full
  // withdrawal).
  const valueAt = async (m: MovedObject, version: string, at: string | null): Promise<OneValue | null> => {
    const state = states.get(`${m.object_id}@${version}`);
    if (!state) {
      unread.push({ what: m.object_id, reason: `its state at version ${version} could not be read` });
      return null;
    }
    const ctx = { owner: m.to ?? m.from!, memo, ...(at !== null ? { atCheckpoint: at } : {}), ...(atTime !== undefined ? { atTime } : {}) };
    const r = await valueObjects([{ object_id: m.object_id, type: m.type, json: state.json, version }], ctx);
    unread.push(...r.unread);
    // A position found inside the object (a farm-wrapped CLMM position) is
    // reported under the inner id, with the holder in detail.held_in.
    const heldIn = (p: ValuedPosition) => {
      const id = (p.detail?.held_in as { object_id?: unknown } | undefined)?.object_id;
      return typeof id === "string" && normalizeSuiAddress(id) === m.object_id;
    };
    const own = r.positions.filter((p) => p.object_id === null || normalizeSuiAddress(p.object_id) === m.object_id || heldIn(p));
    if (own.length === 0) {
      return r.unread.length > 0 ? null : { protocol: null, kind: null, usd: 0, assets: [], estimate: false, tier: null, method: `No position at version ${version}.` };
    }
    const priced = own.every((p) => p.usd_net !== null);
    return {
      protocol: own[0].protocol,
      kind: own[0].kind,
      usd: priced ? own.reduce((s, p) => s + p.usd_net!, 0) : null,
      assets: own.flatMap((p) => p.assets),
      estimate: own.some((p) => p.tier === "heuristic"),
      tier: own[0].tier,
      method: own.map((p) => p.method).join(" "),
      ...(priced ? {} : { unpriced_reason: own.map((p) => p.unpriced_reason).filter(Boolean).join(" ") }),
    };
  };
  // A kept position's two sides are priced at one set of prices: the
  // provider's at `atTime` when the caller prices everything at one moment,
  // else the after side's own.
  const keptPrices = async (after: OneValue, before: OneValue): Promise<Map<string, number>> => {
    if (atTime === undefined) return new Map();
    const coins = [...new Set([...after.assets, ...before.assets].map((a) => a.coin_type))];
    const p = await priceCoinTypes(coins, { owner: "", atTime, memo });
    return new Map(
      [...p.points].map(([coin, point]) => [coin, point.price / 10 ** pricingScale(coin, point).decimals] as const),
    );
  };
  const rows: MovedObjectValue[] = [];
  await Promise.all(
    readable.map(async (m) => {
      // A kept object's state before is valued against protocol state as of
      // the previous checkpoint, since its reader may read the protocol's
      // own record of it (a pool's position record) rather than the object.
      const [after, before] = await Promise.all([
        valueAt(m, m.version!, checkpoint),
        m.before_version ? valueAt(m, m.before_version, checkpoint !== null ? String(Number(checkpoint) - 1) : null) : null,
      ]);
      if (!after || (m.before_version && !before)) return;
      const shown = after.kind !== null ? after : before;
      // Nothing on either side, or a moved object with no position, moved nothing.
      if (!shown || shown.kind === null) return;
      const usd = m.before_version ? keptDelta(after.assets, before!.assets, await keptPrices(after, before!)) : after.usd;
      // A kept object whose value did not change moved nothing.
      if (m.before_version && usd !== null && Math.abs(usd) < 0.005) return;
      const priceNote =
        atTime !== undefined
          ? `the provider's prices at ${new Date(atTime * 1000).toISOString()}`
          : "the after side's prices (a coin only before at its own)";
      rows.push({
        object_id: m.object_id,
        type: m.type,
        from: m.from,
        to: m.to,
        protocol: shown.protocol,
        kind: shown.kind,
        usd: usd === null ? null : Number(usd.toFixed(2)),
        ...(m.before_version ? { changed_in_place: true as const, usd_after: after.usd === null ? null : Number(after.usd.toFixed(2)) } : {}),
        ...(m.custody ? { custody: m.custody } : {}),
        estimate: shown.estimate,
        tier: shown.tier!,
        coin_amounts: [...legAmounts(before ? before.assets : [], -1n, legAmounts(after.assets, 1n, new Map()))]
          .filter(([, v]) => v !== 0n)
          .map(([coin_type, v]) => ({ coin_type, amount: v.toString() })),
        method: m.before_version
          ? `Amounts after the transaction minus amounts before (protocol state as of the previous checkpoint), both sides at ${priceNote}. ${
              sameReading(after.method, before!.method) ? `Both sides read as follows. ${after.method}` : `After: ${after.method} Before: ${before!.method}`
            }`
          : after.method,
        ...(usd === null && (after.unpriced_reason || before?.unpriced_reason)
          ? { unpriced_reason: after.unpriced_reason ?? before!.unpriced_reason }
          : {}),
      });
    }),
  );
  rows.sort((a, b) => Math.abs(b.usd ?? 0) - Math.abs(a.usd ?? 0));
  return { rows, unread };
}

/**
 * Objects one scan over many transactions values, newest transactions
 * first: each costs several reads, and the rest are listed as skipped.
 */
export const SCAN_OBJECT_BUDGET = 100;

/** Transactions whose moved objects are read and valued at once. */
const TX_CONCURRENCY = 8;

export interface TransactionObjects {
  digest: string;
  checkpoint: string | null;
  moved: MovedObject[];
}

/**
 * Value the objects each transaction moved, at its own checkpoint, in the
 * order given, for as many transactions as fit `maxTxs` and `maxObjects`
 * (the first transaction always fits); `skipped` lists the rest that moved
 * any. Prices are at `atTime` when given, else at each transaction's time.
 */
export async function valueTransactionObjects(
  txs: TransactionObjects[],
  limits: { maxTxs: number; maxObjects: number },
  atTime?: number,
): Promise<{ rows: Array<MovedObjectValue & { digest: string }>; unread: Array<{ what: string; reason: string; digest: string }>; skipped: string[] }> {
  const withObjects = txs.filter((t) => t.moved.length > 0);
  const valued: TransactionObjects[] = [];
  let objects = 0;
  for (const t of withObjects) {
    if (valued.length >= limits.maxTxs || (valued.length > 0 && objects + t.moved.length > limits.maxObjects)) break;
    valued.push(t);
    objects += t.moved.length;
  }
  const rows: Array<MovedObjectValue & { digest: string }> = [];
  const unread: Array<{ what: string; reason: string; digest: string }> = [];
  const memo = new Map<string, Promise<unknown>>();
  // Every transaction's object versions and checkpoints (and the one before
  // each, for kept objects) in batched reads before any is valued.
  const versionKeys = valued.flatMap((t) =>
    t.moved.flatMap((m) =>
      [m.version, m.before_version, m.prior_version].filter((v): v is string => typeof v === "string").map((version) => ({ object_id: m.object_id, version })),
    ),
  );
  const [known] = await Promise.all([
    versionKeys.length > 0 ? readObjectVersions(versionKeys) : Promise.resolve(new Map<string, ObjectState>()),
    prefetchCheckpoints(valued.flatMap((t) => (t.checkpoint === null ? [] : [t.checkpoint, String(Number(t.checkpoint) - 1)]))),
  ]);
  const keptAt = new Map<string, MovedObjectValue & { digest: string }>();
  for (let i = 0; i < valued.length; i += TX_CONCURRENCY) {
    const results = await Promise.all(valued.slice(i, i + TX_CONCURRENCY).map((t) => valueMovedObjects(t.moved, t.checkpoint, atTime, memo, known)));
    results.forEach((r, j) => {
      const { digest, checkpoint } = valued[i + j];
      for (const row of r.rows) {
        // A kept position valued from protocol state at the checkpoint reads
        // the same whole change in every transaction of that checkpoint: it
        // is counted once, on the first. One valued from its own JSON at each
        // version reads a different change per transaction, and each counts.
        const key =
          row.changed_in_place && checkpoint !== null ? `${row.object_id}@${checkpoint}@${JSON.stringify(row.coin_amounts ?? [])}` : null;
        const first = key ? keptAt.get(key) : undefined;
        if (first) {
          first.same_checkpoint_digests = [...(first.same_checkpoint_digests ?? []), digest];
          continue;
        }
        const out = { ...row, digest };
        if (key) keptAt.set(key, out);
        rows.push(out);
      }
      unread.push(...r.unread.map((u) => ({ ...u, digest })));
    });
  }
  return { rows, unread, skipped: withObjects.slice(valued.length).map((t) => t.digest) };
}

/** An AttackTx-shaped transaction's moved valued objects. */
export function movedObjectsOf(tx: { movements?: ObjectMovement[]; objects?: ChangedObjectRef[] }, specificOnly = false): MovedObject[] {
  return movedObjects(tx.movements ?? [], tx.objects ?? [], specificOnly);
}

/** Transactions read per gRPC batch for their changed objects. */
const CHANGES_BATCH = 25;
const CHANGES_MASK = { paths: ["digest", "checkpoint", "effects.changed_objects"] };
/** `sui.rpc.v2.ChangedObject` input and output states that carry a version. */
const INPUT_EXISTS = 2;
const OUTPUT_OBJECT_WRITE = 2;
/** `sui.rpc.v2.Owner.OwnerKind` for an address. */
const OWNER_ADDRESS = 1;

async function batchChanges(client: SuiGrpcClient, digests: string[], found: Map<string, GrpcTypes.ExecutedTransaction>): Promise<void> {
  try {
    const { response } = await client.ledgerService.batchGetTransactions({ digests, readMask: CHANGES_MASK });
    response.transactions.forEach((r, i) => {
      if (r.result.oneofKind === "transaction") found.set(digests[i], r.result.transaction);
    });
  } catch {
    // A batch the service refuses whole is read one at a time.
    for (const digest of digests) {
      try {
        const { response } = await client.ledgerService.getTransaction({ digest, readMask: CHANGES_MASK });
        if (response.transaction) found.set(digest, response.transaction);
      } catch {
        // Pruned or unknown here; the archive is tried next.
      }
    }
  }
}

/**
 * The valued objects each transaction moved into or out of an address, read
 * from its changed objects by digest: the fullnode first, the archive for
 * what it pruned. `unread` lists digests neither returned.
 */
export async function readMovedObjects(digests: string[], specificOnly = false): Promise<{ txs: TransactionObjects[]; unread: string[] }> {
  const found = new Map<string, GrpcTypes.ExecutedTransaction>();
  for (let i = 0; i < digests.length; i += CHANGES_BATCH) await batchChanges(sui, digests.slice(i, i + CHANGES_BATCH), found);
  const pruned = digests.filter((d) => !found.has(d));
  if (pruned.length > 0 && getNetworkConfig().archive !== null) {
    for (let i = 0; i < pruned.length; i += CHANGES_BATCH) await batchChanges(archive, pruned.slice(i, i + CHANGES_BATCH), found);
  }
  const txs: TransactionObjects[] = [];
  for (const digest of digests) {
    const t = found.get(digest);
    if (!t) continue;
    const changed = t.effects?.changedObjects ?? [];
    txs.push({
      digest,
      checkpoint: t.checkpoint !== undefined ? t.checkpoint.toString() : null,
      moved: movedObjectsOf({
        movements: readGrpcObjectChanges(changed),
        objects: changed.map((o) => ({
          objectId: o.objectId ?? "",
          objectType: o.objectType ?? null,
          inputVersion: o.inputState === INPUT_EXISTS && o.inputVersion !== undefined ? o.inputVersion.toString() : null,
          outputVersion: o.outputState === OUTPUT_OBJECT_WRITE && o.outputVersion !== undefined ? o.outputVersion.toString() : null,
          heldBy:
            o.inputOwner?.kind === OWNER_ADDRESS && o.outputOwner?.kind === OWNER_ADDRESS && o.inputOwner.address === o.outputOwner.address
              ? (o.inputOwner.address ?? null)
              : null,
        })),
      }, specificOnly),
    });
  }
  return { txs, unread: digests.filter((d) => !found.has(d)) };
}

export interface AddressObjectValue {
  /** Priced value of objects it received minus those it gave up, plus changes in objects it kept; estimates excluded. */
  usd_net: number;
  /** Priced value of objects it received and increases in objects it kept; estimates excluded. */
  usd_gained: number;
  /** Heuristic estimates (NFTs) received minus given up, kept apart. */
  estimate_usd_net: number;
  gained: MovedObjectValue[];
  lost: MovedObjectValue[];
  /** Objects it kept whose value the transaction changed; each row's usd is the signed change. */
  changed: MovedObjectValue[];
  /** Objects it wrapped, unwrapped or received from an unknown holder: listed, not counted. */
  custody: MovedObjectValue[];
  /** Objects it received, gave up or kept changed that have no price. */
  unpriced: number;
}

/** What each address gained and lost in valued objects. */
export function objectValueByAddress(rows: MovedObjectValue[]): Map<string, AddressObjectValue> {
  const by = new Map<string, AddressObjectValue>();
  const entry = (address: string) => {
    let e = by.get(address);
    if (!e) {
      e = { usd_net: 0, usd_gained: 0, estimate_usd_net: 0, gained: [], lost: [], changed: [], custody: [], unpriced: 0 };
      by.set(address, e);
    }
    return e;
  };
  for (const row of rows) {
    if (row.custody) {
      entry((row.to ?? row.from)!).custody.push(row);
      continue;
    }
    if (row.changed_in_place) {
      const e = entry(row.to!);
      e.changed.push(row);
      if (row.usd === null) e.unpriced++;
      else if (row.estimate) e.estimate_usd_net += row.usd;
      else {
        e.usd_net += row.usd;
        if (row.usd > 0) e.usd_gained += row.usd;
      }
      continue;
    }
    for (const [address, sign] of [
      [row.to, 1],
      [row.from, -1],
    ] as const) {
      if (!address) continue;
      const e = entry(address);
      (sign > 0 ? e.gained : e.lost).push(row);
      if (row.usd === null) e.unpriced++;
      else if (row.estimate) e.estimate_usd_net += sign * row.usd;
      else {
        e.usd_net += sign * row.usd;
        if (sign > 0) e.usd_gained += row.usd;
      }
    }
  }
  for (const e of by.values()) {
    e.usd_net = Number(e.usd_net.toFixed(2));
    e.usd_gained = Number(e.usd_gained.toFixed(2));
    e.estimate_usd_net = Number(e.estimate_usd_net.toFixed(2));
  }
  return by;
}
