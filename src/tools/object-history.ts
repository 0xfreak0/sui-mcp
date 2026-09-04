import { z } from "zod";
import { numArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { batchResolveNames } from "../utils/names.js";
import { getLabel } from "../utils/labels.js";
import { computeOwnerChanges, ownerDesc, type OwnerDesc, type VersionEntry } from "../utils/object-history.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface OwnerGql { __typename?: string; address?: { address: string } }
interface VersionNodeGql {
  version: number;
  owner?: OwnerGql;
  previousTransaction?: { digest: string; effects?: { timestamp?: string; checkpoint?: { sequenceNumber: number } } };
}
interface ObjectHistoryResult {
  object: (VersionNodeGql & {
    digest: string;
    asMoveObject?: { contents?: { type?: { repr: string } } };
    objectVersionsBefore: { nodes: VersionNodeGql[] };
  }) | null;
}

const OBJECT_HISTORY_QUERY = `query ($id: SuiAddress!, $last: Int!) {
  object(address: $id) {
    version
    digest
    owner { __typename ... on AddressOwner { address { address } } }
    asMoveObject { contents { type { repr } } }
    previousTransaction { digest effects { timestamp checkpoint { sequenceNumber } } }
    objectVersionsBefore(last: $last) {
      nodes {
        version
        owner { __typename ... on AddressOwner { address { address } } }
        previousTransaction { digest effects { timestamp checkpoint { sequenceNumber } } }
      }
    }
  }
}`;

function toEntry(n: VersionNodeGql): VersionEntry {
  return {
    version: n.version.toString(),
    tx: n.previousTransaction?.digest ?? null,
    timestamp: n.previousTransaction?.effects?.timestamp ?? null,
    checkpoint: n.previousTransaction?.effects?.checkpoint?.sequenceNumber?.toString() ?? null,
    owner: ownerDesc(n.owner),
  };
}

export function registerObjectHistoryTools(server: McpServer) {
  server.tool(
    "trace_object_history",
    "(Incident investigation) Trace the provenance of a Sui object: its version history — each version, the transaction that produced it, when — and every ownership transition (transfers, sharing, freezing). Use it to see the full lifecycle of an exploited pool/vault/cap: who created it and who held it when. Note: history is capped to the most recent versions; very hot objects (e.g. system objects) are truncated.",
    {
      object_id: z.string().describe("Object ID (0x...)"),
      limit: numArg().int().positive().max(50).optional().describe("Max prior versions to include (default 25)"),
    },
    async ({ object_id, limit }) => {
      try {
        const last = limit ?? 25;
        const data = await gqlQuery<ObjectHistoryResult>(OBJECT_HISTORY_QUERY, { id: object_id, last });
        const obj = data.object;
        if (!obj) return errorResult(`Object not found (it may be deleted/wrapped): ${object_id}`);

        const priorNodes = obj.objectVersionsBefore.nodes ?? [];
        // Chronological (oldest -> newest): prior versions, then current.
        const history: VersionEntry[] = [...priorNodes.map(toEntry), toEntry(obj)];
        const truncated = priorNodes.length >= last;

        const ownerChanges = computeOwnerChanges(history);

        // Resolve names/labels for all address owners involved.
        const addrs = new Set<string>();
        for (const e of history) if (e.owner.kind === "address") addrs.add(e.owner.address);
        const nameMap = await batchResolveNames([...addrs]);
        const describeOwner = (o: OwnerDesc) => {
          if (o.kind !== "address") return { kind: o.kind };
          const label = getLabel(o.address);
          return {
            kind: "address" as const,
            address: o.address,
            ...(nameMap.get(o.address) ? { name: nameMap.get(o.address) } : {}),
            ...(label ? { label: label.label, category: label.category } : {}),
          };
        };

        const creation = truncated ? null : history[0];
        const current = history[history.length - 1];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  object_id,
                  type: obj.asMoveObject?.contents?.type?.repr ?? null,
                  current: { version: current.version, owner: describeOwner(current.owner) },
                  created: creation
                    ? { tx: creation.tx, timestamp: creation.timestamp, owner: describeOwner(creation.owner) }
                    : null,
                  history_truncated: truncated,
                  version_count_shown: history.length,
                  owner_change_count: ownerChanges.length,
                  owner_changes: ownerChanges.map((c) => ({
                    from: describeOwner(c.from),
                    to: describeOwner(c.to),
                    at_version: c.at_version,
                    tx: c.tx,
                    timestamp: c.timestamp,
                  })),
                  history: history.map((e) => ({
                    version: e.version,
                    tx: e.tx,
                    timestamp: e.timestamp,
                    checkpoint: e.checkpoint,
                    owner: describeOwner(e.owner),
                  })),
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
