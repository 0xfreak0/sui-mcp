import { z } from "zod";
import { sui, archive } from "../clients/grpc.js";
import { formatStatus, formatGas, bigintToString, timestampToIso } from "../utils/formatting.js";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { gqlQuery } from "../clients/graphql.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function summarizeCommand(cmd: GrpcTypes.Command): string {
  const c = cmd.command;
  switch (c.oneofKind) {
    case "moveCall": {
      const mc = c.moveCall;
      const pkg = mc.package ?? "?";
      const mod = mc.module ?? "?";
      const fn = mc.function ?? "?";
      return `Call ${pkg}::${mod}::${fn}`;
    }
    case "transferObjects": {
      const count = c.transferObjects.objects.length;
      return `Transfer ${count} object${count !== 1 ? "s" : ""}`;
    }
    case "splitCoins":
      return `Split coins (${c.splitCoins.amounts.length} split${c.splitCoins.amounts.length !== 1 ? "s" : ""})`;
    case "mergeCoins":
      return `Merge ${c.mergeCoins.coinsToMerge.length} coin${c.mergeCoins.coinsToMerge.length !== 1 ? "s" : ""}`;
    case "publish":
      return "Publish new package";
    case "upgrade":
      return "Upgrade package";
    case "makeMoveVector":
      return "Construct vector";
    default:
      return "Unknown command";
  }
}

export function registerWorkflowTools(server: McpServer) {
  server.tool(
    "explain_transaction",
    "Get a human-readable explanation of a Sui transaction. Returns a summary of each command (Move calls, transfers, splits, etc.), gas costs, balance changes, and event count.",
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
        ({ response: res } = await archive.ledgerService.getTransaction(req));
      }

      const tx = res.transaction;
      const effects = tx?.effects;
      const transaction = tx?.transaction;
      const kind = transaction?.kind;

      const summary: string[] = [];
      if (kind?.data.oneofKind === "programmableTransaction") {
        const ptb = kind.data.programmableTransaction;
        for (const cmd of ptb.commands) {
          summary.push(summarizeCommand(cmd));
        }
      } else if (kind?.data.oneofKind) {
        summary.push(`System transaction: ${kind.data.oneofKind}`);
      }

      const balanceChanges = tx?.balanceChanges?.map((bc: GrpcTypes.BalanceChange) => ({
        address: bc.address,
        coin_type: bc.coinType,
        amount: bc.amount,
      }));

      const eventCount = tx?.events?.events?.length ?? 0;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                digest: tx?.digest,
                sender: transaction?.sender,
                status: formatStatus(effects?.status),
                timestamp: timestampToIso(tx?.timestamp),
                checkpoint: bigintToString(tx?.checkpoint),
                summary,
                gas: formatGas(effects?.gasUsed),
                balance_changes: balanceChanges,
                event_count: eventCount,
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
    "analyze_wallet",
    "Get a comprehensive overview of a Sui wallet: all token balances, SuiNS name, staked SUI count, and recent transactions.",
    {
      address: z.string().describe("Wallet address (0x...)"),
    },
    async ({ address }) => {
      const [balancesResult, nameResult, objectsResult, txResult] =
        await Promise.all([
          // All token balances
          sui.listBalances({ owner: address, limit: 50, cursor: null }),

          // SuiNS reverse lookup (optional, may fail)
          sui.nameService
            .reverseLookupName({ address })
            .then(({ response }) => response.record?.name ?? null)
            .catch(() => null),

          // Owned objects to find StakedSui
          sui.listOwnedObjects({
            owner: address,
            type: "0x3::staking_pool::StakedSui",
            limit: 50,
            cursor: null,
          }),

          // Recent transactions via GraphQL
          gqlQuery<{
            transactions: {
              nodes: Array<{
                digest: string;
                sender?: { address: string };
                effects?: {
                  status: string;
                  timestamp?: string;
                };
              }>;
            };
          }>(
            `query($address: SuiAddress!, $first: Int) {
              transactions(filter: { affectedAddress: $address }, first: $first) {
                nodes {
                  digest
                  sender { address }
                  effects {
                    status
                    timestamp
                  }
                }
              }
            }`,
            { address, first: 5 }
          ).catch(() => null),
        ]);

      const balances = balancesResult.balances.map((b) => ({
        coin_type: b.coinType,
        balance: b.balance,
      }));

      const recentTransactions = txResult?.transactions.nodes.map((n) => ({
        digest: n.digest,
        sender: n.sender?.address,
        status: n.effects?.status,
        timestamp: n.effects?.timestamp,
      })) ?? [];

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address,
                sui_name: nameResult,
                balances,
                staked_sui_count: objectsResult.objects.length,
                recent_transactions: recentTransactions,
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
