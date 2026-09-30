import { z } from "zod";
import { numArg, addressArg, refinePoint } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { describeWindow, resolveWindow } from "../utils/checkpoint-time.js";
import { resolveEventTypeFilter, resolveModuleEventFilter } from "../utils/package-versions.js";
import {
  BOTH_WAYS_PAGE_INFO,
  orderedPage,
  orderedPageArgs,
  shownRange,
  type BothWaysPageInfo,
} from "../utils/pagination.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const EVENTS_QUERY = `
  query($filter: EventFilter, $first: Int, $after: String, $last: Int, $before: String) {
    events(filter: $filter, first: $first, after: $after, last: $last, before: $before) {
      nodes {
        contents { type { repr } json }
        sender { address }
        transactionModule { fullyQualifiedName }
        timestamp
        transaction { digest }
      }
      ${BOTH_WAYS_PAGE_INFO}
    }
  }
`;

interface EventsPage {
  events: {
    nodes: Array<{
      contents?: { type?: { repr: string }; json: unknown };
      sender?: { address: string };
      transactionModule?: { fullyQualifiedName: string };
      timestamp?: string;
      transaction?: { digest: string };
    }>;
    pageInfo: BothWaysPageInfo;
  };
}

/**
 * A module filter split by the relocate_event_module cutover pages as two
 * disjoint, chronologically ordered segments rather than one connection, so
 * a page's cursor names which segment it continues: `"segIndex|innerCursor"`.
 */
function encodeSegmentCursor(segIdx: number, inner: string | null): string {
  return `${segIdx}|${inner ?? ""}`;
}
function decodeSegmentCursor(cursor: string | undefined): { segIdx: number; inner?: string } {
  if (!cursor) return { segIdx: 0, inner: undefined };
  const bar = cursor.indexOf("|");
  if (bar === -1) return { segIdx: 0, inner: cursor };
  const segIdx = Number(cursor.slice(0, bar));
  const inner = cursor.slice(bar + 1);
  return { segIdx: Number.isInteger(segIdx) ? segIdx : 0, inner: inner || undefined };
}

/**
 * Reads one call makes to fill a page. The service reads a bounded range per
 * request, so a request can return fewer events than asked, or none, while
 * more remain: `sender` with `event_type` returned an empty page and
 * `hasPreviousPage` while the matches sat further back. Reading continues until
 * the page is full, the list ends or this many reads are spent, and a call the
 * budget stopped short says so in `scan`.
 */
export const QUERY_EVENTS_MAX_READS = 10;

export function registerEventTools(server: McpServer) {
  server.tool(
    "query_events",
    "Query events by type, sender, emitting module or time/checkpoint range. Event fields are decoded; no hand-written GraphQL is needed. Use a protocol's own events to measure its flow: whole-PTB balance changes can over-attribute it. For one known transaction, use get_transaction. Pages default to newest first and report order, timestamp bounds and the resolved window. Continue with next_cursor as cursor, preserving order and filters; short service pages are filled to limit, and scan names the continuation if the read budget stops first. Event types use their struct's defining package ID: upgraded IDs are rewritten and event_type_resolution reports it. Module filters follow the network's emitting-ID cutover, using the original ID before it and the called version afterward, merging both for crossing windows. module_scope reports the scope and other version IDs; after cutover, one ID covers only that version. Framework packages upgraded in place keep one ID covering the lineage.",
    {
      event_type: z
        .string()
        .optional()
        .describe("Filter by event type (e.g. 0x2::coin::CoinBalanceChange)"),
      sender: addressArg().optional().describe("Filter by transaction sender"),
      module: z
        .string()
        .optional()
        .describe(
          "Emitting module or package, e.g. 0x2::coin or 0x2. The window selects original or called-version ID across the network cutover. module_scope reports scope; other_version_ids lists versions a post-cutover ID misses.",
        ),
      after_checkpoint: z
        .union([z.string(), z.number()])
        .superRefine(refinePoint)
        .optional()
        .describe("Events after this checkpoint number (exclusive), or at/after this ISO 8601 time (inclusive)."),
      before_checkpoint: z
        .union([z.string(), z.number()])
        .superRefine(refinePoint)
        .optional()
        .describe("Events before this checkpoint number (exclusive), or at/before this ISO 8601 time (inclusive)."),
      order: z
        .enum(["newest", "oldest"])
        .optional()
        .describe("'newest' (default) starts at the most recent event in range and pages back; 'oldest' starts at the earliest and pages forward."),
      limit: numArg().int().min(1).max(50).optional().describe("Max results (default 20, max 50)"),
      cursor: z.string().optional().describe("`next_cursor` from the previous page. Pass the same `order` and filters."),
    },
    async ({
      event_type,
      sender,
      module,
      after_checkpoint,
      before_checkpoint,
      order,
      limit,
      cursor,
    }) => {
      try {
        const direction = order ?? "newest";
        const window = await resolveWindow(after_checkpoint, before_checkpoint);
        const typeFilter = event_type ? await resolveEventTypeFilter(event_type) : null;
        const moduleFilter = module
          ? await resolveModuleEventFilter(module, window.after?.checkpoint ?? null, window.before?.checkpoint ?? null)
          : null;
        const pageSize = limit ?? 20;

        const baseFilter: Record<string, unknown> = {};
        if (typeFilter) baseFilter.type = typeFilter.filter;
        if (sender) baseFilter.sender = sender;

        // One connection per segment. A window spanning the
        // relocate_event_module cutover indexes this module's events under
        // different package ids on each side, so reading it takes two
        // disjoint queries merged into one page sequence. Segments are
        // chronological (oldest first); read order follows display order, and
        // a composite cursor resumes on the right side of the cutover. Any
        // other filter is one segment and passes the service's cursor through.
        const split = moduleFilter !== null && moduleFilter.segments.length > 1;
        let segmentFilters: Array<Record<string, unknown>>;
        if (split) {
          const readOrder = direction === "newest" ? [...moduleFilter.segments].reverse() : moduleFilter.segments;
          segmentFilters = readOrder.map((seg) => {
            const filterParts: Record<string, unknown> = { ...baseFilter, module: seg.filter };
            if (seg.afterCheckpoint != null) filterParts.afterCheckpoint = seg.afterCheckpoint;
            if (seg.beforeCheckpoint != null) filterParts.beforeCheckpoint = seg.beforeCheckpoint;
            return filterParts;
          });
        } else {
          const filterParts: Record<string, unknown> = { ...baseFilter };
          if (moduleFilter) filterParts.module = moduleFilter.segments[0].filter;
          if (window.after?.checkpoint != null) filterParts.afterCheckpoint = window.after.checkpoint;
          if (window.before?.checkpoint != null) filterParts.beforeCheckpoint = window.before.checkpoint;
          segmentFilters = [filterParts];
        }

        const start = split ? decodeSegmentCursor(cursor) : { segIdx: 0, inner: cursor };
        let segIdx = start.segIdx;
        let innerCursor = start.inner;
        // Oldest first, a single connection returns its cursor at the end of
        // the list too, so a later call with it reads only what came after.
        let endCursor: string | null = null;
        let reads = 0;
        const rawNodes: EventsPage["events"]["nodes"] = [];
        while (segIdx < segmentFilters.length && rawNodes.length < pageSize && reads < QUERY_EVENTS_MAX_READS) {
          const filterParts = segmentFilters[segIdx];
          const data = await gqlQuery<EventsPage>(EVENTS_QUERY, {
            filter: Object.keys(filterParts).length > 0 ? filterParts : undefined,
            ...orderedPageArgs(direction, pageSize - rawNodes.length, innerCursor),
          });
          reads += 1;
          const page = orderedPage(data.events.nodes, data.events.pageInfo, direction);
          rawNodes.push(...page.nodes);
          if (!page.has_next_page) {
            endCursor = page.next_cursor;
            segIdx += 1;
            innerCursor = undefined;
            continue;
          }
          innerCursor = page.next_cursor ?? undefined;
          // A claimed next page with no cursor would re-read this one.
          if (innerCursor === undefined) break;
        }
        const hasNextPage = segIdx < segmentFilters.length;
        let nextCursor: string | null;
        if (split) nextCursor = hasNextPage ? encodeSegmentCursor(segIdx, innerCursor ?? null) : null;
        else nextCursor = hasNextPage ? (innerCursor ?? null) : endCursor;
        const budgetSpent = hasNextPage && rawNodes.length < pageSize && reads >= QUERY_EVENTS_MAX_READS;

        const events = rawNodes.map((n) => ({
          // The event struct's own type (`0xpkg::module::EventName`).
          // `transactionModule` is the module whose function was *called*; for
          // anything routed through an aggregator that is a different package
          // from the one defining the event.
          type: n.contents?.type?.repr ?? null,
          // Kept, but named for what it is: useful for telling which protocol's
          // entrypoint emitted an event inside a multi-leg PTB.
          emitting_module: n.transactionModule?.fullyQualifiedName ?? null,
          sender: n.sender?.address,
          data: n.contents?.json,
          tx_digest: n.transaction?.digest,
          timestamp: n.timestamp,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                order: direction,
                window: describeWindow(after_checkpoint, before_checkpoint, window),
                ...shownRange(rawNodes.map((n) => n.timestamp)),
                ...(typeFilter?.resolution ? { event_type_resolution: typeFilter.resolution } : {}),
                ...(moduleFilter?.resolution ? { module_scope: moduleFilter.resolution } : {}),
                events,
                has_next_page: hasNextPage,
                next_cursor: nextCursor,
                ...(budgetSpent
                  ? {
                      scan: {
                        reads,
                        note: `The service reads a bounded range per request and can return fewer events than asked, or none, while more remain. This call spent its ${reads} reads with ${events.length} of ${pageSize} events found; the list continues at next_call.`,
                        next_call: { tool: "query_events", repeat_with: { order: direction, cursor: nextCursor } },
                      },
                    }
                  : {}),
              }),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

}
