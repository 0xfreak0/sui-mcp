import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { formatOwner } from "../utils/formatting.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerMonitorTools(server: McpServer) {
  server.tool(
    "check_activity",
    "Check for recent activity on a Sui address or object. For an address: returns new transactions since a checkpoint or timestamp. For an object: checks if its version has changed since a given version.",
    {
      address: z
        .string()
        .optional()
        .describe("Sui address to check for new transactions. Provide either address or object_id."),
      object_id: z
        .string()
        .optional()
        .describe("Object ID to check for version changes. Provide either address or object_id."),
      since_checkpoint: z
        .number()
        .optional()
        .describe("(address mode) Only show activity after this checkpoint number"),
      since_timestamp: z
        .string()
        .optional()
        .describe('(address mode) Only show activity after this ISO timestamp (e.g. "2024-01-15T00:00:00Z")'),
      since_version: z
        .string()
        .optional()
        .describe("(object mode) Only report if version is newer than this"),
      limit: z
        .number()
        .optional()
        .describe("(address mode) Max results (default 20, max 50)"),
    },
    async ({ address, object_id, since_checkpoint, since_timestamp, since_version, limit }) => {
      if (!address && !object_id) {
        return errorResult("Provide either 'address' or 'object_id'.");
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
        const hasChanged = since_version && currentVersion
          ? BigInt(currentVersion) > BigInt(since_version)
          : false;

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
      const first = Math.min(limit ?? 20, 50);
      const query = `
        query($address: SuiAddress!, $first: Int, $afterCheckpoint: Int) {
          transactions(
            filter: { affectedAddress: $address, afterCheckpoint: $afterCheckpoint }
            first: $first
          ) {
            nodes {
              digest
              sender { address }
              effects {
                status
                timestamp
                checkpoint { sequenceNumber }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      const variables: Record<string, unknown> = {
        address,
        first,
        afterCheckpoint: since_checkpoint ?? undefined,
      };

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
          pageInfo: { hasNextPage: boolean; endCursor?: string };
        };
      }>(query, variables);

      let transactions = data.transactions.nodes.map((n) => ({
        digest: n.digest,
        sender: n.sender?.address,
        status: n.effects?.status?.toLowerCase(),
        checkpoint: n.effects?.checkpoint?.sequenceNumber,
        timestamp: n.effects?.timestamp,
      }));

      if (since_timestamp) {
        const sinceMs = new Date(since_timestamp).getTime();
        transactions = transactions.filter((tx) => {
          if (!tx.timestamp) return true;
          return new Date(tx.timestamp).getTime() > sinceMs;
        });
      }

      const latestCheckpoint = transactions.reduce<number | null>(
        (max, tx) => {
          if (tx.checkpoint == null) return max;
          return max == null || tx.checkpoint > max ? tx.checkpoint : max;
        },
        null
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address,
                since_checkpoint: since_checkpoint ?? null,
                new_transaction_count: transactions.length,
                latest_checkpoint: latestCheckpoint,
                transactions,
                has_more: data.transactions.pageInfo.hasNextPage,
                next_cursor: data.transactions.pageInfo.endCursor ?? null,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
