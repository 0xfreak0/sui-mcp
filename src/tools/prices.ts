import { z } from "zod";
import { numArg } from "./args.js";
import { EXTERNAL_HTTP_TIMEOUT_MS } from "../config.js";
import { pythApiKey, availableSources, fetchDefiLlama } from "../utils/price-providers.js";
import { isVerifiedCoin } from "../utils/coin-registry.js";
import { errorResult } from "../utils/errors.js";
import { displayCoin, priceUsdAtTime, PRICE_STALE_THRESHOLD_SEC } from "../utils/valuation.js";
import { buildPythFeedMap } from "../discovery.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Aftermath Finance public price API
const AFTERMATH_PRICE_URL = "https://aftermath.finance/api/price-info";

// Pyth Network Hermes API. Feed discovery is open; price values need a key.
const PYTH_HERMES_URL = "https://hermes.pyth.network";

export interface AftermathPriceEntry {
  price: number;
  priceChange24HoursPercentage: number;
}

interface PriceResult {
  coin_type: string;
  symbol: string;
  verified: boolean | null;
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
      signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, AftermathPriceEntry>;
  } catch {
    return null;
  }
}

export interface PythParsedPrice {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
  ema_price: { price: string; conf: string; expo: number; publish_time: number };
}

export function parsePythPrice(p: PythParsedPrice): number {
  return Number(p.price.price) * 10 ** p.price.expo;
}

/**
 * Fetch prices from Pyth Hermes API for tokens with known feed IDs.
 * Supports both latest and historical (by timestamp) queries.
 */
export async function fetchPythPrices(
  feedIds: string[],
  timestamp?: number,
): Promise<Map<string, PythParsedPrice> | null> {
  if (feedIds.length === 0) return null;
  try {
    const idParams = feedIds.map((id) => `ids[]=${id}`).join("&");
    const path = timestamp
      ? `/v2/updates/price/${timestamp}`
      : "/v2/updates/price/latest";
    // Hermes now requires authentication for price *values* (feed discovery is
    // still open). Without a key this is a guaranteed 401, so skip the request
    // rather than spend a round trip to be refused.
    const key = pythApiKey();
    if (!key) return null;
    const resp = await fetch(`${PYTH_HERMES_URL}${path}?${idParams}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
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
    "Get USD prices for Sui tokens, current by default or at a past moment when `at` is set. Needs no API key. Current prices come from Aftermath, then DefiLlama, then Pyth. Historical prices come from Pyth when PYTH_API_KEY is set and the coin is on the verified list, and from DefiLlama otherwise. Every price names its source, confidence and the time of the sample it came from, and every coin that could not be priced is listed under `unpriced` with the reason. An unverified coin is priced only by its exact coin type, never by a symbol-matched feed. Accepts full coin type strings (e.g. 0x2::sui::SUI).",
    {
      coin_types: z
        .array(z.string())
        .min(1)
        .max(100)
        .describe(
          "Array of full coin type strings (e.g. ['0x2::sui::SUI', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'])"
        ),
      at: z
        .union([numArg(), z.string()])
        .optional()
        .describe("Optional: price AT this point in time, as Unix seconds or ISO 8601 (e.g. '2025-01-15T00:00:00Z'). Omit for current prices."),
    },
    async ({ coin_types, at }) => {
      if (at !== undefined) {
        let unixTs: number;
        if (typeof at === "number") {
          unixTs = at;
        } else {
          const parsed = Date.parse(at);
          if (isNaN(parsed)) return errorResult("Invalid `at`. Use Unix seconds or ISO 8601 format.");
          unixTs = Math.floor(parsed / 1000);
        }
        const { points, unpriced } = await priceUsdAtTime(coin_types, unixTs);
        const prices = coin_types.map((ct) => {
          const coin = displayCoin(ct);
          const p = points.get(ct);
          if (!p) return { coin_type: ct, symbol: coin.symbol, verified: coin.verified, price_usd: null };
          const offset = p.publishTime - unixTs;
          return {
            coin_type: ct,
            symbol: coin.symbol,
            verified: coin.verified,
            price_usd: p.price,
            source: p.source,
            ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
            price_time: new Date(p.publishTime * 1000).toISOString(),
            // Signed: negative means the sample predates the moment asked for.
            price_offset_sec: offset,
            ...(Math.abs(offset) > PRICE_STALE_THRESHOLD_SEC ? { stale: true } : {}),
          };
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              query_timestamp: unixTs,
              query_date: new Date(unixTs * 1000).toISOString(),
              price_sources: availableSources(),
              confidence_note:
                "DefiLlama's confidence is a 0-1 score for how well its sources agreed; Pyth's is a USD confidence interval. A price whose sample is more than an hour from the moment asked for is marked stale.",
              prices,
              ...(unpriced.length ? { unpriced } : {}),
            }, null, 2),
          }],
        };
      }

      // Pyth is matched by symbol, so it is only asked about verified coins.
      const pythCandidates = coin_types.filter((ct) => isVerifiedCoin(ct));
      const { feedIds: pythFeedIds, reverseMap: pythReverse } =
        await buildPythFeedMap(pythCandidates);

      const [aftermathData, pythData] = await Promise.all([
        fetchAftermathPrices(coin_types),
        fetchPythPrices(pythFeedIds),
      ]);
      // DefiLlama fills what Aftermath did not answer.
      const aftermathMissing = coin_types.filter((ct) => !(aftermathData?.[ct] && aftermathData[ct].price >= 0));
      const llama = aftermathMissing.length > 0 ? await fetchDefiLlama(aftermathMissing) : null;

      const pythForCoin = new Map<string, PythParsedPrice>();
      if (pythData) {
        for (const [fid, entry] of pythData) {
          for (const ct of pythReverse.get(fid) ?? []) {
            pythForCoin.set(ct, entry);
          }
        }
      }

      const prices: PriceResult[] = coin_types.map((ct) => {
        const coin = displayCoin(ct);
        const afEntry = aftermathData?.[ct];
        const pyEntry = pythForCoin.get(ct);

        // Aftermath returns -1 for unknown coins
        const aftermathPrice =
          afEntry && afEntry.price >= 0 ? afEntry.price : null;
        const aftermathChange =
          afEntry && afEntry.price >= 0
            ? afEntry.priceChange24HoursPercentage
            : null;
        const llamaPrice = llama?.quotes.get(ct)?.price ?? null;
        const pythPrice = pyEntry ? parsePythPrice(pyEntry) : null;

        const priceUsd = aftermathPrice ?? llamaPrice ?? pythPrice ?? null;
        const change24h = aftermathChange ?? null;

        const sources: string[] = [];
        if (aftermathPrice != null) sources.push("aftermath");
        if (llamaPrice != null) sources.push("defillama");
        if (pythPrice != null) sources.push("pyth");
        const source = sources.length > 0 ? sources.join("+") : "none";

        const result: PriceResult = {
          coin_type: ct,
          symbol: coin.symbol,
          verified: coin.verified,
          price_usd: priceUsd,
          price_change_24h_percent: change24h,
          source,
        };

        if (priceUsd == null) {
          result.note = llama?.unanswered.has(ct)
            ? "Aftermath had no price and the DefiLlama request failed, so this is not evidence the coin has no market."
            : "No source has a price for this exact coin type. The coin type may be invalid or not traded on any tracked venue.";
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
