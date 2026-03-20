import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerCoinTools(server: McpServer) {
  server.tool(
    "get_balance",
    "Get the balance of a specific coin type for a Sui address. Defaults to SUI. Optionally query balance at a historical checkpoint.",
    {
      owner: z.string().describe("Owner address (0x...)"),
      coin_type: z
        .string()
        .optional()
        .describe("Coin type (default: 0x2::sui::SUI)"),
      at_checkpoint: z
        .number()
        .optional()
        .describe("Query balance at a specific checkpoint (for historical balances)"),
    },
    async ({ owner, coin_type, at_checkpoint }) => {
      if (at_checkpoint != null) {
        const coinType = coin_type ?? "0x2::sui::SUI";
        const data = await gqlQuery<{
          address: {
            balance: { coinType: { repr: string }; totalBalance: string } | null;
          } | null;
        }>(
          `query($owner: SuiAddress!, $coinType: String!, $checkpoint: UInt53) {
            address(address: $owner, atCheckpoint: $checkpoint) {
              balance(coinType: $coinType) {
                coinType { repr }
                totalBalance
              }
            }
          }`,
          { owner, coinType, checkpoint: at_checkpoint }
        );
        const bal = data.address?.balance;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              coin_type: bal?.coinType.repr ?? coinType,
              balance: bal?.totalBalance ?? "0",
              at_checkpoint,
            }, null, 2),
          }],
        };
      }

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
    "get_coin_info",
    "Get on-chain metadata for a token/coin given its exact coin type string (e.g. '0x2::sui::SUI'). Returns name, symbol, decimals, description, icon URL, and total supply. If you only have a name or symbol, use search_token first to find the coin type.",
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
