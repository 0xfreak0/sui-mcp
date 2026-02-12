import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const GQL_PAGE_SIZE = 50;
const DEFAULT_MAX_SCAN = 5000;
const MAX_SCAN_LIMIT = 50000;
const PAGE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// NFT Collection Registry
// ---------------------------------------------------------------------------

interface NftCollectionInfo {
  collection_type: string;
  name: string;
  slug: string;
}

const NFT_COLLECTION_REGISTRY: NftCollectionInfo[] = [
  {
    collection_type:
      "0x70361cdc41d44c2e1f9c30c81837f7cf08c9bf0eaf30d178000070fda9c58b83::gawblenz::Gawblen",
    name: "Gawblenz",
    slug: "gawblenz",
  },
  {
    collection_type:
      "0x9f48e186b1527bd164960a03f392c14669acfd1ef560fb6138ad0918e6e712a3::doonies::NFT",
    name: "Doonies",
    slug: "doonies",
  },
  {
    collection_type:
      "0x034c162f6b594cb5a1805264dd01ca5d80ce3eca6522e6ee37fd9ebfb9d3ddca::factory::PrimeMachin",
    name: "Prime Machin",
    slug: "prime-machin",
  },
];

function resolveCollectionType(name: string): string | null {
  const q = name.toLowerCase();
  const match = NFT_COLLECTION_REGISTRY.find(
    (c) => c.slug === q || c.name.toLowerCase().includes(q)
  );
  return match?.collection_type ?? null;
}

// ---------------------------------------------------------------------------
// In-Memory TTL Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedResult {
  result: string;
  timestamp: number;
}

const holderCache = new Map<string, CachedResult>();

