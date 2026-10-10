import { z } from "zod";
import { boolArg, numArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { searchTokens, probeOnChain } from "../discovery.js";
import { normalizeCoinType, searchVerifiedCoins, vouchFor, resolveVerifiedSymbol } from "../utils/coin-registry.js";
import { guardiansFlagsForCoin, type GuardiansFlag } from "../utils/guardians.js";
import type { TickerCandidate } from "../utils/ticker-search.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface SearchResult {
  coin_type: string;
  name: string;
  symbol: string;
  decimals: number | null;
  /** A curated list vouches for this exact coin type. */
  verified: boolean;
  verified_by?: "verified" | "live";
  /** The verified list, a pool-backed DEX search, the bounded scan, or an exact type. */
  source: "verified_list" | "dex_search" | "discovery" | "on_chain";
  total_supply?: string | null;
  liquidity_usd?: number;
  pool_count?: number;
  volume_24h?: number | null;
  providers?: TickerCandidate["providers"];
  impostor_of?: string;
  flagged_by?: GuardiansFlag[];
  package_id?: string;
  publisher_hint?: string;
}

const DEFAULT_LIMIT = 150;
const MAX_LIMIT = 500;

const UNVERIFIED_NOTE =
  "Unverified coins claim their own name and symbol. Mainnet live matches have a DEX pool on DexScreener or, when needed, GeckoTerminal and are confirmed by exact coin type on chain; coins without a pool are not searched by indexers, and other coins may use this symbol. Check the full coin_type; pool liquidity is not proof of legitimacy.";

