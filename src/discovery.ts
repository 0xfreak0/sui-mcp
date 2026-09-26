import { sui } from "./clients/grpc.js";
import { gqlQuery } from "./clients/graphql.js";
import {
  resolveVerifiedSymbol,
  type RegistryCoin,
} from "./utils/coin-registry.js";
import { symbolIndex, type IndexedCoin, type SymbolIndexInfo, type UnlistedSymbol } from "./utils/coin-symbols.js";
import { EXTERNAL_HTTP_TIMEOUT_MS, getNetwork } from "./config.js";
import { describeError } from "./utils/errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenInfo {
  coin_type: string;
  name: string;
  symbol: string;
  decimals: number;
}

// ---------------------------------------------------------------------------
// GraphQL CoinMetadata discovery (cached 6h)
// ---------------------------------------------------------------------------

const TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const GQL_PAGE_SIZE = 50;
const PAGE_DELAY_MS = 50;

/**
 * Ceiling on pages walked in one scan.
 *
 * There is no symbol filter in the objects API, so resolving a symbol means
 * reading CoinMetadata objects until it turns up. The set is effectively
 * unbounded and grows with every token anyone mints. An uncapped
 * `while (true)` here would stall a tool in the default profile, so the walk
 * is bounded and says when it stopped early rather than presenting a partial
 * answer as the whole set.
 */
const MAX_SCAN_PAGES = 60;

interface TokenScan extends ScanReport {
  tokens: TokenInfo[];
}

/** How far a live metadata scan got. */
export interface ScanReport {
  /** CoinMetadata objects read. */
  scanned: number;
  /** True when the page budget or a failed page stopped it before the end. */
  truncated: boolean;
  /**
   * The error of the page read that ended the walk. A failed read says
   * nothing about the pages after it, so it is a read failure, never a miss.
   */
  failed?: string;
}

/**
 * Caches are keyed by network. A single module-level cache served mainnet coin
 * types to a testnet call, which is the one thing per-call network selection
 * exists to prevent.
 */
const tokenCache = new Map<string, { scan: TokenScan; fetchedAt: number }>();
const fetchInProgress = new Map<string, Promise<TokenScan>>();

/**
 * Resolved symbol → token, keyed `network:symbol`.
 *
 * The streaming resolver deliberately does not cache the pages it walked — a
 * partial corpus would make a later exact match unreachable until it expired.
 * Caching the *answer* has neither problem: a symbol that resolved once is
 * settled, and a repeat lookup costs nothing instead of re-walking a few
 * hundred pages.
 */
const symbolCache = new Map<string, { token: TokenInfo; fetchedAt: number }>();

