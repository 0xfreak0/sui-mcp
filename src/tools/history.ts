import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { decodeTransaction } from "../protocols/decoder.js";
import type { GrpcTypes } from "@mysten/sui/grpc";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// GraphQL response types
interface GqlBalanceChangeNode {
  coinType?: { repr: string };
  amount?: string;
  owner?: { address: string };
}

interface GqlCommandNode {
  __typename: string;
  function?: {
    name: string;
    module: {
      name: string;
      package: { address: string };
    };
  };
}

interface GqlTransactionNode {
  digest: string;
  sender?: { address: string };
  effects?: {
    status: string;
    timestamp?: string;
    balanceChanges?: {
      nodes: GqlBalanceChangeNode[];
    };
  };
  kind?: {
    commands?: {
      nodes: GqlCommandNode[];
    };
  };
}

interface GqlTransactionsResponse {
  transactions: {
    nodes: GqlTransactionNode[];
    pageInfo: {
      hasNextPage: boolean;
      endCursor?: string;
    };
  };
}

/**
 * Convert GraphQL command nodes into the shape expected by decodeTransaction.
 * Skips infrastructure commands (SplitCoins, MergeCoins) as the decoder does.
 */
function adaptCommands(nodes: GqlCommandNode[]): GrpcTypes.Command[] {
  const commands: unknown[] = [];

  for (const node of nodes) {
    switch (node.__typename) {
      case "MoveCallCommand":
        commands.push({
          command: {
            oneofKind: "moveCall",
            moveCall: {
              package: node.function?.module.package.address ?? "",
              module: node.function?.module.name ?? "",
              function: node.function?.name ?? "",
              typeArguments: [],
            },
          },
        });
        break;
      case "TransferObjectsCommand":
        commands.push({
          command: {
            oneofKind: "transferObjects",
            transferObjects: {},
          },
        });
        break;
      case "PublishCommand":
        commands.push({
          command: {
            oneofKind: "publish",
            publish: {},
          },
        });
        break;
      case "UpgradeCommand":
        commands.push({
          command: {
            oneofKind: "upgrade",
            upgrade: {},
          },
        });
        break;
      // SplitCoinsCommand and MergeCoinsCommand are infrastructure - skip
      default:
        break;
    }
  }

  return commands as unknown as GrpcTypes.Command[];
}

/**
 * Convert GraphQL balance change nodes into the shape expected by decodeTransaction.
 */
function adaptBalanceChanges(nodes: GqlBalanceChangeNode[]): GrpcTypes.BalanceChange[] {
  const changes: unknown[] = nodes.map((node) => ({
    address: node.owner?.address ?? "",
    coinType: node.coinType?.repr ?? "",
    amount: node.amount ?? "0",
  }));

  return changes as unknown as GrpcTypes.BalanceChange[];
}

