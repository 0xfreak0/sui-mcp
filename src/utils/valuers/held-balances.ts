/**
 * Balances held inside an object no specific reader values: its
 * `Balance<T>` and `Coin<T>` fields, the entries of a `Table`,
 * `ObjectTable`, `Bag`, `ObjectBag` or `LinkedTable` it holds (or is), and
 * a position another reader values that it wraps, read to a bounded depth.
 * The amounts are read from chain; each coin is priced as a wallet coin is.
 *
 * The reader is a fallback tried before the NFT reader, so an object whose
 * fields hold value is valued by what they hold. Whether a type holds value
 * is a property of its field layout, which `prepare` reads (a layout never
 * changes, so it is cached for good); `handles` answers from that cache.
 *
 * Listing an owner's holdings, it skips coins (the wallet's balances) and
 * types a specific reader owns, so nothing is valued twice, and it also
 * reads the dynamic fields of a bounded number of the other objects, where
 * a vault keeps its balances keyed by coin type.
 */

import { normalizeStructTag } from "@mysten/sui/utils";
import { gqlQuery } from "../../clients/graphql.js";
import { normalizeCoinType } from "../coin-registry.js";
import { ownedObjectsWalk, OWNED_WALK_MAX, type OwnedObjectJson } from "../owned-objects.js";
import {
  readerFor,
  registerValuer,
  valueObjects,
  type ObjectToValue,
  type ValuationContext,
  type ValuedPosition,
  type ValuerResult,
} from "../position-value.js";
import { assemblePosition, bigField, priceCoinTypes, stateNote, type Leg } from "./common.js";
import { typeArgs } from "./lending.js";

export const HELD_BALANCES = "held_balances";

/** Struct levels followed below an object's root. */
const MAX_FIELD_DEPTH = 6;
/** Elements of one vector walked. */
const MAX_VECTOR_ITEMS = 64;
/** Container levels followed: a table an object holds, and a table inside one of its entries. */
const MAX_CONTAINER_DEPTH = 2;
/** Entries read per container; past it the value is a floor and says so. */
const MAX_ENTRIES = 200;
/** Containers read per object, its own dynamic fields included. */
const MAX_CONTAINERS = 8;
/** Owned objects whose layout holds nothing but whose own dynamic fields are read, per call, one per type first. */
const MAX_FIELD_PROBES = 30;
/** Dynamic fields asked for per object when many objects' fields are read in one request. */
const PROBE_FIELDS = 10;
/** Objects whose fields one request reads: the service rejects a query of over 300 nodes, and one object's take 19. */
const PROBES_PER_REQUEST = 15;
/** GraphQL's largest page. */
const GQL_PAGE = 50;
/** Bytes of query and variables one batched request may take; the service caps a request at 5,000. */
const REQUEST_BYTES = 4_500;

const BALANCE = /^0x0*2::balance::Balance</;
const COIN = /^0x0*2::coin::Coin</;
const OPTION = /^0x0*1::option::Option</;
const FRAMEWORK = /^0x0*[123]::/;
const SUI_FRAMEWORK = `0x${"0".repeat(63)}2`;
const CONTAINERS: Array<[RegExp, ContainerKind]> = [
  [/^0x0*2::table::Table</, "table"],
  [/^0x0*2::object_table::ObjectTable</, "object_table"],
  [/^0x0*2::linked_table::LinkedTable</, "linked_table"],
  [/^0x0*2::bag::Bag$/, "bag"],
  [/^0x0*2::object_bag::ObjectBag$/, "object_bag"],
];

type ContainerKind = "table" | "object_table" | "linked_table" | "bag" | "object_bag" | "fields";

type Layout =
  | string
  | { vector: Layout }
  | { struct: { type: string; fields: Array<{ name: string; layout: Layout }> } }
  | { enum: { type?: string; variants: Array<{ name: string; layout: Array<{ name: string; layout: Layout }> }> } };