const COIN_METADATA_QUERY = `
  query($first: Int!, $after: String) {
    objects(filter: { type: "0x2::coin::CoinMetadata" }, first: $first, after: $after) {
      nodes {
        asMoveObject {
          contents {
            type { repr }
            json
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface CoinMetadataPage {
  objects: {
    nodes: Array<{
      asMoveObject?: {
        contents?: {
          type?: { repr?: string };
          json?: {
            name?: string;
            symbol?: string;
            decimals?: number;
          };
        };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

function extractCoinTypeFromMetadata(typeRepr: string): string | null {
  // typeRepr looks like "0x2::coin::CoinMetadata<0xabc::module::TOKEN>"
  const match = typeRepr.match(/^0x0*2::coin::CoinMetadata<(.+)>$/);
  return match?.[1] ?? null;
}

/**
 * Walk CoinMetadata pages, handing each batch to `onBatch`.
 *
 * `onBatch` returning true stops the walk, which is what turns "resolve one
 * symbol" from a full-network crawl into a scan that ends as soon as the
 * symbol turns up. Returns whether the walk stopped with pages left, how
 * many objects it read, and the error of a page read that ended it.
 */
async function pageCoinMetadata(
  onBatch: (batch: TokenInfo[]) => boolean,
): Promise<ScanReport> {
  let cursor: string | undefined;
  let read = 0;

  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    let data: CoinMetadataPage;
    try {
      data = await gqlQuery<CoinMetadataPage>(COIN_METADATA_QUERY, {
        first: GQL_PAGE_SIZE,
        after: cursor ?? undefined,
      });
    } catch (err) {
      // A failed page ends the walk. The partial list is marked truncated,
      // and the error travels with it so no caller reports it as a miss.
      return { truncated: true, scanned: read, failed: describeError(err, getNetwork()) };
    }

    read += data.objects.nodes.length;
    const batch: TokenInfo[] = [];
    for (const node of data.objects.nodes) {
      const contents = node.asMoveObject?.contents;
      const typeRepr = contents?.type?.repr;
      const json = contents?.json;
      if (!typeRepr || !json) continue;

      const coinType = extractCoinTypeFromMetadata(typeRepr);
      if (!coinType) continue;

      const symbol = json.symbol;
      if (!symbol) continue;

      batch.push({
        coin_type: coinType,
        name: json.name ?? symbol,
        symbol,
        decimals: json.decimals ?? 9,
      });
    }

    if (onBatch(batch)) return { truncated: false, scanned: read };
    if (!data.objects.pageInfo.hasNextPage) return { truncated: false, scanned: read };
    cursor = data.objects.pageInfo.endCursor ?? undefined;
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  return { truncated: true, scanned: read };
}

async function doFetchDiscoveryTokens(): Promise<TokenScan> {
  const tokens: TokenInfo[] = [];
  const report = await pageCoinMetadata((batch) => {
    tokens.push(...batch);
    return false;
  });
  return { tokens, ...report };
}

/**
 * The full (bounded) token list for the current network.
 *
 * A scan the page budget cut short is cached like any other, because
 * re-running a 60-page walk per call is worse than reusing a partial one, and
 * `truncated` travels with it so callers can say the set is incomplete. A
 * scan a failed page ended is not cached: the next call reads again.
 */
async function fetchDiscoveryTokens(): Promise<TokenScan> {
  const key = getNetwork();
  const cached = tokenCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return cached.scan;
  }

  // Deduplicate concurrent callers — only one scan at a time per network.
  const inFlight = fetchInProgress.get(key);
  if (inFlight) return inFlight;

  const p = doFetchDiscoveryTokens()
    .then((scan) => {
      if (scan.tokens.length > 0 && !scan.failed) tokenCache.set(key, { scan, fetchedAt: Date.now() });
      return scan;
    })
    .finally(() => {
      fetchInProgress.delete(key);
    });
  fetchInProgress.set(key, p);
  return p;
}

/** Where `searchTokens` found its matches. */
export type TokenSearch =
  | {
      source: "symbol_index";
      tokens: TokenInfo[];
      index: SymbolIndexInfo;
      /** The exact symbol is used by more coins than the index lists: how many. */
      unlisted_exact_count: number | null;
      /** Other symbols containing the query that too many coins use to list, most-used first. */
      unlisted_containing: UnlistedSymbol[];
    }
  | {
      source: "scan";
      tokens: TokenInfo[];
      /** The scan stopped before the end, so a coin absent here may still exist. */
      truncated: boolean;
      /** CoinMetadata objects the scan read. */
      scanned: number;
      /** The error of the page read that ended the scan, if one did. */
      failed?: string;
      /** The index that had no match, on mainnet. */
      index: SymbolIndexInfo | null;
    };

/**
 * Coins whose symbol or name contains `query`.
 *
 * On mainnet the symbol index answers first, since it holds every coin up to
 * its sync. A symbol too common to list still counts as a match: its coins
 * exist, and the index keeps only their count. The bounded live scan runs
 * only when the index has no match at all, which is what a coin published
 * after the sync looks like.
 */
export async function searchTokens(query: string): Promise<TokenSearch> {
  const index = symbolIndex();
  if (index) {
    const { exact, coins, unlisted } = index.search(query);
    if (coins.length > 0 || exact.status === "count_only" || unlisted.length > 0) {
      return {
        source: "symbol_index",
        tokens: coins,
        index: index.info,
        unlisted_exact_count: exact.status === "count_only" ? exact.count : null,
        unlisted_containing: unlisted,
      };
    }
  }
  const scan = await fetchDiscoveryTokens();
  const q = query.toLowerCase();
  return {
    source: "scan",
    tokens: scan.tokens.filter(
      (t) => t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q),
    ),
    truncated: scan.truncated,
    scanned: scan.scanned,
    ...(scan.failed ? { failed: scan.failed } : {}),
    index: index?.info ?? null,
  };
}

/**
 * Resolve a single token by symbol/name. Prefers exact symbol match.
 */
export async function resolveTokenBySymbol(query: string): Promise<TokenInfo | null> {
  const q = query.toLowerCase();

  // The curated registry decides first, and its "no" is load-bearing. Scanning
  // coin metadata and taking the first exact symbol match returns whichever
  // coin is indexed earliest, and for a popular symbol that can be an
  // impostor. Callers that need to distinguish "verified" from "found
  // something" should use resolveSymbolDetailed.
  const verified = resolveVerifiedSymbol(query);
  if (verified.status === "resolved") {
    return {
      coin_type: verified.coin.coin_type,
      name: verified.coin.name,
      symbol: verified.coin.symbol,
      decimals: verified.coin.decimals ?? 0,
    };
  }
  // Ambiguous among verified coins: refuse rather than pick. Several
  // legitimate coins share USDC on Sui, and choosing one silently misreports
  // which asset moved.
  if (verified.status === "ambiguous") return null;

  // The index lists every coin using the symbol up to its sync, so it can say
  // there is exactly one. Several is the same refusal as above.
  const indexed = symbolIndex()?.lookup(query);
  if (indexed?.status === "listed") return indexed.coins.length === 1 ? indexed.coins[0] : null;
  if (indexed?.status === "count_only") return null;

  return (await scanForSymbol(query)).token;
}

/**
 * Search on-chain CoinMetadata for a symbol.
 *
 * **Nothing here verifies anything.** A hit means some coin carries that
 * symbol, and many coins share a symbol with another. Callers must
 * present a result from this as unverified. `scan` is null when the answer
 * came from an earlier call's cache.
 */
async function scanForSymbol(
  query: string,
): Promise<{ token: TokenInfo; scan: ScanReport | null } | { token: null; scan: ScanReport }> {
  const q = query.toLowerCase();
  const symbolKey = `${getNetwork()}:${q}`;
  const hit = symbolCache.get(symbolKey);
  if (hit && Date.now() - hit.fetchedAt < TOKEN_CACHE_TTL_MS) return { token: hit.token, scan: null };

  // A completed scan for this network already has the answer.
  //
  // Exact symbol only, case-insensitive, never a name or symbol substring.
  // Resolving a symbol to an unrelated coin because some field contains the
  // query string is worse than not resolving it: the caller cannot tell a
  // real match from a coincidence, and reports the coincidence as an
  // identification. `searchTokens` is the substring search.
  const cached = tokenCache.get(getNetwork());
  if (cached && Date.now() - cached.fetchedAt < TOKEN_CACHE_TTL_MS) {
    const fromScan = cached.scan.tokens.find((t) => t.symbol.toLowerCase() === q);
    const report = { scanned: cached.scan.scanned, truncated: cached.scan.truncated };
    if (!fromScan) return { token: null, scan: report };
    symbolCache.set(symbolKey, { token: fromScan, fetchedAt: Date.now() });
    return { token: fromScan, scan: report };
  }

  // Otherwise stream pages and stop at the first exact symbol match, rather
  // than reading every CoinMetadata object on the network and then searching.
  // The full walk is hundreds of pages; the symbol being looked up is usually
  // a well-known token that appears early.
  // The callback assigns it, which control-flow analysis cannot see.
  let exact = null as TokenInfo | null;

  const scan = await pageCoinMetadata((batch) => {
    const hit = batch.find((t) => t.symbol.toLowerCase() === q);
    if (hit) {
      exact = hit;
      return true;
    }
    return false;
  });

  // No fuzzy fallback here: a page this walk covered that lacks an exact
  // symbol match is a "not found", not licence to substitute whatever else
  // that page happened to contain. `search_token` is the fuzzy tool.
  if (!exact) return { token: null, scan };
  symbolCache.set(symbolKey, { token: exact, fetchedAt: Date.now() });
  return { token: exact, scan };
}

/** `resolveSymbolDetailed`'s answer. */
export type SymbolDetail =
  | { status: "resolved"; token: TokenInfo; verified: true }
  | { status: "ambiguous"; source: "curated"; candidates: RegistryCoin[] }
  | {
      status: "ambiguous";
      source: "symbol_index";
      /** Coins using the symbol. Above the index's row limit `candidates` is empty. */
      count: number;
      candidates: IndexedCoin[];
      index: SymbolIndexInfo;
    }
  /** The only coin the index lists under the symbol. */
  | { status: "unverified"; source: "symbol_index"; token: TokenInfo; index: SymbolIndexInfo }
  /** The live scan's first exact match. `index` had no coin with this symbol; null off mainnet. */
  | { status: "unverified"; source: "scan"; token: TokenInfo; index: SymbolIndexInfo | null }
  | { status: "not_found"; scan: ScanReport; index: SymbolIndexInfo | null };

/**
 * Symbol resolution with the reason attached.
 *
 * `resolveTokenBySymbol` collapses everything to a coin or null, which cannot
 * distinguish "no such symbol" from "several coins claim it" from "found one,
 * but nothing verifies it". A tool reporting on an asset needs that
 * difference: the last case is where an impostor gets presented as the
 * answer.
 *
 * Order: the curated list, then the symbol index (mainnet), then the live
 * scan for a symbol the index does not have.
 */
export async function resolveSymbolDetailed(query: string): Promise<SymbolDetail> {
  const verified = resolveVerifiedSymbol(query);
  if (verified.status === "resolved") {
    return {
      status: "resolved",
      verified: true,
      token: {
        coin_type: verified.coin.coin_type,
        name: verified.coin.name,
        symbol: verified.coin.symbol,
        decimals: verified.coin.decimals ?? 0,
      },
    };
  }
  if (verified.status === "ambiguous") {
    return { status: "ambiguous", source: "curated", candidates: verified.candidates };
  }
  // Not curated. Whatever is found from here is unverified, so the caller
  // never presents a symbol match as an identification.
  const index = symbolIndex();
  const indexed = index?.lookup(query);
  if (index && indexed?.status === "listed") {
    if (indexed.coins.length === 1) {
      return { status: "unverified", source: "symbol_index", token: indexed.coins[0], index: index.info };
    }
    return {
      status: "ambiguous",
      source: "symbol_index",
      count: indexed.coins.length,
      candidates: indexed.coins,
      index: index.info,
    };
  }
  if (index && indexed?.status === "count_only") {
    return { status: "ambiguous", source: "symbol_index", count: indexed.count, candidates: [], index: index.info };
  }
  const found = await scanForSymbol(query);
  if (found.token === null) return { status: "not_found", scan: found.scan, index: index?.info ?? null };
  return { status: "unverified", source: "scan", token: found.token, index: index?.info ?? null };
}

/**
 * If input contains `::`, return as-is (it's a full coin type). Otherwise
 * resolve the symbol through `resolveTokenBySymbol`, which answers null for a
 * symbol several coins use.
 */
export async function resolveTokenType(
  symbolOrType: string,
): Promise<string | null> {
  const trimmed = symbolOrType.trim();
  if (trimmed.includes("::")) return trimmed;
  const match = await resolveTokenBySymbol(trimmed);
  return match?.coin_type ?? null;
}

// ---------------------------------------------------------------------------
// On-chain probe via gRPC
// ---------------------------------------------------------------------------

/**
 * Verify a full coin type on-chain and return its metadata.
 */
export async function probeOnChain(
  coinType: string,
): Promise<TokenInfo | null> {
  try {
    const { response } = await sui.stateService.getCoinInfo({ coinType });
    const meta = response.metadata;
    if (!meta) return null;
    return {
      coin_type: coinType,
      name: meta.name ?? "",
      symbol: meta.symbol ?? coinType.split("::").pop() ?? "",
      decimals: meta.decimals ?? 9,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pyth feed discovery via Hermes API (cached 24h)
// ---------------------------------------------------------------------------

const PYTH_HERMES_URL = "https://hermes.pyth.network";
const PYTH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface PythFeedEntry {
  id: string;
  attributes: { symbol?: string; base?: string; quote_currency?: string };
}

const pythFeedCache = new Map<
  string,
  { feedId: string | null; fetchedAt: number }
>();

/**
 * Extract the short symbol from a full coin type.
 * e.g. "0x2::sui::SUI" -> "SUI"
 */
function extractSymbol(coinType: string): string {
  const parts = coinType.split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : coinType;
}

/**
 * Resolve a Pyth feed ID for a given symbol by querying the Hermes API.
 * Picks the best match: exact `{SYMBOL}/USD` pattern preferred.
 */
export async function resolvePythFeedId(
  symbol: string,
): Promise<string | null> {
  const key = symbol.toUpperCase();
  const cached = pythFeedCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < PYTH_CACHE_TTL_MS) {
    return cached.feedId;
  }

  try {
    const resp = await fetch(
      `${PYTH_HERMES_URL}/v2/price_feeds?query=${encodeURIComponent(key)}&asset_type=crypto`,
      { signal: AbortSignal.timeout(EXTERNAL_HTTP_TIMEOUT_MS) },
    );
    if (!resp.ok) {
      pythFeedCache.set(key, { feedId: null, fetchedAt: Date.now() });
      return null;
    }

    const feeds = (await resp.json()) as PythFeedEntry[];
    if (feeds.length === 0) {
      pythFeedCache.set(key, { feedId: null, fetchedAt: Date.now() });
      return null;
    }

    // Prefer exact match on attributes.symbol = "Crypto.{SYMBOL}/USD"
    // or attributes.base = symbol and quote_currency = "USD"
    const exactMatch = feeds.find((f) => {
      const sym = f.attributes.symbol ?? "";
      return (
        sym.toUpperCase() === `CRYPTO.${key}/USD` ||
        (f.attributes.base?.toUpperCase() === key &&
          f.attributes.quote_currency?.toUpperCase() === "USD")
      );
    });

    const feedId = exactMatch?.id ?? feeds[0].id;
    pythFeedCache.set(key, { feedId, fetchedAt: Date.now() });
    return feedId;
  } catch {
    pythFeedCache.set(key, { feedId: null, fetchedAt: Date.now() });
    return null;
  }
}

/**
 * Batch-resolve Pyth feed IDs for an array of coin types.
 * Returns deduplicated feed IDs and a reverse map (feedId -> coinTypes[]).
 */
export async function buildPythFeedMap(
  coinTypes: string[],
): Promise<{ feedIds: string[]; reverseMap: Map<string, string[]> }> {
  // Deduplicate symbols
  const symbolToCoinTypes = new Map<string, string[]>();
  for (const ct of coinTypes) {
    const sym = extractSymbol(ct);
    const existing = symbolToCoinTypes.get(sym) ?? [];
    existing.push(ct);
    symbolToCoinTypes.set(sym, existing);
  }

  // Resolve all symbols in parallel
  const entries = await Promise.all(
    [...symbolToCoinTypes.entries()].map(async ([sym, cts]) => {
      const feedId = await resolvePythFeedId(sym);
      return { sym, cts, feedId };
    }),
  );

  const reverseMap = new Map<string, string[]>();
  for (const { cts, feedId } of entries) {
    if (feedId) {
      const existing = reverseMap.get(feedId) ?? [];
      existing.push(...cts);
      reverseMap.set(feedId, existing);
    }
  }

  return { feedIds: [...reverseMap.keys()], reverseMap };
}
