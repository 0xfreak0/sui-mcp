import { z } from "zod";
import { numArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import {
  aggregateEvents,
  suggestValueFields,
  type AggregatableEvent,
} from "../utils/aggregate.js";
import { latestCheckpoint, toCheckpoint } from "../utils/checkpoint-time.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const PAGE_QUERY = `query ($filter: EventFilter, $first: Int, $after: String) {
  events(filter: $filter, first: $first, after: $after) {
    nodes {
      contents { type { repr } json }
      sender { address }
      timestamp
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface EventPage {
  events: {
    nodes: Array<{
      contents?: { type?: { repr: string }; json: unknown };
      sender?: { address: string };
      timestamp?: string;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

/** GraphQL caps a page at 50, so a big window is a lot of round trips. */
const PAGE_SIZE = 50;
const DEFAULT_MAX_EVENTS = 10_000;

export function registerAggregateTools(server: McpServer) {
  server.tool(
    "aggregate_events",
    "(Analytics) Rank addresses or event types by activity across a time window — the 'who were the top wallets on this protocol today' question — in one call instead of paginating thousands of events yourself. " +
      "Filter by event type, module or sender, bound by ISO timestamps or checkpoints, and group by sender or event type. " +
      "Call it WITHOUT value_field first: it returns counts plus a sample event and the numeric fields available, so you can see what the protocol emits (many carry their own USD valuation) and then re-run naming that field. " +
      "Always check `truncated` — a partial scan produces a confidently wrong ranking.",
    {
      event_type: z
        .string()
        .optional()
        .describe(
          "Filter by the event STRUCT's type — the package that DEFINES the event, which is often not the package you called. Accepts 0x..., 0x...::module, or 0x...::module::EventName.",
        ),
      module: z
        .string()
        .optional()
        .describe(
          "Filter by the EMITTING package/module — the one whose function ran. Usually what you want when you know a protocol's package ID. Accepts 0x... or 0x...::module.",
        ),
      sender: z.string().optional().describe("Only events sent by this address."),
      from: z
        .string()
        .optional()
        .describe("Window start: ISO 8601 timestamp (2026-08-07T00:00:00Z) or a checkpoint number."),
      to: z
        .string()
        .optional()
        .describe("Window end: ISO 8601 timestamp, 'now', or a checkpoint number."),
      group_by: z
        .enum(["sender", "event_type"])
        .optional()
        .describe("What to rank (default 'sender')."),
      value_field: z
        .string()
        .optional()
        .describe(
          "Dotted path into the event JSON to sum, e.g. 'deposit_value'. Omit to get counts plus field suggestions.",
        ),
      value_scale: numArg()
        .optional()
        .describe("Divisor for the summed value, e.g. 100 when a protocol reports USD cents."),
      top: numArg().int().min(1).max(200).optional().describe("Groups to return (default 20)."),
      sort_order: z
        .enum(["desc", "asc"])
        .optional()
        .describe(
          "'desc' (default) returns the largest — whales. 'asc' returns the smallest, which is where coordinated dust activity lives: a swarm of wallets each doing one tiny action is invisible in a top-N view.",
        ),
      max_events: numArg()
        .int()
        .min(50)
        .max(50_000)
        .optional()
        .describe(`Scan budget (default ${DEFAULT_MAX_EVENTS}). Raise for busy protocols, or narrow the window.`),
    },
    async ({
      event_type,
      module,
      sender,
      from,
      to,
      group_by,
      value_field,
      value_scale,
      top,
      sort_order,
      max_events,
    }) => {
      try {
        if (!event_type && !module && !sender) {
          return errorResult(
            "Provide at least one of event_type, module or sender. Aggregating every event on the chain is not a bounded query.",
          );
        }

        // One latest-checkpoint probe shared by both bounds.
        const latest = await latestCheckpoint();
        const fromCp = await toCheckpoint(from, latest);
        const toCp = await toCheckpoint(to, latest);

        const filter: Record<string, unknown> = {};
        if (event_type) filter.type = event_type;
        if (module) filter.module = module;
        if (sender) filter.sender = sender;
        if (fromCp) filter.afterCheckpoint = fromCp.checkpoint;
        if (toCp) filter.beforeCheckpoint = toCp.checkpoint;

        const budget = max_events ?? DEFAULT_MAX_EVENTS;
        const events: AggregatableEvent[] = [];
        let cursor: string | undefined;
        let hasNext = true;
        let pages = 0;
        // One sample per event type, not just the first event seen. A protocol
        // emits bookkeeping events (reward refreshes, rate updates) far more
        // often than user actions, so a single sample almost always describes
        // the wrong thing and suggests fields nobody wants to sum.
        const samplesByType = new Map<string, unknown>();
        const countsByType = new Map<string, number>();

        while (hasNext && events.length < budget) {
          const page: EventPage = await gqlQuery(PAGE_QUERY, {
            filter,
            first: Math.min(PAGE_SIZE, budget - events.length),
            after: cursor,
          });
          pages++;

          for (const n of page.events.nodes) {
            const t = n.contents?.type?.repr;
            if (t) {
              countsByType.set(t, (countsByType.get(t) ?? 0) + 1);
              if (!samplesByType.has(t) && n.contents?.json) samplesByType.set(t, n.contents.json);
            }
            events.push({
              sender: n.sender?.address ?? null,
              type: n.contents?.type?.repr ?? null,
              data: n.contents?.json,
            });
          }

          hasNext = page.events.pageInfo.hasNextPage;
          cursor = page.events.pageInfo.endCursor;
          if (!cursor) break;
        }

        const result = aggregateEvents(events, {
          groupBy: group_by ?? "sender",
          valueField: value_field,
          valueScale: value_scale,
          top,
          sortOrder: sort_order,
        });

        // Truncation is surfaced loudly: a ranking built from a partial scan
        // looks exactly like a complete one, and that is how a wrong answer
        // gets believed.
        const truncated = hasNext && events.length >= budget;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  filter: {
                    ...(event_type ? { event_type } : {}),
                    ...(module ? { module } : {}),
                    ...(sender ? { sender } : {}),
                  },
                  window: {
                    from: fromCp
                      ? { checkpoint: fromCp.checkpoint, ...(fromCp.actual_time ? { resolved_time: fromCp.actual_time } : {}) }
                      : null,
                    to: toCp
                      ? { checkpoint: toCp.checkpoint, ...(toCp.actual_time ? { resolved_time: toCp.actual_time } : {}) }
                      : null,
                  },
                  group_by: group_by ?? "sender",
                  events_scanned: events.length,
                  pages_fetched: pages,
                  truncated,
                  ...(truncated
                    ? {
                        truncation_warning:
                          `Hit the ${budget}-event budget with more available. This ranking is INCOMPLETE — ` +
                          "narrow from/to or raise max_events before drawing conclusions.",
                      }
                    : {}),
                  ...(events.length === 0
                    ? {
                        no_results_hint:
                          "No events matched. `event_type` filters on the struct's DEFINING package, which for many " +
                          "protocols differs from the package you call — try `module` with the same address instead. " +
                          "Also check the window: bounds are checkpoints, and GraphQL retains only recent history.",
                      }
                    : {}),
                  distinct_keys: result.distinct_keys,
                  sort_order: sort_order ?? "desc",
                  // Computed over every group, not the returned page: a top-20
                  // view says nothing about the shape of the other 900.
                  distribution: result.distribution,
                  ...(result.ungrouped_count
                    ? { ungrouped_events: result.ungrouped_count }
                    : {}),
                  ...(value_field
                    ? { value_field, value_scale: value_scale ?? 1 }
                    : {
                        // Discovery, per event type — this is what replaces a
                        // per-protocol schema registry. Ordered by frequency so
                        // the noisy bookkeeping events are visible as such.
                        event_types: [...countsByType.entries()]
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 15)
                          .map(([type, count]) => ({
                            type,
                            count,
                            numeric_fields: suggestValueFields(samplesByType.get(type)),
                            sample: samplesByType.get(type),
                          })),
                        hint:
                          "Pick the event type that represents the action you care about (user actions are " +
                          "usually rarer than bookkeeping events), then re-run with event_type set to it and " +
                          "value_field set to one of its numeric_fields.",
                      }),
                  groups: result.groups,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
