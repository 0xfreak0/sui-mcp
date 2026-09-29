/**
 * Where USD prices come from, and what each source can actually answer.
 *
 * Pyth's Hermes endpoint began requiring authentication: `/v2/price_feeds`
 * (which feed is SUI) still answers 200, but `/v2/updates/price/latest` and
 * `/v2/updates/price/{timestamp}` (what SUI costs) return 401. Every call site
 * handled that softly — `if (!resp.ok) return null` — so nothing broke loudly;
 * prices simply became null, which reads as "no value" rather than "no access".
 *
 * The response is a provider layer with three properties:
 *
 *   - **Free by default.** Aftermath and DefiLlama need no key. Aftermath
 *     covers current prices; DefiLlama covers current and historical prices,
 *     so block-time valuation works out of the box.
 *   - **Paid sources are opt-in.** Pyth engages only when its key is set.
 *     Nothing degrades for someone who does not set it, and nobody is billed
 *     by accident.
 *   - **The answer says where it came from.** A price is evidence like anything
 *     else here, and "Aftermath, current" supports a different claim than
 *     "Pyth, at block time".
 *
 * Aftermath and DefiLlama key on the FULL coin type. Pyth feeds are found by
 * ticker symbol, and 585 mainnet coins end `::SUI`, so a Pyth price is only
 * ever attached to a coin the curated registry verifies. An unverified coin
 * priced from a symbol-keyed feed would carry the real asset's price.
 */

import { EXTERNAL_HTTP_TIMEOUT_MS } from "../config.js";
import { normalizeCoinType } from "./coin-registry.js";

export type PriceSource = "aftermath" | "defillama" | "pyth";

export interface PriceQuote {
  /** USD unit price. */
  price: number;
  source: PriceSource;
  /**
   * Unix seconds the quote is for. Absent when the source reports only a
   * current price, which is the case for every free provider here.
   */
  at?: number;
  /** True when the caller asked for a historical price and got a current one. */
  approximate?: boolean;
  /**
   * The provider's own confidence. DefiLlama reports a 0-1 score for how well
   * its sources agree; Pyth reports a USD confidence interval.
   */
  confidence?: number;
  /** Decimals the provider priced one whole unit at (DefiLlama reports these). */
  decimals?: number;
  /** The provider's symbol for the coin. A label, not an identification. */
  symbol?: string;
  /**
   * The provider id of the asset this price belongs to, when it is not the
   * coin's own: a bridge token priced as the asset it is minted against.
   */
  priced_as?: string;
}

/* ------------------------------------------------------------------ *
 * Keys — opt-in, never required
 * ------------------------------------------------------------------ */

/** Pyth Hermes key. Unset means Pyth is skipped entirely, not attempted. */
export const pythApiKey = (): string | null => process.env.PYTH_API_KEY?.trim() || null;

/** Which sources are usable right now, cheapest first. */
export function availableSources(): PriceSource[] {
  const out: PriceSource[] = ["aftermath", "defillama"];
  if (pythApiKey()) out.push("pyth");
  return out;
}

/* ------------------------------------------------------------------ *
 * Aftermath — free, current prices, Sui coin types
 * ------------------------------------------------------------------ */

const AFTERMATH_PRICE_URL = "https://aftermath.finance/api/price-info";

interface AftermathEntry {
  price: number;
  priceChange24HoursPercentage: number;
}

/**
 * Current prices for Sui coin types.
 *
 * Batching is supported and faster than one request per coin, so callers
 * should pass the whole set rather than looping.
 *
 * An unknown coin comes back as `price: -1`, not null and not absent. That
 * sentinel is filtered here so it can never reach a caller as a negative USD
 * value; a coin Aftermath does not know simply has no quote.
 */