const HISTORY_QUERY = `
  query($address: SuiAddress!, $first: Int, $after: String) {
    transactions(filter: { affectedAddress: $address }, first: $first, after: $after) {
      nodes {
        digest
        sender { address }
        effects {
          status
          timestamp
          balanceChanges {
            nodes {
              coinType { repr }
              amount
              owner { address }
            }
          }
        }
        kind {
          ... on ProgrammableTransaction {
            commands {
              nodes {
                ... on MoveCallCommand {
                  __typename
                  function {
                    name
                    module {
                      name
                      package { address }
                    }
                  }
                }
                ... on TransferObjectsCommand {
                  __typename
                }
                ... on SplitCoinsCommand {
                  __typename
                }
                ... on MergeCoinsCommand {
                  __typename
                }
                ... on PublishCommand {
                  __typename
                }
                ... on UpgradeCommand {
                  __typename
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Action category mapping for activity summary
const ACTION_CATEGORIES: Record<string, string> = {
  swap: "defi",
  add_liquidity: "defi",
  remove_liquidity: "defi",
  open_position: "defi",
  close_position: "defi",
  deposit: "defi",
  withdraw: "defi",
  borrow: "defi",
  repay: "defi",
  flash_loan: "defi",
  flash_repay: "defi",
  liquidate: "defi",
  claim_rewards: "defi",
  create_obligation: "defi",
  stake: "staking",
  unstake: "staking",
  transfer: "transfers",
};

function categorizeAction(action: string): string {
  // Match the action label to a category
  const lower = action.toLowerCase();
  for (const [key, cat] of Object.entries(ACTION_CATEGORIES)) {
    if (lower.startsWith(key) || lower.includes(key)) return cat;
  }
  if (lower.includes("publish") || lower.includes("upgrade")) return "development";
  if (lower.includes("transfer")) return "transfers";
  return "other";
}

function shortCoinType(coinType: string): string {
  const parts = coinType.split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : coinType;
}

export function registerHistoryTools(server: McpServer) {
  server.tool(
    "get_transaction_history",
    "Get decoded transaction history for a Sui wallet address. Combines transaction queries with protocol-aware decoding to return a human-readable activity feed with protocol names, action descriptions, and token flow.",
    {
      address: z.string().describe("Sui wallet address (0x...)"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Number of transactions to return (default 10, max 50)"),
      after: z
        .string()
        .optional()
        .describe("Pagination cursor for next page"),
    },
    async ({ address, limit, after }) => {
      const variables: Record<string, unknown> = {
        address,
        first: limit,
        after: after ?? undefined,
      };

      const data = await gqlQuery<GqlTransactionsResponse>(HISTORY_QUERY, variables);

      const transactions = data.transactions.nodes.map((node) => {
        const sender = node.sender?.address;
        const commandNodes = node.kind?.commands?.nodes ?? [];
        const balanceChangeNodes = node.effects?.balanceChanges?.nodes ?? [];

        const commands = adaptCommands(commandNodes);
        const balanceChanges = adaptBalanceChanges(balanceChangeNodes);

        const decoded = decodeTransaction(commands, balanceChanges, sender);

        return {
          digest: node.digest,
          timestamp: node.effects?.timestamp ?? null,
          sender: sender ?? null,
          status: node.effects?.status?.toLowerCase() === "success"
            ? "success"
            : (node.effects?.status?.toLowerCase() ?? "unknown"),
          protocols: decoded.protocols,
          actions: decoded.actions,
          token_flow: decoded.token_flow,
        };
      });

      const result = {
        address,
        transactions,
        has_next_page: data.transactions.pageInfo.hasNextPage,
        next_cursor: data.transactions.pageInfo.endCursor ?? null,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_wallet_activity_summary",
    "Get an aggregated activity summary for a Sui wallet. Analyzes recent transactions and returns: activity categories (DeFi, transfers, staking), protocol usage frequency, net token volume, success rate, and time range. Useful for understanding a wallet's behavior at a glance.",
    {
      address: z.string().describe("Sui wallet address (0x...)"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .default(50)
        .describe("Number of recent transactions to analyze (default 50, max 50)"),
    },
    async ({ address, limit }) => {
      const data = await gqlQuery<GqlTransactionsResponse>(HISTORY_QUERY, {
        address,
        first: limit,
      });

      const nodes = data.transactions.nodes;
      if (nodes.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              address,
              transaction_count: 0,
              note: "No transactions found for this address.",
            }, null, 2),
          }],
        };
      }

      // Aggregate data
      const protocolCounts = new Map<string, number>();
      const categoryCounts = new Map<string, number>();
      const actionCounts = new Map<string, number>();
      const tokenVolume = new Map<string, { in: bigint; out: bigint; raw_type: string }>();
      let successCount = 0;
      let sentCount = 0;
      let receivedCount = 0;

      for (const node of nodes) {
        const sender = node.sender?.address;
        const commandNodes = node.kind?.commands?.nodes ?? [];
        const balanceChangeNodes = node.effects?.balanceChanges?.nodes ?? [];

        const commands = adaptCommands(commandNodes);
        const balanceChanges = adaptBalanceChanges(balanceChangeNodes);
        const decoded = decodeTransaction(commands, balanceChanges, sender);

        // Track success rate
        if (node.effects?.status?.toLowerCase() === "success") successCount++;

        // Track sent vs received
        if (sender === address) sentCount++;
        else receivedCount++;

        // Protocol frequency
        for (const proto of decoded.protocols) {
          protocolCounts.set(proto, (protocolCounts.get(proto) ?? 0) + 1);
        }

        // Action and category counts
        for (const action of decoded.actions) {
          const category = categorizeAction(action);
          categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
          actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
        }

        // Token volume (net flows for this wallet)
        for (const flow of decoded.token_flow) {
          const existing = tokenVolume.get(flow.coin) ?? { in: 0n, out: 0n, raw_type: flow.raw_type };
          const amt = BigInt(flow.amount);
          if (amt > 0n) {
            existing.in += amt;
          } else {
            existing.out += -amt;
          }
          tokenVolume.set(flow.coin, existing);
        }
      }

      // Build sorted outputs
      const protocols = [...protocolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ protocol: name, transaction_count: count }));

      const categories = [...categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([category, count]) => ({ category, action_count: count }));

      const topActions = [...actionCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([action, count]) => ({ action, count }));

      const volume = [...tokenVolume.entries()]
        .sort((a, b) => {
          const aTotal = a[1].in + a[1].out;
          const bTotal = b[1].in + b[1].out;
          return bTotal > aTotal ? 1 : bTotal < aTotal ? -1 : 0;
        })
        .map(([coin, v]) => ({
          coin,
          raw_type: v.raw_type,
          total_in: v.in.toString(),
          total_out: v.out.toString(),
        }));

      // Time range
      const timestamps = nodes
        .map((n) => n.effects?.timestamp)
        .filter((t): t is string => !!t)
        .sort();
      const timeRange = timestamps.length > 0
        ? { oldest: timestamps[0], newest: timestamps[timestamps.length - 1] }
        : null;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            address,
            transactions_analyzed: nodes.length,
            has_more: data.transactions.pageInfo.hasNextPage,
            time_range: timeRange,
            success_rate: nodes.length > 0
              ? Math.round((successCount / nodes.length) * 100) + "%"
              : "N/A",
            sent_count: sentCount,
            received_count: receivedCount,
            categories,
            protocols,
            top_actions: topActions,
            token_volume: volume,
          }, null, 2),
        }],
      };
    }
  );
}
