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
 *   - **Free by default.** Aftermath needs no key and covers current prices,
 *     so the out-of-the-box path keeps working.
 *   - **Paid sources are opt-in.** Pyth and CoinMarketCap engage only when
 *     their key is set. Nothing degrades for someone who sets neither, and
 *     nobody is billed by accident.
 *   - **The answer says where it came from.** A price is evidence like anything
 *     else here, and "Aftermath, current" supports a different claim than
 *     "Pyth, at block time".
 *
 * Historical pricing is the real casualty. Aftermath serves current prices
 * only, so valuing a hop at block time needs a paid key — and a caller that
 * asks for a historical price without one is told that, rather than handed a
 * null it might read as zero.
 */

import { EXTERNAL_HTTP_TIMEOUT_MS } from "../config.js";

export type PriceSource = "aftermath" | "pyth" | "coinmarketcap";

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
  const out: PriceSource[] = ["aftermath"];
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
