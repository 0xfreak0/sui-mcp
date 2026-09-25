import { z } from "zod";
import { boolArg, numArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { searchTokens, probeOnChain } from "../discovery.js";
import { normalizeCoinType, searchVerifiedCoins, vouchFor } from "../utils/coin-registry.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface SearchResult {
  coin_type: string;
  name: string;
  symbol: string;
  decimals: number | null;
  /** A curated list vouches for this exact coin type. */
  verified: boolean;
  verified_by?: "verified" | "live";
  source: "verified_list" | "discovery" | "on_chain";
  total_supply?: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const UNVERIFIED_NOTE =
  "Results with verified: false are claims made by whoever minted the coin. Impostors copy the symbol and name of real assets, so identify a coin by its full coin_type, and prefer a verified one.";

export function registerTokenSearchTools(server: McpServer) {
  server.tool(
    "search_token",
    "Search for Sui tokens/coins by name or symbol (e.g. 'USDC', 'deep', 'cetus'). Returns matching tokens with their full coin type, verified coins first: `verified` says whether a curated list vouches for that exact type, since impostors copy the symbol and name of real coins. Unverified matches come from a bounded scan of on-chain CoinMetadata objects; `discovery_scan_truncated` says the scan did not reach the end, so a coin missing from the list may still exist. Use this when you have a token name but need the coin type for get_balance, get_coin_info, or get_token_prices.",
    {
      query: z.string().describe("Token name, symbol (e.g. 'USDC', 'WAL'), or full coin type (e.g. '0x...::mod::TOKEN')"),
      verify_onchain: boolArg()
        .optional()
        .describe(
          "If true, verify each match on-chain and include total supply (default: false)"
        ),
      limit: numArg()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(`Matches to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Verified coins come first, then exact symbol matches; total_matches counts them all.`),
    },
    async ({ query, verify_onchain, limit }) => {
      const q = query.toLowerCase().trim();

      // If the query looks like a full coin type, probe it directly
      if (q.includes("::")) {
        const probed = await probeOnChain(query);
        if (probed) {
          const vouch = vouchFor(probed.coin_type);
          const verified = vouch === "verified" || vouch === "live";
          const result: SearchResult = {
            coin_type: probed.coin_type,
            name: probed.name,
            symbol: probed.symbol,
            decimals: probed.decimals,
            verified,
            ...(verified ? { verified_by: vouch } : {}),
            source: "on_chain",
          };
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ query, results: [result], total_matches: 1 }, null, 2),
            }],
          };
        }
      }

      // Curated coins first: the discovery scan reads CoinMetadata objects in
      // object-ID order and stops at a page budget, so the real coin can be
      // absent from it while a dozen impostors named after it are present.
      const [curated, discovered] = await Promise.all([searchVerifiedCoins(q), searchTokens(q)]);
      const seen = new Set(curated.map((c) => c.coin_type));
      const results: SearchResult[] = curated.map((c) => ({
        coin_type: c.coin_type,
        name: c.name,
        symbol: c.symbol,
        decimals: c.decimals,
        verified: true,
        verified_by: c.via,
        source: "verified_list",
      }));
      // Exact symbol matches before substring ones: "SUI" matches thousands of
      // names that merely contain it.
      const ranked = [...discovered.tokens].sort(
        (a, b) => Number(a.symbol.toLowerCase() !== q) - Number(b.symbol.toLowerCase() !== q),
      );
      for (const t of ranked) {
        const type = normalizeCoinType(t.coin_type) ?? t.coin_type;
        if (seen.has(type)) continue;
        seen.add(type);
        results.push({ coin_type: t.coin_type, name: t.name, symbol: t.symbol, decimals: t.decimals, verified: false, source: "discovery" });
      }
      const shown = results.slice(0, limit ?? DEFAULT_LIMIT);

      if (verify_onchain) {
        await Promise.all(
          shown.map(async (r) => {
            try {
              const { response: res } = await sui.stateService.getCoinInfo({ coinType: r.coin_type });
              r.total_supply = res.treasury?.totalSupply?.toString() ?? null;
            } catch {
              r.total_supply = null;
            }
          })
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                results: shown,
                total_matches: results.length,
                ...(shown.length < results.length
                  ? {
                      more_matches_note: `${results.length - shown.length} more matches are not shown. Pass limit (max ${MAX_LIMIT}) or a more specific query.`,
                    }
                  : {}),
                ...(discovered.truncated
                  ? {
                      discovery_scan_truncated: true,
                      discovery_scan_note: `The on-chain scan read ${discovered.scanned} CoinMetadata objects in object-ID order and stopped before the end. A coin not listed here may still exist; pass its full coin type to look it up directly.`,
                    }
                  : {}),
                ...(shown.some((r) => !r.verified) ? { note: UNVERIFIED_NOTE } : {}),
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
