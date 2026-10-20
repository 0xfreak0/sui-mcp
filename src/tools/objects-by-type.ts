import { z } from "zod";
import { normalizeStructTag } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { resolveDefiningType, type UnknownTypeName } from "../utils/package-versions.js";
import { coinLayout, type CoinLayout } from "../utils/state-read.js";
import { typeArgsOf } from "../utils/attack-analysis.js";
import { prefetchCoinScale, coinScale } from "../utils/valuation.js";
import { capPayload } from "../utils/output-cap.js";
import { editDistance, numArg } from "./args.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const PAGE_SIZE = 50;
const TIME_BUDGET_MS = 45_000;
const DEFAULT_MAX_SCAN = 10_000;
/** Struct definitions whose coin layout one call reads (gRPC GetDatatype, nested structs included). */
const MAX_LAYOUT_DEFINITIONS = 20;
/** Coins whose decimals one call reads; amounts of the rest stay raw. */
const MAX_SCALE_READS = 200;
/** Units whose largest rows survive the row cap, shared among the summed fields, and how many rows each. */
const KEPT_UNITS = 10;
const KEPT_PER_UNIT = 3;
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;

interface Owner { __typename: string; address?: { address: string } | null }
interface ObjectNode {
  address: string;
  version: number;
  owner: Owner | null;
  previousTransaction?: { digest: string } | null;
  asMoveObject?: { contents?: { type?: { repr: string }; json?: Record<string, unknown> | null } | null } | null;
}
interface Page {
  objects: { nodes: ObjectNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null;
}
interface ScanRow {
  object_id: string;
  object_type: string | null;
  owner: { kind: string; address?: string };
  version: string;
  previous_transaction: string | null;
  fields: Record<string, string | null>;
}
/** What one field's amounts are counted in: a coin, when the layout proves a `Balance<T>` or `Supply<T>`, else the object's own type. */
interface Unit {
  key: string;
  coin_type?: string;
  object_type?: string;
  total: bigint;
  count: number;
  min: bigint;
  max: bigint;
}

const OBJECTS_QUERY = `query($type: String!, $first: Int!, $after: String) {
  objects(filter: { type: $type }, first: $first, after: $after) {
    nodes {
      address version previousTransaction { digest }
      owner {
        __typename
        ... on AddressOwner { address { address } }
        ... on ObjectOwner { address { address } }
        ... on ConsensusAddressOwner { address { address } }
      }
      asMoveObject { contents { type { repr } json } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** A path the object's struct does not have: GraphQL renders every field, so a missing key is a missing field. */
const ABSENT = Symbol("absent");

/** GraphQL renders a `Balance<T>` as its amount, not `{ value }`, so `balance.value` reads the amount itself. */
function atPath(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const [i, key] of parts.entries()) {
    if (key === "value" && i === parts.length - 1 && typeof current === "string") return current;
    if (current === null) return null;
    if (typeof current !== "object" || Array.isArray(current) || !(key in current)) return ABSENT;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function numberAt(value: unknown): bigint | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return numberAt((value as Record<string, unknown>).value);
  if ((typeof value === "string" && INTEGER.test(value)) || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
    return BigInt(value);
  }
  return null;
}

const OWNER_KINDS: Record<string, string> = {
  AddressOwner: "address", ObjectOwner: "object", ConsensusAddressOwner: "consensus",
  Shared: "shared", Immutable: "immutable",
};

function ownerOf(owner: Owner | null): { kind: string; address?: string } {
  const kind = OWNER_KINDS[owner?.__typename ?? ""] ?? "unknown";
  return { kind, ...(owner?.address?.address ? { address: owner.address.address } : {}) };
}

/** Descending order for canonical non-negative integer strings, without a BigInt per comparison. */
function compareNumericStrings(left: string, right: string): number {
  return right.length - left.length || (left < right ? 1 : left > right ? -1 : 0);
}

function formatAmount(amount: bigint, decimals: number): string {
  if (!decimals) return amount.toString();
  const text = amount.toString().padStart(decimals + 1, "0");
  return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`.replace(/\.?0+$/, "") || "0";
}

