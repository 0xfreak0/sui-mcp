import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import { buildPythFeedMap } from "../discovery.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Aftermath Finance public price API
const AFTERMATH_PRICE_URL = "https://aftermath.finance/api/price-info";

// Pyth Network Hermes API (free, public, no auth)
const PYTH_HERMES_URL = "https://hermes.pyth.network";

// Extract short symbol from full coin type string (e.g. "0x2::sui::SUI" -> "SUI")
function extractSymbol(coinType: string): string {
  const parts = coinType.split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : coinType;
}

export interface AftermathPriceEntry {
  price: number;
  priceChange24HoursPercentage: number;
}

interface PriceResult {
  coin_type: string;
  symbol: string;
  price_usd: number | null;
  price_change_24h_percent: number | null;
  source: string;
  note?: string;
}

/**
 * Fetch prices from Aftermath Finance API.
 * Accepts Sui coin types directly. Returns null on failure.
 */
export async function fetchAftermathPrices(
  coinTypes: string[]
): Promise<Record<string, AftermathPriceEntry> | null> {
  try {
    const resp = await fetch(AFTERMATH_PRICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coins: coinTypes }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, AftermathPriceEntry>;
  } catch {
    return null;
  }
}

interface PythParsedPrice {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
  ema_price: { price: string; conf: string; expo: number; publish_time: number };
}

function parsePythPrice(p: PythParsedPrice): number {
  return Number(p.price.price) * 10 ** p.price.expo;
}

/**
 * Fetch prices from Pyth Hermes API for tokens with known feed IDs.
 * Supports both latest and historical (by timestamp) queries.
 */
async function fetchPythPrices(
  feedIds: string[],
  timestamp?: number,
): Promise<Map<string, PythParsedPrice> | null> {
  if (feedIds.length === 0) return null;
  try {
    const idParams = feedIds.map((id) => `ids[]=${id}`).join("&");
    const path = timestamp
      ? `/v2/updates/price/${timestamp}`
      : "/v2/updates/price/latest";
    const resp = await fetch(`${PYTH_HERMES_URL}${path}?${idParams}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { parsed: PythParsedPrice[] };
    const map = new Map<string, PythParsedPrice>();
    for (const entry of data.parsed) {
      map.set(entry.id, entry);
    }
    return map;
  } catch {
    return null;
  }
}

export function registerPriceTools(server: McpServer) {
  server.tool(
    "get_token_prices",
    "Get current USD prices for Sui tokens. Accepts full coin type strings (e.g. 0x2::sui::SUI). Returns price, 24h change, and market data when available. Uses Aftermath Finance as the primary price source with Pyth Network as fallback.",
    {
      coin_types: z
        .array(z.string())
        .min(1)
        .max(100)
        .describe(
          "Array of full coin type strings (e.g. ['0x2::sui::SUI', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'])"
        ),
    },
    async ({ coin_types }) => {
      // Dynamically resolve Pyth feed IDs
      const { feedIds: pythFeedIds, reverseMap: pythReverse } =
        await buildPythFeedMap(coin_types);

      // Fetch from both sources in parallel
      const [aftermathData, pythData] = await Promise.all([
        fetchAftermathPrices(coin_types),
        fetchPythPrices(pythFeedIds),
      ]);

      const pythForCoin = new Map<string, PythParsedPrice>();
      if (pythData) {
        for (const [fid, entry] of pythData) {
          for (const ct of pythReverse.get(fid) ?? []) {
            pythForCoin.set(ct, entry);
          }
        }
      }

      const prices: PriceResult[] = coin_types.map((ct) => {
        const symbol = extractSymbol(ct);
        const afEntry = aftermathData?.[ct];
        const pyEntry = pythForCoin.get(ct);

        // Aftermath returns -1 for unknown coins
        const aftermathPrice =
          afEntry && afEntry.price >= 0 ? afEntry.price : null;
        const aftermathChange =
          afEntry && afEntry.price >= 0
            ? afEntry.priceChange24HoursPercentage
            : null;

        const pythPrice = pyEntry ? parsePythPrice(pyEntry) : null;

        // Prefer Aftermath > Pyth for price
        const priceUsd = aftermathPrice ?? pythPrice ?? null;
        const change24h = aftermathChange ?? null;

        // Determine source attribution
        const sources: string[] = [];
        if (aftermathPrice != null) sources.push("aftermath");
        if (pythPrice != null) sources.push("pyth");
        const source = sources.length > 0 ? sources.join("+") : "none";

        const result: PriceResult = {
          coin_type: ct,
          symbol,
          price_usd: priceUsd,
          price_change_24h_percent: change24h,
          source,
        };

        if (priceUsd == null) {
          result.note =
            "Price not available. The coin type may be invalid or not listed on any tracked DEX.";
        }

        return result;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ prices }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_historical_prices",
    "Get historical USD prices for Sui tokens at a specific point in time using Pyth oracle data. Dynamically resolves Pyth feed IDs via Hermes API. Provide a Unix timestamp or ISO date string.",
    {
      coin_types: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Array of full coin type strings"),
      timestamp: z
        .union([z.number(), z.string()])
        .describe("Unix timestamp (seconds) or ISO 8601 date string (e.g. '2025-01-15T00:00:00Z')"),
    },
    async ({ coin_types, timestamp }) => {
      // Parse timestamp
      let unixTs: number;
      if (typeof timestamp === "number") {
        unixTs = timestamp;
      } else {
        const parsed = Date.parse(timestamp);
        if (isNaN(parsed)) {
          return errorResult("Invalid timestamp. Use Unix seconds or ISO 8601 format.");
        }
        unixTs = Math.floor(parsed / 1000);
      }

      const { feedIds, reverseMap } = await buildPythFeedMap(coin_types);

      // Identify coin types with no feed
      const coinTypesWithFeed = new Set<string>();
      for (const cts of reverseMap.values()) {
        for (const ct of cts) coinTypesWithFeed.add(ct);
      }

      const pythData = await fetchPythPrices(feedIds, unixTs);

      const prices = coin_types.map((ct) => {
        const symbol = extractSymbol(ct);

        if (!coinTypesWithFeed.has(ct)) {
          return {
            coin_type: ct,
            symbol,
            price_usd: null,
            confidence: null,
            timestamp: null,
            note: "No Pyth oracle feed available for this token.",
          };
        }

        // Find the feed ID for this coin type
        let entry: PythParsedPrice | undefined;
        for (const [fid, cts] of reverseMap) {
          if (cts.includes(ct)) {
            entry = pythData?.get(fid);
            break;
          }
        }

        if (!entry) {
          return {
            coin_type: ct,
            symbol,
            price_usd: null,
            confidence: null,
            timestamp: unixTs,
            note: "Pyth oracle returned no data for this timestamp.",
          };
        }

        const price = parsePythPrice(entry);
        const confidence = Number(entry.price.conf) * 10 ** entry.price.expo;

        return {
          coin_type: ct,
          symbol,
          price_usd: price,
          confidence,
          timestamp: entry.price.publish_time,
        };
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            query_timestamp: unixTs,
            query_date: new Date(unixTs * 1000).toISOString(),
            prices,
          }, null, 2),
        }],
      };
    }
  );
}
