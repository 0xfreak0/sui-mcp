import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { fetchAftermathPrices } from "./prices.js";
import { scanTokenTopHolders } from "./holders.js";
import { errorResult } from "../utils/errors.js";
import { resolveTokenBySymbol } from "../discovery.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerAnalyzeTokenTools(server: McpServer) {
  server.tool(
    "analyze_token",
    "(Recommended for token research) Get a comprehensive analysis of a Sui token in one call: metadata, current price, 24h change, total supply, and top 5 holders. Accepts either a coin type (e.g. '0x2::sui::SUI') or a name/symbol (e.g. 'DEEP', 'cetus').",
    {
      query: z
        .string()
        .describe("Token name, symbol (e.g. 'USDC', 'deep'), or full coin type (e.g. '0x2::sui::SUI')"),
      include_holders: z
        .boolean()
        .optional()
        .describe("Include top 5 holders (default: true). Set false for faster response."),
    },
    async ({ query, include_holders }) => {
      const wantHolders = include_holders !== false;

      // Resolve coin type: if it looks like a type (contains ::), use directly; else resolve dynamically
      let coinType: string;
      let discoveredName: string | null = null;
      let discoveredSymbol: string | null = null;
      let discoveredDecimals: number | null = null;

      if (query.includes("::")) {
        coinType = query;
      } else {
        const match = await resolveTokenBySymbol(query);
        if (!match) {
          return errorResult(
            `Token "${query}" not found. Try using the full coin type string (e.g. '0x...::module::TOKEN'), or use search_token for fuzzy search.`
          );
        }
        coinType = match.coin_type;
        discoveredName = match.name;
        discoveredSymbol = match.symbol;
        discoveredDecimals = match.decimals;
      }

      // Fetch metadata, price, and holders in parallel
      const [metaResult, priceResult, holderResult] = await Promise.all([
        sui.stateService
          .getCoinInfo({ coinType })
          .then(({ response }) => response)
          .catch(() => null),

        fetchAftermathPrices([coinType]),

        wantHolders
          ? scanTokenTopHolders(coinType, 5, 2000).catch(() => null)
          : Promise.resolve(null),
      ]);

      const meta = metaResult?.metadata;
      const treasury = metaResult?.treasury;

      const symbol = meta?.symbol ?? discoveredSymbol ?? coinType.split("::").pop() ?? coinType;
      const decimals = meta?.decimals ?? discoveredDecimals ?? 9;
      const name = meta?.name ?? discoveredName ?? null;
      const description = meta?.description ?? null;
      const iconUrl = meta?.iconUrl ?? null;
      const totalSupplyRaw = treasury?.totalSupply?.toString() ?? null;

      // Compute human-readable supply
      let totalSupplyHuman: string | null = null;
      if (totalSupplyRaw) {
        const raw = BigInt(totalSupplyRaw);
        const human = Number(raw) / 10 ** decimals;
        totalSupplyHuman = human.toLocaleString("en-US", { maximumFractionDigits: 2 });
      }

      const priceEntry = priceResult?.[coinType];
      const priceUsd = priceEntry && priceEntry.price >= 0 ? priceEntry.price : null;
      const change24h = priceEntry && priceEntry.price >= 0 ? priceEntry.priceChange24HoursPercentage : null;

      // Compute market cap if we have price and supply
      let marketCapUsd: number | null = null;
      if (priceUsd != null && totalSupplyRaw) {
        const humanSupply = Number(BigInt(totalSupplyRaw)) / 10 ** decimals;
        marketCapUsd = Math.round(priceUsd * humanSupply * 100) / 100;
      }

      const result: Record<string, unknown> = {
        coin_type: coinType,
        symbol,
        name,
        decimals,
        description,
        icon_url: iconUrl,
        total_supply: totalSupplyRaw,
        total_supply_human: totalSupplyHuman,
        price_usd: priceUsd,
        price_change_24h_percent: change24h,
        market_cap_usd: marketCapUsd,
      };

      if (holderResult) {
        result.top_holders = holderResult.holders;
        result.unique_holders_scanned = holderResult.unique_holders;
        result.holder_scan_truncated = holderResult.truncated;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
