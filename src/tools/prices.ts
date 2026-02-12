import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import priceFeedsData from "../data/price-feeds.json" with { type: "json" };
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Aftermath Finance public price API
const AFTERMATH_PRICE_URL = "https://aftermath.finance/api/price-info";

// Pyth Network Hermes API (free, public, no auth)
const PYTH_HERMES_URL = "https://hermes.pyth.network";

// Pyth feed IDs loaded from src/data/price-feeds.json
const COIN_TYPE_TO_PYTH: Record<string, string> = priceFeedsData.pyth;

// CoinGecko free API for supplementary market data
const COINGECKO_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price";

// CoinGecko IDs loaded from src/data/price-feeds.json
const COIN_TYPE_TO_COINGECKO: Record<string, string> = priceFeedsData.coingecko;

// Extract short symbol from full coin type string (e.g. "0x2::sui::SUI" -> "SUI")
function extractSymbol(coinType: string): string {
  const parts = coinType.split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : coinType;
}

interface AftermathPriceEntry {
  price: number;
  priceChange24HoursPercentage: number;
}

interface CoinGeckoEntry {
  usd: number;
  usd_market_cap?: number;
  usd_24h_vol?: number;
  usd_24h_change?: number;
}

interface PriceResult {
  coin_type: string;
  symbol: string;
  price_usd: number | null;
  price_change_24h_percent: number | null;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  source: string;
  note?: string;
}

/**
 * Fetch prices from Aftermath Finance API.
 * Accepts Sui coin types directly. Returns null on failure.
 */
async function fetchAftermathPrices(
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

/**
 * Fetch supplementary market data from CoinGecko for known tokens.
 * Returns null on failure.
 */
async function fetchCoinGeckoData(
  geckoIds: string[]
): Promise<Record<string, CoinGeckoEntry> | null> {
  if (geckoIds.length === 0) return null;
  try {
    const ids = geckoIds.join(",");
    const url = `${COINGECKO_PRICE_URL}?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, CoinGeckoEntry>;
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

/**
 * Build Pyth reverse mapping: collect unique feed IDs and map them back to coin types.
 */
function buildPythReverse(
  coinTypes: string[],
): { feedIds: string[]; reverseMap: Map<string, string[]> } {
  const reverseMap = new Map<string, string[]>();
  for (const ct of coinTypes) {
    const fid = COIN_TYPE_TO_PYTH[ct];
    if (fid) {
      const existing = reverseMap.get(fid) ?? [];
      existing.push(ct);
      reverseMap.set(fid, existing);
    }
  }
  return { feedIds: [...reverseMap.keys()], reverseMap };
}

/**
 * Build a reverse mapping from CoinGecko ID back to the coin types that
 * requested it. Multiple coin types may map to the same CoinGecko ID.
 */
function buildGeckoReverse(
  coinTypes: string[]
): { geckoIds: string[]; reverseMap: Map<string, string[]> } {
  const reverseMap = new Map<string, string[]>();
  for (const ct of coinTypes) {
    const gid = COIN_TYPE_TO_COINGECKO[ct];
    if (gid) {
      const existing = reverseMap.get(gid) ?? [];
      existing.push(ct);
      reverseMap.set(gid, existing);
    }
  }
  return { geckoIds: [...reverseMap.keys()], reverseMap };
}

export function registerPriceTools(server: McpServer) {
  server.tool(
    "get_token_prices",
    "Get current USD prices for Sui tokens. Accepts full coin type strings (e.g. 0x2::sui::SUI). Returns price, 24h change, and market data when available. Uses Aftermath Finance as the primary price source with CoinGecko enrichment for well-known tokens.",
    {
      coin_types: z
        .array(z.string())
        .min(1)
        .max(100)
        .describe(
          "Array of full coin type strings (e.g. [\x270x2::sui::SUI\x27, \x270xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC\x27])"
        ),
    },
    async ({ coin_types }) => {
      // Build reverse mappings for supplementary sources
      const { geckoIds, reverseMap: geckoReverse } = buildGeckoReverse(coin_types);
      const { feedIds: pythFeedIds, reverseMap: pythReverse } = buildPythReverse(coin_types);

      // Fetch from all three sources in parallel
      const [aftermathData, geckoData, pythData] = await Promise.all([
        fetchAftermathPrices(coin_types),
        fetchCoinGeckoData(geckoIds),
        fetchPythPrices(pythFeedIds),
      ]);

      // Build per-coin-type lookups
      const geckoForCoin = new Map<string, CoinGeckoEntry>();
      if (geckoData) {
        for (const [gid, entry] of Object.entries(geckoData)) {
          for (const ct of geckoReverse.get(gid) ?? []) {
            geckoForCoin.set(ct, entry);
          }
        }
      }

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
        const gkEntry = geckoForCoin.get(ct);
        const pyEntry = pythForCoin.get(ct);

        // Aftermath returns -1 for unknown coins
        const aftermathPrice =
          afEntry && afEntry.price >= 0 ? afEntry.price : null;
        const aftermathChange =
          afEntry && afEntry.price >= 0
            ? afEntry.priceChange24HoursPercentage
            : null;

        const pythPrice = pyEntry ? parsePythPrice(pyEntry) : null;

        // Prefer Aftermath > Pyth > CoinGecko for price
        const priceUsd = aftermathPrice ?? pythPrice ?? gkEntry?.usd ?? null;

        // Prefer CoinGecko 24h change (most accurate), fall back to Aftermath
        const change24h =
          gkEntry?.usd_24h_change ?? aftermathChange ?? null;

        const marketCap = gkEntry?.usd_market_cap ?? null;
        const volume = gkEntry?.usd_24h_vol ?? null;

        // Determine source attribution
        const sources: string[] = [];
        if (aftermathPrice != null) sources.push("aftermath");
        if (pythPrice != null) sources.push("pyth");
        if (gkEntry) sources.push("coingecko");
        const source = sources.length > 0 ? sources.join("+") : "none";

        const result: PriceResult = {
          coin_type: ct,
          symbol,
          price_usd: priceUsd,
          price_change_24h_percent: change24h,
          market_cap_usd: marketCap,
          volume_24h_usd: volume,
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
    "Get historical USD prices for Sui tokens at a specific point in time using Pyth oracle data. Supports SUI, USDT, DEEP, NAVX, CETUS, BUCK, AFSUI, STSUI. Provide a Unix timestamp or ISO date string.",
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

      const { feedIds, reverseMap } = buildPythReverse(coin_types);
      const unsupported = coin_types.filter((ct) => !COIN_TYPE_TO_PYTH[ct]);

      const pythData = await fetchPythPrices(feedIds, unixTs);

      const prices = coin_types.map((ct) => {
        const symbol = extractSymbol(ct);
        const fid = COIN_TYPE_TO_PYTH[ct];

        if (!fid) {
          return {
            coin_type: ct,
            symbol,
            price_usd: null,
            confidence: null,
            timestamp: null,
            note: "No Pyth oracle feed available for this token.",
          };
        }

        const entry = pythData?.get(fid);
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
