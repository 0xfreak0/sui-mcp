import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { BOTH_WAYS_PAGE_INFO, shownRange, type BothWaysPageInfo, type ListOrder } from "./pagination.js";
import { EVENTS_SELECTION, readAllEvents, type GqlConnection, type GqlEventNode } from "./tx-connections.js";
import type { ModuleEventFilterResolution } from "./package-versions.js";
import { mergeVersionPages, type VersionPage, type VersionStream } from "./version-fanout.js";

const TX_FRAGMENT = `fragment T on TransactionConnection { edges { cursor node { digest sender { address } effects { timestamp checkpoint { sequenceNumber } ${EVENTS_SELECTION} } } } ${BOTH_WAYS_PAGE_INFO} }`;

interface ObjectTx {
  digest: string;
  sender?: { address: string };
  effects?: {
    timestamp?: string;
    checkpoint?: { sequenceNumber: number };
    events?: GqlConnection<GqlEventNode>;
  };
}
type TxConnection = { edges: Array<{ cursor: string; node: ObjectTx }>; pageInfo: BothWaysPageInfo };

/**
 * Objects read per call, and aliased `transactions` connections per request.
 * Each alias repeats the nested events selection; the service refuses a
 * document of more than 300 query nodes, which 10 aliases fit and 11 do not.
 */
export const OBJECT_EVENTS_MAX_OBJECTS = 20;
const ALIASES_PER_REQUEST = 10;
/**
 * Transactions asked of each object's connection per read: the service's
 * maximum, since a call's cost is its request count. Ten objects of busy pools
 * answer in about a second with 2.6 MB.
 */
const TX_PAGE = 50;
/** All reads, including nested-event continuation reads, share one per-call budget. */
export const OBJECT_EVENTS_MAX_READS = 20;

/**
 * Where the walk stands: each object's connection position; an offset into
 * the matching events of transaction `at`, split by the last page; for a
 * newest-first walk with no upper bound, the checkpoint it is pinned below,
 * so transactions landing after the first page cannot shift a continuation;
 * and, for several objects, the transactions already listed in the last
 * checkpoint, which another object's position may not have passed yet.
 */
interface Position { streams: VersionStream[]; skip: number; at?: string; top?: number; seen?: { cp: number; digests: string[] } }

function encodePosition(order: ListOrder, p: Position): string {
  return Buffer.from(JSON.stringify({
    version: 2,
    order,
    s: p.streams.map((s) => [s.address, s.cursor ?? null, s.done ? 1 : 0]),
    skip: p.skip,
    ...(p.at ? { at: p.at } : {}),
    ...(p.top != null ? { top: p.top } : {}),
    ...(p.seen?.digests.length ? { seen: [p.seen.cp, p.seen.digests] } : {}),
  })).toString("base64url");
}

