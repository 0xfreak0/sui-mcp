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
  /** `symbol_index`: the synced index of every mainnet coin; `discovery`: the bounded live scan. */
  source: "verified_list" | "symbol_index" | "discovery" | "on_chain";
  total_supply?: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const UNVERIFIED_NOTE =
  "Results with verified: false are claims made by whoever minted the coin. Impostors copy the symbol and name of real assets, so identify a coin by its full coin_type, and prefer a verified one.";

export function registerTokenSearchTools(server: McpServer) {
  server.tool(
    "search_token",
    "Search for Sui tokens/coins by name or symbol (e.g. 'USDC', 'deep', 'cetus'). Returns matching tokens with their full coin type, verified coins first, then exact symbol matches: `verified` says whether a curated list vouches for that exact type, since impostors copy the symbol and name of real coins. On mainnet unverified matches come from a symbol index of every CoinMetadata and coin registry entry up to its sync date (`symbol_index.synced_at`); a coin published after that date is missing from it. A symbol more than 100 coins use keeps only a count, so none of its coins is listed; `unlisted_symbols` names every such symbol that is or contains the query, with how many coins use it. When the index has no match at all, and off mainnet, they come from a bounded live scan of on-chain CoinMetadata, and `discovery_scan_truncated` says the scan did not reach the end; `discovery_scan_failed` names the error when a failed read ended it. Use this when you have a token name but need the coin type for get_balance, get_coin_info, or get_token_prices.",
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

      // Curated coins first: an index or scan match only says some coin claims
      // the symbol, and impostors named after a real coin sit beside it.
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
        (a, b) => Number(a.symbol.trim().toLowerCase() !== q) - Number(b.symbol.trim().toLowerCase() !== q),
      );
      const source = discovered.source === "symbol_index" ? "symbol_index" : "discovery";
      for (const t of ranked) {
        const type = normalizeCoinType(t.coin_type) ?? t.coin_type;
        if (seen.has(type)) continue;
        seen.add(type);
        results.push({ coin_type: t.coin_type, name: t.name, symbol: t.symbol, decimals: t.decimals, verified: false, source });
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

      const unlisted =
        discovered.source === "symbol_index"
          ? [
              ...(discovered.unlisted_exact_count !== null ? [{ symbol: q, count: discovered.unlisted_exact_count }] : []),
              ...discovered.unlisted_containing,
            ]
          : [];
      const found =
        discovered.source === "symbol_index"
          ? {
              symbol_index: { synced_at: discovered.index.synced_at, checkpoint: discovered.index.checkpoint },
              ...(unlisted.length ? { unlisted_symbols: unlisted.map((u) => ({ symbol: u.symbol, coins: u.count })) } : {}),
              symbol_index_note:
                `Unverified matches come from the symbol index: every CoinMetadata and coin registry entry on mainnet at checkpoint ${discovered.index.checkpoint} (${discovered.index.synced_at}). A coin published after that is not in it; pass its full coin type to look it up.` +
                (discovered.unlisted_exact_count !== null
                  ? ` ${discovered.unlisted_exact_count} coins use the symbol "${query.trim()}" exactly, more than the ${discovered.index.max_rows_per_symbol} the index lists for one symbol, so none of them is listed: a symbol that common cannot identify a coin.`
                  : "") +
                (discovered.unlisted_containing.length
                  ? ` ${discovered.unlisted_containing.length} longer symbol(s) containing "${query.trim()}" are each used by more than ${discovered.index.max_rows_per_symbol} coins, so none of their ${discovered.unlisted_containing.reduce((s, u) => s + u.count, 0)} coins is listed or counted in total_matches: ${discovered.unlisted_containing
                      .slice(0, 5)
                      .map((u) => `"${u.symbol}" (${u.count} coins)`)
                      .join(", ")}${discovered.unlisted_containing.length > 5 ? `, and ${discovered.unlisted_containing.length - 5} more in unlisted_symbols` : ""}. Pass the full coin type to look one of them up.`
                  : ""),
            }
          : {
              ...(discovered.index
                ? {
                    symbol_index: { synced_at: discovered.index.synced_at, checkpoint: discovered.index.checkpoint },
                    symbol_index_note: `The symbol index (every mainnet coin up to ${discovered.index.synced_at}) has no coin whose symbol contains this query and no listed coin whose name does, so these results come from a bounded live scan. It keeps no names for a symbol more than ${discovered.index.max_rows_per_symbol} coins use, and a coin published after ${discovered.index.synced_at} is reachable only by the scan.`,
                  }
                : {}),
              ...(discovered.truncated
                ? {
                    discovery_scan_truncated: true,
                    ...(discovered.failed ? { discovery_scan_failed: discovered.failed } : {}),
                    discovery_scan_note: discovered.failed
                      ? `The on-chain scan failed after reading ${discovered.scanned} CoinMetadata objects (${discovered.failed}), so these results cover only what it read before the failure. A coin not listed here may still exist; retry, or pass its full coin type to look it up directly.`
                      : `The on-chain scan read ${discovered.scanned} CoinMetadata objects in object-ID order and stopped before the end. A coin not listed here may still exist; pass its full coin type to look it up directly.`,
                  }
                : {}),
            };

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
                ...found,
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
