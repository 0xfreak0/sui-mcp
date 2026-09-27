/**
 * Read the objects a transaction changed at its input and output versions,
 * with the field layout that says which fields are `Balance<T>` and
 * `Supply<T>`, for `state-delta.ts`.
 *
 * Five kinds of object are read, chosen from the effects before any read:
 * shared objects the transaction changed, dynamic fields whose value keeps a
 * `Balance<T>` or a `Supply<T>` (a vault's or a pool's coin holdings, by the
 * value type's layout), other objects owned by an object (a pool kept as a
 * dynamic object field), objects the transaction created, and
 * `TreasuryCap<T>`s it changed (a mint). Everything else it changed (tick
 * and order-book entries, per-user table rows, coins) holds no coin or is a
 * coin, and is not read.
 *
 * Reads are bounded per kind. Shared objects past {@link MAX_SHARED_READ}
 * are cut, the smallest first, by the storage rebate their output version
 * carries (a measure of their size). Every cut candidate is reported, and
 * a type whose layout could not be read in full is named in `layout_unread`.
 */

import type { GrpcTypes, SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { sui, archive } from "../clients/grpc.js";
import { getNetworkConfig } from "../config.js";
import { protoValueToJson } from "./proto.js";
import { typeArgsOf, type AttackObject, type AttackTx } from "./attack-analysis.js";
import type { ObjectState, StateSnapshot } from "./state-delta.js";

/** Shared objects read at both versions, per transaction. */
export const MAX_SHARED_READ = 24;
/** Coin-holding dynamic fields, and created objects or treasury caps, read per transaction. */
const MAX_HOLDINGS_READ = 48;
const MAX_CREATED_READ = 12;
/** Requests per `batchGetObjects` call. */
const OBJECT_BATCH = 50;
/** Nesting depth the layout reader follows into struct fields. */
const LAYOUT_DEPTH = 2;

const READ_MASK = { paths: ["object_id", "version", "object_type", "json", "storage_rebate"] };
/** Enough to rank shared objects by size before reading any JSON. */
const REBATE_MASK = { paths: ["object_id", "version", "storage_rebate"] };

const DYNAMIC_FIELD = /^0x0*2::dynamic_field::Field</;
/** Distinct dynamic-field value types whose layout is read, per transaction. */
const MAX_VALUE_TYPES = 32;
/**
 * Object-owned objects that are not dynamic fields, read per transaction:
 * the same bound as coin-holding fields, since a router touching many pools
 * kept as dynamic object fields changes each pool and its escrow as two
 * such objects.
 */
const MAX_CHILDREN_READ = 48;
const COIN = /^0x0*2::coin::Coin</;
const TREASURY_CAP = /^0x0*2::coin::TreasuryCap</;

/** Framework singletons below 0x10000 (Clock, Random, the system state, the deny list). */
const isSystemObject = (id: string) => /^0x0{60}/.test(normalizeSuiAddress(id));

type Req = { objectId: string; version: bigint };
type Got = Map<string, GrpcTypes.Object>;
type Mask = { paths: string[] };
const key = (id: string, v: bigint | string) => `${normalizeSuiAddress(id)}@${v}`;

async function batchOnce(client: SuiGrpcClient, reqs: Req[], got: Got, readMask: Mask): Promise<void> {
  for (let i = 0; i < reqs.length; i += OBJECT_BATCH) {
    const chunk = reqs.slice(i, i + OBJECT_BATCH);
    try {
      const { response } = await client.ledgerService.batchGetObjects({ requests: chunk, readMask });
      response.objects.forEach((r, j) => {
        if (r.result.oneofKind === "object") got.set(key(chunk[j].objectId, chunk[j].version), r.result.object);
      });
    } catch {
      // A failed batch leaves its objects unread; the archive pass or the
      // caller's `unavailable` list covers them.
    }
  }
}

/** Objects at exact versions, fullnode first and the archive for what it pruned. */
async function readVersions(reqs: Req[], readMask: Mask = READ_MASK): Promise<Got> {
  const got: Got = new Map();
  await batchOnce(sui, reqs, got, readMask);
  const missing = reqs.filter((r) => !got.has(key(r.objectId, r.version)));
  if (missing.length && getNetworkConfig().archive !== null) await batchOnce(archive, missing, got, readMask);
  return got;
}

/** gRPC `OpenSignatureBody.type` values used here. */
const SIG_VECTOR = 9;
const SIG_DATATYPE = 10;
const SIG_TYPE_PARAMETER = 11;
const SIG_PRIMITIVES: Record<number, string> = { 1: "address", 2: "bool", 3: "u8", 4: "u16", 5: "u32", 6: "u64", 7: "u128", 8: "u256" };

function renderSig(sig: GrpcTypes.OpenSignatureBody | undefined, args: string[]): string {
  if (!sig) return "?";
  if (sig.type === SIG_TYPE_PARAMETER) return args[sig.typeParameter ?? -1] ?? "?";
  if (sig.type === SIG_VECTOR) return `vector<${renderSig(sig.typeParameterInstantiation[0], args)}>`;
  if (sig.type === SIG_DATATYPE) {
    const inst = sig.typeParameterInstantiation.map((s) => renderSig(s, args));
    return `${sig.typeName ?? "?"}${inst.length ? `<${inst.join(", ")}>` : ""}`;
  }
  return SIG_PRIMITIVES[sig.type ?? 0] ?? "?";
}

/** JSON paths of a struct's `Balance<T>` values and `Supply<T>` totals, each to its canonical `T`. */
export interface CoinLayout {
  balances: Record<string, string>;
  supplies: Record<string, string>;
}

/** A layout, and whether every nested struct it follows was read. */
export interface LayoutRead {
  layout: CoinLayout;
  complete: boolean;
}

const BALANCE = normalizeStructTag("0x2::balance::Balance");
const SUPPLY = normalizeStructTag("0x2::balance::Supply");
/** Framework structs followed into: they hold a balance or a supply. Other framework types are containers (Table, Bag, VecMap) or hold neither. */
const FOLLOWED = new Set([normalizeStructTag("0x2::coin::Coin"), normalizeStructTag("0x2::coin::TreasuryCap")]);

const layoutCache = new Map<string, Promise<LayoutRead | null>>();

/**
 * Where a struct keeps coins: its `Balance<T>` fields and its `Supply<T>`
 * fields (a `Supply` renders as `{ value }`), following nested structs
 * {@link LAYOUT_DEPTH} levels below `depth`. Null when the struct itself
 * cannot be read; `complete` is false when a nested struct could not be.
 * Only a complete read is cached, per type and depth: a layout never
 * changes, but a failed read has to be retried and a shallower read is
 * not a deeper one.
 */
export function coinLayout(type: string, depth = 0): Promise<LayoutRead | null> {
  const k = `${depth} ${type}`;
  let hit = layoutCache.get(k);
  if (!hit) {
    hit = readCoinLayout(type, depth).catch(() => null);
    layoutCache.set(k, hit);
    void hit.then((r) => {
      if (!r?.complete) layoutCache.delete(k);
    });
  }
  return hit;
}

async function readCoinLayout(type: string, depth: number): Promise<LayoutRead | null> {
  const [pkg, moduleName, nameWithArgs] = type.split("::");
  const name = nameWithArgs?.split("<")[0];
  if (!pkg || !moduleName || !name) return null;
  const { response } = await sui.movePackageService.getDatatype({ packageId: pkg, moduleName, name });
  const fields = response.datatype?.fields ?? [];
  const args = typeArgsOf(type);
  const layout: CoinLayout = { balances: {}, supplies: {} };
  const nested: Array<{ field: string; read: Promise<LayoutRead | null> }> = [];
  for (const f of fields) {
    const sig = f.type;
    if (!f.name || sig?.type !== SIG_DATATYPE || !sig.typeName) continue;
    const base = normalizeStructTag(sig.typeName);
    if (base === BALANCE || base === SUPPLY) {
      const coin = normalizeStructTag(renderSig(sig.typeParameterInstantiation[0], args));
      if (base === BALANCE) layout.balances[f.name] = coin;
      else layout.supplies[`${f.name}.value`] = coin;
      continue;
    }
    if (depth >= LAYOUT_DEPTH || (/^0x0*[12]::/.test(base) && !FOLLOWED.has(base))) continue;
    nested.push({ field: f.name, read: coinLayout(renderSig(sig, args), depth + 1) });
  }
  let complete = true;
  for (const { field, read } of nested) {
    const r = await read;
    if (!r?.complete) complete = false;
    for (const [p, coin] of Object.entries(r?.layout.balances ?? {})) layout.balances[`${field}.${p}`] = coin;
    for (const [p, coin] of Object.entries(r?.layout.supplies ?? {})) layout.supplies[`${field}.${p}`] = coin;
  }
  return { layout, complete };
}

/**
 * Where a dynamic field's value keeps coins, as paths under the field's
 * `value`: the value itself when it is a `Balance<T>`, or the value
 * struct's balance and supply fields. An empty complete layout for a value
 * of a primitive or container type, which holds no coin; null when the
 * value struct could not be read.
 */
async function fieldValueLayout(fieldType: string): Promise<LayoutRead | null> {
  const none: LayoutRead = { layout: { balances: {}, supplies: {} }, complete: true };
  const value = typeArgsOf(fieldType)[1];
  if (!value || !/^0x[0-9a-fA-F]+::/.test(value)) return none;
  const base = normalizeStructTag(value.split("<")[0]);
  if (base === BALANCE) return { layout: { balances: { value: normalizeStructTag(typeArgsOf(value)[0] ?? "") }, supplies: {} }, complete: true };
  if (/^0x0*[12]::/.test(base) && !FOLLOWED.has(base)) return none;
  const inner = await coinLayout(value, 1);
  if (!inner) return null;
  const prefix = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).map(([p, c]) => [`value.${p}`, c]));
  return { layout: { balances: prefix(inner.layout.balances), supplies: prefix(inner.layout.supplies) }, complete: inner.complete };
}

