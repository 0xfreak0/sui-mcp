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

export function registerEventTools(server: McpServer) {
  server.tool(
    "query_events",
    "Query Sui events with filters (type, sender, emitting module, time or checkpoint range). Returns each event's type AND its DECODED FIELDS, so there is no need to hand-write a GraphQL query to read event values; the GraphQL Event has neither `type` nor `json` at its top level (both sit under `contents`). Use this to measure per-protocol flow: a transaction's balance changes cover the whole PTB and over-attribute, while a protocol's own events do not. Newest first by default; each page reports its `order`, `oldest_shown`/`newest_shown` and the resolved `window`, and `next_cursor` goes back as `cursor` with the same `order`. An event carries the ID of the package version that DEFINED its struct, so an `event_type` written with an upgraded package ID is rewritten to the defining one and `event_type_resolution` says so. A module's emitting id depends on when the call happened: before mainnet checkpoint 69,982,635 (2024-10-17) Sui anchored it to the package's ORIGINAL id for the life of the lineage regardless of the version called; from that checkpoint on it is the id of the version that was actually called. A `module` filter is queried at whichever id (or both, merged, for a window spanning the cutover) the window needs, and `module_scope` reports how. A framework package upgraded in place (0x2, 0x3…) keeps one ID for every version, so its filter already covers the whole lineage. For the events of ONE known transaction, use get_transaction instead: it returns them already decoded.",
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
          "Filter by emitting module (e.g. 0x2::coin or 0x2). Before the relocate_event_module cutover (mainnet checkpoint 69,982,635 on 2024-10-17, testnet 118,397,835 on 2024-10-09, devnet at genesis), events carry the package's ORIGINAL id regardless of the version called; from the cutover on they carry the id of the version actually called. The filter is queried at whichever id (or both, merged) your window needs, and `module_scope` reports how. From the cutover on, any one id (the original included) matches calls through that version only, and `module_scope.other_version_ids` lists the lineage's other ids.",
        ),
      after_checkpoint: z
        .union([z.string(), z.number()])
        .superRefine(refinePoint)
        .optional()
        .describe("Only events after this point: a checkpoint number, or an ISO 8601 time (2026-08-07T00:00:00Z), which includes events at that time"),
      before_checkpoint: z
        .union([z.string(), z.number()])
        .superRefine(refinePoint)
        .optional()
        .describe("Only events before this point: a checkpoint number, or an ISO 8601 time, which includes events at that time"),
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

        let rawNodes: EventsPage["events"]["nodes"];
        let hasNextPage: boolean;
        let nextCursor: string | null;

        if (moduleFilter && moduleFilter.segments.length > 1) {
          // The window spans the relocate_event_module cutover: this module's
          // events are indexed under different package ids on each side, so
          // reading it takes two disjoint queries merged into one page
          // sequence. Segments are chronological (oldest first); read order
          // follows display order, and a composite cursor resumes on the
          // right side of the cutover.
          const readOrder = direction === "newest" ? [...moduleFilter.segments].reverse() : moduleFilter.segments;
          const decoded = decodeSegmentCursor(cursor);
          let segIdx = decoded.segIdx;
          let innerCursor = decoded.inner;
          let remaining = pageSize;
          const collected: EventsPage["events"]["nodes"] = [];
          hasNextPage = false;
          nextCursor = null;

          while (segIdx < readOrder.length && remaining > 0) {
            const seg = readOrder[segIdx];
            const filterParts: Record<string, unknown> = { ...baseFilter, module: seg.filter };
            if (seg.afterCheckpoint != null) filterParts.afterCheckpoint = seg.afterCheckpoint;
            if (seg.beforeCheckpoint != null) filterParts.beforeCheckpoint = seg.beforeCheckpoint;
            const segData = await gqlQuery<EventsPage>(EVENTS_QUERY, {
              filter: filterParts,
              ...orderedPageArgs(direction, remaining, innerCursor),
            });
            const segPage = orderedPage(segData.events.nodes, segData.events.pageInfo, direction);
            collected.push(...segPage.nodes);
            remaining -= segPage.nodes.length;
            if (segPage.has_next_page) {
              hasNextPage = true;
              nextCursor = encodeSegmentCursor(segIdx, segPage.next_cursor);
              break;
            }
            segIdx += 1;
            innerCursor = undefined;
            if (segIdx < readOrder.length) {
              hasNextPage = true;
              nextCursor = encodeSegmentCursor(segIdx, null);
            } else {
              hasNextPage = false;
              nextCursor = null;
            }
          }
          rawNodes = collected;
        } else {
          const filterParts: Record<string, unknown> = { ...baseFilter };
          if (moduleFilter) filterParts.module = moduleFilter.segments[0].filter;
          if (window.after?.checkpoint != null) filterParts.afterCheckpoint = window.after.checkpoint;
          if (window.before?.checkpoint != null) filterParts.beforeCheckpoint = window.before.checkpoint;

          const data = await gqlQuery<EventsPage>(EVENTS_QUERY, {
            filter: Object.keys(filterParts).length > 0 ? filterParts : undefined,
            ...orderedPageArgs(direction, pageSize, cursor),
          });
          const page = orderedPage(data.events.nodes, data.events.pageInfo, direction);
          rawNodes = page.nodes;
          hasNextPage = page.has_next_page;
          nextCursor = page.next_cursor;
        }

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
              text: JSON.stringify(
                {
                  order: direction,
                  window: describeWindow(after_checkpoint, before_checkpoint, window),
                  ...shownRange(rawNodes.map((n) => n.timestamp)),
                  ...(typeFilter?.resolution ? { event_type_resolution: typeFilter.resolution } : {}),
                  ...(moduleFilter?.resolution ? { module_scope: moduleFilter.resolution } : {}),
                  events,
                  has_next_page: hasNextPage,
                  next_cursor: nextCursor,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );

}
