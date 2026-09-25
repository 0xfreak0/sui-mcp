import { z } from "zod";
import { boolArg, numArg, addressListArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { addressFlow, collectPackageIds, decodeTransaction } from "../protocols/decoder.js";
import { prefetchProtocolNames } from "../protocols/registry.js";
import { batchResolveNames } from "../utils/names.js";
import { getLabel } from "../utils/labels.js";
import { activityHours } from "../utils/activity-hours.js";
import { adaptCommands, adaptBalanceChanges } from "../utils/gql-adapters.js";
import type { GqlBalanceChangeNode, GqlCommandNode } from "../utils/gql-adapters.js";
import { errorResult } from "../utils/errors.js";
import { inWindow, mergeTimelineEntries, type TimelineEntry } from "../utils/timeline.js";
import { describeWindow, resolveWindow } from "../utils/checkpoint-time.js";
import {
  BALANCE_CHANGES_SELECTION,
  COMMANDS_SELECTION,
  completeTxConnections,
  type GqlConnection,
} from "../utils/tx-connections.js";
import {
  BOTH_WAYS_PAGE_INFO,
  orderedPage,
  orderedPageArgs,
  type BothWaysPageInfo,
  type ListOrder,
} from "../utils/pagination.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface TxNode {
  digest: string;
  sender?: { address: string };
  effects?: {
    status?: string;
    timestamp?: string;
    checkpoint?: { sequenceNumber: number };
    balanceChanges?: GqlConnection<GqlBalanceChangeNode>;
  };
  kind?: { commands?: GqlConnection<GqlCommandNode> };
}

interface TimelineResponse {
  transactions: { nodes: TxNode[]; pageInfo: BothWaysPageInfo };
}

const TIMELINE_QUERY = `
  query($address: SuiAddress!, $first: Int, $after: String, $last: Int, $before: String, $afterCp: UInt53, $beforeCp: UInt53) {
    transactions(filter: { affectedAddress: $address, afterCheckpoint: $afterCp, beforeCheckpoint: $beforeCp }, first: $first, after: $after, last: $last, before: $before) {
      nodes {
        digest
        sender { address }
        effects { status timestamp checkpoint { sequenceNumber } ${BALANCE_CHANGES_SELECTION} }
        kind { ... on ProgrammableTransaction { ${COMMANDS_SELECTION} } }
      }
      ${BOTH_WAYS_PAGE_INFO}
    }
  }
`;

/** One address's walk through the window. */
interface AddressWalk {
  entries: TimelineEntry[];
  /** `per_address` ended the walk while the window still held more. */
  truncated: boolean;
  /**
   * Where the walk stopped: the latest checkpoint read when walking forward,
   * the earliest when walking back. Null when nothing was read.
   */
  reached_checkpoint: number | null;
  /** Digests decoded from a partial list because a follow-up read failed. */
  incomplete: string[];
}

/**
 * Walk one address's transactions inside the window and turn them into
 * timeline entries. `oldest` walks forward from the window start; `newest`
 * walks back from its end, or from the latest transaction when unbounded.
 */
async function fetchAddressEntries(
  address: string,
  tracked: Set<string>,
  afterCp: number | undefined,
  beforeCp: number | undefined,
  perAddress: number,
  direction: ListOrder,
): Promise<AddressWalk> {
  const entries: TimelineEntry[] = [];
  const incomplete: string[] = [];
  let cursor: string | undefined;
  let more = false;
  // Paginate up to the per-address budget (50 nodes/page max).
  while (entries.length < perAddress) {
    const size = Math.min(50, perAddress - entries.length);
    const data: TimelineResponse = await gqlQuery<TimelineResponse>(TIMELINE_QUERY, {
      address,
      ...orderedPageArgs(direction, size, cursor),
      afterCp,
      beforeCp,
    });
    const page = orderedPage(data.transactions.nodes, data.transactions.pageInfo, direction);
    const completed = await completeTxConnections(
      page.nodes.map((node) => ({
        digest: node.digest,
        balanceChanges: node.effects?.balanceChanges,
        commands: node.kind?.commands,
      })),
    );
    // One bulk MVR lookup per page, ahead of the synchronous decode loop.
    await prefetchProtocolNames(completed.flatMap((c) => collectPackageIds(adaptCommands(c.commands))));
    for (const [i, node] of page.nodes.entries()) {
      const sender = node.sender?.address ?? null;
      const bcNodes = completed[i].balanceChanges;
      if (completed[i].balanceChangesTruncated || completed[i].commandsTruncated) incomplete.push(node.digest);
      const decoded = decodeTransaction(adaptCommands(completed[i].commands), adaptBalanceChanges(bcNodes), sender ?? undefined);

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
        // token_flow is the sender's; this is each tracked address's own side.
        subject_flow: Object.fromEntries(
          [...involved].map((a) => [a, addressFlow(adaptBalanceChanges(bcNodes), a)]),
        ),
      });
    }
    more = page.has_next_page;
    if (!more) break;
    // No cursor with another page claimed would restart the walk, re-reading
    // page one and double-counting every entry on it.
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  const last = entries.at(-1);
  return {
    entries,
    truncated: more && entries.length >= perAddress,
    reached_checkpoint: last?.checkpoint ?? null,
    incomplete,
  };
}

