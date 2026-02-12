import { z } from "zod";
import { sui, archive } from "../clients/grpc.js";
import { formatStatus, formatGas, bigintToString, timestampToIso } from "../utils/formatting.js";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { gqlQuery } from "../clients/graphql.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { decodeTransaction } from "../protocols/decoder.js";

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
      const sender = transaction?.sender;

      let decoded;
      if (kind?.data.oneofKind === "programmableTransaction") {
        const ptb = kind.data.programmableTransaction;
        decoded = decodeTransaction(ptb.commands, tx?.balanceChanges, sender);
      } else if (kind?.data.oneofKind) {
        decoded = {
          protocols: [] as string[],
          actions: [`System transaction: ${kind.data.oneofKind}`],
          token_flow: [] as { coin: string; amount: string; raw_type: string }[],
        };
      } else {
        decoded = {
          protocols: [] as string[],
          actions: [] as string[],
          token_flow: [] as { coin: string; amount: string; raw_type: string }[],
        };
      }

      const eventCount = tx?.events?.events?.length ?? 0;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                digest: tx?.digest,
                sender,
                status: formatStatus(effects?.status),
                timestamp: timestampToIso(tx?.timestamp),
                protocols: decoded.protocols,
                actions: decoded.actions,
                token_flow: decoded.token_flow,
                gas: formatGas(effects?.gasUsed),
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
    "Get a comprehensive overview of a Sui wallet: all token balances, SuiNS name, staked SUI count, kiosk/NFT count, and recent transactions.",
    {
      address: z.string().describe("Wallet address (0x...)"),
    },
    async ({ address }) => {
      const [balancesResult, nameResult, objectsResult, kioskResult, txResult] =
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

          // Kiosk count via KioskOwnerCap
          sui.listOwnedObjects({
            owner: address,
            type: "0x2::kiosk::KioskOwnerCap",
            limit: 50,
            cursor: null,
          }).catch(() => ({ objects: [] })),

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
                balances_truncated: balancesResult.hasNextPage ?? false,
                staked_sui_count: objectsResult.objects.length,
                staked_sui_truncated: objectsResult.hasNextPage ?? false,
                kiosk_count: kioskResult.objects.length,
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
