import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const EVENTS_QUERY = `
  query($filter: EventFilter, $first: Int, $after: String) {
    events(filter: $filter, first: $first, after: $after) {
      nodes {
        contents { json }
        sender { address }
        transactionModule { fullyQualifiedName }
        timestamp
        transaction { digest }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface EventsPage {
  events: {
    nodes: Array<{
      contents?: { json: unknown };
      sender?: { address: string };
      transactionModule?: { fullyQualifiedName: string };
      timestamp?: string;
      transaction?: { digest: string };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

export function registerEventTools(server: McpServer) {
  server.tool(
    "query_events",
    "Query Sui events with filters. Supports filtering by event type, sender, module, and checkpoint range.",
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
        .string()
        .optional()
        .describe("Only events after this checkpoint"),
      before_checkpoint: z
        .string()
        .optional()
        .describe("Only events before this checkpoint"),
      limit: z.number().optional().describe("Max results (default 20)"),
      after: z.string().optional().describe("Pagination cursor"),
    },
    async ({
      event_type,
      sender,
      module,
      after_checkpoint,
      before_checkpoint,
      limit,
      after,
    }) => {
      const filterParts: Record<string, unknown> = {};
      if (event_type) filterParts.type = event_type;
      if (sender) filterParts.sender = sender;
      if (module) filterParts.module = module;
      if (after_checkpoint)
        filterParts.afterCheckpoint = parseInt(after_checkpoint);
      if (before_checkpoint)
        filterParts.beforeCheckpoint = parseInt(before_checkpoint);

      const variables = {
        filter: Object.keys(filterParts).length > 0 ? filterParts : undefined,
        first: limit ?? 20,
        after: after ?? undefined,
      };
      const data = await gqlQuery<EventsPage>(EVENTS_QUERY, variables);

      const events = data.events.nodes.map((n) => ({
        type: n.transactionModule?.fullyQualifiedName,
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
                events,
                has_next_page: data.events.pageInfo.hasNextPage,
                next_cursor: data.events.pageInfo.endCursor,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "search_events",
    "Search Sui events by content. Fetches events matching the given filters and post-filters by content substring match. Useful for finding events containing specific addresses, amounts, or data.",
    {
      content_contains: z
        .string()
        .describe("Substring to search for in event content (case-insensitive)"),
      event_type: z
        .string()
        .optional()
        .describe("Filter by event type before content search"),
      sender: z.string().optional().describe("Filter by transaction sender"),
      module: z
        .string()
        .optional()
        .describe("Filter by emitting module"),
      after_checkpoint: z
        .string()
        .optional()
        .describe("Only events after this checkpoint"),
      before_checkpoint: z
        .string()
        .optional()
        .describe("Only events before this checkpoint"),
      limit: z
        .number()
        .optional()
        .describe("Max matching results to return (default 10, max 50)"),
    },
    async ({
      content_contains,
      event_type,
      sender,
      module,
      after_checkpoint,
      before_checkpoint,
      limit,
    }) => {
      const targetLimit = Math.min(limit ?? 10, 50);
      const needle = content_contains.toLowerCase();

      const filterParts: Record<string, unknown> = {};
      if (event_type) filterParts.type = event_type;
      if (sender) filterParts.sender = sender;
      if (module) filterParts.module = module;
      if (after_checkpoint)
        filterParts.afterCheckpoint = parseInt(after_checkpoint);
      if (before_checkpoint)
        filterParts.beforeCheckpoint = parseInt(before_checkpoint);

      const filter = Object.keys(filterParts).length > 0 ? filterParts : undefined;
      const matched: Array<Record<string, unknown>> = [];
      let cursor: string | undefined;
      let preFilterCount = 0;
      const maxPages = 10;

      for (let page = 0; page < maxPages && matched.length < targetLimit; page++) {
        const pageSize = Math.min(50, targetLimit * 5);
        const data = await gqlQuery<EventsPage>(EVENTS_QUERY, {
          filter,
          first: pageSize,
          after: cursor ?? undefined,
        });

        for (const n of data.events.nodes) {
          preFilterCount++;
          const json = JSON.stringify(n.contents?.json ?? {}).toLowerCase();
          if (json.includes(needle)) {
            matched.push({
              type: n.transactionModule?.fullyQualifiedName,
              sender: n.sender?.address,
              data: n.contents?.json,
              tx_digest: n.transaction?.digest,
              timestamp: n.timestamp,
            });
            if (matched.length >= targetLimit) break;
          }
        }

        if (!data.events.pageInfo.hasNextPage) break;
        cursor = data.events.pageInfo.endCursor ?? undefined;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                content_filter: content_contains,
                pre_filter_count: preFilterCount,
                match_count: matched.length,
                events: matched,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
