import { z } from "zod";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { numArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { withArchiveFallback } from "../utils/archive-fallback.js";
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

const OWNER_FIELDS = `owner {
      __typename
      ... on AddressOwner { address { address } }
      ... on ConsensusAddressOwner { address { address } }
    }`;

const OBJECT_HISTORY_QUERY = `query ($id: SuiAddress!, $last: Int!) {
  object(address: $id) {
    version
    digest
    ${OWNER_FIELDS}
    asMoveObject { contents { type { repr } } }
    previousTransaction { digest effects { timestamp checkpoint { sequenceNumber } } }
    objectVersionsBefore(last: $last) {
      nodes {
        version
        ${OWNER_FIELDS}
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

/** `sui.rpc.v2.ChangedObject.IdOperation.CREATED` */
const ID_CREATED = 2;

/**
 * Did `digest` create `objectId`? True, false, or null when the transaction
 * could not be read.
 *
 * Asked only when the indexer returns no earlier version. That happens both
 * for an object whose history is beyond retention and for one created
 * recently and never touched since, and only the creating transaction's
 * effects tell the two apart. gRPC returns every changed object in one read,
 * where GraphQL would page them 50 at a time.
 */
async function createdIn(digest: string, objectId: string): Promise<boolean | null> {
  try {
    const res = await withArchiveFallback<GrpcTypes.GetTransactionResponse>(
      (client) => client.ledgerService.getTransaction({ digest, readMask: { paths: ["effects"] } }),
      (r) => !r.transaction?.effects,
    );
    const want = normalizeSuiAddress(objectId);
    const change = res.transaction?.effects?.changedObjects?.find(
      (c) => c.objectId !== undefined && normalizeSuiAddress(c.objectId) === want,
    );
    return change?.idOperation === ID_CREATED;
  } catch {
    return null;
  }
}

export function registerObjectHistoryTools(server: McpServer) {
  server.tool(
    "trace_object_history",
    "(Incident investigation) Trace the provenance of a Sui object: its version history — each version, the transaction that produced it, when — and every ownership transition (transfers, sharing, freezing, party transfers). Use it to see the full lifecycle of an exploited pool/vault/cap: who created it and who held it when. A party object reports owner kind `consensus` with its single owner's address. Note: history is capped to the most recent versions; very hot objects (e.g. system objects) are truncated.",
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

        // Two different ways the history can be incomplete, and only one of
        // them used to be detected.
        //
        // A full page means there are older versions we did not ask for.
        // ZERO prior versions is the case that mattered and read as the
        // opposite: historical versions fall outside the indexer's retention
        // for any object that has sat still, so a long-lived object comes back
        // with one version and looks like it was created by whatever last
        // touched it and never moved since.
        //
        // Verified on a real UpgradeCap: published by 0x158d6f85, now owned by
        // 0x2, so it provably changed hands — and this reported
        // `owner_change_count: 0`, `history_truncated: false`, and named the
        // burn address as its creator. Three false claims from one missing
        // page.
        const pageFull = priorNodes.length >= last;
        // No earlier version is also what a young object looks like: created
        // by the transaction that wrote its current version and untouched
        // since. Only that transaction's effects tell the two apart.
        const createdByCurrent =
          priorNodes.length === 0 && obj.previousTransaction?.digest
            ? await createdIn(obj.previousTransaction.digest, object_id)
            : null;
        const noPriorVersions = priorNodes.length === 0 && createdByCurrent !== true;
        const truncated = pageFull || noPriorVersions;

        const ownerChanges = computeOwnerChanges(history);

        // Resolve names/labels for every owner that is an address, including
        // the single owner of a party object.
        const addrs = new Set<string>();
        for (const e of history) {
          if (e.owner.kind === "address" || e.owner.kind === "consensus") addrs.add(e.owner.address);
        }
        const nameMap = await batchResolveNames([...addrs]);
        const describeOwner = (o: OwnerDesc) => {
          if (o.kind !== "address" && o.kind !== "consensus") return { kind: o.kind };
          const label = getLabel(o.address);
          return {
            kind: o.kind,
            address: o.address,
            ...(nameMap.get(o.address) ? { name: nameMap.get(o.address) } : {}),
            ...(label ? { label: label.label, category: label.category } : {}),
          };
        };

        // Only claim a creation when the walk actually reached the beginning.
        // With one version and nothing before it, "created here" and "this is
        // as far back as the indexer goes" are indistinguishable unless the
        // creating transaction was checked.
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
                  ...(noPriorVersions
                    ? {
                        history_unavailable:
                          "The indexer returned no versions before the current one, which for a long-lived object means its history is beyond retention rather than absent. `created` is therefore null and `owner_change_count` counts only what was visible — NOT that this object was never transferred. Verified on a real upgrade cap: published by one address, now held by another, and this call could see neither.",
                      }
                    : {}),
                  version_count_shown: history.length,
                  // Transitions among the versions RETURNED. Reads as a count
                  // of everything that ever happened, so it is named and
                  // caveated where the history is short.
                  owner_change_count: ownerChanges.length,
                  ...(truncated
                    ? {
                        owner_change_note:
                          "Counts transitions among the versions shown only. An earlier transfer outside this window would not appear.",
                      }
                    : {}),
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
