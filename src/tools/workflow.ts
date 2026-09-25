import { coinScale, displayCoin } from "../utils/valuation.js";
import { boolArg, addressArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";
import { describeError, errorResult } from "../utils/errors.js";
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
      address: addressArg().describe("Wallet address (0x...)"),
      include_prices: boolArg()
        .optional()
        .describe("Include USD prices and portfolio value (default: false)"),
    },
    async ({ address, include_prices }) => {
      const [gqlResult, objectsResult, kioskResult] =
        await Promise.all([
          gqlQuery<{
            address: {
              defaultNameRecord: { domain: string } | null;
              balances: {
                nodes: Array<{
                  coinType: { repr: string };
                  totalBalance: string;
                  coinBalance: string | null;
                  addressBalance: string | null;
                }>;
                pageInfo: { hasNextPage: boolean };
              };
            } | null;
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
            `query($address: SuiAddress!, $first: Int, $txFirst: Int) {
              address(address: $address) {
                defaultNameRecord { domain }
                balances(first: $first) {
                  nodes {
                    coinType { repr }
                    totalBalance
                    coinBalance
                    addressBalance
                  }
                  pageInfo { hasNextPage }
                }
              }
              transactions(filter: { affectedAddress: $address }, last: $txFirst) {
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
            { address, first: 50, txFirst: 5 }
          // A failed read is an error, never an empty wallet: `holdings: []`
          // and no transactions is exactly what a real unused address returns.
          ).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),

          sui.listOwnedObjects({
            owner: address,
            type: "0x3::staking_pool::StakedSui",
            limit: 50,
            cursor: null,
          }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),

          sui.listOwnedObjects({
            owner: address,
            type: "0x2::kiosk::KioskOwnerCap",
            limit: 50,
            cursor: null,
          }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
        ]);

      if (gqlResult instanceof Error) {
        return errorResult(
          `Could not read the balances, name and recent transactions of ${address}: ${describeError(gqlResult, getNetwork())}. ` +
            "This is not evidence the wallet is empty.",
        );
      }
      const addrData = gqlResult.address;
      const nameResult = addrData?.defaultNameRecord?.domain ?? null;
      const rawBalances = (addrData?.balances.nodes ?? [])
        .filter((b) => b.totalBalance !== "0")
        .map((b) => ({
          coinType: b.coinType.repr,
          balance: b.totalBalance,
          coinBalance: b.coinBalance ?? "0",
          addressBalance: b.addressBalance ?? "0",
        }));
      const hasNextPage = addrData?.balances.pageInfo.hasNextPage ?? false;
      const txResult = gqlResult;
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
        // On-chain metadata is authoritative when present. Falling back to the
        // registry's scale rather than a bare 9 keeps this consistent with how
        // traces render the same coin, and marks a guess as a guess.
        const scale = coinScale(b.coinType);
        const decimals = meta?.decimals ?? scale.decimals;
        const known = displayCoin(b.coinType);
        const symbol = meta?.symbol ?? known.symbol;

        const base: Record<string, unknown> = {
          coin_type: b.coinType,
          symbol,
          // The symbol is whatever the minter chose; 8,008 mainnet coins share
          // one with another. Marked here for the same reason a trace marks it.
          verified: known.verified,
          balance: b.balance,
          // `balance` is the total. A holding with no Coin<T> objects sits
          // entirely in the address balance, so list_owned_objects shows no
          // coin for it while this shows the funds.
          coin_balance: b.coinBalance,
          address_balance: b.addressBalance,
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

      // `last` returns the five newest in ascending order; reversed so the
      // first row is the most recent. `first` would return the address's
      // five OLDEST transactions under a field named "recent".
      const recentTransactions = [...(txResult?.transactions.nodes ?? [])].reverse().map((n) => ({
        digest: n.digest,
        sender: n.sender?.address,
        status: n.effects?.status,
        timestamp: n.effects?.timestamp,
      }));

      const result: Record<string, unknown> = {
        address,
        sui_name: nameResult,
        holdings,
        holdings_truncated: hasNextPage,
        staked_sui_count: objectsResult instanceof Error ? null : objectsResult.objects.length,
        kiosk_count: kioskResult instanceof Error ? null : kioskResult.objects.length,
        recent_transactions: recentTransactions,
      };
      // A failed read is reported as unknown, not as zero.
      if (objectsResult instanceof Error) {
        result.staked_sui_unavailable = `The StakedSui read failed (${describeError(objectsResult, getNetwork())}), so how much is staked is unknown. Try get_staking_summary.`;
      }
      if (kioskResult instanceof Error) {
        result.kiosk_unavailable = `The kiosk read failed (${describeError(kioskResult, getNetwork())}), so whether this wallet owns kiosks is unknown.`;
      }

      if (include_prices) {
        // A holding with no price contributes 0, so the total silently covers
        // only what could be priced. Measured on three mainnet wallets: 1 of 3,
        // 46 of 50 and 5 of 15 holdings had no price. The middle one reported
        // $1.86 for a wallet holding fifty coins, which reads as a portfolio
        // value rather than as four coins out of fifty.
        const priced = holdings.filter((h) => h.value_usd != null);
        const unpriced = holdings.length - priced.length;
        result.total_value_usd =
          Math.round(priced.reduce((sum, h) => sum + ((h.value_usd as number) ?? 0), 0) * 100) / 100;
        result.priced_holdings = priced.length;
        result.unpriced_holdings = unpriced;
        result.verified_holdings = holdings.filter((h) => h.verified === true).length;

        if (unpriced > 0 || hasNextPage) {
          const parts: string[] = [];
          if (unpriced > 0) {
            // Say what an absent price most likely MEANS rather than only that
            // it is absent. Nobody makes a market in a token minted to look
            // like another one, which is why `pickFundingTx` treats an unpriced
            // coin as spam at any size — but a newly listed asset is
            // indistinguishable here, so both readings are given.
            const unverifiedUnpriced = holdings.filter(
              (h) => h.value_usd == null && h.verified === false,
            ).length;
            parts.push(
              `Covers the ${priced.length} of ${holdings.length} holdings that have a price. The other ${unpriced} contribute nothing.` +
                (unverifiedUnpriced > 0
                  ? ` ${unverifiedUnpriced} of those are also unverified — no market price and nothing vouching for the coin is the usual shape of a spam or impersonation token, though a newly listed asset looks the same.`
                  : " A coin with no market price usually has no market, though a newly listed asset looks the same here."),
            );
          }
          if (hasNextPage) {
            parts.push(
              "The holdings list was also truncated, so coins beyond the page are excluded entirely.",
            );
          }
          result.total_value_note = `${parts.join(" ")} Treat this as a floor, not a portfolio value.`;
        }
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
