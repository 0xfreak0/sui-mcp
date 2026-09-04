import { sui } from "./clients/grpc.js";
import { gqlQuery } from "./clients/graphql.js";
import { EXTERNAL_HTTP_TIMEOUT_MS, getNetwork } from "./config.js";

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
 * reading CoinMetadata objects until it turns up. Measured on mainnet: 637
 * pages / 31,850 coins in 45s *without* the delay below, and the connection had
 * not ended — the set is effectively unbounded and grows with every token
 * anyone mints. An uncapped `while (true)` here is a multi-minute stall on a
 * tool in the default profile, so the walk is bounded and says when it stopped
 * early rather than presenting a partial answer as the whole set.
 */
const MAX_SCAN_PAGES = 60;

interface TokenScan {
  tokens: TokenInfo[];
  /** True when the page budget ran out with pages still outstanding. */
  truncated: boolean;
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
 * `onBatch` returning true stops the walk — which is what turns "resolve one
 * symbol" from a full-network crawl into a scan that ends as soon as the
 * symbol turns up. Returns whether the budget ran out with pages left.
 */
async function pageCoinMetadata(
  onBatch: (batch: TokenInfo[]) => boolean,
): Promise<{ truncated: boolean }> {
  let cursor: string | undefined;

  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    let data: CoinMetadataPage;
    try {
      data = await gqlQuery<CoinMetadataPage>(COIN_METADATA_QUERY, {
        first: GQL_PAGE_SIZE,
        after: cursor ?? undefined,
      });
    } catch {
      // A failed page ends the walk, and the caller is told it was cut short so
      // a partial list is never mistaken for the full set.
      return { truncated: true };
    }

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

    if (onBatch(batch)) return { truncated: false };
    if (!data.objects.pageInfo.hasNextPage) return { truncated: false };
    cursor = data.objects.pageInfo.endCursor ?? undefined;
    await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  return { truncated: true };
}

async function doFetchDiscoveryTokens(): Promise<TokenScan> {
  const tokens: TokenInfo[] = [];
  const { truncated } = await pageCoinMetadata((batch) => {
    tokens.push(...batch);
    return false;
  });
  return { tokens, truncated };
}

/**
 * The full (bounded) token list for the current network.
 *
 * A truncated scan is cached like any other, because re-running a 60-page walk
 * per call is worse than reusing a partial one — but `truncated` travels with
 * it so callers can say the set is incomplete. Previously a scan cut short by
 * an error was cached as if complete for six hours.
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
      if (scan.tokens.length > 0) tokenCache.set(key, { scan, fetchedAt: Date.now() });
      return scan;
    })
    .finally(() => {
      fetchInProgress.delete(key);
    });
  fetchInProgress.set(key, p);
  return p;
}

export async function searchTokens(query: string): Promise<TokenInfo[]> {
  const { tokens } = await fetchDiscoveryTokens();
  const q = query.toLowerCase();
  return tokens.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.symbol.toLowerCase().includes(q),
  );
}

/**
 * Resolve a single token by symbol/name. Prefers exact symbol match.
 */
export async function resolveTokenBySymbol(query: string): Promise<TokenInfo | null> {
  const q = query.toLowerCase();

  const symbolKey = `${getNetwork()}:${q}`;
  const hit = symbolCache.get(symbolKey);
  if (hit && Date.now() - hit.fetchedAt < TOKEN_CACHE_TTL_MS) return hit.token;

  // A completed scan for this network already has the answer.
  const cached = tokenCache.get(getNetwork());
  if (cached && Date.now() - cached.fetchedAt < TOKEN_CACHE_TTL_MS) {
    const fromScan = matchToken(cached.scan.tokens, q);
    if (fromScan) symbolCache.set(symbolKey, { token: fromScan, fetchedAt: Date.now() });
    return fromScan;
  }

  // Otherwise stream pages and stop at the first exact symbol match, rather
  // than reading every CoinMetadata object on the network and then searching.
  // Measured on mainnet, the full walk is 600+ pages and climbing; the symbol
  // being looked up is usually a well-known token that appears early.
  let exact: TokenInfo | null = null;
  const seen: TokenInfo[] = [];

  await pageCoinMetadata((batch) => {
    seen.push(...batch);
    const hit = batch.find((t) => t.symbol.toLowerCase() === q);
    if (hit) {
      exact = hit;
      return true;
    }
    return false;
  });

  // Fall back to a fuzzy match over whatever the walk covered. The corpus is
  // deliberately not cached — it is a partial view, and caching it would make a
  // later exact match unreachable for six hours — but the resolved answer is.
  const resolved: TokenInfo | null = exact ?? matchToken(seen, q);
  if (resolved) symbolCache.set(symbolKey, { token: resolved, fetchedAt: Date.now() });
  return resolved;
}

/** Exact symbol first, then a name/symbol substring. */
function matchToken(tokens: TokenInfo[], q: string): TokenInfo | null {
  return (
    tokens.find((t) => t.symbol.toLowerCase() === q) ??
    tokens.find(
      (t) => t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q),
    ) ??
    null
  );
}

/**
 * If input contains `::`, return as-is (it's a full coin type).
 * Otherwise resolve the symbol via on-chain CoinMetadata.
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
