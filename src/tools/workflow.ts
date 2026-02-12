import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { fetchAftermathPrices } from "./prices.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function extractSymbol(coinType: string): string {
  return coinType.split("::").pop() ?? coinType;
}

export function registerWorkflowTools(server: McpServer) {
  server.tool(
    "get_wallet_overview",
    "(Recommended first tool for wallets) Get a comprehensive overview of a Sui wallet: all token balances, SuiNS name, staked SUI count, kiosk/NFT count, and recent transactions. Set include_prices=true for USD values and total portfolio value. Start here before drilling into specific tools.",
    {
      address: z.string().describe("Wallet address (0x...)"),
      include_prices: z
        .boolean()
        .optional()
        .describe("Include USD prices and portfolio value (default: false)"),
    },
    async ({ address, include_prices }) => {
      const [balancesResult, nameResult, objectsResult, kioskResult, txResult] =
        await Promise.all([
          sui.listBalances({ owner: address, limit: 50, cursor: null }),

          sui.nameService
            .reverseLookupName({ address })
            .then(({ response }) => response.record?.name ?? null)
            .catch(() => null),

          sui.listOwnedObjects({
            owner: address,
            type: "0x3::staking_pool::StakedSui",
            limit: 50,
            cursor: null,
          }),

          sui.listOwnedObjects({
            owner: address,
            type: "0x2::kiosk::KioskOwnerCap",
            limit: 50,
            cursor: null,
          }).catch(() => ({ objects: [] })),

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

      const rawBalances = balancesResult.balances.filter((b) => b.balance !== "0");
      const coinTypes = rawBalances.map((b) => b.coinType);

      // Optionally fetch prices and metadata
      let priceData: Record<string, { price: number; priceChange24HoursPercentage: number }> | null = null;
      let metaMap = new Map<string, { decimals: number; symbol: string }>();

      if (include_prices && coinTypes.length > 0) {
        const [prices, metaResults] = await Promise.all([
          fetchAftermathPrices(coinTypes),
          Promise.allSettled(
            coinTypes.map((ct) =>
              sui.stateService.getCoinInfo({ coinType: ct })
            )
          ),
        ]);
        priceData = prices;

        for (let i = 0; i < coinTypes.length; i++) {
          const result = metaResults[i];
          if (result.status === "fulfilled") {
            const meta = result.value.response.metadata;
            if (meta) {
              metaMap.set(coinTypes[i], {
                decimals: meta.decimals ?? 9,
                symbol: meta.symbol ?? extractSymbol(coinTypes[i]),
              });
            }
          }
        }
      }

      // Build holdings
      const holdings = rawBalances.map((b) => {
        const meta = metaMap.get(b.coinType);
        const decimals = meta?.decimals ?? 9;
        const symbol = meta?.symbol ?? extractSymbol(b.coinType);

        const base: Record<string, unknown> = {
          coin_type: b.coinType,
          symbol,
          balance: b.balance,
        };

        if (include_prices) {
          const humanAmount = Number(BigInt(b.balance)) / 10 ** decimals;
          const afEntry = priceData?.[b.coinType];
          const priceUsd = afEntry && afEntry.price >= 0 ? afEntry.price : null;
          const valueUsd = priceUsd != null
            ? Math.round(humanAmount * priceUsd * 100) / 100
            : null;
          base.balance_human = humanAmount.toString();
          base.decimals = decimals;
          base.price_usd = priceUsd;
          base.value_usd = valueUsd;
        }

        return base;
      });

      // Sort by value if prices included
      if (include_prices) {
        holdings.sort((a, b) => {
          const aVal = a.value_usd as number | null;
          const bVal = b.value_usd as number | null;
          if (aVal == null && bVal == null) return 0;
          if (aVal == null) return 1;
          if (bVal == null) return -1;
          return bVal - aVal;
        });
      }

      const recentTransactions = txResult?.transactions.nodes.map((n) => ({
        digest: n.digest,
        sender: n.sender?.address,
        status: n.effects?.status,
        timestamp: n.effects?.timestamp,
      })) ?? [];

      const result: Record<string, unknown> = {
        address,
        sui_name: nameResult,
        holdings,
        holdings_truncated: balancesResult.hasNextPage ?? false,
        staked_sui_count: objectsResult.objects.length,
        kiosk_count: kioskResult.objects.length,
        recent_transactions: recentTransactions,
      };

      if (include_prices) {
        const totalValueUsd = Math.round(
          holdings.reduce((sum, h) => sum + ((h.value_usd as number) ?? 0), 0) * 100
        ) / 100;
        result.total_value_usd = totalValueUsd;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