export async function fetchAftermath(coinTypes: string[]): Promise<Map<string, PriceQuote>> {
  const out = new Map<string, PriceQuote>();
  if (coinTypes.length === 0) return out;

  try {
    const resp = await fetch(AFTERMATH_PRICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coins: coinTypes }),
      signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
    });
    if (!resp.ok) return out;
    const data = (await resp.json()) as Record<string, AftermathEntry>;
    for (const [coinType, entry] of Object.entries(data ?? {})) {
      if (!entry || typeof entry.price !== "number" || entry.price < 0) continue;
      out.set(coinType, { price: entry.price, source: "aftermath" });
    }
  } catch {
    // Best-effort: a pricing failure must not break the caller.
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * DefiLlama — free, current AND historical, keyed by full coin type
 * ------------------------------------------------------------------ */

const DEFILLAMA_PRICES_URL = "https://coins.llama.fi/prices";
const DEFILLAMA_PERCENTAGE_URL = "https://coins.llama.fi/percentage";

/**
 * Coins per request. Keys are ~90 characters, so 25 keeps the URL near 2.3 KB,
 * well inside what proxies accept.
 */
const DEFILLAMA_BATCH = 25;

/**
 * DefiLlama's key for a Sui coin type: `sui:` plus the type with its address
 * padded to 64 hex digits.
 *
 * Padding matters in one direction only. `sui:0x2::sui::SUI` and the padded form
 * both resolve, but an address whose leading zero is stripped does not:
 * `sui:0x6864a6f9…::cetus::CETUS` returns nothing where `sui:0x06864a6f9…`
 * returns CETUS. The padded form is always sent.
 *
 * A coin type with type parameters (`…::lp::LP<A, B>`) has no key. The list is
 * comma-separated in the URL path, so such a coin is reported unpriced rather
 * than split into two garbage keys. Module and struct names must be Move
 * identifiers: the key goes into a URL path, and one malformed key in a batch
 * would cost the other 24 coins their prices.
 */
export function defiLlamaKey(coinType: string): string | null {
  const t = normalizeCoinType(coinType);
  if (!t) return null;
  const [, mod, name] = t.split("::");
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  return ident.test(mod) && ident.test(name) ? `sui:${t}` : null;
}

interface DefiLlamaEntry {
  price?: unknown;
  timestamp?: unknown;
  confidence?: unknown;
  decimals?: unknown;
  symbol?: unknown;
}

/**
 * Read a `/prices/current` or `/prices/historical` body into quotes keyed by
 * the coin types the caller asked for.
 *
 * The response keys echo the keys sent, so `keyToCoins` maps each back. One
 * key can stand for several spellings of the same coin (`0x2::sui::SUI` and the
 * padded form), and every spelling gets the quote. A missing, non-finite or
 * negative price is no quote at all.
 */
export function parseDefiLlamaPrices(
  body: unknown,
  keyToCoins: Map<string, string[]>,
): Map<string, PriceQuote> {
  const out = new Map<string, PriceQuote>();
  const coins = (body as { coins?: Record<string, DefiLlamaEntry> } | null)?.coins;
  if (!coins || typeof coins !== "object") return out;
  for (const [key, entry] of Object.entries(coins)) {
    const targets = keyToCoins.get(key);
    if (!targets || !entry) continue;
    const price = entry.price;
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) continue;
    const quote: PriceQuote = { price, source: "defillama" };
    if (typeof entry.timestamp === "number") quote.at = entry.timestamp;
    if (typeof entry.confidence === "number") quote.confidence = entry.confidence;
    if (typeof entry.decimals === "number" && Number.isInteger(entry.decimals)) quote.decimals = entry.decimals;
    if (typeof entry.symbol === "string") quote.symbol = entry.symbol;
    for (const coinType of targets) out.set(coinType, quote);
  }
  return out;
}

export interface DefiLlamaResult {
  quotes: Map<string, PriceQuote>;
  /** Coin types whose request failed, as opposed to coins DefiLlama does not list. */
  unanswered: Set<string>;
  /** Coin types that have no DefiLlama key (type parameters, malformed). */
  unsupported: Set<string>;
}

/**
 * Sui Bridge tokens, each minted 1:1 against an Ethereum asset the bridge
 * locks (token ids 1, 2, 4 and 6 in `0xb::treasury::NewTokenEvent`), keyed to
 * that asset's DefiLlama id. Used only for a bridge token DefiLlama has no
 * price for under its own Sui type; the quote then names the asset in
 * `priced_as`.
 */
const SUI_BRIDGE_ASSET: Record<string, string> = Object.fromEntries(
  Object.entries({
    "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC": "coingecko:wrapped-bitcoin",
    "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH": "coingecko:ethereum",
    "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT": "coingecko:tether",
    "0xc6d1cb347faf61fb743d09cf91be7280960052374a3e894342ce947b2de3e56f::wlbtc::WLBTC": "coingecko:lombard-staked-btc",
  }).map(([coinType, asset]) => [normalizeCoinType(coinType)!, asset]),
);

/**
 * DefiLlama batches in flight at once. The endpoint is shared and public, so
 * requests are few at a time, but more than one: a meme-coin drain prices
 * hundreds of coins, and its batches one after another would be the call's
 * latency.
 */
const DEFILLAMA_CONCURRENCY = 4;

/**
 * Ask DefiLlama for `keyToCoins`' keys in batches, adding each answer to
 * `quotes` under every coin type its key stands for. A failed batch marks
 * its coins `unanswered`.
 */
async function requestDefiLlama(
  keyToCoins: Map<string, string[]>,
  base: string,
  quotes: Map<string, PriceQuote>,
  unanswered: Set<string>,
): Promise<void> {
  const keys = [...keyToCoins.keys()];
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += DEFILLAMA_BATCH) chunks.push(keys.slice(i, i + DEFILLAMA_BATCH));
  const request = async (chunk: string[]) => {
    try {
      const resp = await fetch(base + chunk.join(","), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const chunkMap = new Map(chunk.map((k) => [k, keyToCoins.get(k)!]));
      for (const [coinType, q] of parseDefiLlamaPrices(await resp.json(), chunkMap)) quotes.set(coinType, q);
    } catch {
      // Best-effort, but never silent: these coins are reported as unanswered,
      // which is a different finding from "DefiLlama has no price".
      for (const k of chunk) for (const coinType of keyToCoins.get(k)!) unanswered.add(coinType);
    }
  };
  for (let i = 0; i < chunks.length; i += DEFILLAMA_CONCURRENCY) await Promise.all(chunks.slice(i, i + DEFILLAMA_CONCURRENCY).map(request));
}

