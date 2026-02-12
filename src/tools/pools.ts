import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { fetchAftermathPrices } from "./prices.js";
import { lookupProtocol } from "../protocols/registry.js";
import { errorResult } from "../utils/errors.js";
import { createRequire } from "node:module";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const require = createRequire(import.meta.url);
const tokensData = require("../data/tokens.json");

interface TokenEntry {
  coin_type: string;
  name: string;
  symbol: string;
  decimals: number;
}

const POOL_TOKEN_REGISTRY: TokenEntry[] = tokensData.tokens;

// Extract generic type parameters from a Move type string
function extractTypeParams(typeStr: string): string[] {
  const match = typeStr.match(/<(.+)>/);
  if (!match) return [];
  const params: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of match[1]) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      params.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) params.push(current.trim());
  return params;
}

function extractPackageId(typeStr: string): string | null {
  const match = typeStr.match(/^(0x[a-fA-F0-9]+)::/);
  return match ? match[1] : null;
}

interface PoolInfo {
  protocol: string | null;
  protocol_type: string | null;
  token_a: string | null;
  token_b: string | null;
  reserves: Record<string, unknown>;
  fee_info: Record<string, unknown>;
  extra: Record<string, unknown>;
}

function parseCetusPool(json: Record<string, unknown>, typeParams: string[]): PoolInfo {
  return {
    protocol: "Cetus",
    protocol_type: "dex",
    token_a: typeParams[0] ?? null,
    token_b: typeParams[1] ?? null,
    reserves: {
      coin_a: json.coin_a ?? json.balance_a,
      coin_b: json.coin_b ?? json.balance_b,
    },
    fee_info: { fee_rate: json.fee_rate },
    extra: {
      current_sqrt_price: json.current_sqrt_price,
      tick_spacing: json.tick_spacing,
      is_pause: json.is_pause,
    },
  };
}

function parseDeepBookPool(json: Record<string, unknown>, typeParams: string[]): PoolInfo {
  return {
    protocol: "DeepBook",
    protocol_type: "dex",
    token_a: typeParams[0] ?? null,
    token_b: typeParams[1] ?? null,
    reserves: {
      base_vault: json.base_vault,
      quote_vault: json.quote_vault,
    },
    fee_info: { taker_fee: json.taker_fee, maker_fee: json.maker_fee },
    extra: { lot_size: json.lot_size, tick_size: json.tick_size },
  };
}

function parseTurbosPool(json: Record<string, unknown>, typeParams: string[]): PoolInfo {
  return {
    protocol: "Turbos",
    protocol_type: "dex",
    token_a: typeParams[0] ?? null,
    token_b: typeParams[1] ?? null,
    reserves: {
      coin_a: json.coin_a ?? json.balance_a,
      coin_b: json.coin_b ?? json.balance_b,
    },
    fee_info: { fee: json.fee, fee_rate: json.fee_rate },
    extra: { sqrt_price: json.sqrt_price, tick_spacing: json.tick_spacing },
  };
}

function parseGenericPool(json: Record<string, unknown>, typeParams: string[], protocol: string | null): PoolInfo {
  return {
    protocol,
    protocol_type: "dex",
    token_a: typeParams[0] ?? null,
    token_b: typeParams[1] ?? null,
    reserves: json,
    fee_info: {},
    extra: {},
  };
}

