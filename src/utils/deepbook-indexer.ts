import { EXTERNAL_HTTP_TIMEOUT_MS, getNetworkConfig } from "../config.js";

/**
 * Client for the DeepBook v3 indexer.
 *
 * DeepBook is a central limit order book, not an AMM: there is no reserve pair
 * to read off a pool object, and the book, the fill history and any candle
 * series only exist as the accumulation of events. Reconstructing them from
 * chain reads would mean indexing every fill, so this is one of the few places
 * where a hosted service is the only practical source.
 *
 * Unauthenticated, and mainnet/testnet only — devnet runs no indexer.
 *
 * Freshness caveat: the indexer runs ~78 pipelines and they are not equally
 * current. The trading pipelines behind the endpoints used here were live when
 * this was written, but the `@backfill_collateral` family (margin, collateral,
 * `/portfolio`) was months behind. That is why nothing here touches margin
 * data — see `deepbookIndexerStatus` for checking before trusting a result.
 */

/** Base URL for the active call's network, or null where no indexer exists. */
export function deepbookIndexerUrl(): string | null {
  return getNetworkConfig().deepbookIndexer;
}

export class DeepBookUnavailableError extends Error {
  constructor(network: string) {
    super(
      `DeepBook indexer is not available on ${network}. ` +
        "DeepBook v3 runs on mainnet and testnet only.",
    );
    this.name = "DeepBookUnavailableError";
  }
}

async function indexerFetch<T>(path: string): Promise<T> {
  const base = deepbookIndexerUrl();
  if (!base) throw new DeepBookUnavailableError(getNetworkConfig().network);

  const res = await fetch(`${base}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`DeepBook indexer ${res.status} on ${path}${body ? `: ${body}` : ""}`);
  }
  return (await res.json()) as T;
}

export interface DeepBookPool {
  pool_id: string;
  pool_name: string;
  base_asset_id: string;
  base_asset_symbol: string;
  base_asset_decimals: number;
  quote_asset_id: string;
  quote_asset_symbol: string;
  quote_asset_decimals: number;
}

/** Every pool the indexer knows, keyed by `pool_name` (e.g. `SUI_USDC`). */
export async function fetchPools(): Promise<DeepBookPool[]> {
  return indexerFetch<DeepBookPool[]>("/get_pools");
}

/**
 * Resolve a pool by name, case-insensitively.
 *
 * Throws with the available names rather than a bare 404: the pool naming
 * convention (`BASE_QUOTE`, with bridged assets carrying prefixes like `BWETH`)
 * is not guessable, so the error has to be the discovery mechanism.
 */
export async function resolvePool(poolName: string): Promise<DeepBookPool> {
  const pools = await fetchPools();
  const want = poolName.trim().toUpperCase();
  const hit = pools.find((p) => p.pool_name.toUpperCase() === want);
  if (hit) return hit;
  throw new Error(
    `Unknown DeepBook pool '${poolName}'. Available: ${pools.map((p) => p.pool_name).sort().join(", ")}`,
  );
}

/** Raw order book: `[price, quantity]` pairs, best price first. */
export interface DeepBookOrderbook {
  bids: [string, string][];
  asks: [string, string][];
  timestamp: string;
}

/**
 * @param levelsPerSide price levels wanted on *each* side.
 *
 * Upstream `depth` counts levels across BOTH sides — `depth=6` returns 3 bids
 * and 3 asks, verified against mainnet — which is not what anyone means by
 * "depth". Callers pass per-side and this doubles it.
 */
export async function fetchOrderbook(
  poolName: string,
  level: 1 | 2,
  levelsPerSide: number,
): Promise<DeepBookOrderbook> {
  const qs = new URLSearchParams({
    level: String(level),
    depth: String(levelsPerSide * 2),
  });
  return indexerFetch<DeepBookOrderbook>(`/orderbook/${encodeURIComponent(poolName)}?${qs}`);
}

export interface DeepBookTrade {
  digest: string;
  price: number;
  base_volume: number;
  quote_volume: number;
  taker_is_bid: boolean;
  maker_balance_manager_id: string;
  taker_balance_manager_id: string;
  timestamp?: number;
}

export async function fetchTrades(
  poolName: string,
  params: {
    limit?: number;
    start_time?: number;
    end_time?: number;
    maker_balance_manager_id?: string;
    taker_balance_manager_id?: string;
  },
): Promise<DeepBookTrade[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const q = qs.toString();
  return indexerFetch<DeepBookTrade[]>(
    `/trades/${encodeURIComponent(poolName)}${q ? `?${q}` : ""}`,
  );
}

/** `[openTimeMs, open, high, low, close, volume]`, newest first. */
export type DeepBookCandle = [number, number, number, number, number, number];

/**
 * @param params start/end in **Unix seconds** — converted below.
 *
 * Two undocumented quirks, both verified against mainnet:
 *
 *   - The path is `/ohclv`, not `/ohlcv`. The letters are transposed upstream
 *     and in the Sui docs; `/ohlcv` silently returns nothing.
 *   - This endpoint wants **milliseconds**, while `/trades` and
 *     `/historical_volume` want seconds. Passing seconds here returns an empty
 *     candle array rather than an error, so the failure looks like "this pool
 *     didn't trade" instead of "wrong units".
 *
 * Every function in this module takes seconds; the conversion lives here so no
 * caller has to remember which endpoint is which.
 */
export async function fetchCandles(
  poolName: string,
  interval: string,
  params: { start_time?: number; end_time?: number; limit?: number },
): Promise<DeepBookCandle[]> {
  const qs = new URLSearchParams({ interval });
  if (params.start_time !== undefined) qs.set("start_time", String(params.start_time * 1000));
  if (params.end_time !== undefined) qs.set("end_time", String(params.end_time * 1000));
  if (params.limit !== undefined) qs.set("limit", String(params.limit));

  const data = await indexerFetch<{ candles: DeepBookCandle[] }>(
    `/ohclv/${encodeURIComponent(poolName)}?${qs}`,
  );
  return data.candles ?? [];
}

export interface IndexerPipelineStatus {
  pipeline: string;
  checkpoint_lag: number;
  time_lag_seconds: number;
}

/** Indexer health, including per-pipeline lag. */
export async function deepbookIndexerStatus(): Promise<{
  status: string;
  latest_onchain_checkpoint: number;
  pipelines: IndexerPipelineStatus[];
}> {
  return indexerFetch("/status");
}