function decodePosition(cursor: string | undefined, order: ListOrder, objects: string[]): Position {
  if (!cursor) return { streams: objects.map((address) => ({ address, done: false })), skip: 0 };
  const invalid = new Error("Invalid object-event cursor. Pass next_cursor from a previous call with the same affected_object list, order and filters.");
  let p: { version?: unknown; order?: unknown; s?: unknown; skip?: unknown; at?: unknown; top?: unknown; seen?: unknown };
  try {
    p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  if (!p || p.version !== 2 || p.order !== order || !Array.isArray(p.s) || p.s.length !== objects.length ||
    !Number.isSafeInteger(p.skip) || (p.skip as number) < 0 ||
    (p.at !== undefined && typeof p.at !== "string") || (p.top !== undefined && !Number.isSafeInteger(p.top))) throw invalid;
  const streams = p.s.map((entry: unknown, i: number) => {
    if (!Array.isArray(entry) || entry[0] !== objects[i] || (entry[1] !== null && typeof entry[1] !== "string")) throw invalid;
    return { address: objects[i], cursor: entry[1] ?? undefined, done: entry[2] === 1 };
  });
  let seen: Position["seen"];
  if (p.seen !== undefined) {
    const [cp, digests] = Array.isArray(p.seen) ? p.seen : [];
    if (!Number.isSafeInteger(cp) || !Array.isArray(digests) || !digests.every((d) => typeof d === "string")) throw invalid;
    seen = { cp, digests };
  }
  return { streams, skip: p.skip as number, at: p.at as string | undefined, top: p.top as number | undefined, seen };
}

/**
 * Whether an event type falls under a requested package, module, struct or
 * instantiated type. Type arguments are compared normalized: the event's
 * type renders every address padded.
 */
export function typeMatches(type: string | undefined, requested: string[] | undefined): boolean {
  if (!requested?.length) return true;
  if (!type) return false;
  const [pkg, mod, name] = type.split("<", 1)[0].split("::");
  return requested.some((r) => {
    const [rPkg, rMod, rName] = r.split("<", 1)[0].split("::");
    if (!rPkg || !pkg || normalizeSuiAddress(rPkg) !== normalizeSuiAddress(pkg)) return false;
    if ((rMod && rMod !== mod) || (rName && rName !== name)) return false;
    if (!r.includes("<")) return true;
    try {
      return normalizeStructTag(r) === normalizeStructTag(type);
    } catch {
      return false;
    }
  });
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

/** First listed object a decoded field names within eight levels, with its field path. */
function namedObject(json: unknown, objects: string[]): { index: number; path: string } | null {
  const visit = (value: unknown, path: string, depth: number): { index: number; path: string } | null => {
    if (typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value)) {
      const index = objects.indexOf(normalizeSuiAddress(value));
      return index < 0 ? null : { index, path };
    }
    if (!value || typeof value !== "object" || depth >= 8) return null;
    for (const [key, child] of Object.entries(value)) {
      const hit = visit(child, path ? `${path}.${key}` : key, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return visit(json, "", 0);
}

/**
 * Decoded events of the transactions affecting one or several objects, in
 * checkpoint order. Several objects are read as aliased connections and
 * merged; a transaction affecting more than one of them is listed once.
 * Transactions of different objects in one checkpoint are ordered by the
 * object's position in the list, since the connection does not expose their
 * order within a checkpoint.
 */
export async function readObjectEvents(opts: {
  /** Canonical object ids, 1 to {@link OBJECT_EVENTS_MAX_OBJECTS}, no repeats. */
  objects: string[];
  /** Checkpoint bounds (exclusive) and the transaction sender, applied in the transaction filter. */
  filter: { afterCheckpoint?: number; beforeCheckpoint?: number; sentAddress?: string };
  /** Event types, modules or packages; an event matching any of them is listed. */
  eventTypes?: string[];
  module: ModuleEventFilterResolution | null;
  /** List only events whose decoded fields name a listed object id. */
  namesObjectOnly?: boolean;
  order: ListOrder;
  limit: number;
  cursor?: string;
}) {
  const { objects, order } = opts;
  const multi = objects.length > 1;
  const position = decodePosition(opts.cursor, order, objects);
  let streams = position.streams;
  let skip = position.skip;
  let at = position.at;
  let top = position.top;
  /** Checkpoint of every transaction fully listed, by digest. */
  const seen = new Map<string, number>((position.seen?.digests ?? []).map((d) => [d, position.seen!.cp]));
  let eventsRead = 0;
  let namesObjectDropped = 0;
  const pages: Array<VersionPage<ObjectTx> | null> = streams.map(() => null);
  /** Streams whose page must reach further before the next transaction is placed. */
  const extend = new Set<number>();
  /** Which listed objects each transaction read so far affected. */
  const affects = new Map<string, Set<number>>();
  const events: Array<Record<string, unknown>> = [];
  const incompleteTransactions: string[] = [];
  let reads = 0;
  let processed = 0;
  let lastCheckpoint: number | undefined;
  let stop = false;
  const take = () => {
    if (reads >= OBJECT_EVENTS_MAX_READS) return false;
    reads++;
    return true;
  };
  const checkpointOf = (tx: ObjectTx) => tx.effects?.checkpoint?.sequenceNumber;

  const readStreams = async (idx: number[]) => {
    const before = top != null ? Math.min(top, opts.filter.beforeCheckpoint ?? top) : opts.filter.beforeCheckpoint;
    for (let start = 0; start < idx.length; start += ALIASES_PER_REQUEST) {
      const chunk = idx.slice(start, start + ALIASES_PER_REQUEST);
      const decls = chunk.map((_, k) => `$f${k}: TransactionFilter!, $c${k}: String`).join(", ");
      const fields = chunk
        .map((_, k) => `o${k}: transactions(filter: $f${k}, ${order === "newest" ? `last: $n, before: $c${k}` : `first: $n, after: $c${k}`}) { ...T }`)
        .join(" ");
      const variables: Record<string, unknown> = { n: TX_PAGE };
      const requested = chunk.map((i) => pages[i]?.nextCursor ?? streams[i].cursor);
      chunk.forEach((i, k) => {
        variables[`f${k}`] = {
          ...opts.filter,
          affectedObject: streams[i].address,
          ...(before != null ? { beforeCheckpoint: before } : {}),
        };
        variables[`c${k}`] = requested[k];
      });
      reads++;
      const data = await gqlQuery<Record<string, TxConnection | null>>(`query($n: Int, ${decls}) { ${fields} } ${TX_FRAGMENT}`, variables);
      chunk.forEach((i, k) => {
        const conn = data[`o${k}`];
        if (!conn?.edges || !conn.pageInfo) throw new Error("An object's transaction connection could not be read.");
        let hasMore = order === "newest" ? conn.pageInfo.hasPreviousPage : conn.pageInfo.hasNextPage;
        let next = (order === "newest" ? conn.pageInfo.startCursor : conn.pageInfo.endCursor) ?? null;
        if (!conn.edges.length && hasMore) {
          // The service answers a read from a list's last cursor, or from one
          // outside the window, with no rows, another page claimed and the same
          // cursor back. A read that returned nothing and did not move is the end.
          if (next === null) throw new Error("An object's transaction connection reports more rows without a cursor.");
          if (next === (requested[k] ?? null)) hasMore = false;
        }
        if (next === null && conn.edges.length) next = (order === "newest" ? conn.edges[0] : conn.edges.at(-1)!).cursor;
        for (const e of conn.edges) {
          if (!e.cursor || !e.node?.digest || !e.node.effects?.events) throw new Error("An object transaction lacks an event connection or cursor.");
          const set = affects.get(e.node.digest) ?? new Set<number>();
          set.add(i);
          affects.set(e.node.digest, set);
        }
        const previous = pages[i]?.edges ?? [];
        pages[i] = {
          edges: order === "newest" ? [...conn.edges, ...previous] : [...previous, ...conn.edges],
          hasMore,
          nextCursor: next ?? pages[i]?.nextCursor ?? null,
        };
      });
    }
  };

  for (; ;) {
    const need = streams.flatMap((s, i) => (!s.done && (!pages[i] || extend.has(i)) ? [i] : []));
    if (need.length) {
      // Every object needs a first read before any row's place is known.
      if (reads > 0 && reads + Math.ceil(need.length / ALIASES_PER_REQUEST) > OBJECT_EVENTS_MAX_READS) break;
      await readStreams(need);
      extend.clear();
      if (order === "newest" && top == null) {
        const read = pages.flatMap((p) => p?.edges.map((e) => checkpointOf(e.node) ?? 0) ?? []);
        if (read.length) top = Math.max(...read) + 1;
      }
    }
    const merged = mergeVersionPages(streams, pages, order, Number.MAX_SAFE_INTEGER, (n) => n.digest, checkpointOf);
    let consumed = 0;
    for (const tx of merged.nodes) {
      if (seen.has(tx.digest)) {
        consumed++;
        continue;
      }
      if (at && tx.digest !== at) throw new Error("The transactions this cursor continues no longer line up. Repeat the call without cursor.");
      const checkpoint = checkpointOf(tx);
      if (multi && checkpoint != null) {
        // Another object's copy of this transaction, and its share of the
        // object list, must be in hand before it is listed: read on any page
        // that has not passed this checkpoint.
        const short = streams.flatMap((s, j) => {
          const page = pages[j];
          if (s.done || !page?.hasMore || affects.get(tx.digest)?.has(j)) return [];
          // The farthest checkpoint this page reaches in walk order.
          const edge = order === "newest" ? page.edges[0] : page.edges.at(-1);
          const reach = edge && checkpointOf(edge.node);
          return reach == null || (order === "newest" ? reach >= checkpoint : reach <= checkpoint) ? [j] : [];
        });
        if (short.length) {
          for (const j of short) extend.add(j);
          break;
        }
      }
      at = undefined;
      const completed = await readAllEvents(tx.digest, tx.effects!.events, take);
      if (completed.truncated) {
        // A later call reads this transaction first, with the whole budget,
        // so its events are completed and a split resumes on the same list.
        if (processed > 0) {
          stop = true;
          break;
        }
        incompleteTransactions.push(tx.digest);
      }
      processed++;
      lastCheckpoint = checkpoint;
      const nodes = order === "newest" ? [...completed.nodes].reverse() : completed.nodes;
      const refs = multi ? [...(affects.get(tx.digest) ?? [])].sort((a, b) => a - b) : [];
      let matched = 0;
      let emitted = 0;
      let split = false;
      for (const e of nodes) {
        eventsRead++;
        if (!typeMatches(e.contents?.type?.repr, opts.eventTypes) ||
          !moduleMatches(e.transactionModule?.fullyQualifiedName, opts.module, checkpoint)) continue;
        const named = namedObject(e.contents?.json, objects);
        if (opts.namesObjectOnly && !named) {
          namesObjectDropped++;
          continue;
        }
        if (matched++ < skip) continue;
        if (events.length >= opts.limit) {
          split = true;
          break;
        }
        emitted++;
        events.push({
          type: e.contents?.type?.repr ?? null,
          emitting_module: e.transactionModule?.fullyQualifiedName ?? null,
          sender: e.sender?.address ?? tx.sender?.address,
          data: e.contents?.json,
          tx_digest: tx.digest,
          checkpoint,
          timestamp: tx.effects?.timestamp,
          names_object: named !== null,
          ...(named ? { names_object_at: named.path } : {}),
          ...(multi ? { object_refs: refs, ...(named ? { named_object_ref: named.index } : {}) } : {}),
        });
      }
      if (split) {
        skip += emitted;
        at = tx.digest;
        stop = true;
        break;
      }
      skip = 0;
      consumed++;
      seen.set(tx.digest, checkpoint ?? 0);
      if (events.length >= opts.limit) {
        stop = true;
        break;
      }
    }
    // Advance each object's position past exactly the transactions consumed,
    // and keep the rest of each page for the next round.
    const advanced = consumed === merged.nodes.length
      ? merged
      : mergeVersionPages(streams, pages, order, consumed, (n) => n.digest, checkpointOf);
    const taken = new Set(merged.nodes.slice(0, consumed).map((n) => n.digest));
    streams.forEach((s, i) => {
      const page = pages[i];
      if (s.done || !page) return;
      const walk = order === "newest" ? [...page.edges].reverse() : page.edges;
      let k = 0;
      while (k < walk.length && taken.has(walk[k].node.digest)) k++;
      const rest = walk.slice(k);
      pages[i] = rest.length || extend.has(i) ? { ...page, edges: order === "newest" ? rest.reverse() : rest } : null;
    });
    streams = advanced.streams;
    if (stop || !advanced.has_next_page) break;
    if (reads >= OBJECT_EVENTS_MAX_READS) break;
    if (!extend.size && !streams.some((s, i) => !s.done && !pages[i])) break;
  }

  const hasNext = at !== undefined || streams.some((s) => !s.done);
  // Only the last checkpoint's transactions can still sit behind another
  // object's position, and only when there are several objects.
  const boundary = lastCheckpoint ?? position.seen?.cp;
  const carried = multi && boundary != null ? [...seen].filter(([, cp]) => cp === boundary).map(([d]) => d) : [];
  const nextCursor = hasNext
    ? encodePosition(order, { streams, skip, at, top, seen: boundary != null ? { cp: boundary, digests: carried } : undefined })
    : null;
  return {
    ...(multi ? { objects } : {}),
    events,
    has_next_page: hasNext,
    next_cursor: nextCursor,
    ...shownRange(events.map((e) => e.timestamp as string | undefined)),
    ...(events.length === 0 ? {
      no_results_hint: opts.namesObjectOnly && namesObjectDropped
        ? `Read ${eventsRead} events in this transaction scan slice; names_object dropped ${namesObjectDropped} that did not name a requested object. ${incompleteTransactions.length ? "Inspect incomplete_transactions before drawing a conclusion." : hasNext ? "Continue with next_cursor; more transactions remain." : "No matching events were found in this slice."}`
        : incompleteTransactions.length
        ? "Some matching transactions have incomplete event reads; inspect incomplete_transactions before concluding no events match."
        : hasNext
          ? "No events matched in this transaction scan slice; continue with next_cursor."
          : opts.cursor
            ? "No events past this cursor in the requested objects and window."
            : "No events matched in transactions affecting the requested objects in this window.",
    } : {}),
    ...(incompleteTransactions.length ? {
      incomplete_transactions: incompleteTransactions,
      incomplete_note: "These transactions had more event pages than this call could read. Read each digest with get_transaction for all its events; filtered results cannot establish absence in those transactions.",
    } : {}),
    ...(hasNext && events.length < opts.limit ? {
      scan: {
        reads,
        note: `The transaction scan stopped after ${reads} reads with ${events.length} of ${opts.limit} matching events. Continue at next_call.`,
        next_call: { tool: "query_events", repeat_with: { order, cursor: nextCursor } },
      },
    } : {}),
  };
}