const keyOf = (type: string): string => {
  try {
    return normalizeStructTag(type);
  } catch {
    return type;
  }
};
const isStruct = (type: string): boolean => /^0x[0-9a-fA-F]+::/.test(type);
const containerKind = (type: string): ContainerKind | null => CONTAINERS.find(([re]) => re.test(type))?.[1] ?? null;
/** The value type a keyed container holds; null for a bag, whose values differ. */
const containerValueType = (type: string): string | null => {
  const kind = containerKind(type);
  return kind === "table" || kind === "object_table" || kind === "linked_table" ? (typeArgs(type)[1] ?? null) : null;
};
const coinOf = (balanceOrCoin: string): string => {
  const t = typeArgs(balanceOrCoin)[0] ?? "";
  return normalizeCoinType(t) ?? t;
};
/** A struct another reader values as a position of its own, followed when wrapped. */
const nestedReader = (type: string): boolean => !COIN.test(type) && readerFor(type, true) !== null;

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

/** Read layouts by type; null for a type the service could not give. */
const layouts = new Map<string, Layout | null>();
const layoutReads = new Map<string, Promise<void>>();
const holdsCache = new Map<string, boolean>();

async function readLayoutBatch(types: string[]): Promise<void> {
  const decl = types.map((_, i) => `$t${i}: String!`).join(", ");
  const body = types.map((_, i) => `t${i}: type(type: $t${i}) { layout }`).join(" ");
  const vars = Object.fromEntries(types.map((t, i) => [`t${i}`, t]));
  try {
    const d = await gqlQuery<Record<string, { layout: Layout | null } | null>>(`query(${decl}) { ${body} }`, vars);
    types.forEach((t, i) => layouts.set(t, d[`t${i}`]?.layout ?? null));
  } catch {
    // One unreadable type fails the whole request, so each is then asked
    // alone. A type whose own request fails stays unread, to be asked again
    // by the next call, and holds nothing as far as this one knows.
    if (types.length > 1) await Promise.all(types.map((t) => readLayoutBatch([t])));
  }
}

/**
 * Split keys into batches whose request, at `bytes(key)` each plus `base`,
 * stays under {@link REQUEST_BYTES}.
 */
