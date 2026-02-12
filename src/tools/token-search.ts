import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const tokensData = require("../data/tokens.json");
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface TokenInfo {
  coin_type: string;
  name: string;
  symbol: string;
  decimals: number;
}

const TOKEN_REGISTRY: TokenInfo[] = tokensData.tokens;

// ---------------------------------------------------------------------------
// Dynamic discovery: fetch Aftermath Finance's full coin list as a fallback
// when the static registry has no matches. Results are cached in-memory.
// ---------------------------------------------------------------------------

const AFTERMATH_COINS_URL = "https://aftermath.finance/api/coins";
const DISCOVERY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface DiscoveredToken {
  coin_type: string;
  name: string;
  symbol: string;
  decimals: number;
}

let discoveryCache: { tokens: DiscoveredToken[]; fetchedAt: number } | null = null;

async function fetchDiscoveryTokens(): Promise<DiscoveredToken[]> {
  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < DISCOVERY_CACHE_TTL_MS) {
    return discoveryCache.tokens;
  }

  try {
    const resp = await fetch(AFTERMATH_COINS_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return [];

    const data = await resp.json() as Record<string, {
      name?: string;
      symbol?: string;
      decimals?: number;
      type?: string;
    }>;

    // Aftermath returns {coinType: {name, symbol, decimals, ...}}
    const tokens: DiscoveredToken[] = [];
    for (const [coinType, info] of Object.entries(data)) {
      if (info.symbol) {
        tokens.push({
          coin_type: coinType,
          name: info.name ?? info.symbol,
          symbol: info.symbol,
          decimals: info.decimals ?? 9,
        });
      }
    }

    discoveryCache = { tokens, fetchedAt: Date.now() };
    return tokens;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// gRPC probing: if user provides a full coin type directly, verify it on-chain
// ---------------------------------------------------------------------------

async function probeOnChain(coinType: string): Promise<TokenInfo | null> {
  try {
    const { response } = await sui.stateService.getCoinInfo({ coinType });
    const meta = response.metadata;
    if (!meta) return null;
    return {
      coin_type: coinType,
      name: meta.name ?? "",
      symbol: meta.symbol ?? coinType.split("::").pop() ?? "",
      decimals: meta.decimals ?? 9,
    };
  } catch {
    return null;
  }
}

export function registerTokenSearchTools(server: McpServer) {
  server.tool(
    "search_token",
    "Search for Sui tokens/coins by name or symbol (e.g. 'USDC', 'deep', 'cetus'). Returns matching tokens with their full coin type. Use this when you have a token name but need the coin type for get_balance, get_coin_info, or get_token_prices. Falls back to on-chain discovery via Aftermath Finance API if the static registry has no match.",
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

      // Search static registry first
      const registryMatches = TOKEN_REGISTRY.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.symbol.toLowerCase().includes(q)
      );

      // If no static matches, try dynamic discovery
      let dynamicMatches: DiscoveredToken[] = [];
      if (registryMatches.length === 0) {
        const discovered = await fetchDiscoveryTokens();
        // Filter out tokens already in registry to avoid duplicates
        const registryTypes = new Set(TOKEN_REGISTRY.map((t) => t.coin_type));
        dynamicMatches = discovered.filter(
          (t) =>
            !registryTypes.has(t.coin_type) &&
            (t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q))
        );
      }

      const allMatches = [
        ...registryMatches.map((t) => ({ ...t, source: "registry" as const })),
        ...dynamicMatches.map((t) => ({ ...t, source: "discovery" as const })),
      ];

      let results;
      if (verify_onchain) {
        results = await Promise.all(
          allMatches.map(async (t) => {
            try {
              const { response: res } = await sui.stateService.getCoinInfo({
                coinType: t.coin_type,
              });
              return {
                coin_type: t.coin_type,
                name: t.name,
                symbol: t.symbol,
                decimals: t.decimals,
                source: t.source,
                total_supply: res.treasury?.totalSupply?.toString() ?? null,
              };
            } catch {
              return {
                coin_type: t.coin_type,
                name: t.name,
                symbol: t.symbol,
                decimals: t.decimals,
                source: t.source,
                total_supply: null,
              };
            }
          })
        );
      } else {
        results = allMatches.map((t) => ({
          coin_type: t.coin_type,
          name: t.name,
          symbol: t.symbol,
          decimals: t.decimals,
          source: t.source,
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
