import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { fetchAftermathPrices } from "./prices.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface WalletHolding {
  coin_type: string;
  balance: string;
  usd_value: number | null;
}

interface WalletSummary {
  address: string;
  holdings: WalletHolding[];
  total_value_usd: number | null;
  nft_count: number;
}

export function registerCompareTools(server: McpServer) {
  server.tool(
    "compare_wallets",
    "Compare token holdings across multiple Sui wallets. Shows shared and unique tokens, with USD values where available.",
    {
      addresses: z
        .array(z.string())
        .min(2)
        .max(5)
        .describe("Array of 2-5 wallet addresses to compare"),
    },
    async ({ addresses }) => {
      // Fetch balances and NFT counts in parallel for all wallets
      const walletData = await Promise.all(
        addresses.map(async (addr) => {
          const [balRes, nftRes] = await Promise.all([
            sui.listBalances({ owner: addr, limit: 100, cursor: null }),
            sui.listOwnedObjects({
              owner: addr,
              type: "0x2::kiosk::KioskOwnerCap",
              limit: 50,
            }),
          ]);
          return {
            address: addr,
            balances: balRes.balances,
            nftCount: nftRes.objects.length,
          };
        })
      );

      // Collect all unique coin types
      const allCoinTypes = new Set<string>();
      for (const w of walletData) {
        for (const b of w.balances) {
          allCoinTypes.add(b.coinType);
        }
      }

      // Fetch prices for all coin types
      const prices = allCoinTypes.size > 0
        ? await fetchAftermathPrices([...allCoinTypes])
        : null;

      // Build wallet summaries
      const wallets: WalletSummary[] = walletData.map((w) => {
        let totalUsd: number | null = 0;
        const holdings: WalletHolding[] = w.balances.map((b) => {
          const priceEntry = prices?.[b.coinType];
          const priceUsd = priceEntry && priceEntry.price >= 0 ? priceEntry.price : null;
          let usdValue: number | null = null;
          if (priceUsd != null) {
            // Assume 9 decimals for SUI-type tokens, rough estimate for others
            const balance = Number(b.balance) / 1_000_000_000;
            usdValue = Math.round(balance * priceUsd * 100) / 100;
            if (totalUsd != null) totalUsd += usdValue;
          } else {
            totalUsd = null;
          }
          return {
            coin_type: b.coinType,
            balance: b.balance,
            usd_value: usdValue,
          };
        });
        return {
          address: w.address,
          holdings,
          total_value_usd: totalUsd,
          nft_count: w.nftCount,
        };
      });

      // Compute shared and unique tokens
      const tokenSets = walletData.map(
        (w) => new Set(w.balances.map((b) => b.coinType))
      );
      const sharedTokens = [...allCoinTypes].filter((ct) =>
        tokenSets.every((s) => s.has(ct))
      );
      const uniquePerWallet: Record<string, string[]> = {};
      for (let i = 0; i < addresses.length; i++) {
        uniquePerWallet[addresses[i]] = [...tokenSets[i]].filter(
          (ct) => !tokenSets.some((s, j) => j !== i && s.has(ct))
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                wallet_count: addresses.length,
                wallets,
                comparison: {
                  total_unique_tokens: allCoinTypes.size,
                  shared_tokens: sharedTokens,
                  unique_tokens_per_wallet: uniquePerWallet,
                },
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
