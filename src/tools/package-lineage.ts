import { z } from "zod";
import { numArg, addressArg, timePointArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { latestCheckpoint, toCheckpoint } from "../utils/checkpoint-time.js";
import {
  candidatesForProtocol,
  summarizeLineage,
  type LineageEntry,
} from "../utils/package-lineage.js";
import { loadProtocolRegistry } from "../protocols/registry.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const VERSIONS_QUERY = `query ($addr: SuiAddress!, $after: String) {
  packageVersions(address: $addr, first: 50, after: $after) {
    nodes { address version }
    pageInfo { hasNextPage endCursor }
  }
}`;

const PROBE_QUERY = `query ($f: EventFilter) {
  events(filter: $f, first: 1) { nodes { contents { type { repr } } } }
}`;

interface VersionsResult {
  packageVersions: {
    nodes: Array<{ address: string; version: number }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  } | null;
}
interface ProbeResult {
  events: { nodes: Array<{ contents?: { type?: { repr: string } } }> };
}

export function registerPackageLineageTools(server: McpServer) {
  server.tool(
    "resolve_protocol_packages",
    "(Incident investigation) Find which package IDs of a protocol are actually emitting events right now, so a query targets something live. Start here before aggregate_events or query_events when you know a protocol by name or hold a package ID of unknown vintage. The bundled protocol registry maps IDs to names for DECODING and is full of historical versions on purpose, so using one as a query target silently returns zero events and looks like the protocol is dead. Note the answer is usually plural: an event carries the ID of the package version that defined it, so a protocol upgraded piecemeal emits from several versions at once, and querying only the newest drops the rest.",
    {
      protocol: z
        .string()
        .optional()
        .describe("Protocol name as it appears in the bundled registry, e.g. 'Cetus', 'Suilend'."),
      package_id: addressArg()
        .optional()
        .describe("Any package ID in the lineage, of any age. Its whole upgrade history is walked."),
      since: timePointArg()
        .optional()
        .describe(
          "How far back to probe for activity: ISO 8601 timestamp or checkpoint. Defaults to roughly the last day.",
        ),
      max_versions: numArg()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Most recent versions to probe (default 8). Older ones are rarely still live."),
      version_offset: numArg().int().min(0).optional()
        .describe("Skip this many newest versions in the combined lineage (default 0). Follow versions_page.next_call to probe older versions."),
    },
    async ({ protocol, package_id, since, max_versions, version_offset }) => {
      try {
        if (!protocol && !package_id) {
          return errorResult("Provide protocol or package_id.");
        }

        let seeds: string[] = [];
        if (package_id) seeds = [package_id];
        else {
          seeds = candidatesForProtocol(loadProtocolRegistry(), protocol!);
          if (seeds.length === 0) {
            return errorResult(
              `'${protocol}' is not in the bundled registry. Pass package_id instead — any ID in the lineage works, ` +
                "however old. The registry is a curated decode map, not a directory of every protocol on Sui.",
            );
          }
        }

        const latest = await latestCheckpoint();
        const sinceCp = await toCheckpoint(since, latest);
        // Default probe window: about a day of checkpoints. A protocol quiet for
        // a full day is worth flagging even if it is not truly dead.
        const afterCheckpoint = sinceCp?.checkpoint ?? Math.max(0, latest.seq - 400_000);

        // Walk every seed's lineage, then de-duplicate: several registry entries
        // for one protocol are often versions of a single package, and probing
        // the same address twice wastes a round trip per duplicate.
        const byAddress = new Map<string, { address: string; version: number }>();
        let seedError: unknown;
        for (const seed of seeds) {
          try {
            let after: string | null = null;
            for (; ;) {
              const r: VersionsResult = await gqlQuery<VersionsResult>(VERSIONS_QUERY, { addr: seed, after });
              const conn: VersionsResult["packageVersions"] = r.packageVersions;
              if (!conn) break;
              for (const n of conn.nodes) byAddress.set(n.address, n);
              if (!conn.pageInfo.hasNextPage) break;
              if (!conn.pageInfo.endCursor || conn.pageInfo.endCursor === after) {
                throw new Error(`Package versions for ${seed} have more pages but no advancing cursor.`);
              }
              after = conn.pageInfo.endCursor;
            }
          } catch (err) {
            // A seed that is not a package (or does not exist) contributes
            // nothing rather than failing the whole lookup.
            seedError ??= err;
          }
        }
        if (seedError) throw seedError;
        // No versions at all: an empty lineage reported as "nothing emitting"
        // reads as a dead protocol when the ID was never a package.
        if (byAddress.size === 0) {
          if (seedError) throw seedError;
          return errorResult(
            `${package_id ?? seeds.join(", ")} is not a package on this network: no package versions were found for it.`,
          );
        }

        const versions = [...byAddress.values()].sort((a, b) => b.version - a.version || a.address.localeCompare(b.address));
        const offset = version_offset ?? 0;
        if (offset >= versions.length) return errorResult(`version_offset ${offset} is past the ${versions.length} known package versions.`);
        const page = versions.slice(offset, offset + (max_versions ?? 8));
        const entries: LineageEntry[] = [];
        for (const v of page) {
          let emitting = false;
          let sample: string | undefined;
          try {
            const p = await gqlQuery<ProbeResult>(PROBE_QUERY, {
              f: { module: v.address, afterCheckpoint },
            });
            emitting = p.events.nodes.length > 0;
            sample = p.events.nodes[0]?.contents?.type?.repr;
          } catch {
            // Probe failure means unknown, and unknown must not read as active.
          }
          entries.push({ ...v, emitting, ...(sample ? { sample_event_type: sample } : {}) });
        }

        const summary = summarizeLineage(entries);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                queried: { protocol, package_id },
                seeds_from_registry: package_id ? undefined : seeds,
                versions_page: {
                  offset,
                  listed: page.length,
                  total: versions.length,
                  ...(offset + page.length < versions.length
                    ? { next_call: { tool: "resolve_protocol_packages", repeat_with: { version_offset: offset + page.length } } }
                    : {}),
                  note: "Activity covers the package versions probed on this page, not unprobed versions of the lineage.",
                },
                probe_window: { after_checkpoint: afterCheckpoint, latest_checkpoint: latest.seq },
                ...summary,
                ...(summary.emitting_package_ids.length
                  ? { next_call: { tool: "aggregate_events", args: { module: summary.emitting_package_ids[0], group_by: "event_type" } } }
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
