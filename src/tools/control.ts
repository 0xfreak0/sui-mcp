import { z } from "zod";
import { numArg, addressListArg, timePointArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { describeWindow, resolveWindow } from "../utils/checkpoint-time.js";
import { resolveEventTypeFilter, resolveModuleEventFilter } from "../utils/package-versions.js";
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
    "(Incident investigation) Draw a random control group from the same population as a cohort you are testing: other addresses that used the same protocol over the same window. Shared funding, common ancestry and timing overlap all look damning until you measure how often they occur by chance; this is what you compare against. Excludes the cohort automatically, samples randomly rather than by size (top-N would compare against whales, which collide more than ordinary wallets), and accepts a seed so the draw can be reproduced by whoever checks the report.",
    {
      module: z
        .string()
        .optional()
        .describe(
          "Population: addresses that called this package/module. Before the relocate_event_module cutover (mainnet checkpoint 69,982,635 on 2024-10-17, testnet 118,397,835 on 2024-10-09, devnet at genesis), events carry the package's ORIGINAL id regardless of the version called; from the cutover on they carry the id of the version actually called. The filter is queried at whichever id (or both, merged) your window needs, and `module_scope` reports how. From the cutover on, any one id (the original included) matches calls through that version only, and `module_scope.other_version_ids` lists the lineage's other ids. Accepts 0x... or 0x...::module.",
        ),
      event_type: z
        .string()
        .optional()
        .describe(
          "Population: addresses that emitted this event struct type. Any version's ID of the defining package works.",
        ),
      size: numArg()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Control group size (default 25). Match it to the cohort; an unequal comparison is hard to read.",
        ),
      exclude: addressListArg()
        .optional()
        .describe(
          "The cohort under test. Excluded from the draw; leaving them in contaminates the comparison.",
        ),
      from: timePointArg()
        .optional()
        .describe("Window start: ISO 8601 timestamp or a checkpoint number."),
      to: timePointArg().optional().describe("Window end: ISO 8601 timestamp, 'now', or a checkpoint."),
      seed: numArg()
        .int()
        .optional()
        .describe(
          "Integer seed. Makes the draw reproducible. Record it alongside the result; without it nobody can redraw your control.",
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

        // Exact edges, as aggregate_events resolves them, so a control drawn
        // over the cohort's window holds the same checkpoints.
        const window = await resolveWindow(from, to);
        // An event carries the package version that defined its struct; a
        // type or module written with an upgraded ID would silently match
        // nothing, drawing an empty control from a real population.
        const typeFilter = event_type ? await resolveEventTypeFilter(event_type) : null;
        const moduleFilter = module
          ? await resolveModuleEventFilter(module, window.after?.checkpoint ?? null, window.before?.checkpoint ?? null)
          : null;

        // One segment when the window sits on one side of the
        // relocate_event_module cutover (or there is no module filter); two
        // when it spans the cutover, queried and merged in turn.
        const segments: Array<{ module?: string; afterCheckpoint: number | null; beforeCheckpoint: number | null }> =
          moduleFilter
            ? moduleFilter.segments.map((s) => ({
                module: s.filter,
                afterCheckpoint: s.afterCheckpoint,
                beforeCheckpoint: s.beforeCheckpoint,
              }))
            : [{ afterCheckpoint: window.after?.checkpoint ?? null, beforeCheckpoint: window.before?.checkpoint ?? null }];

        const budget = max_events ?? DEFAULT_SCAN;
        const senders: string[] = [];
        let scanned = 0;
        // True when any segment stopped mid-scan on budget, or a later
        // segment was skipped entirely because budget was already spent.
        let truncated = false;

        for (const seg of segments) {
          if (scanned >= budget) {
            truncated = true;
            break;
          }
          const filter: Record<string, unknown> = {};
          if (typeFilter) filter.type = typeFilter.filter;
          if (seg.module) filter.module = seg.module;
          if (seg.afterCheckpoint != null) filter.afterCheckpoint = seg.afterCheckpoint;
          if (seg.beforeCheckpoint != null) filter.beforeCheckpoint = seg.beforeCheckpoint;

          let cursor: string | undefined;
          let hasNext = true;
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
          if (hasNext) truncated = true;
        }

        const result = sampleControl(senders, size ?? 25, { exclude, seed });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  filter: { module, event_type },
                  ...(typeFilter?.resolution ? { event_type_resolution: typeFilter.resolution } : {}),
                  ...(moduleFilter?.resolution ? { module_scope: moduleFilter.resolution } : {}),
                  window: describeWindow(from, to, window),
                  events_scanned: scanned,
                  // A truncated scan still gives a valid control — it is a
                  // sample either way — but it is drawn from whichever slice of
                  // the window the scan reached, so say so.
                  population_truncated: truncated,
                  ...result,
                  how_to_use:
                    "Run the same test on this control that you ran on the cohort — find_funding_sources over both, then compare how many share a funder. A cohort rate that matches the control's is not evidence, however striking the cohort looked alone.",
                  ...(result.undersampled
                    ? {
                        warning:
                          `Only ${result.population_size} distinct addresses were available, fewer than the ${result.requested} requested. A control this small will not separate a real effect from chance — widen the window or raise max_events.` +
                          (moduleFilter?.resolution?.other_version_ids
                            ? " From the relocate_event_module cutover on, a `module` filter draws callers of one package version only; module_scope.other_version_ids lists the rest of the lineage."
                            : ""),
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