export function registerTokenSearchTools(server: McpServer) {
  server.tool(
    "search_token",
    "Find a Sui coin type by name or symbol. Verified types rank first. Mainnet searches DexScreener for the ticker and ticker + SUI; GeckoTerminal is used when results are missing, capped or unavailable. Up to 25 pool-backed candidates are confirmed by exact coin type on chain and clean searches are cached for 10 minutes. Symbols are not unique; partial result caps, provider outages and failed on-chain confirmations are reported separately. Without confirmed live matches or off mainnet, a bounded CoinMetadata scan is used; pass a full coin type to inspect a coin without a pool.",
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
        .describe(`Matches returned (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); verified types then exact symbols. total_matches counts all matches.`),
    },
    async ({ query, verify_onchain, limit }) => {
      const q = query.toLowerCase().trim();

      // If the query looks like a full coin type, probe it directly
      if (q.includes("::")) {
        const probed = await probeOnChain(query);
        if (probed) {
          const vouch = vouchFor(probed.coin_type);
          const verified = vouch !== null && vouch !== "not-curated-here";
          const trusted = resolveVerifiedSymbol(probed.symbol);
          const package_id = probed.coin_type.split("::")[0];
          const flagged_by = guardiansFlagsForCoin(probed.coin_type);
          const result: SearchResult = {
            coin_type: probed.coin_type,
            name: probed.name,
            symbol: probed.symbol,
            decimals: probed.decimals,
            verified,
            ...(vouch === "verified" || vouch === "live" ? { verified_by: vouch } : {}),
            ...(!verified && trusted.status === "resolved" &&
              normalizeCoinType(trusted.coin.coin_type) !== normalizeCoinType(probed.coin_type)
              ? { impostor_of: trusted.coin.coin_type } : {}),
            ...(flagged_by.length ? { flagged_by } : {}),
            package_id,
            publisher_hint: `Use identify_address on package ${package_id} to find its publisher, then get_wallet_packages on that publisher to pivot across deployed packages.`,
            source: "on_chain",
          };
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ query, results: [result], total_matches: 1 }),
            }],
          };
        }
      }

      // Curated coins always rank first. Pool-backed matches can include
      // impostors with the same symbol as a verified coin.
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
      // Live candidates are already ordered verified, exact symbol, liquidity.
      const ranked = discovered.source === "dex_search" ? discovered.tokens
        : [...discovered.tokens].sort(
            (a, b) => Number(a.symbol.trim().toLowerCase() !== q) - Number(b.symbol.trim().toLowerCase() !== q),
          );
      for (const t of ranked) {
        const type = normalizeCoinType(t.coin_type) ?? t.coin_type;
        if (seen.has(type)) continue;
        seen.add(type);
        const vouch = vouchFor(t.coin_type);
        const verified = vouch !== null && vouch !== "not-curated-here";
        const real = resolveVerifiedSymbol(t.symbol);
        const indexed = discovered.source === "dex_search" ? t as TickerCandidate : null;
        results.push({
          coin_type: t.coin_type, name: t.name, symbol: t.symbol, decimals: t.decimals,
          verified,
          ...(verified && (vouch === "verified" || vouch === "live") ? { verified_by: vouch } : {}),
          source: indexed ? "dex_search" : "discovery",
          ...(indexed ? {
            total_supply: indexed.total_supply, liquidity_usd: indexed.liquidity_usd,
            pool_count: indexed.pool_count, volume_24h: indexed.volume_24h,
            providers: indexed.providers, package_id: indexed.package_id,
            publisher_hint: indexed.publisher_hint,
          } : {}),
          ...(indexed?.impostor_of || (!verified && real.status === "resolved" && normalizeCoinType(real.coin.coin_type) !== type)
            ? { impostor_of: indexed?.impostor_of ?? (real.status === "resolved" ? real.coin.coin_type : undefined) } : {}),
          ...(guardiansFlagsForCoin(type).length ? { flagged_by: guardiansFlagsForCoin(type) } : {}),
        });
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

      const scan = discovered.scan;
      const found = {
        search_coverage: {
          providers: discovered.coverage,
          unavailable_providers: discovered.unavailable_providers,
          partial: discovered.partial,
          unconfirmed: discovered.unconfirmed,
          ...(discovered.unconfirmed_reason ? { unconfirmed_reason: discovered.unconfirmed_reason } : {}),
          note: (discovered.partial
            ? "Live search coverage is partial for this ticker: popular symbols exceed the providers' result caps. "
            : "") +
            (discovered.unconfirmed
              ? `${discovered.unconfirmed} candidates could not be confirmed on chain (${discovered.unconfirmed_reason ?? "metadata unavailable"}). `
              : "") +
            (discovered.source === "dex_search"
              ? "Only candidates with a DEX pool were searched; up to 25 high-liquidity candidates were confirmed by their exact on-chain coin metadata. Other coins may use the same symbol."
              : discovered.unavailable_providers.length === 2
                ? "Both live DEX search providers were unavailable (possibly rate limited); these matches come only from a bounded on-chain CoinMetadata scan. Zero results is not evidence that the symbol does not exist."
                : discovered.coverage.dexscreener === "skipped"
                  ? "Live DEX ticker search is mainnet-only. These matches are from a bounded on-chain CoinMetadata scan; other coins may use this symbol."
                  : "Live search had no confirmed pool-backed hits or is unavailable; these matches come from a bounded on-chain CoinMetadata scan. Other coins may use the same symbol."),
        },
        ...(scan ? {
          discovery_scan_scanned: scan.scanned,
          discovery_scan_truncated: scan.truncated,
          ...(scan.failed ? { discovery_scan_failed: scan.failed } : {}),
          ...(scan.failed ? { discovery_scan_note: `The on-chain scan failed after ${scan.scanned} objects (${scan.failed}); absence is not evidence of nonexistence.` } : {}),
        } : {}),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              query,
              ...(shown.length === 0 && discovered.unconfirmed > 0 ? { status: "could_not_confirm" } : {}),
              results: shown,
              total_matches: results.length,
              ...(shown.length < results.length
                ? {
                    more_matches_note: `${results.length - shown.length} more matches are not shown. Pass limit (max ${MAX_LIMIT}) or a more specific query.`,
                  }
                : {}),
              ...found,
              ...(shown.some((r) => !r.verified) ? { note: UNVERIFIED_NOTE } : {}),
            }),
          },
        ],
      };
    }
  );
}