const keepsCoin = (l: CoinLayout) => Object.keys(l.balances).length + Object.keys(l.supplies).length > 0;

/**
 * Read the state candidates of one transaction. Shared objects are ranked
 * largest first by the storage rebate of their output version, read with no
 * JSON, and the first {@link MAX_SHARED_READ} are read in full at both
 * versions. Every candidate left unread is listed in `skipped`.
 */
export async function readObjectStates(tx: Pick<AttackTx, "objects">): Promise<StateSnapshot> {
  const seen = new Set<string>();
  const unique = tx.objects.filter((o) => {
    const id = o.objectId ? normalizeSuiAddress(o.objectId) : "";
    if (!id || seen.has(id) || isSystemObject(id)) return false;
    seen.add(id);
    return true;
  });
  const skipped: StateSnapshot["skipped"] = [];
  const cut = (list: AttackObject[], max: number, role: ObjectState["role"]) => {
    for (const o of list.slice(max)) skipped.push({ object_id: o.objectId, object_type: o.objectType, role });
    return list.slice(0, max);
  };
  const layoutUnread = new Set<string>();

  const shared = unique.filter((o) => o.shared && o.inputVersion && o.outputVersion);
  // A dynamic field is a holding when its value type keeps a balance or a
  // supply; the layouts are read per distinct type, before any object.
  const fields = unique.filter((o) => o.parent && o.objectType && DYNAMIC_FIELD.test(o.objectType));
  const allFieldTypes = [...new Set(fields.map((o) => o.objectType!))];
  const fieldTypes = allFieldTypes.slice(0, MAX_VALUE_TYPES);
  for (const o of fields) if (!fieldTypes.includes(o.objectType!)) skipped.push({ object_id: o.objectId, object_type: o.objectType, role: "holding" });
  const fieldLayouts = new Map(await Promise.all(fieldTypes.map(async (t) => [t, await fieldValueLayout(t)] as const)));
  for (const [t, r] of fieldLayouts) if (!r?.complete) layoutUnread.add(t);
  // A field whose value type could not be read may hold coins: listed, not read.
  for (const o of fields) if (fieldLayouts.get(o.objectType!) === null) skipped.push({ object_id: o.objectId, object_type: o.objectType, role: "holding" });
  const holdings = fields.filter((o) => {
    const r = fieldLayouts.get(o.objectType!);
    return r != null && keepsCoin(r.layout);
  });
  const holdingsRead = cut(holdings, MAX_HOLDINGS_READ, "holding");
  // An object another object owns that is not a dynamic field: a pool or a
  // vault kept as a dynamic object field, or a position in a table.
  const children = unique.filter((o) => o.parent && !o.shared && o.objectType && !DYNAMIC_FIELD.test(o.objectType) && !COIN.test(o.objectType) && o.inputVersion && o.outputVersion);
  const childrenRead = cut(children, MAX_CHILDREN_READ, "child");
  const created = unique.filter((o) => !o.shared && !o.parent && !o.inputVersion && o.outputVersion && o.objectType && !COIN.test(o.objectType));
  const createdRead = cut(created, MAX_CREATED_READ, "created");
  // A treasury cap held by an address mints outside any shared object.
  const treasuries = unique.filter((o) => !o.shared && !o.parent && o.inputVersion && o.outputVersion && o.objectType && TREASURY_CAP.test(o.objectType));
  const treasuriesRead = cut(treasuries, MAX_CREATED_READ, "supply");

  const outputReq = (o: AttackObject) => ({ objectId: o.objectId, version: BigInt(o.outputVersion!) });
  const inputReq = (o: AttackObject) => ({ objectId: o.objectId, version: BigInt(o.inputVersion!) });
  let sharedRead = shared;
  if (shared.length > MAX_SHARED_READ) {
    const sizes = await readVersions(shared.map(outputReq), REBATE_MASK);
    const rebate = (o: AttackObject) => sizes.get(key(o.objectId, o.outputVersion!))?.storageRebate ?? 0n;
    sharedRead = cut([...shared].sort((a, b) => (rebate(b) > rebate(a) ? 1 : rebate(b) < rebate(a) ? -1 : 0)), MAX_SHARED_READ, "shared");
  }

  const whole = [...sharedRead, ...childrenRead, ...treasuriesRead];
  const [after, before] = await Promise.all([
    readVersions([...whole, ...holdingsRead, ...createdRead].filter((o) => o.outputVersion).map(outputReq)),
    readVersions([...whole, ...holdingsRead.filter((o) => o.inputVersion)].map(inputReq)),
  ]);
  // Every distinct type's layout at once; a type read before is cached.
  const types = [...new Set([...whole, ...createdRead].map((o) => o.objectType).filter((t): t is string => t !== null))];
  const layouts = new Map(await Promise.all(types.map(async (t) => [t, await coinLayout(t)] as const)));
  for (const [t, r] of layouts) if (!r?.complete) layoutUnread.add(t);

  const unavailable: string[] = [];
  const json = (got: Got, o: AttackObject, v: string | null | undefined): unknown | undefined => {
    if (!v) return null;
    const obj = got.get(key(o.objectId, v));
    return obj ? (protoValueToJson(obj.json) ?? null) : undefined;
  };
  const objects: ObjectState[] = [];
  const push = (o: AttackObject, role: ObjectState["role"]) => {
    const b = role === "created" ? null : json(before, o, o.inputVersion);
    const a = json(after, o, o.outputVersion);
    if (b === undefined || a === undefined) {
      unavailable.push(o.objectId);
      return;
    }
    const read = role === "holding" ? fieldLayouts.get(o.objectType ?? "") : o.objectType ? layouts.get(o.objectType) : null;
    const layout = read?.layout ?? { balances: {}, supplies: {} };
    objects.push({ objectId: o.objectId, objectType: o.objectType, role, parent: o.parent ?? null, before: b, after: a, ...layout });
  };
  for (const o of sharedRead) push(o, "shared");
  for (const o of childrenRead) push(o, "child");
  for (const o of holdingsRead) push(o, "holding");
  for (const o of createdRead) push(o, "created");
  for (const o of treasuriesRead) push(o, "supply");
  return { objects, skipped, unavailable, layout_unread: [...layoutUnread] };
}
