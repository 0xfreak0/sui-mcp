import { z } from "zod";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { fetchTypeOrigins } from "../utils/package-versions.js";
import { prefetchCoinScale, coinScale } from "../utils/valuation.js";
import { capPayload } from "../utils/output-cap.js";
import { numArg } from "./args.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const PAGE_SIZE = 50;
const TIME_BUDGET_MS = 45_000;
const DEFAULT_MAX_SCAN = 10_000;
const MAX_LAYOUT_TYPES = 20;
const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const TYPE_HEAD = new RegExp(`^(0x[0-9a-fA-F]{1,64})::(${IDENT})(?:::(${IDENT})(?:<.*>)?)?$`);
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;
const BALANCE = /^0x0*2::balance::Balance<(.+)>$/;

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
interface Layout { struct?: { type: string; fields: Array<{ name: string; layout: Layout | string }> } }
interface ScanRow {
  object_id: string;
  object_type: string | null;
  owner: { kind: string; address?: string };
  version: string;
  previous_transaction: string | null;
  fields: Record<string, string | null>;
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

function atPath(value: unknown, parts: string[]): unknown {
  let current = value;
  for (const key of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
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

/** The layout identifies Balance<T> for exactly the requested field path. */
function fieldType(layout: Layout | string | undefined, path: string): string | null {
  let part: Layout | string | undefined = layout;
  for (const key of path.split(".")) {
    if (!part || typeof part === "string" || !part.struct) return null;
    part = part.struct.fields.find((f) => f.name === key)?.layout;
  }
  return typeof part === "object" ? part.struct?.type ?? null : part ?? null;
}

function formatAmount(amount: bigint, decimals: number): string {
  if (!decimals) return amount.toString();
  const text = amount.toString().padStart(decimals + 1, "0");
  return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`.replace(/\.?0+$/, "") || "0";
}

/** Scan totals cover every matching row fetched, independently of the displayed row cap. */
export async function scanObjectsByType(args: {
  type: string; sum_fields?: string[]; where?: { field: string; gt?: string };
  max_scan?: number; cursor?: string; detail?: "summary" | "full"; row_offset?: number;
}) {
  const { type, where, cursor, detail } = args;
  const sumFields = [...new Set(args.sum_fields ?? [])];
  const rowOffset = args.row_offset ?? 0;
  const maxScan = args.max_scan ?? DEFAULT_MAX_SCAN;
  const match = TYPE_HEAD.exec(type.trim());
  if (!match || !sumFields.every((p) => FIELD_PATH.test(p)) || (where && (!FIELD_PATH.test(where.field) || !INTEGER.test(where.gt ?? "0")))) {
    throw new Error("Pass a valid 0x…::module or 0x…::module::Struct type, numeric field paths, and a non-negative where.gt.");
  }
  const [, pkg, mod, name] = match;
  const requested = type.trim();
  let filter = requested;
  const origins = await fetchTypeOrigins(pkg);
  if (origins === null) throw new Error(`No package was found at ${pkg}; the scan cannot establish a type-wide count.`);
  let otherDefiningPackages: string[] = [];
  if (origins?.length) {
    const relevant = origins.filter((o) => o.module === mod && (!name || o.struct === name));
    const ids = [...new Set(relevant.map((o) => normalizeSuiAddress(o.definingId)))];
    if (ids.length) {
      const chosen = ids.includes(normalizeSuiAddress(pkg)) ? normalizeSuiAddress(pkg) : ids[0]!;
      if (chosen !== normalizeSuiAddress(pkg)) filter = chosen + requested.slice(pkg.length);
      otherDefiningPackages = ids.filter((id) => id !== chosen);
    }
  }
  // A module can contain structs defined by several upgrades. The result names
  // the missing versions, rather than claiming one filtered walk covers them.
  const selectedFields = [...new Set([...sumFields, ...(where ? [where.field] : [])])];
  const selectedPaths = Object.fromEntries(selectedFields.map((field) => [field, field.split(".")]));
  const whereGt = where ? BigInt(where.gt ?? "0") : null;
  const stats = Object.fromEntries(sumFields.map((field) => [field, {
    total: 0n, min: null as bigint | null, max: null as bigint | null, counted: 0, unreadable: 0,
  }]));
  const counts: Record<string, number> = { address: 0, object: 0, consensus: 0, shared: 0, immutable: 0, unknown: 0 };
  const rows: ScanRow[] = [];
  let whereUnreadable = 0;
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
      const content = node.asMoveObject?.contents?.json;
      if (where) {
        const tested = numberAt(atPath(content, selectedPaths[where.field]!));
        if (tested === null) { whereUnreadable++; continue; }
        if (tested <= whereGt!) continue;
      }
      counts[owner.kind] = (counts[owner.kind] ?? 0) + 1;
      const fields: Record<string, string | null> = {};
      for (const field of selectedFields) {
        const n = numberAt(atPath(content, selectedPaths[field]!));
        fields[field] = n?.toString() ?? null;
        const stat = stats[field];
        if (!stat) continue;
        if (n === null) { stat.unreadable++; continue; }
        stat.counted++;
        stat.total += n;
        if (stat.min === null || n < stat.min) stat.min = n;
        if (stat.max === null || n > stat.max) stat.max = n;
      }
      rows.push({
        object_id: node.address, object_type: node.asMoveObject?.contents?.type?.repr ?? null,
        owner, version: String(node.version),
        previous_transaction: node.previousTransaction?.digest ?? null, fields
      });
    }
    if (!page.pageInfo.hasNextPage) { complete = true; after = null; break; }
    if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after) { stopReason = "missing_or_repeated_cursor"; after = null; break; }
    after = page.pageInfo.endCursor;
  }
  if (!complete && !stopReason) stopReason = scanned >= maxScan ? "max_scan" : "time_budget";
  const scales: Record<string, { coin_type: string; decimals: number; source: string }> = {};
  const coinTotals = new Map<string, Map<string, bigint>>();
  let scaleUnavailable: string | undefined;
  if (sumFields.length && rows.length) {
    const typesFound = new Set<string>();
    for (const row of rows) if (row.object_type) typesFound.add(row.object_type);
    const concreteTypes = [...typesFound];
    const coinsByField = new Map<string, Set<string>>();
    const coinsByType = new Map<string, Map<string, string>>();
    try {
      if (rows.some((row) => !row.object_type)) {
        scaleUnavailable = "Some scanned object types could not be read; sums remain in raw units.";
      } else if (concreteTypes.length > MAX_LAYOUT_TYPES) {
        scaleUnavailable = `More than ${MAX_LAYOUT_TYPES} concrete Move types matched; coin scales were not read. Sums remain in raw units.`;
      }
      for (const concreteType of scaleUnavailable ? [] : concreteTypes) {
        const layoutResponse = await gqlQuery<{ type: { layout: Layout | null } | null }>(
          `query($type:String!){ type(type:$type){ layout } }`, { type: concreteType });
        const layout = layoutResponse.type?.layout;
        if (!layout) { scaleUnavailable = "At least one Move layout could not be read; sums remain in raw units."; break; }
        const typedFields = new Map<string, string>();
        for (const field of sumFields) {
          const coin = BALANCE.exec(fieldType(layout, field) ?? "")?.[1];
          if (coin) {
            const found = coinsByField.get(field) ?? new Set<string>();
            found.add(coin);
            coinsByField.set(field, found);
            typedFields.set(field, coin);
          }
        }
        coinsByType.set(concreteType, typedFields);
      }
      if (!scaleUnavailable) {
        for (const row of rows) {
          const typed = coinsByType.get(row.object_type ?? "");
          for (const [field, coin] of typed ?? []) {
            const value = row.fields[field];
            if (value === null) continue;
            const totals = coinTotals.get(field) ?? new Map<string, bigint>();
            totals.set(coin, (totals.get(coin) ?? 0n) + BigInt(value));
            coinTotals.set(field, totals);
          }
        }
      }
      if (!scaleUnavailable) {
        const coins = [...new Set([...coinsByField.values()].flatMap((set) => [...set]))];
        await prefetchCoinScale(coins);
        for (const [field, types] of coinsByField) {
          if (types.size !== 1 || coinsByType.size !== concreteTypes.length ||
            [...coinsByType.values()].some((fields) => !fields.has(field))) {
            scaleUnavailable = "This Balance field does not have one coin type across the scanned objects; per-coin totals are reported separately.";
            continue;
          }
          const coin = types.values().next().value!;
          const { decimals, source } = coinScale(coin);
          scales[field] = { coin_type: coin, decimals, source };
        }
      }
    } catch (error) {
      scaleUnavailable = `The Move layout or coin scale could not be read: ${error instanceof Error ? error.message : String(error)}. Sums remain in raw units.`;
    }
  }
  const sums = Object.fromEntries(sumFields.map((field) => {
    const stat = stats[field]!;
    const scale = scales[field];
    return [field, {
      total: stat.unreadable || (coinTotals.get(field)?.size ?? 0) > 1 ? null : stat.total.toString(),
      ...(stat.unreadable ? { observed_total: stat.total.toString() } : {}),
      min: stat.min?.toString() ?? null, max: stat.max?.toString() ?? null,
      count: stat.counted, unreadable: stat.unreadable,
      ...((coinTotals.get(field)?.size ?? 0) > 1 ? {
        by_coin: Object.fromEntries([...coinTotals.get(field)!].map(([coin, amount]) => {
          const { decimals, source } = coinScale(coin);
          return [coin, {
            raw_total: amount.toString(), formatted_total: formatAmount(amount, decimals),
            decimals_source: source,
          }];
        })),
      } : {}),
      ...(scale && stat.unreadable === 0 ? {
        coin_type: scale.coin_type, formatted_total: formatAmount(stat.total, scale.decimals),
        decimals: scale.decimals, decimals_source: scale.source
      } : {}),
    }];
  }));
  // Every field's largest object survives the default cap, even when one field
  // is small relative to the first field's values.
  const largestIds = new Set<string>();
  for (const field of sumFields) {
    const top: ScanRow[] = [];
    for (const row of rows) {
      const value = row.fields[field];
      if (value === null) continue;
      let position = 0;
      while (position < top.length && compareNumericStrings(value, top[position]!.fields[field]!) >= 0) position++;
      if (position < 5) {
        top.splice(position, 0, row);
        if (top.length > 5) top.pop();
      }
    }
    for (const row of top) largestIds.add(row.object_id);
  }
  const ranked = sumFields.length ? rows.sort((a, b) => {
    const x = largestIds.has(a.object_id) ? 1 : 0;
    const y = largestIds.has(b.object_id) ? 1 : 0;
    if (x !== y) return y - x;
    return compareNumericStrings(a.fields[sumFields[0]!] ?? "0", b.fields[sumFields[0]!] ?? "0");
  }) : rows;
  const full = {
    requested_type: requested, queried_type: filter,
    ...(otherDefiningPackages.length ? {
      other_defining_packages: otherDefiningPackages,
      type_scope_note: "This module contains structs defined in more than one package version; query the other defining packages for their objects."
    } : {}),
    scanned, matched: rows.length, complete: complete && otherDefiningPackages.length === 0,
    ...(otherDefiningPackages.length ? { queried_complete: complete } : {}),
    ...(!complete || otherDefiningPackages.length ? { truncated: true } : {}),
    ...(whereUnreadable ? {
      where_unreadable: whereUnreadable,
      matched_complete: false,
      where_note: "Some scanned objects lacked a readable numeric filter field, so matched is a lower bound.",
    } : {}),
    ...(where ? { where: { field: where.field, gt: where.gt ?? "0" } } : {}),
    owner_kinds: counts, sums, pages, elapsed_ms: Date.now() - started,
    ...(scaleUnavailable ? { scale_unavailable: scaleUnavailable } : {}),
    ...(stopReason || otherDefiningPackages.length ? {
      stop_reason: stopReason ?? "other_defining_packages",
    } : {}),
    ...(after ? {
      next_cursor: after, next_call: {
        tool: "list_objects_by_type", args: {
          type: requested, sum_fields: sumFields, where, max_scan: maxScan, cursor: after,
        }
      }
    } : {}),
    objects: ranked.slice(rowOffset),
  };
  const { payload } = capPayload("list_objects_by_type", args, full,
    { objects: { budget: 30_000, keep: (row: ScanRow) => largestIds.has(row.object_id) } },
    {
      full: detail === "full", maxChars: 450_000,
      fullContinuation: {
        path: "objects", nextCall: (shown) => ({
          tool: "list_objects_by_type", args: { ...args, detail: "full", row_offset: rowOffset + shown },
        })
      },
      next_call: { tool: "list_objects_by_type", args: { ...args, detail: "full" } }
    });
  return payload;
}

export function registerObjectsByTypeTools(server: McpServer) {
  server.tool("list_objects_by_type",
    "Scan current Sui objects matching a Move struct or module filter across every owner kind. " +
    "Reports scanned and matched counts, owner kinds, raw integer sums/min/max over selected fields, and largest rows. " +
    "`where: {field:'offer',gt:'0'}` keeps funded objects only. Nested paths use dots. " +
    "Balance<T> sums include coin decimals when the type layout and metadata are available. " +
    "A partial scan reports `truncated` and, when a cursor is available, `next_call`; totals cover only scanned objects. " +
    "A module spanning defining package versions reports the other IDs separately. Rows are ranked by selected value and capped. " +
    "`detail:'full'` pages large row sets with `row_offset`. Object-id order is unrelated to value. " +
    "Use `max_scan` to bound the scan and `cursor` to resume; totals on separate calls are not cumulative.",
    {
      type: z.string().describe("Move struct type or module, e.g. 0x2::kiosk::Kiosk or 0x2::kiosk"),
      sum_fields: z.array(z.string()).max(8).optional().describe("Numeric field paths to sum, e.g. ['offer'] or ['balance.value']"),
      where: z.object({ field: z.string(), gt: z.string().regex(INTEGER).optional() }).optional()
        .describe("Include only objects with the named numeric field greater than gt (default '0')"),
      max_scan: numArg().int().min(1).max(50_000).optional().describe("Max objects to scan per call (default 10000, max 50000)"),
      cursor: z.string().optional().describe("Continue at next_cursor; sums and counts cover this call only"),
      row_offset: numArg().int().min(0).max(50_000).optional().describe("Offset into value-ranked rows of this scan, for full-view pagination"),
      detail: z.enum(["summary", "full"]).optional().describe("'full' returns all rows scanned; summary caps rows but keeps totals"),
    },
    async (args) => ({ content: [{ type: "text" as const, text: JSON.stringify(await scanObjectsByType(args)) }] }),
  );
}
