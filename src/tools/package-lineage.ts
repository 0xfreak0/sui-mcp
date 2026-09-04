import { z } from "zod";
import { numArg } from "./args.js";
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

const VERSIONS_QUERY = `query ($addr: SuiAddress!, $last: Int!) {
  packageVersions(address: $addr, last: $last) {
    nodes { address version }
  }
}`;

const PROBE_QUERY = `query ($f: EventFilter) {
  events(filter: $f, first: 1) { nodes { contents { type { repr } } } }
}`;

interface VersionsResult {
  packageVersions: { nodes: Array<{ address: string; version: number }> } | null;
}
interface ProbeResult {
  events: { nodes: Array<{ contents?: { type?: { repr: string } } }> };
}

export function registerPackageLineageTools(server: McpServer) {
  server.tool(
    "resolve_protocol_packages",
    "(Incident investigation) Find which package IDs of a protocol are actually emitting events right now, so a query targets something live. Start here before aggregate_events or query_events when you know a protocol by name or hold a package ID of unknown vintage. The bundled protocol registry maps IDs to names for DECODING and is full of historical versions on purpose, so using one as a query target silently returns zero events and looks like the protocol is dead. Note the answer is usually plural: an event carries the ID of the package version that defined it, so a protocol upgraded piecemeal emits from several versions at once — querying only the newest drops the rest.",
    {
      protocol: z
        .string()
        .optional()
        .describe("Protocol name as it appears in the bundled registry, e.g. 'Cetus', 'Suilend'."),
      package_id: z
        .string()
        .optional()
        .describe("Any package ID in the lineage, of any age. Its whole upgrade history is walked."),
      since: z
        .string()
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
    },
    async ({ protocol, package_id, since, max_versions }) => {
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
        for (const seed of seeds) {
          try {
            const r = await gqlQuery<VersionsResult>(VERSIONS_QUERY, {
              addr: seed,
              last: max_versions ?? 8,
            });
            for (const n of r.packageVersions?.nodes ?? []) byAddress.set(n.address, n);
          } catch {
            // A seed that is not a package (or does not exist) contributes
            // nothing rather than failing the whole lookup.
          }
        }

        const entries: LineageEntry[] = [];
        for (const v of byAddress.values()) {
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
              text: JSON.stringify(
                {
                  queried: { protocol, package_id },
                  seeds_from_registry: package_id ? undefined : seeds,
                  probe_window: { after_checkpoint: afterCheckpoint, latest_checkpoint: latest.seq },
                  ...summary,
                  next_step: summary.emitting_package_ids.length
                    ? `aggregate_events(module: "${summary.emitting_package_ids[0]}", group_by: "event_type") to see what it emits.`
                    : undefined,
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
