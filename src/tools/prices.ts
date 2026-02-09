import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Aftermath Finance public price API
const AFTERMATH_PRICE_URL = "https://aftermath.finance/api/price-info";

// CoinGecko free API for supplementary market data
const COINGECKO_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price";
// Static mapping from Sui coin types to CoinGecko IDs for well-known tokens.
// This enables richer market data (market cap, volume, 24h change) from CoinGecko
// as a supplement to the primary Aftermath price feed.
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
      // Build CoinGecko reverse mapping for supplementary data
      const { geckoIds, reverseMap } = buildGeckoReverse(coin_types);

      // Fetch from both sources in parallel
      const [aftermathData, geckoData] = await Promise.all([
        fetchAftermathPrices(coin_types),
        fetchCoinGeckoData(geckoIds),
      ]);

      // Build a per-coin-type CoinGecko lookup for fast access
      const geckoForCoin = new Map<string, CoinGeckoEntry>();
      if (geckoData) {
        for (const [gid, entry] of Object.entries(geckoData)) {
          const types = reverseMap.get(gid);
          if (types) {
            for (const ct of types) {
              geckoForCoin.set(ct, entry);
            }
          }
        }
      }

      const prices: PriceResult[] = coin_types.map((ct) => {
        const symbol = extractSymbol(ct);
        const afEntry = aftermathData?.[ct];
        const gkEntry = geckoForCoin.get(ct);

        // Aftermath returns -1 for unknown coins
        const aftermathPrice =
          afEntry && afEntry.price >= 0 ? afEntry.price : null;
        const aftermathChange =
          afEntry && afEntry.price >= 0
            ? afEntry.priceChange24HoursPercentage
            : null;

        // Prefer Aftermath price (direct coin type match), fall back to CoinGecko
        const priceUsd = aftermathPrice ?? gkEntry?.usd ?? null;

        // Prefer CoinGecko 24h change (more accurate), fall back to Aftermath
        const change24h =
          gkEntry?.usd_24h_change ?? aftermathChange ?? null;

        const marketCap = gkEntry?.usd_market_cap ?? null;
        const volume = gkEntry?.usd_24h_vol ?? null;

        // Determine source attribution
        let source: string;
        if (aftermathPrice != null && gkEntry) {
          source = "aftermath+coingecko";
        } else if (aftermathPrice != null) {
          source = "aftermath";
        } else if (gkEntry) {
          source = "coingecko";
        } else {
          source = "none";
        }

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
}
