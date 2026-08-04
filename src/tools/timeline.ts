import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { decodeTransaction } from "../protocols/decoder.js";
import { batchResolveNames } from "../utils/names.js";
import { getLabel } from "../utils/labels.js";
import { adaptCommands, adaptBalanceChanges } from "../utils/gql-adapters.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "../utils/gql-adapters.js";
import { errorResult } from "../utils/errors.js";
import { mergeTimelineEntries, parseTimeBound, type TimelineEntry } from "../utils/timeline.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface TxNode {
  digest: string;
  sender?: { address: string };
  effects?: {
    status?: string;
    timestamp?: string;
    checkpoint?: { sequenceNumber: number };
    balanceChanges?: { nodes: GqlBalanceChangeNode[] };
  };
  kind?: { commands?: { nodes: GqlCommandNode[] } };
}

interface TimelineResponse {
  transactions: { nodes: TxNode[]; pageInfo: { hasNextPage: boolean; endCursor?: string } };
}

const TIMELINE_QUERY = `
  query($address: SuiAddress!, $first: Int, $after: String, $afterCp: Int, $beforeCp: Int) {
    transactions(filter: { affectedAddress: $address, afterCheckpoint: $afterCp, beforeCheckpoint: $beforeCp }, first: $first, after: $after) {
      nodes {
        digest
        sender { address }
        effects {
          status
          timestamp
          checkpoint { sequenceNumber }
          balanceChanges { nodes { coinType { repr } amount owner { address } } }
        }
        kind {
          ... on ProgrammableTransaction {
            commands { nodes {
              ... on MoveCallCommand { __typename function { name module { name package { address } } } }
              ... on TransferObjectsCommand { __typename }
              ... on SplitCoinsCommand { __typename }
              ... on MergeCoinsCommand { __typename }
              ... on PublishCommand { __typename }
              ... on UpgradeCommand { __typename }
            } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Fetch a window of one address's transactions and turn them into timeline entries. */
async function fetchAddressEntries(
  address: string,
  tracked: Set<string>,
  afterCp: number | undefined,
  beforeCp: number | undefined,
  perAddress: number,
): Promise<TimelineEntry[]> {
  const entries: TimelineEntry[] = [];
  let after: string | undefined;
  // Paginate up to the per-address budget (50 nodes/page max).
  while (entries.length < perAddress) {
    const first = Math.min(50, perAddress - entries.length);
    const data: TimelineResponse = await gqlQuery<TimelineResponse>(TIMELINE_QUERY, {
      address,
      first,
      after,
      afterCp,
      beforeCp,
    });
    for (const node of data.transactions.nodes) {
      const sender = node.sender?.address ?? null;
      const bcNodes = node.effects?.balanceChanges?.nodes ?? [];
      const decoded = decodeTransaction(adaptCommands(node.kind?.commands?.nodes ?? []), adaptBalanceChanges(bcNodes), sender ?? undefined);

      // Which tracked addresses does this tx touch?
      const involved = new Set<string>();
      if (sender && tracked.has(sender)) involved.add(sender);
      for (const bc of bcNodes) {
        const a = bc.owner?.address;
        if (a && tracked.has(a)) involved.add(a);
      }
      if (involved.size === 0) involved.add(address); // safety: the queried addr is affected

      entries.push({
        digest: node.digest,
        checkpoint: node.effects?.checkpoint?.sequenceNumber ?? null,
        timestamp: node.effects?.timestamp ?? null,
        sender,
        status: node.effects?.status?.toLowerCase() === "success" ? "success" : (node.effects?.status?.toLowerCase() ?? "unknown"),
        protocols: decoded.protocols,
        actions: decoded.actions,
        token_flow: decoded.token_flow,
        involved: [...involved],
      });
    }
    if (!data.transactions.pageInfo.hasNextPage) break;
    after = data.transactions.pageInfo.endCursor;
  }
  return entries;
}

export function registerTimelineTools(server: McpServer) {
  server.tool(
    "build_timeline",
    "(Incident investigation) Build a single chronological, protocol-decoded timeline of activity across multiple addresses — merged, de-duplicated, and ordered by checkpoint. Use it to reconstruct what happened across a set of wallets/objects during an incident. Optionally bound by a time window (`from`/`to` as ISO dates or checkpoint numbers).",
    {
      addresses: z.array(z.string()).min(1).max(10).describe("Addresses to merge into one timeline (1-10)"),
      from: z.string().optional().describe("Window start: ISO date (e.g. 2024-11-11T00:00:00Z) or a checkpoint number"),
      to: z.string().optional().describe("Window end: ISO date or a checkpoint number"),
      limit: z.number().int().positive().max(200).optional().describe("Max timeline entries to return (default 60)"),
      per_address: z.number().int().positive().max(50).optional().describe("Max transactions to pull per address before merging (default 30)"),
    },
    async ({ addresses, from, to, limit, per_address }) => {
      try {
        const tracked = new Set(addresses);
        const fromB = parseTimeBound(from);
        const toB = parseTimeBound(to);
        const perAddress = per_address ?? 30;
        const maxEntries = limit ?? 60;

        const perAddressEntries = await Promise.all(
          addresses.map((a) => fetchAddressEntries(a, tracked, fromB.checkpoint, toB.checkpoint, perAddress)),
        );

        const merged = mergeTimelineEntries(perAddressEntries.flat(), {
          fromMs: fromB.ms,
          toMs: toB.ms,
          limit: maxEntries,
        });

        // Resolve names + labels for the tracked addresses (for readable output).
        const nameMap = await batchResolveNames(addresses);
        const legend = addresses.map((a) => {
          const label = getLabel(a);
          const name = nameMap.get(a);
          return { address: a, ...(name ? { name } : {}), ...(label ? { label: label.label, category: label.category } : {}) };
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  addresses: legend,
                  window: { from: from ?? null, to: to ?? null },
                  entry_count: merged.length,
                  timeline: merged,
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
