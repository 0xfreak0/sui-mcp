import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { clampPageSize } from "../utils/pagination.js";
import { fetchAftermathPrices } from "./prices.js";
import { scanTokenTopHolders } from "./holders.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCoinTools(server: McpServer) {
  server.tool(
    "get_balance",
    "Get the balance of a specific coin type for a Sui address. Defaults to SUI.",
    {
      owner: z.string().describe("Owner address (0x...)"),
      coin_type: z
        .string()
        .optional()
        .describe("Coin type (default: 0x2::sui::SUI)"),
    },
    async ({ owner, coin_type }) => {
      const res = await sui.getBalance({
        owner,
        coinType: coin_type,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                coin_type: res.balance.coinType,
                balance: res.balance.balance,
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
    "list_balances",
    "List all coin balances for a Sui address.",
    {
      owner: z.string().describe("Owner address (0x...)"),
      limit: z.number().optional().describe("Max results (default 50)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ owner, limit, cursor }) => {
      const res = await sui.listBalances({
        owner,
        limit: clampPageSize(limit),
        cursor: cursor ?? null,
      });
      const balances = res.balances.map((b) => ({
        coin_type: b.coinType,
        balance: b.balance,
      }));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                balances,
                has_next_page: res.hasNextPage,
                next_cursor: res.cursor,
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
    "get_coin_info",
    "Look up a token/coin on Sui by its full coin type. Returns name, symbol, decimals, description, icon URL, and total supply. Use this to find token info — requires the exact coin type string (e.g. '0x2::sui::SUI').",
    {
      coin_type: z
        .string()
        .describe("Coin type (e.g. 0x2::sui::SUI)"),
    },
    async ({ coin_type }) => {
      // Use low-level client for full data including supply
      const { response: res } = await sui.stateService.getCoinInfo({
        coinType: coin_type,
      });
      const meta = res.metadata;
      const treasury = res.treasury;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                coin_type: res.coinType,
                name: meta?.name,
                symbol: meta?.symbol,
                decimals: meta?.decimals,
                description: meta?.description,
                icon_url: meta?.iconUrl,
                total_supply: treasury?.totalSupply?.toString(),
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
    "get_token_info_extended",
    "Get extended token information including metadata, current price, 24h change, and top holders. Combines coin info, price data, and holder analysis in one call.",
    {
      coin_type: z
        .string()
        .describe("Coin type (e.g. 0x2::sui::SUI)"),
    },
    async ({ coin_type }) => {
      const [coinInfoRes, priceData, holderData] = await Promise.all([
        sui.stateService.getCoinInfo({ coinType: coin_type }).then((r) => r.response),
        fetchAftermathPrices([coin_type]),
        scanTokenTopHolders(coin_type, 5, 1000).catch(() => null),
      ]);

      const meta = coinInfoRes.metadata;
      const treasury = coinInfoRes.treasury;
      const priceEntry = priceData?.[coin_type];
      const priceUsd = priceEntry && priceEntry.price >= 0 ? priceEntry.price : null;
      const priceChange = priceEntry && priceEntry.price >= 0
        ? priceEntry.priceChange24HoursPercentage
        : null;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                coin_type: coinInfoRes.coinType,
                name: meta?.name,
                symbol: meta?.symbol,
                decimals: meta?.decimals,
                description: meta?.description,
                icon_url: meta?.iconUrl,
                total_supply: treasury?.totalSupply?.toString(),
                price_usd: priceUsd,
                price_change_24h_percent: priceChange,
                top_holders: holderData?.holders ?? [],
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
