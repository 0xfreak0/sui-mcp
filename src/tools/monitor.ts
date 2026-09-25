import { z } from "zod";
import { numArg, addressArg, timePointArg, u64StringArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { formatOwner } from "../utils/formatting.js";
import { errorResult } from "../utils/errors.js";
import { toFilterBound } from "../utils/checkpoint-time.js";
import { inWindow } from "../utils/timeline.js";
import { BOTH_WAYS_PAGE_INFO, orderedPage, orderedPageArgs, type BothWaysPageInfo } from "../utils/pagination.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMonitorTools(server: McpServer) {
  server.tool(
    "check_activity",
    "(Monitoring/polling) Stateless one-shot check for new activity on a Sui address or object since a known checkpoint, timestamp, cursor or version. Address mode with a baseline returns the transactions after it, oldest first; `next_cursor` marks the newest one read, so passing it back as `cursor` on the next check returns only what came after. Without a baseline it returns the most recent transactions, newest first, and a `next_cursor` to poll from. Object mode reports `has_changed` against `since_version`, and null when none is given. For ongoing monitoring of several addresses use watch_addresses / poll_watch; for history use get_transaction_history.",
    {
      address: addressArg()
        .optional()
        .describe("Sui address to check for new transactions. Provide either address or object_id."),
      object_id: addressArg()
        .optional()
        .describe("Object ID to check for version changes. Provide either address or object_id."),
      since_checkpoint: numArg()
        .int()
        .min(0)
        .optional()
        .describe("(address mode) Only show activity after this checkpoint number"),
      since_timestamp: timePointArg()
        .optional()
        .describe('(address mode) Only show activity after this ISO timestamp (e.g. "2024-01-15T00:00:00Z")'),
      since_version: u64StringArg()
        .optional()
        .describe("(object mode) Only report if version is newer than this"),
      limit: numArg()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("(address mode) Max results (default 20, max 50)"),
      cursor: z
        .string()
        .optional()
        .describe("(address mode) `next_cursor` from a previous check. Returns only transactions after it."),
    },
    async ({ address, object_id, since_checkpoint, since_timestamp, since_version, limit, cursor }) => {
      if (!address && !object_id) {
        return errorResult("Provide either 'address' or 'object_id'.");
      }
      if (address && object_id) {
        return errorResult("Give 'address' or 'object_id', not both: they select different checks.");
      }

      // Object mode: check version change
      if (object_id) {
        const { response: res } = await sui.ledgerService.getObject({
          objectId: object_id,
          readMask: {
            paths: ["object_id", "version", "digest", "object_type", "owner"],
          },
        });
        const obj = res.object;
        const currentVersion = obj?.version?.toString();
        // Without a baseline there is nothing to compare against, and "false"
        // would read as "checked, unchanged".
        const hasChanged = since_version && currentVersion
          ? BigInt(currentVersion) > BigInt(since_version)
          : null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  object_id: obj?.objectId,
                  current_version: currentVersion,
                  since_version: since_version ?? null,
                  has_changed: hasChanged,
                  ...(hasChanged === null
                    ? { note: "No since_version given, so there is no baseline to compare. Pass current_version as since_version on the next check." }
                    : {}),
                  type: obj?.objectType,
                  owner: formatOwner(obj?.owner),
                  digest: obj?.digest,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Address mode: check for new transactions
      try {
        // "After T" is strictly later than T, so the window starts 1ms after it.
        const sinceMs = since_timestamp ? Date.parse(since_timestamp) : undefined;
        if (since_timestamp && Number.isNaN(sinceMs)) {
          return errorResult(
            `Could not parse since_timestamp '${since_timestamp}'. Use an ISO 8601 timestamp such as 2026-08-07T00:00:00Z.`,
          );
        }
        const fromTime =
          sinceMs !== undefined ? await toFilterBound(new Date(sinceMs + 1).toISOString(), "after") : null;
        const bounds = [since_checkpoint, fromTime?.checkpoint].filter((c): c is number => c != null);
        const afterCheckpoint = bounds.length ? Math.max(...bounds) : undefined;
        // A baseline (checkpoint, time or cursor) reads forward from it. None
        // means "what is happening now": the newest transactions.
        const hasBaseline = afterCheckpoint !== undefined || !!cursor;
        const direction = hasBaseline ? "oldest" : "newest";

        const query = `
          query($address: SuiAddress!, $first: Int, $after: String, $last: Int, $before: String, $afterCheckpoint: UInt53) {
            transactions(
              filter: { affectedAddress: $address, afterCheckpoint: $afterCheckpoint }
              first: $first, after: $after, last: $last, before: $before
            ) {
              nodes {
                digest
                sender { address }
                effects { status timestamp checkpoint { sequenceNumber } }
              }
              ${BOTH_WAYS_PAGE_INFO}
            }
          }
        `;

        const data = await gqlQuery<{
          transactions: {
            nodes: Array<{
              digest: string;
              sender?: { address: string };
              effects?: {
                status: string;
                timestamp?: string;
                checkpoint?: { sequenceNumber: number };
              };
            }>;
            pageInfo: BothWaysPageInfo;
          };
        }>(query, {
          address,
          ...orderedPageArgs(direction, limit ?? 20, cursor),
          afterCheckpoint,
        });
        const page = orderedPage(data.transactions.nodes, data.transactions.pageInfo, direction);

        const transactions = page.nodes
          .map((n) => ({
            digest: n.digest,
            sender: n.sender?.address,
            status: n.effects?.status?.toLowerCase(),
            checkpoint: n.effects?.checkpoint?.sequenceNumber,
            timestamp: n.effects?.timestamp,
          }))
          // The checkpoint bound already holds the window; this drops the
          // few extra checkpoints a widened bound can let in.
          .filter((tx) => sinceMs === undefined || inWindow(tx.timestamp ?? null, sinceMs + 1));

        const latestCheckpoint = transactions.reduce<number | null>(
          (max, tx) => {
            if (tx.checkpoint == null) return max;
            return max == null || tx.checkpoint > max ? tx.checkpoint : max;
          },
          null
        );

        // The end cursor marks the newest transaction read in either direction,
        // so it is the poll position. With nothing new, keep the one passed in.
        const nextCursor = data.transactions.pageInfo.endCursor ?? cursor ?? null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  address,
                  mode: hasBaseline ? "since" : "latest",
                  order: direction,
                  since_checkpoint: since_checkpoint ?? null,
                  since_timestamp: since_timestamp ?? null,
                  after_checkpoint: afterCheckpoint ?? null,
                  new_transaction_count: transactions.length,
                  latest_checkpoint: latestCheckpoint,
                  transactions,
                  // Only meaningful with a baseline: more new transactions wait
                  // past this page. Without one these are already the newest.
                  has_more: hasBaseline ? page.has_next_page : false,
                  next_cursor: nextCursor,
                  ...(!hasBaseline
                    ? {
                        note: "No since_checkpoint, since_timestamp or cursor was given, so these are the most recent transactions, newest first. Pass next_cursor as cursor on the next check to see only what came after them.",
                      }
                    : {}),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    }
  );
}
