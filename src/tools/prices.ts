import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Aftermath Finance public price API
const AFTERMATH_PRICE_URL = "https://aftermath.finance/api/price-info";

// Pyth Network Hermes API (free, public, no auth)
const PYTH_HERMES_URL = "https://hermes.pyth.network";

// Pyth feed IDs for Sui ecosystem tokens
const COIN_TYPE_TO_PYTH: Record<string, string> = {
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI":
    "23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
  "0x2::sui::SUI":
    "23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC":
    "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN":
    "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", // wUSDC
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d9c15345502::coin::COIN":
    "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b", // USDT
  "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP":
    "29bdd5248234e33bd93d3b81100b5fa32eaa5997843847e2c2cb16d7c6d9f7ff",
  "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX":
    "88250f854c019ef4f88a5c073d52a18bb1c6ac437033f5932cd017d24917ab46",
  "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS":
    "e5b274b2611143df055d6e7cd8d93fe1961716bcd4dca1cad87a83bc1e78c1ef",
  "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK":
    "fdf28a46570252b25fd31cb257973f865afc5ca2f320439e45d95e0394bc7382",
  "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI":
    "17cd845b16e874485b2684f8b8d1517d744105dbb904eec30222717f4bc9ee0d",
  "0xd1b72982e40348d069bb1ff701e634c117bb5f741f44dff91e472d3b01461e55::stsui::STSUI":
    "0b3eae8cb6e221e7388a435290e0f2211172563f94769077b7f4c4c6a11eea76",
  "0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI":
    "0b3eae8cb6e221e7388a435290e0f2211172563f94769077b7f4c4c6a11eea76", // stSUI equivalent
};

// CoinGecko free API for supplementary market data
const COINGECKO_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price";

const COIN_TYPE_TO_COINGECKO: Record<string, string> = {
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI":
    "sui",
  "0x2::sui::SUI": "sui",
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC":
    "usd-coin",
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d9c15345502::coin::COIN":
    "tether",
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN":
    "usd-coin",
  "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP":
    "deep",
  "0xa99b8952d4f7d947ea77fe0ecdcc9e5fc0bcab2841d6e2a5aa00c3044e5544b5::navx::NAVX":
    "navx",
  "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::SCA":
    "scallop-2",
  "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2::buck::BUCK":
    "bucket-protocol",
  "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS":
    "cetus-protocol",
  "0xbde4ba4c2e274a60ce15c1cfff9e5c42e136a8bc::afsui::AFSUI":
    "aftermath-staked-sui",
  "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI":
    "aftermath-staked-sui",
};

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
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: "Invalid timestamp. Use Unix seconds or ISO 8601 format." }),
            }],
            isError: true,
          };
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