/** Names closest to `asked` first, at most 15, with the count of the rest. */
function closestNames(asked: string | undefined, names: string[]): string {
  if (!names.length) return "none";
  const lower = (asked ?? "").toLowerCase();
  const ranked = [...names].sort((a, b) => editDistance(lower, a.toLowerCase()) - editDistance(lower, b.toLowerCase()) || a.localeCompare(b));
  const shown = ranked.slice(0, 15).join(", ");
  return ranked.length > 15 ? `${shown} and ${ranked.length - 15} more` : shown;
}

/** Why a type that names something its package does not define cannot be scanned. */
function unknownNameMessage(u: UnknownTypeName): string {
  if (u.not_a_package) return `No package exists at ${u.package} on this network, so no object can have this type.`;
  if (u.structs) {
    return `Module ${u.module} of ${u.package} defines no struct named ${u.struct}, so no object can have this type. ` +
      `Structs in ${u.module}, closest first: ${closestNames(u.struct, u.structs)}.`;
  }
  return `Package ${u.package} defines no struct in a module named ${u.module}, so no object can have this type. ` +
    `Modules that define structs, closest first: ${closestNames(u.module, u.modules ?? [])}.`;
}

/** A struct's definition with its type arguments replaced by placeholders, so one layout read covers every instantiation. */
const placeholder = (i: number) => normalizeStructTag(`0x0::type_param_${i}::T`);

function genericOf(objectType: string): { definition: string; args: string[] } {
  const args = typeArgsOf(objectType);
  const head = objectType.split("<")[0]!;
  return { definition: args.length ? `${head}<${args.map((_, i) => placeholder(i)).join(",")}>` : head, args };
}

/** The coin a field path is denominated in, when the layout shows the path is a `Balance<T>`, its `value`, or a `Supply<T>`. */
function coinOfPath(layout: CoinLayout, path: string): string | undefined {
  const parent = path.endsWith(".value") ? path.slice(0, -".value".length) : undefined;
  return layout.balances[path] ?? (parent !== undefined ? layout.balances[parent] : undefined) ??
    layout.supplies[path] ?? layout.supplies[`${path}.value`];
}

