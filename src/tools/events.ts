import { z } from "zod";
import { numArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { describeWindow, resolveWindow } from "../utils/checkpoint-time.js";
import { resolveEventTypeFilter, versionScopeNote } from "../utils/package-versions.js";
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

export function registerEventTools(server: McpServer) {
  server.tool(
    "query_events",
    "Query Sui events with filters (type, sender, emitting module, time or checkpoint range). Returns each event's type AND its DECODED FIELDS, so there is no need to hand-write a GraphQL query to read event values; the GraphQL Event has neither `type` nor `json` at its top level (both sit under `contents`). Use this to measure per-protocol flow: a transaction's balance changes cover the whole PTB and over-attribute, while a protocol's own events do not. Newest first by default; each page reports its `order`, `oldest_shown`/`newest_shown` and the resolved `window`, and `next_cursor` goes back as `cursor` with the same `order`. An event carries the ID of the package version that DEFINED its struct, so an `event_type` written with an upgraded package ID is rewritten to the defining one and `event_type_resolution` says so. A `module` filter matches one package version; `module_scope` names the lineage when there are others. For the events of ONE known transaction, use get_transaction instead: it returns them already decoded.",
    {
      event_type: z
        .string()
        .optional()
        .describe("Filter by event type (e.g. 0x2::coin::CoinBalanceChange)"),
      sender: z.string().optional().describe("Filter by transaction sender"),
      module: z
        .string()
        .optional()
        .describe("Filter by emitting module (e.g. 0x2::coin or 0x2)"),
      after_checkpoint: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Only events after this point: a checkpoint number, or an ISO 8601 time (2026-08-07T00:00:00Z), which includes events at that time"),
      before_checkpoint: z
        .union([z.string(), z.number()])
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

        const filterParts: Record<string, unknown> = {};
        if (typeFilter) filterParts.type = typeFilter.filter;
        if (sender) filterParts.sender = sender;
        if (module) filterParts.module = module;
        if (window.after?.checkpoint != null) filterParts.afterCheckpoint = window.after.checkpoint;
        if (window.before?.checkpoint != null) filterParts.beforeCheckpoint = window.before.checkpoint;

        const variables = {
          filter: Object.keys(filterParts).length > 0 ? filterParts : undefined,
          ...orderedPageArgs(direction, limit ?? 20, cursor),
        };
        const [data, moduleScope] = await Promise.all([
          gqlQuery<EventsPage>(EVENTS_QUERY, variables),
          module ? versionScopeNote(module, "module") : Promise.resolve(null),
        ]);
        const page = orderedPage(data.events.nodes, data.events.pageInfo, direction);

        const events = page.nodes.map((n) => ({
          // The event struct's own type (`0xpkg::module::EventName`). Previously
          // this reported `transactionModule`, which is the module whose function
          // was *called* — for anything routed through an aggregator those are
          // different packages entirely, so a DeepBook OrderCanceled came back
          // labelled with the router's module. Filtering by event_type still
          // worked; reading the type back did not.
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
                  ...shownRange(page.nodes.map((n) => n.timestamp)),
                  ...(typeFilter?.resolution ? { event_type_resolution: typeFilter.resolution } : {}),
                  ...(moduleScope ? { module_scope: moduleScope } : {}),
                  events,
                  has_next_page: page.has_next_page,
                  next_cursor: page.next_cursor,
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
