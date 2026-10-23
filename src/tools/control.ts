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

function encodeScanCursor(segment: number, after?: string): string {
  return Buffer.from(JSON.stringify([segment, after ?? null])).toString("base64url");
}

function decodeScanCursor(cursor: string, segments: number): { segment: number; after?: string } {
  const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 2 ||
    !Number.isInteger(parsed[0]) || parsed[0] < 0 || parsed[0] >= segments ||
    (parsed[1] !== null && (typeof parsed[1] !== "string" || !parsed[1]))) {
    throw new Error("Invalid cursor; follow the unmodified scan.next_call.");
  }
  return { segment: parsed[0] as number, ...(parsed[1] === null ? {} : { after: parsed[1] as string }) };
}

export function registerControlTools(server: McpServer) {
  server.tool(
    "sample_control_addresses",
    "(Incident investigation) Sample addresses that used the same protocol over the same window as a cohort, to measure how often a signal such as shared funding, common ancestry or timing overlap occurs by chance. Select the population by module or event_type, exclude the cohort, and pass a seed for a reproducible draw. Sampling is random rather than ranked by activity.",
    {
      module: z
        .string()
        .optional()
        .describe(
          "Population: addresses that called this package or module, 0x... or 0x...::module. The window selects original or called-version ID across the network cutover. module_scope reports scope; other_version_ids lists versions a post-cutover ID misses.",
        ),
      event_type: z
        .string()
        .optional()
        .describe(
          "Population: addresses that emitted this event struct type. Any version's ID of the defining package works; an unknown struct or struct-less module returns candidates.",
        ),
      size: numArg()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Control group size (default 25). Choose a size comparable to the cohort.",
        ),
      exclude: addressListArg()
        .optional()
        .describe(
          "Cohort addresses to exclude from the draw.",
        ),
      from: timePointArg()
        .optional()
        .describe("Window start: ISO 8601 timestamp or a checkpoint number."),
      to: timePointArg().optional().describe("Window end: ISO 8601 timestamp, 'now', or a checkpoint."),
      seed: numArg()
        .int()
        .optional()
        .describe(
          "Integer seed for a reproducible draw. Record it with the result.",
        ),
      max_events: numArg()
        .int()
        .min(50)
        .max(50000)
        .optional()
        .describe("Events to scan when building the population (default 5000)."),
      cursor: z.string().min(1).optional()
        .describe("Opaque cursor from scan.next_call. Each call draws a separate slice of the same population."),
    },
    async ({ module, event_type, size, exclude, from, to, seed, max_events, cursor }) => {
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
        const start = cursor ? decodeScanCursor(cursor, segments.length) : { segment: 0, after: undefined };
        const senders: string[] = [];
        let scanned = 0;
        // True when any segment stopped mid-scan on budget, or a later
        // segment was skipped entirely because budget was already spent.
        let truncated = false;
        let nextCursor: string | null = null;
        let cursorStalled = false;

        for (let index = start.segment; index < segments.length; index++) {
          const seg = segments[index];
          if (scanned >= budget) {
            truncated = true;
            nextCursor = encodeScanCursor(index, index === start.segment ? start.after : undefined);
            break;
          }
          const filter: Record<string, unknown> = {};
          if (typeFilter) filter.type = typeFilter.filter;
          if (seg.module) filter.module = seg.module;
          if (seg.afterCheckpoint != null) filter.afterCheckpoint = seg.afterCheckpoint;
          if (seg.beforeCheckpoint != null) filter.beforeCheckpoint = seg.beforeCheckpoint;

          let after: string | undefined = index === start.segment ? start.after : undefined;
          let hasNext = true;
          while (hasNext && scanned < budget) {
            const page: SenderPage = await gqlQuery(SENDER_QUERY, {
              filter,
              first: Math.min(PAGE_SIZE, budget - scanned),
              after,
            });
            for (const n of page.events.nodes) {
              scanned++;
              if (n.sender?.address) senders.push(n.sender.address);
            }
            hasNext = page.events.pageInfo.hasNextPage;
            const endCursor = page.events.pageInfo.endCursor;
            if (hasNext && (!endCursor || endCursor === after)) {
              truncated = true;
              cursorStalled = true;
              break;
          }
            after = endCursor;
          }
          if (hasNext) {
            truncated = true;
            if (after && !cursorStalled) nextCursor = encodeScanCursor(index, after);
            break;
          }
          if (index + 1 < segments.length && scanned >= budget) {
            truncated = true;
            nextCursor = encodeScanCursor(index + 1);
          }
        }

        const result = sampleControl(senders, size ?? 25, { exclude, seed });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                filter: { module, event_type },
                ...(typeFilter?.resolution ? { event_type_resolution: typeFilter.resolution } : {}),
                ...(moduleFilter?.resolution ? { module_scope: moduleFilter.resolution } : {}),
                window: describeWindow(from, to, window),
                events_scanned: scanned,
                // A truncated scan still gives a valid control — it is a
                // sample either way — but it is drawn from whichever slice of
                // the window the scan reached, so say so.
                population_truncated: truncated,
                ...(nextCursor || cursorStalled ? {
                  scan: {
                    ...(nextCursor ? { next_call: { tool: "sample_control_addresses", repeat_with: { cursor: nextCursor } } } : {}),
                    note: cursorStalled
                      ? "The event connection reported another page without an advancing cursor; this slice cannot be resumed safely."
                      : "The sample and population size cover this segment only; samples from separate segments are not one random draw from their union.",
                  },
                } : {}),
                ...result,
                how_to_use:
                  "Run the same test on this control that you ran on the cohort — find_funding_sources over both, then compare how many share a funder. A cohort rate that matches the control's is not evidence, however striking the cohort looked alone.",
                ...(result.undersampled
                  ? {
                      warning:
                        `Only ${result.population_size} distinct addresses were available, fewer than the ${result.requested} requested. A control this small will not separate a real effect from chance — widen the window or raise max_events.` +
                        (moduleFilter?.resolution?.other_version_ids
                          ? " From the relocate_event_module cutover on, a `module` filter draws callers of one package version only; module_scope.other_version_ids lists the rest of the lineage."
                          : "") +
                        (typeFilter?.resolution?.unverified
                          ? " The event type's package type origins could not be read, so the type was queried unchecked; event_type_resolution says so."
                          : ""),
                    }
                  : {}),
                ...(result.seed === null
                  ? {
                      note: "No seed given, so this draw cannot be reproduced. Pass `seed` if the result is going into a report.",
                    }
                  : {}),
              }),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