function batchesOf(keys: string[], base: number, bytes: (key: string) => number): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = base;
  for (const k of keys) {
    const add = bytes(k);
    if (batch.length > 0 && size + add > REQUEST_BYTES) {
      batches.push(batch);
      batch = [];
      size = base;
    }
    batch.push(k);
    size += add;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function readLayouts(types: string[]): Promise<void> {
  const missing = [...new Set(types)].filter((t) => !layouts.has(t) && !layoutReads.has(t));
  // Per type: its variable (the type, quoted, and its name), its declaration and its aliased field.
  for (const b of batchesOf(missing, 40, (t) => Buffer.byteLength(JSON.stringify(t)) + 60)) {
    const read = readLayoutBatch(b).finally(() => {
      for (const t of b) layoutReads.delete(t);
    });
    for (const t of b) layoutReads.set(t, read);
  }
  return Promise.all([...new Set(types)].map((t) => layoutReads.get(t))).then(() => undefined);
}

/** Struct types a layout names as a keyed container's values, whose own layout decides whether the container is worth reading. */
function containerValueTypes(layout: Layout | null | undefined, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (!layout || typeof layout === "string" || depth > MAX_FIELD_DEPTH) return out;
  if ("vector" in layout) return containerValueTypes(layout.vector, out, depth);
  if ("enum" in layout) {
    for (const v of layout.enum.variants) for (const f of v.layout) containerValueTypes(f.layout, out, depth + 1);
    return out;
  }
  const type = layout.struct.type;
  if (containerKind(type)) {
    const value = containerValueType(type);
    if (value && isStruct(value) && !BALANCE.test(value) && !COIN.test(value)) out.add(keyOf(value));
    return out;
  }
  for (const f of layout.struct.fields) containerValueTypes(f.layout, out, depth + 1);
  return out;
}

/**
 * Read what `handles` needs for these types: each one's layout, and the
 * layout of the values its containers hold, container levels deep.
 */
export async function prepareHeldTypes(types: string[]): Promise<void> {
  let wanted = [...new Set(types.filter(isStruct).map(keyOf))].filter((t) => !layouts.has(t));
  for (let level = 0; level <= MAX_CONTAINER_DEPTH && wanted.length > 0; level++) {
    await readLayouts(wanted);
    const next = new Set<string>();
    for (const t of wanted) containerValueTypes(layouts.get(t), next);
    wanted = [...next].filter((t) => !layouts.has(t));
  }
}

function layoutHolds(layout: Layout, depth: number, seen: Set<string>): boolean {
  if (typeof layout === "string") return false;
  if ("vector" in layout) return layoutHolds(layout.vector, depth, seen);
  if ("enum" in layout) return layout.enum.variants.some((v) => v.layout.some((f) => layoutHolds(f.layout, depth + 1, seen)));
  const type = layout.struct.type;
  if (BALANCE.test(type)) return true;
  if (containerKind(type)) return containerMayHold(type, seen);
  if (depth > 0 && nestedReader(type)) return true;
  if (depth >= MAX_FIELD_DEPTH) return false;
  return layout.struct.fields.some((f) => layoutHolds(f.layout, depth + 1, seen));
}

function containerMayHold(type: string, seen: Set<string>): boolean {
  const kind = containerKind(type);
  if (kind === "bag" || kind === "object_bag") return true;
  const value = containerValueType(type);
  if (!value || !isStruct(value)) return false;
  if (BALANCE.test(value) || COIN.test(value) || nestedReader(value)) return true;
  const k = keyOf(value);
  if (seen.has(k)) return false;
  const layout = layouts.get(k);
  // An unread value layout leaves reading the container as the only way to know.
  if (!layout) return true;
  return layoutHolds(layout, 1, new Set([...seen, k]));
}

/** Whether a type's fields can hold value; undefined before its layout is read. */
function holds(type: string): boolean | undefined {
  const k = keyOf(type);
  const cached = holdsCache.get(k);
  if (cached !== undefined) return cached;
  const layout = layouts.get(k);
  if (layout === undefined) return undefined;
  const answer = layout !== null && layoutHolds(layout, 0, new Set([k]));
  holdsCache.set(k, answer);
  return answer;
}

// ---------------------------------------------------------------------------
// Walking an object
// ---------------------------------------------------------------------------

interface Container {
  id: string;
  kind: ContainerKind;
  type: string;
  path: string;
  level: number;
  /** Its entries, when a batched read already has them all. */
  preread?: EntriesRead;
}

interface EntriesRead {
  entries: Entry[];
  complete: boolean;
}

interface Found {
  legs: Map<string, bigint>;
  /** Whether a leg came from the object's own fields rather than a container's entries. */
  fields: boolean;
  where: Array<{ coin_type: string; amount: string; in: string }>;
  containers: Container[];
  nested: Array<ObjectToValue & { path: string }>;
  read: Array<{ id: string; kind: ContainerKind; entries_read: number; complete: boolean }>;
  /** Parts left unread: vector elements, struct levels, containers past a bound. */
  cut: string[];
}

function addLeg(found: Found, coin: string, amount: bigint, where: string): void {
  found.legs.set(coin, (found.legs.get(coin) ?? 0n) + amount);
  if (amount > 0n && found.where.length < 20) found.where.push({ coin_type: coin, amount: amount.toString(), in: where });
}

function walk(layout: Layout, json: unknown, path: string, depth: number, level: number, found: Found): void {
  if (typeof layout === "string" || json === null || json === undefined) return;
  if ("vector" in layout) {
    if (!Array.isArray(json)) return;
    json.slice(0, MAX_VECTOR_ITEMS).forEach((item, i) => walk(layout.vector, item, `${path}[${i}]`, depth, level, found));
    if (json.length > MAX_VECTOR_ITEMS) found.cut.push(`${json.length - MAX_VECTOR_ITEMS} elements of ${path} past the first ${MAX_VECTOR_ITEMS}`);
    return;
  }
  if ("enum" in layout) {
    const name = (json as Record<string, unknown>)["@variant"];
    const variant = layout.enum.variants.find((v) => v.name === name);
    for (const f of variant?.layout ?? []) walk(f.layout, (json as Record<string, unknown>)[f.name], `${path}.${f.name}`, depth + 1, level, found);
    return;
  }
  const { type, fields } = layout.struct;
  if (BALANCE.test(type)) {
    const amount = bigField(json) ?? bigField((json as Record<string, unknown>).value);
    if (amount !== null) {
      addLeg(found, coinOf(type), amount, path || "the object");
      if (level === 0) found.fields = true;
    }
    return;
  }
  if (OPTION.test(type)) {
    // An Option renders as its value, or null when empty.
    const inner = fields[0]?.layout;
    if (inner && typeof inner === "object" && "vector" in inner) walk(inner.vector, json, path, depth, level, found);
    return;
  }
  const kind = containerKind(type);
  if (kind) {
    const id = (json as Record<string, unknown>).id;
    if (typeof id === "string" && containerMayHold(type, new Set())) found.containers.push({ id, kind, type, path, level: level + 1 });
    return;
  }
  const id = (json as Record<string, unknown>).id;
  if (depth > 0 && nestedReader(type) && typeof id === "string") {
    found.nested.push({ object_id: id, type, json: json as Record<string, unknown>, path });
    return;
  }
  if (depth >= MAX_FIELD_DEPTH) {
    found.cut.push(`fields of ${path} below ${MAX_FIELD_DEPTH} levels`);
    return;
  }
  for (const f of fields) walk(f.layout, (json as Record<string, unknown>)[f.name], path ? `${path}.${f.name}` : f.name, depth + 1, level, found);
}

interface Entry {
  type: string;
  json: unknown;
  object_id: string | null;
}

interface EntriesPage {
  address: {
    dynamicFields: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        value:
          | { __typename: "MoveValue"; type: { repr: string }; json: unknown }
          | { __typename: "MoveObject"; address: string; contents: { type: { repr: string }; json: unknown } | null }
          | null;
      }>;
    } | null;
  } | null;
}

