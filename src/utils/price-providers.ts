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
 *   - **Paid sources are opt-in.** Pyth and CoinMarketCap engage only when
 *     their key is set. Nothing degrades for someone who sets neither, and
 *     nobody is billed by accident.
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

export type PriceSource = "aftermath" | "defillama" | "pyth" | "coinmarketcap";

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
}

/** Why a price is missing, so a null is never read as a zero. */
export interface PriceGap {
  reason: "no_provider" | "unsupported" | "unavailable";
  detail: string;
}

export interface PriceLookup {
  quotes: Map<string, PriceQuote>;
  /** Present when something was asked for and could not be answered. */
  gap?: PriceGap;
}

/* ------------------------------------------------------------------ *
 * Keys — opt-in, never required
 * ------------------------------------------------------------------ */

/** Pyth Hermes key. Unset means Pyth is skipped entirely, not attempted. */
export const pythApiKey = (): string | null => process.env.PYTH_API_KEY?.trim() || null;

/** CoinMarketCap key. Unset means CMC is skipped entirely. */
export const cmcApiKey = (): string | null => process.env.CMC_API_KEY?.trim() || null;

/** Which sources are usable right now, cheapest first. */
export function availableSources(): PriceSource[] {
  const out: PriceSource[] = ["aftermath", "defillama"];
  if (pythApiKey()) out.push("pyth");
  if (cmcApiKey()) out.push("coinmarketcap");
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
 * Batching is both supported and faster — four coins in one request measured
 * quicker than one coin — so callers should pass the whole set rather than
 * looping.
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

/**
 * Coins per request. Keys are ~90 characters, so 25 keeps the URL near 2.3 KB,
 * well inside what proxies accept. The Cetus replay priced 195 coins in 8.
 */
export const DEFILLAMA_BATCH = 25;

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
 * Prices from DefiLlama: current when `unixTs` is omitted, otherwise the
 * nearest point DefiLlama holds to that second.
 *
 * The quote's `at` is the timestamp of the point DefiLlama actually used, which
 * can sit on either side of the one asked for, so the caller can see how far
 * from block time a price is. Measured for SUI at 2025-05-22 10:30:00 UTC: the
 * point is 1 s away and priced at $4.16.
 *
 * Batches run in sequence: this is a public endpoint and a 200-coin incident
 * is eight requests.
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
  const keys = [...keyToCoins.keys()];
  const base = unixTs === undefined
    ? `${DEFILLAMA_PRICES_URL}/current/`
    : `${DEFILLAMA_PRICES_URL}/historical/${Math.floor(unixTs)}/`;
  for (let i = 0; i < keys.length; i += DEFILLAMA_BATCH) {
    const chunk = keys.slice(i, i + DEFILLAMA_BATCH);
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
  }
  return { quotes, unanswered, unsupported };
}

/* ------------------------------------------------------------------ *
 * CoinMarketCap — opt-in, keyed by symbol
 * ------------------------------------------------------------------ */

const CMC_QUOTES_URL = "https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest";

/**
 * Current prices by ticker symbol.
 *
 * CMC keys on symbols rather than Sui coin types, which is a real weakness for
 * forensics: symbols are not unique and anyone can mint a coin called USDC.
 * The caller supplies the symbol→coinType mapping it already trusts, so this
 * never guesses which coin a ticker meant.
 */
export async function fetchCoinMarketCap(
  symbolToCoinType: Map<string, string>,
): Promise<Map<string, PriceQuote>> {
  const out = new Map<string, PriceQuote>();
  const key = cmcApiKey();
  if (!key || symbolToCoinType.size === 0) return out;

  try {
    const symbols = [...symbolToCoinType.keys()].join(",");
    const resp = await fetch(`${CMC_QUOTES_URL}?symbol=${encodeURIComponent(symbols)}`, {
      headers: { "X-CMC_PRO_API_KEY": key, accept: "application/json" },
      signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS),
    });
    if (!resp.ok) return out;
    const body = (await resp.json()) as {
      data?: Record<string, Array<{ quote?: { USD?: { price?: number } } }>>;
    };
    for (const [symbol, entries] of Object.entries(body.data ?? {})) {
      const price = entries?.[0]?.quote?.USD?.price;
      const coinType = symbolToCoinType.get(symbol) ?? symbolToCoinType.get(symbol.toUpperCase());
      if (typeof price !== "number" || !coinType) continue;
      out.set(coinType, { price, source: "coinmarketcap" });
    }
  } catch {
    /* opt-in source: never fail the caller */
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
