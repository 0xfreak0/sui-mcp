import { z } from "zod";
import { numArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { latestCheckpoint, toCheckpoint } from "../utils/checkpoint-time.js";
import { sampleControl } from "../utils/control-sample.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SENDER_QUERY = `query ($filter: EventFilter, $first: Int, $after: String) {
  events(filter: $filter, first: $first, after: $after) {
    nodes { sender { address } }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface SenderPage {
  events: {
    nodes: Array<{ sender?: { address: string } }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

/** GraphQL caps a page at 50. */
const PAGE_SIZE = 50;
const DEFAULT_SCAN = 5000;

export function registerControlTools(server: McpServer) {
  server.tool(
    "sample_control_addresses",
    "(Incident investigation) Draw a random control group from the same population as a cohort you are testing — other addresses that used the same protocol over the same window. Shared funding, common ancestry and timing overlap all look damning until you measure how often they occur by chance; this is what you compare against. Excludes the cohort automatically, samples randomly rather than by size (top-N would compare against whales, which collide more than ordinary wallets), and accepts a seed so the draw can be reproduced by whoever checks the report.",
    {
      module: z
        .string()
        .optional()
        .describe(
          "Population: addresses that called this package/module. Accepts 0x... or 0x...::module.",
        ),
      event_type: z
        .string()
        .optional()
        .describe("Population: addresses that emitted this event struct type."),
      size: numArg()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Control group size (default 25). Match it to the cohort — an unequal comparison is hard to read.",
        ),
      exclude: z
        .array(z.string())
        .optional()
        .describe(
          "The cohort under test. Excluded from the draw; leaving them in contaminates the comparison.",
        ),
      from: z
        .string()
        .optional()
        .describe("Window start: ISO 8601 timestamp or a checkpoint number."),
      to: z.string().optional().describe("Window end: ISO 8601 timestamp, 'now', or a checkpoint."),
      seed: numArg()
        .int()
        .optional()
        .describe(
          "Makes the draw reproducible. Record it alongside the result — without it nobody can redraw your control.",
        ),
      max_events: numArg()
        .int()
        .min(50)
        .max(50000)
        .optional()
        .describe("Events to scan when building the population (default 5000)."),
    },
    async ({ module, event_type, size, exclude, from, to, seed, max_events }) => {
      try {
        if (!module && !event_type) {
          return errorResult(
            "Provide module or event_type. A control group only means something when it is drawn from the same population as the cohort — sampling the whole chain compares against everyone, which is not a control.",
          );
        }

        const latest = await latestCheckpoint();
        const fromCp = await toCheckpoint(from, latest);
        const toCp = await toCheckpoint(to, latest);

        const filter: Record<string, unknown> = {};
        if (event_type) filter.type = event_type;
        if (module) filter.module = module;
        if (fromCp) filter.afterCheckpoint = fromCp.checkpoint;
        if (toCp) filter.beforeCheckpoint = toCp.checkpoint;

        const budget = max_events ?? DEFAULT_SCAN;
        const senders: string[] = [];
        let cursor: string | undefined;
        let hasNext = true;
        let scanned = 0;

        while (hasNext && scanned < budget) {
          const page: SenderPage = await gqlQuery(SENDER_QUERY, {
            filter,
            first: Math.min(PAGE_SIZE, budget - scanned),
            after: cursor,
          });
          for (const n of page.events.nodes) {
            scanned++;
            if (n.sender?.address) senders.push(n.sender.address);
          }
          hasNext = page.events.pageInfo.hasNextPage;
          cursor = page.events.pageInfo.endCursor;
          if (!cursor) break;
        }

        const result = sampleControl(senders, size ?? 25, { exclude, seed });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  filter: { module, event_type },
                  window: { from: fromCp, to: toCp },
                  events_scanned: scanned,
                  // A truncated scan still gives a valid control — it is a
                  // sample either way — but it is drawn from whichever slice of
                  // the window the scan reached, so say so.
                  population_truncated: hasNext,
                  ...result,
                  how_to_use:
                    "Run the same test on this control that you ran on the cohort — find_funding_sources over both, then compare how many share a funder. A cohort rate that matches the control's is not evidence, however striking the cohort looked alone.",
                  ...(result.undersampled
                    ? {
                        warning: `Only ${result.population_size} distinct addresses were available, fewer than the ${result.requested} requested. A control this small will not separate a real effect from chance — widen the window or raise max_events.`,
                      }
                    : {}),
                  ...(result.seed === null
                    ? {
                        note: "No seed given, so this draw cannot be reproduced. Pass `seed` if the result is going into a report.",
                      }
                    : {}),
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