type FieldPage = NonNullable<NonNullable<EntriesPage["address"]>["dynamicFields"]>;

const FIELD_PAGE = `fragment F on DynamicFieldConnection {
  pageInfo { hasNextPage endCursor }
  nodes { value { __typename ... on MoveValue { type { repr } json } ... on MoveObject { address contents { type { repr } json } } } }
}`;

const ENTRIES_QUERY = `${FIELD_PAGE}
query($id: SuiAddress!, $after: String, $cp: UInt53) {
  address(address: $id, atCheckpoint: $cp) { dynamicFields(first: ${GQL_PAGE}, after: $after) { ...F } }
}`;

function pageEntries(conn: FieldPage, entries: Entry[]): void {
  for (const n of conn.nodes) {
    const v = n.value;
    if (!v) continue;
    if (v.__typename === "MoveValue") entries.push({ type: v.type.repr, json: v.json, object_id: null });
    else if (v.contents) entries.push({ type: v.contents.type.repr, json: v.contents.json, object_id: v.address });
  }
}

/** A container's entries (or an object's own dynamic fields), up to {@link MAX_ENTRIES}. */
async function readEntries(id: string, ctx: ValuationContext): Promise<EntriesRead> {
  const entries: Entry[] = [];
  let after: string | null = null;
  for (;;) {
    const d: EntriesPage = await gqlQuery<EntriesPage>(ENTRIES_QUERY, { id, after, cp: ctx.atCheckpoint === undefined ? null : Number(ctx.atCheckpoint) });
    const conn = d.address?.dynamicFields;
    if (!conn) return { entries, complete: true };
    pageEntries(conn, entries);
    if (!conn.pageInfo.hasNextPage) return { entries, complete: true };
    if (!conn.pageInfo.endCursor || entries.length >= MAX_ENTRIES) return { entries, complete: false };
    after = conn.pageInfo.endCursor;
  }
}

/**
 * The first {@link PROBE_FIELDS} dynamic fields of many objects, several
 * objects per request; `complete` says whether that was all of an object's.
 * An object whose read failed is absent.
 */
async function readOwnFieldsBatch(ids: string[]): Promise<Map<string, EntriesRead>> {
  const out = new Map<string, EntriesRead>();
  const base = Buffer.byteLength(FIELD_PAGE) + 40;
  await Promise.all(
    batchesOf(ids, base, () => 150)
      .flatMap((b) => Array.from({ length: Math.ceil(b.length / PROBES_PER_REQUEST) }, (_, i) => b.slice(i * PROBES_PER_REQUEST, (i + 1) * PROBES_PER_REQUEST)))
      .map(async (batch) => {
      const decl = batch.map((_, i) => `$a${i}: SuiAddress!`).join(", ");
      const body = batch.map((_, i) => `o${i}: address(address: $a${i}) { dynamicFields(first: ${PROBE_FIELDS}) { ...F } }`).join(" ");
      try {
        const d = await gqlQuery<Record<string, { dynamicFields: FieldPage | null } | null>>(`${FIELD_PAGE}\nquery(${decl}) { ${body} }`, Object.fromEntries(batch.map((id, i) => [`a${i}`, id])));
        batch.forEach((id, i) => {
          const conn = d[`o${i}`]?.dynamicFields;
          const entries: Entry[] = [];
          if (conn) pageEntries(conn, entries);
          out.set(id, { entries, complete: !conn?.pageInfo.hasNextPage });
        });
      } catch {
        // Left out: the caller counts these objects' fields as not read.
      }
    }),
  );
  return out;
}