function getCached(key: string): string | null {
  const entry = holderCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    holderCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key: string, result: string): void {
  holderCache.set(key, { result, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// Owner resolution types & helpers
// ---------------------------------------------------------------------------

interface OwnerNode {
  address?: {
    address?: string;
    asObject?: {
      owner?: OwnerNode;
      asMoveObject?: {
        contents?: { json?: { owner?: string } };
      };
    };
  };
}

interface NftObjectsPage {
  objects: {
    nodes: Array<{ owner?: OwnerNode }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

interface CoinObjectsPage {
  objects: {
    nodes: Array<{
      owner?: { address?: { address: string } };
      asMoveObject?: {
        contents?: { json?: { balance?: string } };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

// Resolves owner address for both directly-owned and kiosk-stored NFTs.
// Chain: NFT -> ObjectOwner(wrapper) -> ObjectOwner(kiosk) -> kiosk.contents.json.owner
function extractNftOwner(node: { owner?: OwnerNode }): string | null {
  const addr = node.owner?.address;
  // Direct AddressOwner (no asObject means it's a plain address, not an object ref)
  if (addr?.address && !addr.asObject) return addr.address;
  // ObjectOwner path: follow through wrapper to kiosk
  const inner = addr?.asObject?.owner?.address;
  // Wrapper owned by AddressOwner
  if (inner?.address && !inner.asObject) return inner.address;
  // Wrapper owned by ObjectOwner (kiosk) - read kiosk contents for owner field
  const kioskOwner =
    inner?.asObject?.asMoveObject?.contents?.json?.owner;
  if (kioskOwner) return kioskOwner;
  return null;
}

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

// NFT query with nested owner resolution for kiosk-stored NFTs.
// Resolves: AddressOwner directly, or ObjectOwner -> ObjectOwner -> Kiosk contents
const NFT_OBJECTS_QUERY = `
  query($type: String!, $first: Int, $after: String) {
    objects(filter: { type: $type }, first: $first, after: $after) {
      nodes {
        owner {
          ... on AddressOwner {
            address { address }
          }
          ... on ObjectOwner {
            address {
              asObject {
                owner {
                  ... on ObjectOwner {
                    address {
                      asObject {
                        asMoveObject { contents { json } }
                      }
                    }
                  }
                  ... on AddressOwner {
                    address { address }
                  }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const COIN_OBJECTS_QUERY = `
  query($type: String!, $first: Int, $after: String) {
    objects(filter: { type: $type }, first: $first, after: $after) {
      nodes {
        owner {
          ... on AddressOwner {
            address { address }
          }
        }
        asMoveObject {
          contents { json }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerHolderTools(server: McpServer) {
  server.tool(
    "get_nft_collection_holders",
    "Scan all objects of an NFT collection type, aggregate by owner, and return top holders ranked by count. Resolves kiosk-stored NFTs to the actual wallet owner. Accepts either a full Move type or a collection name from the built-in registry.",
    {
      collection_type: z
        .string()
        .optional()
        .describe(
          "Full Move type of the NFT (e.g. 0xabc::module::NFT). Optional if collection_name is provided."
        ),
      collection_name: z
        .string()
        .optional()
        .describe(
          "Collection name or slug to look up in the registry (e.g. 'gawblenz'). Optional if collection_type is provided."
        ),
      limit: z
        .number()
        .optional()
        .describe("Top N holders to return (default 20, max 100)"),
      max_scan: z
        .number()
        .optional()
        .describe("Max objects to scan (default 5000, max 50000)"),
    },
    async ({ collection_type, collection_name, limit, max_scan }) => {
      // Resolve collection type
      let resolvedType = collection_type;
      if (!resolvedType && collection_name) {
        resolvedType = resolveCollectionType(collection_name) ?? undefined;
        if (!resolvedType) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: `Collection "${collection_name}" not found in registry. Use collection_type with the full Move type instead.`,
                    known_collections: NFT_COLLECTION_REGISTRY.map((c) => ({
                      name: c.name,
                      slug: c.slug,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      }
      if (!resolvedType) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error:
                    "Either collection_type or collection_name must be provided.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const topN = Math.min(limit ?? 20, 100);
      const maxScan = Math.min(max_scan ?? DEFAULT_MAX_SCAN, MAX_SCAN_LIMIT);

      // Check cache
      const cacheKey = `nft:${resolvedType}:${maxScan}`;
      const cached = getCached(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        parsed.cached = true;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(parsed, null, 2) },
          ],
        };
      }

      const holderCounts = new Map<string, number>();
      let cursor: string | undefined;
      let totalScanned = 0;
      let truncated = false;

      while (totalScanned < maxScan) {
        const remaining = maxScan - totalScanned;
        const first = Math.min(GQL_PAGE_SIZE, remaining);

        const data = await gqlQuery<NftObjectsPage>(NFT_OBJECTS_QUERY, {
          type: resolvedType,
          first,
          after: cursor ?? undefined,
        });

        for (const node of data.objects.nodes) {
          const addr = extractNftOwner(node);
          if (addr) {
            holderCounts.set(addr, (holderCounts.get(addr) ?? 0) + 1);
          }
        }

        totalScanned += data.objects.nodes.length;

        if (!data.objects.pageInfo.hasNextPage) break;
        cursor = data.objects.pageInfo.endCursor ?? undefined;

        if (totalScanned >= maxScan) {
          truncated = true;
          break;
        }

        await sleep(PAGE_DELAY_MS);
      }

      const sorted = [...holderCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN);

      const topHolders = sorted.map(([address, count], i) => ({
        rank: i + 1,
        address,
        count,
      }));

      const result = {
        collection_type: resolvedType,
        total_scanned: totalScanned,
        unique_holders: holderCounts.size,
        truncated,
        cached: false,
        top_holders: topHolders,
      };

      setCache(cacheKey, JSON.stringify(result));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_token_top_holders",
    "Scan coin objects of a given type, aggregate balance by owner, and return top holders ranked by total balance.",
    {
      coin_type: z
        .string()
        .describe(
          "Coin type (e.g. 0x2::sui::SUI). Auto-wraps in 0x2::coin::Coin<...> if needed."
        ),
      limit: z
        .number()
        .optional()
        .describe("Top N holders to return (default 20, max 100)"),
      max_scan: z
        .number()
        .optional()
        .describe("Max coin objects to scan (default 5000, max 50000)"),
    },
    async ({ coin_type, limit, max_scan }) => {
      const topN = Math.min(limit ?? 20, 100);
      const maxScan = Math.min(max_scan ?? DEFAULT_MAX_SCAN, MAX_SCAN_LIMIT);

      // Auto-wrap in Coin<> if not already wrapped
      const fullType = coin_type.startsWith("0x2::coin::Coin<")
        ? coin_type
        : `0x2::coin::Coin<${coin_type}>`;

      // Check cache
      const cacheKey = `token:${fullType}:${maxScan}`;
      const cached = getCached(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        parsed.cached = true;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(parsed, null, 2) },
          ],
        };
      }

      const holderBalances = new Map<string, bigint>();
      const holderCounts = new Map<string, number>();
      let cursor: string | undefined;
      let totalScanned = 0;
      let truncated = false;

      while (totalScanned < maxScan) {
        const remaining = maxScan - totalScanned;
        const first = Math.min(GQL_PAGE_SIZE, remaining);

        const data = await gqlQuery<CoinObjectsPage>(COIN_OBJECTS_QUERY, {
          type: fullType,
          first,
          after: cursor ?? undefined,
        });

        for (const node of data.objects.nodes) {
          const addr = node.owner?.address?.address;
          const balanceStr = node.asMoveObject?.contents?.json?.balance;
          if (addr && balanceStr) {
            const bal = BigInt(balanceStr);
            holderBalances.set(
              addr,
              (holderBalances.get(addr) ?? 0n) + bal
            );
            holderCounts.set(addr, (holderCounts.get(addr) ?? 0) + 1);
          }
        }

        totalScanned += data.objects.nodes.length;

        if (!data.objects.pageInfo.hasNextPage) break;
        cursor = data.objects.pageInfo.endCursor ?? undefined;

        if (totalScanned >= maxScan) {
          truncated = true;
          break;
        }

        await sleep(PAGE_DELAY_MS);
      }

      const sorted = [...holderBalances.entries()]
        .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
        .slice(0, topN);

      const topHolders = sorted.map(([address, balance], i) => ({
        rank: i + 1,
        address,
        balance: balance.toString(),
        count: holderCounts.get(address) ?? 0,
      }));

      const result = {
        coin_type,
        total_scanned: totalScanned,
        unique_holders: holderBalances.size,
        truncated,
        cached: false,
        top_holders: topHolders,
      };

      setCache(cacheKey, JSON.stringify(result));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
