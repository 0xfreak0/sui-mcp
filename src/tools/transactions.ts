import { z } from "zod";
import { sui, archive } from "../clients/grpc.js";
import { formatStatus, formatGas, bigintToString, timestampToIso } from "../utils/formatting.js";
import { errorResult } from "../utils/errors.js";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { gqlQuery } from "../clients/graphql.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerTransactionTools(server: McpServer) {
  server.tool(
    "get_transaction",
    "Get a Sui transaction by its digest. Returns sender, effects, events, gas, and balance changes.",
    {
      digest: z.string().describe("Transaction digest (Base58)"),
    },
    async ({ digest }) => {
      const req = {
        digest,
        readMask: {
          paths: [
            "digest", "transaction", "effects", "events",
            "checkpoint", "timestamp", "balance_changes",
          ],
        },
      };
      let res: GrpcTypes.GetTransactionResponse;
      try {
        ({ response: res } = await sui.ledgerService.getTransaction(req));
      } catch {
        // Fall back to archive for pruned transactions
        ({ response: res } = await archive.ledgerService.getTransaction(req));
      }
      const tx = res.transaction;
      const effects = tx?.effects;
      const events = tx?.events?.events?.map((e: GrpcTypes.Event) => ({
        package_id: e.packageId,
        module: e.module,
        event_type: e.eventType,
        sender: e.sender,
      }));
      const balanceChanges = tx?.balanceChanges?.map((bc: GrpcTypes.BalanceChange) => ({
        address: bc.address,
        coin_type: bc.coinType,
        amount: bc.amount,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                digest: tx?.digest,
                sender: tx?.transaction?.sender,
                status: formatStatus(effects?.status),
                gas: formatGas(effects?.gasUsed),
                epoch: bigintToString(effects?.epoch),
                checkpoint: bigintToString(tx?.checkpoint),
                timestamp: timestampToIso(tx?.timestamp),
                events,
                balance_changes: balanceChanges,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "query_transactions",
    "Query Sui transactions with filters. Uses GraphQL for rich filtering by sender, address, object, function, and checkpoint range. Note: only ONE of affected_address, affected_object, or function can be used per query (Sui GraphQL limitation). sender and checkpoint filters can be combined with any of them.",
    {
      sender: z.string().optional().describe("Filter by sender address"),
      affected_address: z
        .string()
        .optional()
        .describe("Filter by affected address (sender, sponsor, or recipient). Mutually exclusive with affected_object and function."),
      affected_object: z
        .string()
        .optional()
        .describe("Filter by affected object ID. Mutually exclusive with affected_address and function."),
      function: z
        .string()
        .optional()
        .describe("Filter by Move function (e.g. 0x2::coin::transfer or 0x2::pay). Mutually exclusive with affected_address and affected_object."),
      after_checkpoint: z
        .string()
        .optional()
        .describe("Only transactions after this checkpoint"),
      before_checkpoint: z
        .string()
        .optional()
        .describe("Only transactions before this checkpoint"),
      limit: z.number().optional().describe("Max results (default 20)"),
      after: z.string().optional().describe("Pagination cursor"),
    },
    async ({
      sender,
      affected_address,
      affected_object,
      function: fn,
      after_checkpoint,
      before_checkpoint,
      limit,
      after,
    }) => {
      // Sui GraphQL only allows one of these per query
      const exclusiveFilters = [
        affected_address && "affected_address",
        affected_object && "affected_object",
        fn && "function",
      ].filter(Boolean);

      if (exclusiveFilters.length > 1) {
        return errorResult(
          `Only one of [affected_address, affected_object, function] can be specified per query. Got: ${exclusiveFilters.join(", ")}. Use separate queries for each filter.`
        );
      }

      const filterParts: Record<string, unknown> = {};
      if (sender) filterParts.sentAddress = sender;
      if (affected_address) filterParts.affectedAddress = affected_address;
      if (affected_object) filterParts.affectedObject = affected_object;
      if (fn) filterParts.function = fn;
      if (after_checkpoint)
        filterParts.afterCheckpoint = parseInt(after_checkpoint);
      if (before_checkpoint)
        filterParts.beforeCheckpoint = parseInt(before_checkpoint);

      const query = `
        query($filter: TransactionFilter, $first: Int, $after: String) {
          transactions(filter: $filter, first: $first, after: $after) {
            nodes {
              digest
              sender { address }
              effects {
                status
                gasEffects {
                  gasSummary {
                    computationCost
                    storageCost
                    storageRebate
                  }
                }
                checkpoint { sequenceNumber }
                timestamp
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;
      const variables = {
        filter: Object.keys(filterParts).length > 0 ? filterParts : undefined,
        first: limit ?? 20,
        after: after ?? undefined,
      };
      const data = await gqlQuery<{
        transactions: {
          nodes: Array<{
            digest: string;
            sender?: { address: string };
            effects?: {
              status: string;
              gasEffects?: {
                gasSummary?: {
                  computationCost: string;
                  storageCost: string;
                  storageRebate: string;
                };
              };
              checkpoint?: { sequenceNumber: number };
              timestamp?: string;
            };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor?: string };
        };
      }>(query, variables);

      const transactions = data.transactions.nodes.map((n) => ({
        digest: n.digest,
        sender: n.sender?.address,
        status: n.effects?.status,
        checkpoint: n.effects?.checkpoint?.sequenceNumber,
        timestamp: n.effects?.timestamp,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                transactions,
                has_next_page: data.transactions.pageInfo.hasNextPage,
                next_cursor: data.transactions.pageInfo.endCursor,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "batch_get_transactions",
    "Fetch multiple Sui transactions by their digests in a single batch call. More efficient than calling get_transaction multiple times. Returns sender, effects, events, gas, and balance changes for each transaction.",
    {
      digests: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Array of transaction digests (Base58). Max 50."),
    },
    async ({ digests }) => {
      const readMask = {
        paths: [
          "digest", "transaction", "effects", "events",
          "checkpoint", "timestamp", "balance_changes",
        ],
      };

      // Fetch all transactions in parallel
      const txResults = await Promise.allSettled(
        digests.map(async (digest) => {
          const req = { digest, readMask };
          let res: GrpcTypes.GetTransactionResponse;
          try {
            ({ response: res } = await sui.ledgerService.getTransaction(req));
          } catch {
            ({ response: res } = await archive.ledgerService.getTransaction(req));
          }
          return res.transaction;
        })
      );

      const results = txResults.map((result, i) => {
        if (result.status === "rejected") {
          return {
            digest: digests[i],
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          };
        }
        const tx = result.value;
        if (!tx) {
          return { digest: digests[i], error: "Transaction not found" };
        }
        const effects = tx.effects;
        const events = tx.events?.events?.map((e: GrpcTypes.Event) => ({
          package_id: e.packageId,
          module: e.module,
          event_type: e.eventType,
          sender: e.sender,
        }));
        const balanceChanges = tx.balanceChanges?.map((bc: GrpcTypes.BalanceChange) => ({
          address: bc.address,
          coin_type: bc.coinType,
          amount: bc.amount,
        }));

        return {
          digest: tx.digest,
          sender: tx.transaction?.sender,
          status: formatStatus(effects?.status),
          gas: formatGas(effects?.gasUsed),
          epoch: bigintToString(effects?.epoch),
          checkpoint: bigintToString(tx.checkpoint),
          timestamp: timestampToIso(tx.timestamp),
          events,
          balance_changes: balanceChanges,
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                count: results.length,
                transactions: results,
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