/**
 * Whether an object's JSON could hold a coin at all. A `Balance` renders as
 * a u64 string, and a table or a wrapped object as a struct with an `id`, so
 * JSON with neither below its own id holds none and needs no layout read.
 */
function mayHoldValue(json: unknown, depth = 0): boolean {
  if (depth > MAX_FIELD_DEPTH + 2) return false;
  if (typeof json === "string") return depth > 0 && /^\d+$/.test(json);
  if (Array.isArray(json)) return json.some((v) => mayHoldValue(v, depth + 1));
  if (!json || typeof json !== "object") return false;
  if (depth > 0 && typeof (json as Record<string, unknown>).id === "string") return true;
  return Object.entries(json).some(([k, v]) => !(depth === 0 && k === "id") && mayHoldValue(v, depth + 1));
}

/** Walk one entry's value: a coin or balance directly, a wrapped position, or a struct by its layout. */
function walkEntry(entry: Entry, container: Container, found: Found): void {
  const where = container.kind === "fields" ? `a dynamic field of ${container.id}` : `an entry of ${container.kind} ${container.id}`;
  if (BALANCE.test(entry.type)) {
    const amount = bigField(entry.json);
    if (amount !== null) addLeg(found, coinOf(entry.type), amount, where);
    return;
  }
  if (entry.object_id && nestedReader(entry.type)) {
    found.nested.push({ object_id: entry.object_id, type: entry.type, json: entry.json as Record<string, unknown>, path: where });
    return;
  }
  if (COIN.test(entry.type)) {
    const amount = bigField((entry.json as Record<string, unknown> | null)?.balance);
    if (amount !== null) addLeg(found, coinOf(entry.type), amount, where);
    return;
  }
  const layout = layouts.get(keyOf(entry.type));
  if (layout) walk(layout, entry.json, where, 1, container.level, found);
}

/**
 * Read the containers found so far, level by level, walking each entry. A
 * container's entries are the dynamic fields of its id, so an object that is
 * itself a table is read once, not again as its own fields.
 */
async function readContainers(found: Found, ctx: ValuationContext): Promise<void> {
  const done = new Set<string>();
  for (;;) {
    const open: Container[] = [];
    for (const c of found.containers) {
      if (done.has(c.id)) continue;
      done.add(c.id);
      open.push(c);
    }
    if (open.length === 0) return;
    const room = MAX_CONTAINERS - found.read.length;
    const now = open.filter((c) => c.level <= MAX_CONTAINER_DEPTH).slice(0, Math.max(0, room));
    for (const c of open.filter((c) => !now.includes(c))) {
      found.cut.push(c.level > MAX_CONTAINER_DEPTH ? `${c.kind} ${c.id}, ${c.level} containers deep` : `${c.kind} ${c.id}, past ${MAX_CONTAINERS} containers per object`);
    }
    const reads = await Promise.all(now.map((c) => (c.preread ? Promise.resolve(c.preread) : readEntries(c.id, ctx)).then((r) => ({ c, ...r }))));
    const valueTypes = reads.flatMap((r) => r.entries.map((e) => e.type)).filter((t) => !BALANCE.test(t) && !COIN.test(t) && !nestedReader(t));
    await prepareHeldTypes(valueTypes);
    for (const { c, entries, complete } of reads) {
      found.read.push({ id: c.id, kind: c.kind, entries_read: entries.length, complete });
      if (!complete) found.cut.push(`${c.kind} ${c.id} past its first ${entries.length} entries`);
      for (const e of entries) walkEntry(e, c, found);
    }
  }
}

export interface HeldOptions {
  /**
   * Also read the object's own dynamic fields, where a vault keeps balances
   * keyed by coin type; their entries when a batched read already has them.
   */
  ownFields: boolean | EntriesRead;
}