export function registerTimelineTools(server: McpServer) {
  server.tool(
    "build_timeline",
    "(Incident investigation) Build one chronological, protocol-decoded timeline across up to 10 addresses, merged, de-duplicated and ordered by checkpoint. Use it to reconstruct what happened across a set of wallets/objects during an incident. Bound it with `from`/`to` (ISO 8601 or checkpoint numbers); a time is resolved to the checkpoints stamped inside the window and applied in the query. With `from`, each address is read forward from the window start; without it, each address's most recent `per_address` transactions (before `to`, if given) are read. `coverage` reports per address how many transactions were read, whether `per_address` stopped the walk early (`truncated`), the checkpoint it reached, and the `from`/`to` that continues it. Each entry's `subject_flow` holds every involved tracked address's own signed balance change per coin, keyed by address; `token_flow` is the transaction sender's.",
    {
      addresses: addressListArg().min(1).max(10).describe("Addresses to merge into one timeline (1-10)"),
      from: z.string().optional().describe("Window start: ISO date (e.g. 2024-11-11T00:00:00Z) or a checkpoint number"),
      to: z.string().optional().describe("Window end: ISO date or a checkpoint number"),
      limit: numArg().int().positive().max(200).optional().describe("Max timeline entries to return (default 60)"),
      per_address: numArg()
        .int()
        .positive()
        .max(300)
        .optional()
        .describe(
          "Max transactions to read per address before merging (default 30). An address with more in the window is reported `truncated` in `coverage`. Raise it for `activity_hours`: a daily rhythm needs 50+ transactions spanning a week or more, and the reading says so when it has less.",
        ),
      activity_hours: boolArg()
        .optional()
        .describe(
          "Also report when each address is active, by UTC hour (default false). Reports the distribution and only offers a timezone reading when sample size, span and depth support one — on Sui the common answer is 'flat, consistent with automation', which is itself a finding.",
        ),
    },
    async ({ addresses, from, to, limit, per_address, activity_hours }) => {
      try {
        const tracked = new Set(addresses);
        // Throws on a bound that is neither a time nor a checkpoint, so a typo
        // is an error rather than an unbounded read.
        const window = await resolveWindow(from, to);
        const perAddress = per_address ?? 30;
        const maxEntries = limit ?? 60;
        // With a start, read forward from it. Without one, "the window" is the
        // present: read back from the end, so an old address shows what it is
        // doing now rather than its first transactions.
        const direction = from ? "oldest" : "newest";
        const fromMs = window.after?.ms;
        const toMs = window.before?.ms;

        const walks = await Promise.all(
          addresses.map((a) =>
            fetchAddressEntries(
              a,
              tracked,
              window.after?.checkpoint ?? undefined,
              window.before?.checkpoint ?? undefined,
              perAddress,
              direction,
            ),
          ),
        );

        const { entries: merged, omitted } = mergeTimelineEntries(
          walks.flatMap((w) => w.entries),
          { fromMs, toMs, limit: maxEntries, keep: direction },
        );

        const coverage = addresses.map((a, i) => {
          const w = walks[i];
          const reached = w.reached_checkpoint;
          return {
            address: a,
            fetched: w.entries.length,
            truncated: w.truncated,
            reached_checkpoint: reached,
            // Re-reads the boundary checkpoint: other transactions of this
            // address may sit in it, and skipping them would be silent.
            ...(w.truncated && reached != null
              ? { continue_with: direction === "oldest" ? { from: String(reached - 1) } : { to: String(reached + 1) } }
              : {}),
            ...(w.incomplete.length ? { incomplete_transactions: w.incomplete } : {}),
          };
        });
        const cut = coverage.filter((c) => c.truncated && c.reached_checkpoint != null);
        const boundary = cut.length
          ? direction === "oldest"
            ? Math.min(...cut.map((c) => c.reached_checkpoint!))
            : Math.max(...cut.map((c) => c.reached_checkpoint!))
          : null;

        // Resolve names + labels for the tracked addresses (for readable output).
        const nameMap = await batchResolveNames(addresses);
        const legend = addresses.map((a) => {
          const label = getLabel(a);
          const name = nameMap.get(a);
          return { address: a, ...(name ? { name } : {}), ...(label ? { label: label.label, category: label.category } : {}) };
        });

        // Per address, not merged: two addresses having the SAME active window
        // is the corroborating observation, and merging them destroys it.
        // Computed over every in-window transaction read rather than the capped
        // timeline, since the entry limit is about readability and this wants
        // volume.
        const activity = activity_hours
          ? addresses
              .map((a, i) => ({
                address: a,
                ...(activityHours(
                  walks[i].entries.filter((e) => inWindow(e.timestamp, fromMs, toMs)).map((e) => e.timestamp),
                ) ?? {}),
              }))
              .filter((x) => "histogram" in x)
          : undefined;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  addresses: legend,
                  window: describeWindow(from, to, window),
                  read_from: direction === "oldest" ? "window start, forward" : to ? "window end, backward" : "latest, backward",
                  coverage,
                  ...(boundary != null
                    ? {
                        coverage_note:
                          direction === "oldest"
                            ? `per_address stopped some walks before the end of the window. After checkpoint ${boundary} the timeline is missing those addresses' activity; continue each with its continue_with, raise per_address, or narrow the window.`
                            : `per_address stopped some walks before the start of the window. Before checkpoint ${boundary} the timeline is missing those addresses' activity; continue each with its continue_with, raise per_address, or set from.`,
                      }
                    : {}),
                  entry_count: merged.length,
                  ...(omitted
                    ? {
                        omitted_by_limit: omitted,
                        limit_note: `limit kept the ${direction === "oldest" ? "earliest" : "latest"} ${merged.length} of ${merged.length + omitted} entries read. Raise limit to see the rest.`,
                      }
                    : {}),
                  ...(activity?.length
                    ? {
                        activity_hours: activity,
                        activity_hours_note:
                          "Hour-of-day activity per address, in UTC. A shared quiet window across addresses is corroborating; opposite windows argue against common control and are the rarer, more useful result. Read `reading` before `utc_offset_estimate` — it is null unless sample size, span and depth support one, and even then it is a longitude rather than a country.",
                      }
                    : {}),
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
