import { z } from "zod";
import { sui } from "../clients/grpc.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AFTERMATH_PRICE_URL = "https://aftermath.finance/api/price-info";

interface AftermathPriceEntry {
  price: number;
  priceChange24HoursPercentage: number;
}

function extractSymbol(coinType: string): string {
  return coinType.split("::").pop() ?? coinType;
}

interface Holding {
  coin_type: string;
  symbol: string;
  balance_raw: string;
  balance: string;
  decimals: number;
  price_usd: number | null;
  value_usd: number | null;
}

export function registerPortfolioTools(server: McpServer) {
  server.tool(
    "get_portfolio_value",
    "Get a wallet's total portfolio value in USD: all token balances with prices and USD values, staked SUI count, and SuiNS name.",
    {
      address: z.string().describe("Wallet address (0x...)"),
    },
    async ({ address }) => {
      // 1. Fetch all balances
      const balanceRes = await sui.listBalances({
        owner: address,
        limit: 50,
        cursor: null,
      });
      const balancesTruncated = balanceRes.hasNextPage ?? false;
      const balances = balanceRes.balances.filter((b) => b.balance !== "0");
      const coinTypes = balances.map((b) => b.coinType);

      // 2. Fetch metadata, prices, staked objects, and SuiNS name in parallel
      const metaResultsPromise = Promise.allSettled(
        coinTypes.map((ct) =>
          sui.stateService.getCoinInfo({ coinType: ct })
        )
      );

      const pricePromise = fetch(AFTERMATH_PRICE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coins: coinTypes }),
        signal: AbortSignal.timeout(10_000),
      })
        .then((resp) => (resp.ok ? resp.json() : null))
        .catch(() => null) as Promise<Record<
        string,
        AftermathPriceEntry
      > | null>;

      const stakedPromise = sui
        .listOwnedObjects({
          owner: address,
          type: "0x3::staking_pool::StakedSui",
          limit: 50,
          cursor: null,
        })
        .then((res) => res.objects.length)
        .catch(() => 0);

      const namePromise = sui.nameService
        .reverseLookupName({ address })
        .then(({ response }) => response.record?.name ?? null)
        .catch(() => null);

      const [metaResults, priceData, stakedSuiCount, suiName] =
        await Promise.all([
          metaResultsPromise,
          pricePromise,
          stakedPromise,
          namePromise,
        ]);

      // 3. Build metadata map
      const metaMap = new Map<
        string,
        { decimals: number; symbol: string }
      >();
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

      // 4. Build holdings
      const unpricedTokens: string[] = [];
      const holdings: Holding[] = [];

      for (const b of balances) {
        const meta = metaMap.get(b.coinType);
        const decimals = meta?.decimals ?? 9;
        const symbol = meta?.symbol ?? extractSymbol(b.coinType);

        const humanAmount = Number(BigInt(b.balance)) / 10 ** decimals;

        const afEntry = priceData?.[b.coinType];
        const priceUsd =
          afEntry && afEntry.price >= 0 ? afEntry.price : null;

        if (priceUsd == null) {
          unpricedTokens.push(b.coinType);
        }

        const valueUsd =
          priceUsd != null
            ? Math.round(humanAmount * priceUsd * 100) / 100
            : null;

        holdings.push({
          coin_type: b.coinType,
          symbol,
          balance_raw: b.balance,
          balance: humanAmount.toString(),
          decimals,
          price_usd: priceUsd,
          value_usd: valueUsd,
        });
      }

      // 5. Sort by value_usd descending (nulls last)
      holdings.sort((a, b) => {
        if (a.value_usd == null && b.value_usd == null) return 0;
        if (a.value_usd == null) return 1;
        if (b.value_usd == null) return -1;
        return b.value_usd - a.value_usd;
      });

      // 6. Compute total portfolio value
      const totalValueUsd =
        Math.round(
          holdings.reduce((sum, h) => sum + (h.value_usd ?? 0), 0) * 100
        ) / 100;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address,
                sui_name: suiName,
                total_value_usd: totalValueUsd,
                holdings,
                holdings_truncated: balancesTruncated,
                staked_sui_count: stakedSuiCount,
                unpriced_tokens: unpricedTokens,
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