/**
 * What one object holds inside it: its balance legs as positions (priced
 * coins in one, unpriced ones apart so the priced still count), and each
 * position it wraps as valued by that position's reader. Nothing when it
 * holds nothing.
 */
export async function valueHeld(obj: ObjectToValue, ctx: ValuationContext, options: HeldOptions): Promise<ValuerResult> {
  const found: Found = { legs: new Map(), fields: false, where: [], containers: [], nested: [], read: [], cut: [] };
  if (mayHoldValue(obj.json)) {
    await prepareHeldTypes([obj.type]);
    const layout = layouts.get(keyOf(obj.type));
    if (layout) walk(layout, obj.json, "", 0, 0, found);
  }
  if (options.ownFields) {
    found.containers.push({
      id: obj.object_id,
      kind: "fields",
      type: obj.type,
      path: "",
      level: 1,
      ...(typeof options.ownFields === "object" ? { preread: options.ownFields } : {}),
    });
  }
  await readContainers(found, ctx);

  const positions: ValuedPosition[] = [];
  const unread: ValuerResult["unread"] = [];
  const heldIn = { object_id: obj.object_id, type: obj.type };
  // A balance of a coin a reader values (an LP share, a receipt) is valued
  // by that reader, as the same amount held as a coin would be.
  for (const [coin, amount] of found.legs) {
    const asCoin = `${SUI_FRAMEWORK}::coin::Coin<${coin}>`;
    if (amount === 0n || readerFor(asCoin, true) === null) continue;
    found.legs.delete(coin);
    found.nested.push({ object_id: obj.object_id, type: asCoin, json: { id: obj.object_id, balance: amount.toString() }, path: "a balance" });
  }
  if (found.nested.length > 0) {
    const inner = await valueObjects(
      found.nested.map(({ path: _path, ...o }) => o),
      ctx,
    );
    for (const p of inner.positions) {
      positions.push({ ...p, method: `Held inside ${obj.object_id} (${obj.type}). ${p.method}`, detail: { ...(p.detail ?? {}), held_in: heldIn } });
    }
    unread.push(...inner.unread);
  }

  const cut = found.cut.length > 0 ? ` A floor: ${found.cut.slice(0, 3).join("; ")}${found.cut.length > 3 ? `; and ${found.cut.length - 3} more` : ""} were not read.` : "";
  if (found.legs.size > 0) {
    const coins = [...found.legs.keys()];
    const prices = await priceCoinTypes(coins, ctx);
    const tables = found.read.filter((r) => r.kind !== "fields");
    const fieldsRead = found.read.filter((r) => r.kind === "fields");
    const parts = [
      ...(found.fields ? ["its Balance and Coin fields"] : []),
      ...(tables.length ? [`${tables.reduce((s, r) => s + r.entries_read, 0)} entries of the ${tables.length} table(s) or bag(s) it holds`] : []),
      ...(fieldsRead.length && fieldsRead[0].entries_read > 0 ? [`its ${fieldsRead[0].entries_read} dynamic field(s)`] : []),
    ];
    const method = `Balances held inside the object: ${parts.join(", ")}, read ${stateNote(ctx, false)}. The amounts are read from chain; each coin is priced as a wallet coin is.${cut}`;
    const detail = {
      object_type: obj.type,
      held: found.where,
      ...(found.read.length ? { containers: found.read } : {}),
      ...(found.cut.length ? { partial: true, not_read: found.cut } : {}),
    };
    const legs: Leg[] = [...found.legs].map(([coin_type, amount]) => ({ coin_type, amount, side: "supply" }));
    const priced = legs.filter((l) => l.amount === 0n || prices.points.has(l.coin_type));
    const unpriced = legs.filter((l) => !priced.includes(l));
    const base = { protocol: null, kind: "vault" as const, object_id: obj.object_id, detail };
    if (priced.length > 0) positions.push(assemblePosition({ ...base, method }, priced, prices));
    if (unpriced.length > 0) {
      positions.push(
        assemblePosition({ ...base, method: `${method} These coins have no price and are listed apart from the object's priced coins, which still count.` }, unpriced, prices),
      );
    }
  }
  return { positions, unread };
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/** What the owner walk read, for the coverage count that follows it. */
export interface HeldWalk {
  objects: OwnedObjectJson[];
  complete: boolean;
  /** Objects whose own dynamic fields were read; past {@link MAX_FIELD_PROBES}, others were not. */
  fields_read: string[];
}

const walkKey = (owner: string) => `held-walk:${owner}`;

/** The held-balances walk of this call, if it ran. */
export function heldWalk(ctx: ValuationContext): Promise<HeldWalk> | undefined {
  return ctx.memo?.get(walkKey(ctx.owner)) as Promise<HeldWalk> | undefined;
}

async function valueHoldings(ctx: ValuationContext): Promise<ValuerResult> {
  if (ctx.atCheckpoint !== undefined || ctx.atTime !== undefined) {
    return {
      positions: [],
      unread: [{ what: HELD_BALANCES, reason: "An owner's objects are walked at the latest state only, so balances held inside them are not valued for a past time." }],
    };
  }
  let settle: (w: HeldWalk) => void = () => undefined;
  if (ctx.memo) ctx.memo.set(walkKey(ctx.owner), new Promise<HeldWalk>((resolve) => (settle = resolve)));
  try {
    const walked = await ownedObjectsWalk(ctx.owner, ctx.memo);
    const candidates = walked.objects.filter((o) => !COIN.test(o.type) && readerFor(o.type, true) === null);
    // A layout is read only for a type whose object's JSON could hold a coin.
    await prepareHeldTypes(candidates.filter((o) => mayHoldValue(o.json)).map((o) => o.type));
    const holding = candidates.filter((o) => mayHoldValue(o.json) && handles(o.type));
    // Only the module defining a type can add dynamic fields to its objects,
    // and the framework's owned objects (caps, kiosk keys) keep no coins
    // that way, so only other types are probed. One object per type first:
    // a type keeping balances in dynamic fields shows it on its first
    // object as on the others.
    const rest = candidates.filter((o) => !holding.includes(o) && !FRAMEWORK.test(o.type));
    const firsts = new Map<string, OwnedObjectJson>();
    for (const o of rest) if (!firsts.has(o.type)) firsts.set(o.type, o);
    const probes = [...firsts.values(), ...rest.filter((o) => firsts.get(o.type) !== o)].slice(0, MAX_FIELD_PROBES);
    // An object that is itself a table has its entries read as the table's.
    const fieldTargets = [...holding.filter((o) => !containerKind(o.type)), ...probes];
    const fields = await readOwnFieldsBatch(fieldTargets.map((o) => o.objectId));
    const read = [
      ...holding.map((o) => ({ o, ownFields: containerKind(o.type) ? false : (fields.get(o.objectId) ?? true) })),
      // A probed object with no dynamic field holds nothing there.
      ...probes.filter((o) => (fields.get(o.objectId)?.entries.length ?? 0) > 0).map((o) => ({ o, ownFields: fields.get(o.objectId)! })),
    ];
    const results = await Promise.all(
      read.map(({ o, ownFields }) =>
        valueHeld({ object_id: o.objectId, type: o.type, json: o.json, version: o.version }, ctx, {
          ownFields: typeof ownFields === "object" && !ownFields.complete ? true : ownFields,
        }).catch((err: unknown) => ({
          positions: [],
          unread: [{ what: o.objectId, reason: `What it holds could not be read: ${err instanceof Error ? err.message : String(err)}` }],
        })),
      ),
    );
    settle({
      objects: walked.objects,
      complete: walked.complete,
      fields_read: [...holding.filter((o) => containerKind(o.type)), ...fieldTargets.filter((o) => fields.has(o.objectId))].map((o) => o.objectId),
    });
    const unread: ValuerResult["unread"] = results.flatMap((r) => r.unread);
    if (!walked.complete) {
      unread.push({
        what: "owned objects",
        reason: `Only the first ${OWNED_WALK_MAX} objects this address owns were read, so balances held inside the rest are not valued.`,
      });
    }
    return { positions: results.flatMap((r) => r.positions), unread };
  } catch (err) {
    settle({ objects: [], complete: false, fields_read: [] });
    throw err;
  }
}

function handles(type: string): boolean {
  return !COIN.test(type) && holds(type) === true;
}

registerValuer({
  name: HELD_BALANCES,
  fallback: true,
  prepare: prepareHeldTypes,
  handles,
  value: valueHoldings,
  valueObject: (obj, ctx) => valueHeld(obj, ctx, { ownFields: false }),
});