/** Scan totals cover every matching row fetched, independently of the displayed row cap. */
export async function scanObjectsByType(args: {
  type: string; sum_fields?: string[]; where?: { field: string; gt?: string };
  max_scan?: number; cursor?: string; detail?: "summary" | "full"; row_offset?: number;
}) {
  const { where, cursor, detail } = args;
  const sumFields = [...new Set(args.sum_fields ?? [])];
  const rowOffset = args.row_offset ?? 0;
  const maxScan = args.max_scan ?? DEFAULT_MAX_SCAN;
  if (!sumFields.every((p) => FIELD_PATH.test(p)) || (where && (!FIELD_PATH.test(where.field) || !INTEGER.test(where.gt ?? "0")))) {
    throw new Error("Field paths are Move identifiers joined by dots (e.g. 'offer' or 'balance.value'), and where.gt is a non-negative integer.");
  }
  const requested = args.type.trim();
  const resolved = await resolveDefiningType(requested);
  if (!resolved || !resolved.filter.includes("::")) {
    throw new Error("Pass a Move struct type or module: 0x…::module or 0x…::module::Struct<…>, with full types as type arguments.");
  }
  if (resolved.unknown.length) throw new Error(resolved.unknown.map(unknownNameMessage).join(" "));
  const filter = resolved.filter;
  // A module can contain structs defined by several upgrades. The result names
  // the missing versions, rather than claiming one filtered walk covers them.
  const otherDefiningPackages = resolved.other_defining_packages;
  const selectedFields = [...new Set([...sumFields, ...(where ? [where.field] : [])])];
  const selectedPaths = Object.fromEntries(selectedFields.map((field) => [field, field.split(".")]));
  const whereGt = where ? BigInt(where.gt ?? "0") : null;
  const unreadable = Object.fromEntries(sumFields.map((field) => [field, 0]));
  const absent = Object.fromEntries(sumFields.map((field) => [field, 0]));
  const counts: Record<string, number> = { address: 0, object: 0, consensus: 0, shared: 0, immutable: 0, unknown: 0 };
  const rows: ScanRow[] = [];
  let whereUnreadable = 0;
  let whereAbsent = 0;
  let firstFields: string[] | null = null;
  let after = cursor ?? null;
  let scanned = 0;
  let pages = 0;
  let complete = false;
  let stopReason: string | null = null;
  const started = Date.now();
  while (scanned < maxScan && Date.now() - started < TIME_BUDGET_MS) {
    const response = await gqlQuery<Page>(OBJECTS_QUERY, { type: filter, first: Math.min(PAGE_SIZE, maxScan - scanned), after });
    const page = response.objects;
    if (!page) throw new Error(`The object connection for ${filter} was unavailable.`);
    pages++;
    for (const node of page.nodes) {
      scanned++;
      const owner = ownerOf(node.owner);
      // No contents at all reads as unreadable, never as a struct without the field.
      const content = node.asMoveObject?.contents?.json ?? null;
      if (!firstFields && content && typeof content === "object") firstFields = Object.keys(content);
      if (where) {
        const found = atPath(content, selectedPaths[where.field]!);
        const tested = numberAt(found);
        if (found === ABSENT) { whereAbsent++; continue; }
        if (tested === null) { whereUnreadable++; continue; }
        if (tested <= whereGt!) continue;
      }
      counts[owner.kind] = (counts[owner.kind] ?? 0) + 1;
      const fields: Record<string, string | null> = {};
      for (const field of selectedFields) {
        const found = atPath(content, selectedPaths[field]!);
        const n = numberAt(found);
        fields[field] = n?.toString() ?? null;
        if (n === null && field in unreadable) (found === ABSENT ? absent : unreadable)[field]!++;
      }
      rows.push({
        object_id: node.address, object_type: node.asMoveObject?.contents?.type?.repr ?? null,
        owner, version: String(node.version),
        previous_transaction: node.previousTransaction?.digest ?? null, fields,
      });
    }
    if (!page.pageInfo.hasNextPage) { complete = true; after = null; break; }
    if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after) { stopReason = "missing_or_repeated_cursor"; after = null; break; }
    after = page.pageInfo.endCursor;
  }
  if (!complete && !stopReason) stopReason = scanned >= maxScan ? "max_scan" : "time_budget";

  // Units. Two objects of one concrete type hold a field of one type, so the
  // object type is always a sound unit. A layout that proves the field is a
  // Balance<T> or Supply<T> lets objects of different types add up in T.
  const layouts = new Map<string, CoinLayout | null>();
  let layoutsSkipped = 0;
  let layoutsUnread = 0;
  if (sumFields.length) {
    const byDefinition = new Map<string, number>();
    for (const row of rows) {
      if (!row.object_type) continue;
      const { definition } = genericOf(row.object_type);
      byDefinition.set(definition, (byDefinition.get(definition) ?? 0) + 1);
    }
    const definitions = [...byDefinition.entries()].sort((a, b) => b[1] - a[1]).map(([definition]) => definition);
    layoutsSkipped = Math.max(0, definitions.length - MAX_LAYOUT_DEFINITIONS);
    const read = definitions.slice(0, MAX_LAYOUT_DEFINITIONS);
    const results = await Promise.all(read.map((definition) => coinLayout(definition)));
    read.forEach((definition, i) => layouts.set(definition, results[i]?.layout ?? null));
    layoutsUnread = results.filter((r) => !r?.complete).length;
  }
  const units = new Map<string, Map<string, Unit>>(sumFields.map((field) => [field, new Map()]));
  const unitUnread = Object.fromEntries(sumFields.map((field) => [field, 0]));
  const rowUnit = new Map<ScanRow, Record<string, string>>();
  for (const row of rows) {
    if (!sumFields.length) break;
    const generic = row.object_type ? genericOf(row.object_type) : null;
    const layout = generic ? layouts.get(generic.definition) : undefined;
    const keys: Record<string, string> = {};
    for (const field of sumFields) {
      const value = row.fields[field];
      if (value === null || value === undefined) continue;
      if (!row.object_type || !generic) { unitUnread[field]!++; continue; }
      let coin = layout ? coinOfPath(layout, field) : undefined;
      if (coin) generic.args.forEach((arg, i) => { coin = coin!.split(placeholder(i)).join(arg); });
      const key = coin ? `coin:${coin}` : `type:${row.object_type}`;
      keys[field] = key;
      const amount = BigInt(value);
      const fieldUnits = units.get(field)!;
      const unit = fieldUnits.get(key);
      if (unit) {
        unit.total += amount;
        unit.count++;
        if (amount < unit.min) unit.min = amount;
        if (amount > unit.max) unit.max = amount;
      } else {
        fieldUnits.set(key, {
          key, ...(coin ? { coin_type: coin } : { object_type: row.object_type }),
          total: amount, count: 1, min: amount, max: amount,
        });
      }
    }
    rowUnit.set(row, keys);
  }
  const coinCounts = new Map<string, number>();
  for (const fieldUnits of units.values()) {
    for (const unit of fieldUnits.values()) if (unit.coin_type) coinCounts.set(unit.coin_type, (coinCounts.get(unit.coin_type) ?? 0) + unit.count);
  }
  const scaled = new Set([...coinCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SCALE_READS).map(([coin]) => coin));
  let scaleUnavailable: string | undefined;
  try {
    await prefetchCoinScale(scaled);
  } catch (error) {
    scaled.clear();
    scaleUnavailable = `Coin decimals could not be read: ${error instanceof Error ? error.message : String(error)}. Amounts stay raw.`;
  }
  const scaleOf = (coin: string) => {
    if (!scaled.has(coin)) return { decimals: null, decimals_source: "not_read" as const };
    const { decimals, source } = coinScale(coin);
    return { decimals, decimals_source: source };
  };
  const formatted = (coin: string, amount: bigint) => {
    const scale = scaleOf(coin);
    return scale.decimals === null ? { ...scale } : { formatted: formatAmount(amount, scale.decimals), ...scale };
  };

  const fieldsHint = firstFields ? ` Top-level fields of the first object scanned: ${firstFields.join(", ")}.` : "";
  const sumUnits: Array<Record<string, unknown>> = [];
  const sums = Object.fromEntries(sumFields.map((field) => {
    const fieldUnits = [...units.get(field)!.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const count = fieldUnits.reduce((n, u) => n + u.count, 0);
    const missing = unreadable[field]! + unitUnread[field]!;
    const single = fieldUnits.length <= 1 ? fieldUnits[0] : undefined;
    const raw = single?.total ?? 0n;
    const coinView = (unit: Unit | undefined, amount: bigint, name: "total" | "observed_total") => {
      if (!unit?.coin_type) return {};
      const f = formatted(unit.coin_type, amount);
      return { coin_type: unit.coin_type, ...("formatted" in f ? { [`formatted_${name}`]: f.formatted } : {}), decimals: f.decimals, decimals_source: f.decimals_source };
    };
    if (fieldUnits.length > 1) {
      for (const unit of fieldUnits) {
        const f = unit.coin_type ? formatted(unit.coin_type, unit.total) : null;
        sumUnits.push({
          field, ...(unit.coin_type ? { coin_type: unit.coin_type } : { object_type: unit.object_type }),
          count: unit.count, raw_total: unit.total.toString(), min: unit.min.toString(), max: unit.max.toString(),
          ...(f ? { ...("formatted" in f ? { formatted_total: f.formatted } : {}), decimals: f.decimals, decimals_source: f.decimals_source } : {}),
        });
      }
    }
    // A path no matched object has is most often a misspelt field: zero over
    // no objects must not read as a total.
    const noSuchField = count === 0 && absent[field]! > 0 && !missing;
    return [field, {
      total: fieldUnits.length <= 1 && !missing && !noSuchField ? raw.toString() : null,
      ...(fieldUnits.length === 1 && missing ? { observed_total: raw.toString() } : {}),
      min: single?.min.toString() ?? null, max: single?.max.toString() ?? null,
      count, unreadable: unreadable[field]!,
      ...(absent[field] ? { absent: absent[field] } : {}),
      ...(noSuchField ? { field_note: `No matched object has a field at ${field}.${fieldsHint}` } : {}),
      ...(unitUnread[field] ? { unit_unread: unitUnread[field] } : {}),
      ...(single ? coinView(single, raw, missing ? "observed_total" : "total") : {}),
      ...(fieldUnits.length > 1 ? {
        unit_count: fieldUnits.length,
        units_note: "These objects hold this field in different coins or object types, so no total across them is given; sum_units lists each.",
      } : {}),
      ...(missing ? {
        total_note: fieldUnits.length > 1
          ? "Some objects' amounts or object types could not be read; sum_units covers the rest."
          : fieldUnits.length === 1
            ? "Some objects' amounts or object types could not be read, so total is null; observed_total covers the rest and is a lower bound."
            : "No object's amount at this path could be read, so total is null.",
      } : {}),
    }];
  }));
  const layoutNote = [
    layoutsSkipped ? `${layoutsSkipped} struct definitions past the first ${MAX_LAYOUT_DEFINITIONS} were not read for coin layouts.` : "",
    layoutsUnread ? `The coin layout of ${layoutsUnread} struct definitions could not be read in full.` : "",
    layoutsSkipped || layoutsUnread ? "Their amounts are counted per object type rather than per coin." : "",
  ].filter(Boolean).join(" ");

  // Each unit's largest objects survive the default cap: across units the raw
  // numbers are not comparable, so the largest by raw value alone could hide them all.
  const largest = new Set<ScanRow>();
  for (const field of sumFields) {
    const unitsKept = Math.max(1, Math.floor(KEPT_UNITS / sumFields.length));
    const kept = new Set([...units.get(field)!.values()].sort((a, b) => b.count - a.count).slice(0, unitsKept).map((u) => u.key));
    const tops = new Map<string, ScanRow[]>();
    for (const row of rows) {
      const key = rowUnit.get(row)?.[field];
      if (!key || !kept.has(key)) continue;
      const top = tops.get(key) ?? [];
      const value = row.fields[field]!;
      let position = 0;
      while (position < top.length && compareNumericStrings(value, top[position]!.fields[field]!) >= 0) position++;
      if (position < KEPT_PER_UNIT) {
        top.splice(position, 0, row);
        if (top.length > KEPT_PER_UNIT) top.pop();
      }
      tops.set(key, top);
    }
    for (const top of tops.values()) for (const row of top) largest.add(row);
  }
  const ranked = sumFields.length ? rows.sort((a, b) => {
    const x = largest.has(a) ? 1 : 0;
    const y = largest.has(b) ? 1 : 0;
    if (x !== y) return y - x;
    return compareNumericStrings(a.fields[sumFields[0]!] ?? "0", b.fields[sumFields[0]!] ?? "0") || a.object_id.localeCompare(b.object_id);
  }) : rows;
  const largestIds = new Set([...largest].map((row) => row.object_id));
  const full = {
    requested_type: requested, queried_type: filter,
    ...(resolved.rewritten ? { type_note: "The type was rewritten to the package versions that defined its structs, which is the id an object's type carries." } : {}),
    ...(otherDefiningPackages.length ? {
      other_defining_packages: otherDefiningPackages,
      type_scope_note: "This module contains structs defined in more than one package version; query the other defining packages for their objects.",
    } : {}),
    scanned, matched: rows.length, complete: complete && otherDefiningPackages.length === 0,
    ...(otherDefiningPackages.length ? { queried_complete: complete } : {}),
    ...(!complete || otherDefiningPackages.length ? { truncated: true } : {}),
    ...(whereUnreadable ? {
      where_unreadable: whereUnreadable,
      matched_complete: false,
      where_note: "Some scanned objects lacked a readable numeric filter field, so matched is a lower bound.",
    } : {}),
    ...(whereAbsent ? {
      where_absent: whereAbsent,
      where_absent_note: whereAbsent === scanned
        ? `No scanned object has a field at ${where!.field}, so nothing matched.${fieldsHint}`
        : `${whereAbsent} scanned objects have no field at ${where!.field} and are not matched.`,
    } : {}),
    ...(where ? { where: { field: where.field, gt: where.gt ?? "0" } } : {}),
    ...(scanned === 0 && complete && !cursor ? {
      scope_note: "No top-level object of this type exists now. Objects wrapped inside another object's fields are not indexed by type and are not counted.",
    } : {}),
    owner_kinds: counts, sums, pages, elapsed_ms: Date.now() - started,
    ...(scaleUnavailable ? { scale_unavailable: scaleUnavailable } : {}),
    ...(layoutNote ? { layout_note: layoutNote } : {}),
    ...(stopReason || otherDefiningPackages.length ? {
      stop_reason: stopReason ?? "other_defining_packages",
    } : {}),
    ...(after ? {
      next_cursor: after, next_call: {
        tool: "list_objects_by_type", args: {
          type: requested, sum_fields: sumFields, where, max_scan: maxScan, cursor: after, ...(detail ? { detail } : {}),
        },
      },
    } : {}),
    ...(sumUnits.length ? { sum_units: sumUnits } : {}),
    ...(detail === "full" && rowOffset > 0 ? { row_offset_note: ROW_OFFSET_NOTE } : {}),
    objects: ranked.slice(rowOffset),
  };
  const { payload } = capPayload("list_objects_by_type", args, full,
    {
      objects: { budget: 30_000, keep: (row: ScanRow) => largestIds.has(row.object_id) },
      sum_units: { budget: 10_000 },
    },
    {
      full: detail === "full", maxChars: 450_000,
      fullContinuation: {
        path: "objects", nextCall: (shown) => ({
          tool: "list_objects_by_type", args: { ...args, detail: "full", row_offset: rowOffset + shown },
        }),
      },
      next_call: { tool: "list_objects_by_type", args: { ...args, detail: "full" } },
    });
  if (detail === "full" && payload.omitted && !payload.row_offset_note) return { ...payload, row_offset_note: ROW_OFFSET_NOTE };
  return payload;
}

