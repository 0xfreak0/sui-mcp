import { z } from "zod";
import { sui } from "../clients/grpc.js";
import tokensData from "../data/tokens.json" with { type: "json" };
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface TokenInfo {
  coin_type: string;
  name: string;
  symbol: string;
  decimals: number;
}

const TOKEN_REGISTRY: TokenInfo[] = tokensData.tokens;

export function registerTokenSearchTools(server: McpServer) {
  server.tool(
    "search_token",
    "Search for Sui tokens/coins by name or symbol. Returns matching tokens with their full coin type, which can be used with other tools like get_balance or get_coin_info.",
    {
      query: z.string().describe("Search query (e.g. 'USDC', 'SUI', 'staked')"),
      verify_onchain: z
        .boolean()
        .optional()
        .describe(
          "If true, verify each match on-chain and include total supply (default: false)"
        ),
    },
    async ({ query, verify_onchain }) => {
      const q = query.toLowerCase();

      const matches = TOKEN_REGISTRY.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.symbol.toLowerCase().includes(q)
      );

      let results;
      if (verify_onchain) {
        results = await Promise.all(
          matches.map(async (t) => {
            try {
              const { response: res } = await sui.stateService.getCoinInfo({
                coinType: t.coin_type,
              });
              return {
                coin_type: t.coin_type,
                name: t.name,
                symbol: t.symbol,
                decimals: t.decimals,
                total_supply: res.treasury?.totalSupply?.toString() ?? null,
              };
            } catch {
              return {
                coin_type: t.coin_type,
                name: t.name,
                symbol: t.symbol,
                decimals: t.decimals,
                total_supply: null,
              };
            }
          })
        );
      } else {
        results = matches.map((t) => ({
          coin_type: t.coin_type,
          name: t.name,
          symbol: t.symbol,
          decimals: t.decimals,
        }));
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                results,
                total_matches: results.length,
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
