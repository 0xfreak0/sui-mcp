import { z } from "zod";
import { errorResult } from "../utils/errors.js";
import {
  fetchCandles,
  fetchOrderbook,
  fetchPools,
  fetchTrades,
  resolvePool,
} from "../utils/deepbook-indexer.js";
import { round, summarizeBook } from "../utils/orderbook.js";
import { buildDeviationReport, type Candle } from "../utils/oracle-deviation.js";
import { priceUsdAtTime } from "../utils/valuation.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ok = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});

/** Candle intervals the indexer accepts. */
const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;

/** Rough seconds per interval, for turning a candle count into a time window. */
const INTERVAL_SECONDS: Record<(typeof INTERVALS)[number], number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

export function registerDeepBookTools(server: McpServer) {
  server.tool(
    "deepbook_orderbook",
    "(DeepBook) Live order book depth for a DeepBook v3 pool: bids, asks, spread, mid price and resting-liquidity imbalance. DeepBook is a central limit order book, so this — not pool reserves — is its real liquidity picture. Omit pool_name to list available pools.",
    {
      pool_name: z
        .string()
        .optional()
        .describe("Pool name such as 'SUI_USDC'. Omit to list all pools."),
      depth: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Price levels per side (default 10)."),
      level: z
        .union([z.literal(1), z.literal(2)])
        .optional()
        .describe("1 = best bid/ask only, 2 = full ladder (default 2)."),
    },
    async ({ pool_name, depth, level }) => {
      try {
        if (!pool_name) {
          const pools = await fetchPools();
          return ok({
            pool_count: pools.length,
            pools: pools.map((p) => ({
              pool_name: p.pool_name,
              pool_id: p.pool_id,
              base: p.base_asset_symbol,
              quote: p.quote_asset_symbol,
            })),
          });
        }

        const pool = await resolvePool(pool_name);
        const book = await fetchOrderbook(pool.pool_name, level ?? 2, depth ?? 10);
        const summary = summarizeBook(book.bids ?? [], book.asks ?? []);

        return ok({
          pool_name: pool.pool_name,
          pool_id: pool.pool_id,
          base: pool.base_asset_symbol,
          quote: pool.quote_asset_symbol,
          as_of: new Date(Number(book.timestamp)).toISOString(),
          summary: {
            ...summary,
            spread_bps: round(summary.spread_bps, 2),
            imbalance: round(summary.imbalance, 4),
          },
          bids: (book.bids ?? []).map(([price, qty]) => ({ price: Number(price), quantity: Number(qty) })),
          asks: (book.asks ?? []).map(([price, qty]) => ({ price: Number(price), quantity: Number(qty) })),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    "deepbook_trades",
    "(DeepBook) Recent fills for a DeepBook v3 pool, with the maker and taker balance manager IDs behind each trade. Filter by balance manager to attribute trading activity to one account during an incident window, or by time range to reconstruct what traded when.",
    {
      pool_name: z.string().describe("Pool name such as 'SUI_USDC'."),
      limit: z.number().int().min(1).max(200).optional().describe("Max trades (default 50)."),
      start_time: z.number().int().optional().describe("Window start, Unix seconds."),
      end_time: z.number().int().optional().describe("Window end, Unix seconds."),
      balance_manager_id: z
        .string()
        .optional()
        .describe("Only trades where this balance manager was maker or taker."),
    },
    async ({ pool_name, limit, start_time, end_time, balance_manager_id }) => {
      try {
        const pool = await resolvePool(pool_name);

        // The indexer filters maker and taker separately, so "this account was
        // involved either way" needs both queries merged. Doing it here keeps
        // the caller from having to know that.
        const base = { limit: limit ?? 50, start_time, end_time };
        const trades = balance_manager_id
          ? dedupeByDigest([
              ...(await fetchTrades(pool.pool_name, {
                ...base,
                maker_balance_manager_id: balance_manager_id,
              })),
              ...(await fetchTrades(pool.pool_name, {
                ...base,
                taker_balance_manager_id: balance_manager_id,
              })),
            ]).slice(0, limit ?? 50)
          : await fetchTrades(pool.pool_name, base);

        const volume = trades.reduce((a, t) => a + (t.base_volume ?? 0), 0);
        const cap = limit ?? 50;
        return ok({
          pool_name: pool.pool_name,
          base: pool.base_asset_symbol,
          quote: pool.quote_asset_symbol,
          trade_count: trades.length,
          // Explicit, because the indexer has no cursor: a full page is
          // indistinguishable from "that was all of them" unless we say so.
          // Narrow start_time/end_time to walk further back.
          truncated: trades.length >= cap,
          ...(trades.length >= cap
            ? {
                truncation_note:
                  `Returned the maximum ${cap} trades. There are probably more in this window — ` +
                  "narrow start_time/end_time and page through by time.",
              }
            : {}),
          total_base_volume: round(volume, 6),
          ...(balance_manager_id ? { filtered_by_balance_manager: balance_manager_id } : {}),
          trades: trades.map((t) => ({
            digest: t.digest,
            price: t.price,
            base_volume: t.base_volume,
            quote_volume: t.quote_volume,
            side: t.taker_is_bid ? "buy" : "sell",
            maker_balance_manager_id: t.maker_balance_manager_id,
            taker_balance_manager_id: t.taker_balance_manager_id,
          })),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    "compare_oracle_price",
    "(Incident investigation) Compare the Pyth oracle price against the price DeepBook actually traded at, over a time window. Lending protocols liquidate on oracle prices, so divergence between the oracle and the book is the signature of a stale feed, a manipulation window, or liquidations priced at levels the market never printed.",
    {
      pool_name: z.string().describe("DeepBook pool such as 'SUI_USDC'. Its base asset is priced."),
      interval: z.enum(INTERVALS).optional().describe("Candle interval (default '1h')."),
      limit: z.number().int().min(1).max(100).optional().describe("Candles to compare (default 24)."),
      end_time: z
        .number()
        .int()
        .optional()
        .describe("End of window, Unix seconds. Defaults to now."),
      threshold_pct: z
        .number()
        .optional()
        .describe("Absolute deviation percent that counts as notable (default 1)."),
    },
    async ({ pool_name, interval, limit, end_time, threshold_pct }) => {
      try {
        const pool = await resolvePool(pool_name);
        const iv = interval ?? "1h";
        const count = limit ?? 24;
        const end = end_time ?? Math.floor(Date.now() / 1000);
        const start = end - INTERVAL_SECONDS[iv] * count;

        const candles = (await fetchCandles(pool.pool_name, iv, {
          start_time: start,
          end_time: end,
          limit: count,
        })) as Candle[];

        if (candles.length === 0) {
          return ok({
            pool_name: pool.pool_name,
            note: "No candles in this window — the pool may not have traded.",
            window: { start, end, interval: iv },
          });
        }

        // One Pyth query per candle: Hermes is a point-in-time API, so there is
        // no bulk form. Sequential rather than parallel to stay polite to a
        // public endpoint; the candle count is bounded at 100.
        const oracle = new Map<number, { price: number; publishTime: number }>();
        for (const [openMs] of candles) {
          const prices = await priceUsdAtTime([pool.base_asset_id], Math.floor(openMs / 1000));
          const p = prices.get(pool.base_asset_id);
          if (p) oracle.set(openMs, { price: p.price, publishTime: p.publishTime });
        }

        const report = buildDeviationReport(
          candles,
          (ms) => oracle.get(ms) ?? null,
          threshold_pct ?? 1,
        );

        return ok({
          pool_name: pool.pool_name,
          asset: pool.base_asset_symbol,
          coin_type: pool.base_asset_id,
          window: {
            start: new Date(start * 1000).toISOString(),
            end: new Date(end * 1000).toISOString(),
            interval: iv,
          },
          oracle_source: "Pyth",
          market_source: "DeepBook v3",
          max_abs_deviation_pct: report.max_abs_deviation_pct,
          max_deviation_at: report.max_deviation_at,
          volume_weighted_mean_deviation_pct: report.mean_deviation_pct,
          flagged_count: report.flagged.length,
          threshold_pct: threshold_pct ?? 1,
          // Points where the oracle had no price are kept with nulls rather
          // than dropped: a gap in oracle coverage during an incident is
          // itself a finding.
          points: report.points,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

/** Merge maker-side and taker-side results without double-counting a fill. */
function dedupeByDigest<T extends { digest: string }>(trades: T[]): T[] {
  const seen = new Set<string>();
  return trades.filter((t) => !seen.has(t.digest) && seen.add(t.digest));
}
