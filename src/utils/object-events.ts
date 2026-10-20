import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { BOTH_WAYS_PAGE_INFO, orderedPageArgs, shownRange, type BothWaysPageInfo, type ListOrder } from "./pagination.js";
import { EVENTS_SELECTION, readAllEvents, type GqlConnection, type GqlEventNode } from "./tx-connections.js";
import type { ModuleEventFilterResolution } from "./package-versions.js";

const OBJECT_EVENTS_QUERY = `query($filter: TransactionFilter!, $first: Int, $after: String, $last: Int, $before: String) {
  transactions(filter: $filter, first: $first, after: $after, last: $last, before: $before) {
    edges { cursor node { digest sender { address } effects { timestamp checkpoint { sequenceNumber } ${EVENTS_SELECTION} } } }
    ${BOTH_WAYS_PAGE_INFO}
  }
}`;

interface ObjectTx {
  digest: string;
  sender?: { address: string };
  effects?: {
    timestamp?: string;
    checkpoint?: { sequenceNumber: number };
    events?: GqlConnection<GqlEventNode>;
  };
}
interface ObjectEdge { cursor: string; node: ObjectTx }
interface ObjectPage { transactions: { edges: ObjectEdge[]; pageInfo: BothWaysPageInfo } }

/** A transaction boundary plus an offset into its matching events. */
interface Position { order: ListOrder; boundary?: string; skip: number }
function decodePosition(cursor: string | undefined, order: ListOrder): Position {
  if (!cursor) return { order, skip: 0 };
  try {
    const p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Position & { version?: number };
    if (p.version !== 1 || p.order !== order || (p.boundary !== undefined && typeof p.boundary !== "string") ||
      !Number.isSafeInteger(p.skip) || p.skip < 0) throw new Error("invalid");
    return p;
  } catch {
    throw new Error("Invalid object-event cursor. Pass next_cursor from a previous object-event page with the same order.");
  }
}
function encodePosition(p: Position): string {
  return Buffer.from(JSON.stringify({ version: 1, ...p })).toString("base64url");
}

function typeMatches(type: string | undefined, requested: string | undefined): boolean {
  if (!requested) return true;
  if (!type) return false;
  const [pkg, ...parts] = requested.split("::");
  const [eventPkg, ...eventParts] = type.split("::");
  if (!pkg?.startsWith("0x") || !eventPkg?.startsWith("0x") || normalizeSuiAddress(pkg) !== normalizeSuiAddress(eventPkg)) return false;
  const suffix = parts.join("::");
  const actual = eventParts.join("::");
  return !suffix || actual === suffix ||
    (parts.length === 1 && actual.startsWith(`${suffix}::`)) ||
    (parts.length === 2 && !suffix.includes("<") && actual.startsWith(`${suffix}<`));
}
function moduleMatches(actual: string | undefined, requested: ModuleEventFilterResolution | null, checkpoint: number | undefined): boolean {
  if (!requested) return true;
  if (!actual || checkpoint == null) return false;
  return requested.segments.some((seg) => {
    if (seg.afterCheckpoint != null && checkpoint <= seg.afterCheckpoint) return false;
    if (seg.beforeCheckpoint != null && checkpoint >= seg.beforeCheckpoint) return false;
    const [pkg, ...parts] = seg.filter.split("::");
    const [eventPkg, ...eventParts] = actual.split("::");
    return !!pkg && !!eventPkg && normalizeSuiAddress(pkg) === normalizeSuiAddress(eventPkg) &&
      (!parts.length || parts.join("::") === eventParts.join("::"));
  });
}
function namesObject(json: unknown, object: string): boolean {
  return !!json && typeof json === "object" && !Array.isArray(json) &&
    Object.values(json).some((value) => typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value) && normalizeSuiAddress(value) === object);
}

/** All reads, including nested-event continuation reads, share one per-call budget. */
export const OBJECT_EVENTS_MAX_READS = 20;
const TX_BATCH = 10;