export function registerPoolTools(server: McpServer) {
  server.tool(
    "get_pool_stats",
    "Get stats for a DeFi liquidity pool on Sui given its object ID. Auto-detects the protocol (Cetus, DeepBook, Turbos, etc.) and returns token pair, reserves, fees, and current prices.",
    {
      pool_id: z.string().describe("Pool object ID (0x...)"),
      protocol: z
        .string()
        .optional()
        .describe("Protocol hint (e.g. 'cetus', 'deepbook', 'turbos'). Auto-detected if omitted."),
    },
    async ({ pool_id, protocol: protocolHint }) => {
      // Use high-level SDK to get object with JSON content
      const res = await sui.getObject({
        objectId: pool_id,
        include: { json: true },
      });
      const obj = res.object;
      if (!obj) return errorResult(`Object ${pool_id} not found`);

      const objectType = obj.type ?? "";
      const typeParams = extractTypeParams(objectType);
      const packageId = extractPackageId(objectType);

      // Determine protocol
      let detectedProtocol = protocolHint?.toLowerCase() ?? null;
      if (!detectedProtocol && packageId) {
        const info = lookupProtocol(packageId);
        if (info) detectedProtocol = info.name.toLowerCase();
      }
      if (!detectedProtocol) {
        const typeLower = objectType.toLowerCase();
        if (typeLower.includes("cetus")) detectedProtocol = "cetus";
        else if (typeLower.includes("deepbook") || typeLower.includes("clob")) detectedProtocol = "deepbook";
        else if (typeLower.includes("turbos")) detectedProtocol = "turbos";
      }

      const json = (obj.json ?? {}) as Record<string, unknown>;

      let poolInfo: PoolInfo;
      switch (detectedProtocol) {
        case "cetus":
          poolInfo = parseCetusPool(json, typeParams);
          break;
        case "deepbook":
          poolInfo = parseDeepBookPool(json, typeParams);
          break;
        case "turbos":
          poolInfo = parseTurbosPool(json, typeParams);
          break;
        default:
          poolInfo = parseGenericPool(json, typeParams, detectedProtocol);
      }

      // Fetch prices for the token pair
      const tokenTypes = [poolInfo.token_a, poolInfo.token_b].filter(
        (t): t is string => t != null
      );
      const prices = tokenTypes.length > 0
        ? await fetchAftermathPrices(tokenTypes)
        : null;

      const tokenPrices: Record<string, number | null> = {};
      for (const t of tokenTypes) {
        const entry = prices?.[t];
        tokenPrices[t] = entry && entry.price >= 0 ? entry.price : null;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                pool_id,
                object_type: objectType,
                protocol: poolInfo.protocol,
                protocol_type: poolInfo.protocol_type,
                token_a: poolInfo.token_a,
                token_b: poolInfo.token_b,
                reserves: poolInfo.reserves,
                fee_info: poolInfo.fee_info,
                extra: poolInfo.extra,
                prices: tokenPrices,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // find_pools: discover liquidity pools by token pair
  // ---------------------------------------------------------------------------

  const POOL_QUERY = `
    query($type: String!) {
      objects(filter: { type: $type }, first: 10) {
        nodes {
          address
          asMoveObject {
            contents { type { repr } }
          }
        }
      }
    }
  `;

  interface PoolQueryResult {
    objects: {
      nodes: Array<{
        address: string;
        asMoveObject?: {
          contents?: { type?: { repr?: string } };
        };
      }>;
    };
  }

  // Supported DEX pool type templates: package_id::module::PoolType<A, B>
  const DEX_POOL_TYPES: Record<string, { package: string; type: string }> = {
    cetus: {
      package: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
      type: "pool::Pool",
    },
    deepbook: {
      package: "0x158f2027f60c89bb91526d9bf08831d27f5a0fcb0f74e6698b9f0e1fb2be5d05",
      type: "clob_v2::Pool",
    },
    turbos: {
      package: "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1",
      type: "pool::Pool",
    },
  };

  function resolveTokenType(query: string): string | null {
    const q = query.toLowerCase().trim();
    // If it's already a full type, return as-is
    if (q.includes("::")) return query.trim();
    // Look up in static registry
    const match = POOL_TOKEN_REGISTRY.find(
      (t) => t.symbol.toLowerCase() === q || t.name.toLowerCase() === q
    );
    return match?.coin_type ?? null;
  }

  server.tool(
    "find_pools",
    "Find DeFi liquidity pools by token pair. Searches Cetus, DeepBook, and Turbos for pools matching the given tokens. Use get_pool_stats on a returned pool_id for detailed stats.",
    {
      token_a: z.string().describe("First token: symbol (e.g. 'SUI') or full coin type"),
      token_b: z.string().describe("Second token: symbol (e.g. 'USDC') or full coin type"),
      protocol: z
        .string()
        .optional()
        .describe("Filter by protocol: 'cetus', 'deepbook', or 'turbos'. Searches all if omitted."),
    },
    async ({ token_a, token_b, protocol: protocolFilter }) => {
      const typeA = resolveTokenType(token_a);
      const typeB = resolveTokenType(token_b);

      if (!typeA) return errorResult(`Could not resolve token: ${token_a}. Provide the full coin type (0x...::module::TYPE).`);
      if (!typeB) return errorResult(`Could not resolve token: ${token_b}. Provide the full coin type (0x...::module::TYPE).`);

      // Determine which protocols to search
      const protocols = protocolFilter
        ? { [protocolFilter.toLowerCase()]: DEX_POOL_TYPES[protocolFilter.toLowerCase()] }
        : DEX_POOL_TYPES;

      if (protocolFilter && !DEX_POOL_TYPES[protocolFilter.toLowerCase()]) {
        return errorResult(`Unsupported protocol: ${protocolFilter}. Supported: cetus, deepbook, turbos.`);
      }

      // Build all type queries: for each protocol, try both token orderings
      const queries: Array<{ protocol: string; poolType: string }> = [];
      for (const [name, dex] of Object.entries(protocols)) {
        if (!dex) continue;
        queries.push({
          protocol: name,
          poolType: `${dex.package}::${dex.type}<${typeA}, ${typeB}>`,
        });
        queries.push({
          protocol: name,
          poolType: `${dex.package}::${dex.type}<${typeB}, ${typeA}>`,
        });
      }

      // Execute all queries in parallel
      const results = await Promise.all(
        queries.map(async ({ protocol: proto, poolType }) => {
          try {
            const data = await gqlQuery<PoolQueryResult>(POOL_QUERY, { type: poolType });
            return data.objects.nodes.map((n) => ({
              pool_id: n.address,
              protocol: proto,
              object_type: n.asMoveObject?.contents?.type?.repr ?? poolType,
              token_a: typeA,
              token_b: typeB,
            }));
          } catch {
            return [];
          }
        })
      );

      const pools = results.flat();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query: { token_a: typeA, token_b: typeB, protocol: protocolFilter ?? "all" },
                pools,
                total: pools.length,
                hint: pools.length > 0
                  ? "Use get_pool_stats with a pool_id for detailed reserves, fees, and prices."
                  : "No pools found. Try different token pairs or check that the coin types are correct.",
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
