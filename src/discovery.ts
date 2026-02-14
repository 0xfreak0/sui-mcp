import { sui } from "./clients/grpc.js";
import { gqlQuery } from "./clients/graphql.js";

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

let tokenCache: { tokens: TokenInfo[]; fetchedAt: number } | null = null;
let fetchInProgress: Promise<TokenInfo[]> | null = null;

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

async function doFetchDiscoveryTokens(): Promise<TokenInfo[]> {
  const tokens: TokenInfo[] = [];
  let cursor: string | undefined;

  try {
    while (true) {
      const data = await gqlQuery<CoinMetadataPage>(COIN_METADATA_QUERY, {
        first: GQL_PAGE_SIZE,
        after: cursor ?? undefined,
      });

      for (const node of data.objects.nodes) {
        const contents = node.asMoveObject?.contents;
        const typeRepr = contents?.type?.repr;
        const json = contents?.json;
        if (!typeRepr || !json) continue;

        const coinType = extractCoinTypeFromMetadata(typeRepr);
        if (!coinType) continue;

        const symbol = json.symbol;
        if (!symbol) continue;

        tokens.push({
          coin_type: coinType,
          name: json.name ?? symbol,
          symbol,
          decimals: json.decimals ?? 9,
        });
      }

      if (!data.objects.pageInfo.hasNextPage) break;
      cursor = data.objects.pageInfo.endCursor ?? undefined;

      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
  } catch {
    // On partial failure, return what we got so far
  }

  return tokens;
}

async function fetchDiscoveryTokens(): Promise<TokenInfo[]> {
  if (tokenCache && Date.now() - tokenCache.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return tokenCache.tokens;
  }

  // Deduplicate concurrent callers — only one scan at a time
  if (fetchInProgress) return fetchInProgress;

  fetchInProgress = doFetchDiscoveryTokens()
    .then((tokens) => {
      if (tokens.length > 0) {
        tokenCache = { tokens, fetchedAt: Date.now() };
      }
      return tokenCache?.tokens ?? [];
    })
    .finally(() => {
      fetchInProgress = null;
    });

  return fetchInProgress;
}

/**
 * Search on-chain CoinMetadata by name/symbol (fuzzy, case-insensitive).
 */
export async function searchTokens(query: string): Promise<TokenInfo[]> {
  const tokens = await fetchDiscoveryTokens();
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
export async function resolveTokenBySymbol(
  query: string,
): Promise<TokenInfo | null> {
  const tokens = await fetchDiscoveryTokens();
  const q = query.toLowerCase();
  // Exact symbol match first
  const exact = tokens.find((t) => t.symbol.toLowerCase() === q);
  if (exact) return exact;
  // Then name or symbol contains
  return (
    tokens.find(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.symbol.toLowerCase().includes(q),
    ) ?? null
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
      { signal: AbortSignal.timeout(10_000) },
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
