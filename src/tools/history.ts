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

export function registerHistoryTools(server: McpServer) {
  server.tool(
    "get_transaction_history",
    "(Recommended for wallet activity) Get decoded transaction history for a Sui wallet. Returns a human-readable activity feed with protocol names (e.g. Cetus, Suilend), action descriptions (e.g. 'Swap USDC → SUI'), and token flow. Prefer this over query_transactions when exploring what a wallet has been doing.",
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

}