const ROW_OFFSET_NOTE =
  "A row_offset page scans current state again from the same cursor and ranks it again, so an object created, deleted or changed between calls can move rows between pages. With SUI_STORE_PATH set, omitted.result pages the rows of this one scan instead.";

export function registerObjectsByTypeTools(server: McpServer) {
  server.tool("list_objects_by_type",
    "Scan current top-level Sui objects matching a Move struct or module filter across every owner kind. " +
    "Objects wrapped inside another object's fields are not indexed by type and are not listed. " +
    "Reports scanned and matched counts, owner kinds, integer sums/min/max over selected fields, and the largest rows. " +
    "`where: {field:'offer',gt:'0'}` keeps funded objects only. Nested paths use dots. " +
    "A total is given only when every amount is in one unit: a Balance<T> field adds up per coin T with its decimals, any other field per object type; mixed units are listed in `sum_units`. " +
    "Types are rewritten to the package versions that defined them; a module or struct the package lacks is refused with the names it has. " +
    "A partial scan reports `truncated` and, when a cursor is available, `next_call`; totals cover only the objects this call scanned and are not cumulative across calls. " +
    "Object-id order is unrelated to value. `detail:'full'` pages rows with `row_offset`, which scans again.",
    {
      type: z.string().describe("Move struct type or module, e.g. 0x2::kiosk::Kiosk, 0x2::coin::Coin<0x2::sui::SUI> or 0x2::kiosk"),
      sum_fields: z.array(z.string()).max(8).optional().describe("Numeric field paths to sum, e.g. ['offer'] or ['balance.value']"),
      where: z.object({ field: z.string(), gt: z.string().regex(INTEGER).optional() }).optional()
        .describe("Include only objects with the named numeric field greater than gt (default '0')"),
      max_scan: numArg().int().min(1).max(50_000).optional().describe("Max objects to scan per call (default 10000, max 50000)"),
      cursor: z.string().optional().describe("Continue at next_cursor; sums and counts cover this call only"),
      row_offset: numArg().int().min(0).max(50_000).optional().describe("Offset into value-ranked rows of this scan, for full-view pagination; each page scans again"),
      detail: z.enum(["summary", "full"]).optional().describe("'full' returns all rows scanned; summary caps rows but keeps totals"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await scanObjectsByType(args)) }] }),
  );
}