export async function readObjectEvents(opts: {
  object: string;
  filter: Record<string, unknown>;
  eventType?: string;
  module: ModuleEventFilterResolution | null;
  order: ListOrder;
  limit: number;
  cursor?: string;
}) {
  const position = decodePosition(opts.cursor, opts.order);
  const object = normalizeSuiAddress(opts.object);
  const events: Array<Record<string, unknown>> = [];
  const incompleteTransactions: string[] = [];
  let reads = 0;
  let more = true;
  let next = position;
  while (more && events.length < opts.limit && reads < OBJECT_EVENTS_MAX_READS) {
    const data = await gqlQuery<ObjectPage>(OBJECT_EVENTS_QUERY, {
      filter: opts.filter,
      ...orderedPageArgs(opts.order, TX_BATCH, next.boundary),
    });
    reads++;
    const conn = data.transactions;
    if (!conn?.edges || !conn.pageInfo) throw new Error("Object transaction connection could not be read.");
    const edges = opts.order === "newest" ? conn.edges.reverse() : conn.edges;
    for (const [edgeIndex, edge] of edges.entries()) {
      const tx = edge.node;
      if (!edge.cursor || !tx?.digest || !tx.effects?.events) throw new Error("Object transaction lacks an event connection or cursor.");
      const completed = await readAllEvents(tx.digest, tx.effects.events, () => {
        if (reads >= OBJECT_EVENTS_MAX_READS) return false;
        reads++;
        return true;
      });
      if (completed.truncated) incompleteTransactions.push(tx.digest);
      const nodes = opts.order === "newest" ? completed.nodes.reverse() : completed.nodes;
      // Resume within this transaction without allocating filtered copies.
      let matched = 0;
      let emitted = 0;
      let unshown = false;
      for (const e of nodes) {
        if (!typeMatches(e.contents?.type?.repr, opts.eventType) ||
          !moduleMatches(e.transactionModule?.fullyQualifiedName, opts.module, tx.effects.checkpoint?.sequenceNumber)) continue;
        if (matched++ < next.skip) continue;
        if (events.length >= opts.limit) {
          unshown = true;
          break;
        }
        emitted++;
        events.push({
          type: e.contents?.type?.repr ?? null,
          emitting_module: e.transactionModule?.fullyQualifiedName ?? null,
          sender: e.sender?.address ?? tx.sender?.address,
          data: e.contents?.json,
          tx_digest: tx.digest,
          checkpoint: tx.effects.checkpoint?.sequenceNumber,
          timestamp: tx.effects.timestamp,
          names_object: namesObject(e.contents?.json, object),
        });
      }
      if (unshown) {
        next = { order: opts.order, boundary: next.boundary, skip: next.skip + emitted };
        return result(true);
      }
      next = { order: opts.order, boundary: edge.cursor, skip: 0 };
      if (events.length >= opts.limit || reads >= OBJECT_EVENTS_MAX_READS) {
        const hasMoreTransactions = edgeIndex < edges.length - 1 ||
          (opts.order === "newest" ? conn.pageInfo.hasPreviousPage : conn.pageInfo.hasNextPage);
        return result(hasMoreTransactions);
      }
    }
    more = opts.order === "newest" ? conn.pageInfo.hasPreviousPage : conn.pageInfo.hasNextPage;
    const pageBoundary = opts.order === "newest" ? conn.pageInfo.startCursor : conn.pageInfo.endCursor;
    if (!edges.length && more) {
      if (!pageBoundary || pageBoundary === next.boundary) throw new Error("Object transaction connection reports more rows without an advancing cursor.");
      next = { order: opts.order, boundary: pageBoundary, skip: 0 };
    }
    if (more && !next.boundary) throw new Error("Object transaction connection reports more rows without a cursor.");
  }
  return result(more);

  function result(hasNext: boolean) {
    const nextCursor = hasNext ? encodePosition(next) : null;
    return {
      events,
      has_next_page: hasNext,
      next_cursor: nextCursor,
      ...shownRange(events.map((e) => e.timestamp as string | undefined)),
      ...(events.length === 0 ? {
        no_results_hint: incompleteTransactions.length
          ? "Some matching transactions have incomplete event reads; inspect incomplete_transactions before concluding no events match."
          : hasNext
            ? "No events matched in this transaction scan slice; continue with next_cursor."
            : opts.cursor
              ? "No events past this cursor in the requested object and window."
              : "No events matched in transactions affecting this object in the requested window.",
      } : {}),
      ...(incompleteTransactions.length ? {
        incomplete_transactions: incompleteTransactions,
        incomplete_note: "Some transactions had event pages that could not be completed within this call's read bound. Read each digest with get_transaction for all its events; filtered results cannot establish absence in those transactions.",
      } : {}),
      ...(hasNext && events.length < opts.limit ? {
        scan: {
          reads,
          note: `The transaction scan stopped after ${reads} reads with ${events.length} of ${opts.limit} matching events. Continue at next_call.`,
          next_call: { tool: "query_events", repeat_with: { order: opts.order, cursor: nextCursor } },
        },
      } : {}),
    };
  }
}
