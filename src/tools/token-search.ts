import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { searchTokens, probeOnChain } from "../discovery.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerTokenSearchTools(server: McpServer) {
  server.tool(
    "search_token",
    "Search for Sui tokens/coins by name or symbol (e.g. 'USDC', 'deep', 'cetus'). Returns matching tokens with their full coin type. Use this when you have a token name but need the coin type for get_balance, get_coin_info, or get_token_prices. Discovers tokens by scanning on-chain CoinMetadata objects via GraphQL.",
    {
      query: z.string().describe("Token name, symbol (e.g. 'USDC', 'WAL'), or full coin type (e.g. '0x...::mod::TOKEN')"),
      verify_onchain: z
        .boolean()
        .optional()
        .describe(
          "If true, verify each match on-chain and include total supply (default: false)"
        ),
    },
    async ({ query, verify_onchain }) => {
      const q = query.toLowerCase().trim();

      // If the query looks like a full coin type, probe it directly
      if (q.includes("::")) {
        const probed = await probeOnChain(query);
        if (probed) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                query,
                results: [{
                  coin_type: probed.coin_type,
                  name: probed.name,
                  symbol: probed.symbol,
                  decimals: probed.decimals,
                  source: "on_chain",
                }],
                total_matches: 1,
              }, null, 2),
            }],
          };
        }
      }

      // Search on-chain CoinMetadata (cached 6h)
      const matches = await searchTokens(q);

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
                source: "discovery" as const,
                total_supply: res.treasury?.totalSupply?.toString() ?? null,
              };
            } catch {
              return {
                coin_type: t.coin_type,
                name: t.name,
                symbol: t.symbol,
                decimals: t.decimals,
                source: "discovery" as const,
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
          source: "discovery" as const,
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
