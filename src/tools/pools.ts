import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { fetchAftermathPrices } from "./prices.js";
import { lookupProtocol } from "../protocols/registry.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
    "Get stats for a DeFi liquidity pool on Sui. Auto-detects the protocol (Cetus, DeepBook, Turbos, etc.) and returns token pair, reserves, fees, and prices.",
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
}
