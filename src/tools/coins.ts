import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { clampPageSize } from "../utils/pagination.js";
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
    "Get metadata for a coin type: name, symbol, decimals, description, supply.",
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
}