/**
 * Prices from DefiLlama: current when `unixTs` is omitted, otherwise the
 * nearest point DefiLlama holds to that second.
 *
 * The quote's `at` is the timestamp of the point DefiLlama actually used, which
 * can sit on either side of the one asked for, so the caller can see how far
 * from block time a price is.
 *
 * A Sui Bridge token with no price of its own gets its Ethereum asset's
 * ({@link SUI_BRIDGE_ASSET}), marked `priced_as`.
 */
export async function fetchDefiLlama(coinTypes: string[], unixTs?: number): Promise<DefiLlamaResult> {
  const quotes = new Map<string, PriceQuote>();
  const unanswered = new Set<string>();
  const unsupported = new Set<string>();
  const keyToCoins = new Map<string, string[]>();
  for (const coinType of new Set(coinTypes)) {
    const key = defiLlamaKey(coinType);
    if (!key) {
      unsupported.add(coinType);
      continue;
    }
    keyToCoins.set(key, [...(keyToCoins.get(key) ?? []), coinType]);
  }
  const base = unixTs === undefined
    ? `${DEFILLAMA_PRICES_URL}/current/`
    : `${DEFILLAMA_PRICES_URL}/historical/${Math.floor(unixTs)}/`;
  await requestDefiLlama(keyToCoins, base, quotes, unanswered);

  const assetToCoins = new Map<string, string[]>();
  for (const coins of keyToCoins.values()) {
    for (const coinType of coins) {
      if (quotes.has(coinType) || unanswered.has(coinType)) continue;
      const asset = SUI_BRIDGE_ASSET[normalizeCoinType(coinType) ?? ""];
      if (asset) assetToCoins.set(asset, [...(assetToCoins.get(asset) ?? []), coinType]);
    }
  }
  if (assetToCoins.size > 0) {
    const assetQuotes = new Map<string, PriceQuote>();
    await requestDefiLlama(assetToCoins, base, assetQuotes, unanswered);
    for (const [coinType, q] of assetQuotes) quotes.set(coinType, { ...q, priced_as: SUI_BRIDGE_ASSET[normalizeCoinType(coinType)!] });
  }
  return { quotes, unanswered, unsupported };
}

/**
 * Percent change over the last 24 hours, from DefiLlama's `/percentage`
 * endpoint, keyed by the coin types asked for. A coin DefiLlama does not list
 * is absent from its answer and from this map, as is every coin of a batch
 * whose request failed: an unknown change is never a zero.
 *
 * A framework coin (package 0x2) is asked for under its short address:
 * DefiLlama's `/percentage` answer for the 64-digit form of SUI does not
 * follow the price, while the short form does.
 *
 * Aftermath's `priceChange24HoursPercentage` is not used: it reads 0.0 for
 * every coin, SUI included, whatever the price did.
 */
export async function fetchDefiLlamaChange24h(coinTypes: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const keyToCoins = new Map<string, string[]>();
  for (const coinType of new Set(coinTypes)) {
    const key = defiLlamaKey(coinType)?.replace(/^sui:0x0{63}2::/, "sui:0x2::");
    if (key) keyToCoins.set(key, [...(keyToCoins.get(key) ?? []), coinType]);
  }
  const keys = [...keyToCoins.keys()];
  for (let i = 0; i < keys.length; i += DEFILLAMA_BATCH) {
    const chunk = keys.slice(i, i + DEFILLAMA_BATCH);
    try {
      const resp = await fetch(`${DEFILLAMA_PERCENTAGE_URL}/${chunk.join(",")}?period=24h`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
      });
      if (!resp.ok) continue;
      const coins = ((await resp.json()) as { coins?: Record<string, unknown> } | null)?.coins ?? {};
      for (const [key, pct] of Object.entries(coins)) {
        if (typeof pct !== "number" || !Number.isFinite(pct)) continue;
        for (const coinType of keyToCoins.get(key) ?? []) out.set(coinType, pct);
      }
    } catch {
      // Best-effort: these coins are left out, which the caller reports as null.
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Ranking — relative value, deliberately not historical
 * ------------------------------------------------------------------ */

/**
 * Prices for deciding which of several amounts is larger.
 *
 * Ranking needs *relative* value, not the price at a past instant: choosing
 * which of five recipients received the most does not become more correct with
 * block-time precision. So this uses the free current-price path and never
 * reaches for a paid historical one — the previous code paid for a per-hop
 * historical lookup to answer a question that did not need it, and after Pyth
 * closed it was paying for a guaranteed 401.
 */
export async function pricesForRanking(coinTypes: string[]): Promise<Map<string, PriceQuote>> {
  return fetchAftermath([...new Set(coinTypes)]);
}
