import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { sui } from "../clients/grpc.js";
import { batchResolveNames } from "../utils/names.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const GQL_PAGE_SIZE = 50;
const DEFAULT_MAX_SCAN = 5000;
const MAX_SCAN_LIMIT = 50000;
const PAGE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

function extractNftOwner(node: { owner?: OwnerNode }): string | null {
  const addr = node.owner?.address;
  if (addr?.address && !addr.asObject) return addr.address;
  const inner = addr?.asObject?.owner?.address;
  if (inner?.address && !inner.asObject) return inner.address;
  const kioskOwner =
    inner?.asObject?.asMoveObject?.contents?.json?.owner;
  if (kioskOwner) return kioskOwner;
  return null;
}

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

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
// Shared helper: scan token top holders
// ---------------------------------------------------------------------------

export interface TokenHolder {
  rank: number;
  address: string;
  balance: string;
  count: number;
}

export interface TokenHolderResult {
  holders: TokenHolder[];
  total_scanned: number;
  unique_holders: number;
  truncated: boolean;
}

export async function scanTokenTopHolders(
  coinType: string,
  topN: number,
  maxScan: number,
): Promise<TokenHolderResult> {
  const fullType = coinType.startsWith("0x2::coin::Coin<")
    ? coinType
    : `0x2::coin::Coin<${coinType}>`;

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
        holderBalances.set(addr, (holderBalances.get(addr) ?? 0n) + bal);
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

  const holders = sorted.map(([address, balance], i) => ({
    rank: i + 1,
    address,
    balance: balance.toString(),
    count: holderCounts.get(address) ?? 0,
  }));

  return { holders, total_scanned: totalScanned, unique_holders: holderBalances.size, truncated };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerHolderTools(server: McpServer) {
  server.tool(
    "get_top_holders",
    "(Advanced — slow, paginated scan) Scan objects of a given type and return top holders. Works for NFT collections (ranked by count) or tokens (ranked by balance). Resolves kiosk-stored NFTs to actual wallet owner. Use list_nft_collections to discover collection types. Results cached 24h.",
    {
      type: z
        .string()
        .describe(
          "Full Move type of the NFT or coin type (e.g. '0xabc::module::NFT' or '0x2::sui::SUI'). Auto-wraps coins in Coin<...> if needed."
        ),
      mode: z
        .enum(["nft", "token"])
        .optional()
        .describe("'nft' ranks by count, 'token' ranks by balance. Auto-detected from type if omitted (Coin<...> = token, otherwise nft)."),
      limit: z
        .number()
        .optional()
        .describe("Top N holders to return (default 20, max 100)"),
      max_scan: z
        .number()
        .optional()
        .describe("Max objects to scan (default 5000, max 50000)"),
    },
    async ({ type: resolvedType, mode, limit, max_scan }) => {
      const topN = Math.min(limit ?? 20, 100);
      const maxScan = Math.min(max_scan ?? DEFAULT_MAX_SCAN, MAX_SCAN_LIMIT);

      // Auto-detect mode: if it looks like a coin type, use token mode
      const effectiveMode = mode ?? (
        resolvedType.includes("::coin::Coin<") || resolvedType.includes("::sui::SUI") || resolvedType.includes("::usdc::USDC")
          ? "token"
          : "nft"
      );

      const cacheKey = `${effectiveMode}:${resolvedType}:${maxScan}`;
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

      if (effectiveMode === "token") {
        const scan = await scanTokenTopHolders(resolvedType, topN, maxScan);

        // Fetch total supply and resolve names in parallel
        const [supplyResult, nameMap] = await Promise.all([
          sui.stateService
            .getCoinInfo({ coinType: resolvedType })
            .then(({ response }) => response.treasury?.totalSupply?.toString() ?? null)
            .catch(() => null),
          batchResolveNames(scan.holders.map((h) => h.address)),
        ]);

        const totalSupply = supplyResult ? BigInt(supplyResult) : null;

        const enrichedHolders = scan.holders.map((h) => ({
          ...h,
          name: nameMap.get(h.address) ?? null,
          percentage:
            totalSupply && totalSupply > 0n
              ? `${(Number(BigInt(h.balance)) / Number(totalSupply) * 100).toFixed(4)}%`
              : null,
        }));

        const result = {
          mode: "token",
          type: resolvedType,
          total_supply: supplyResult,
          total_scanned: scan.total_scanned,
          unique_holders: scan.unique_holders,
          truncated: scan.truncated,
          cached: false,
          top_holders: enrichedHolders,
        };
        setCache(cacheKey, JSON.stringify(result));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      }

      // NFT mode
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

      // Resolve SuiNS names for top holders
      const nameMap = await batchResolveNames(sorted.map(([addr]) => addr));

      const topHolders = sorted.map(([address, count], i) => ({
        rank: i + 1,
        address,
        name: nameMap.get(address) ?? null,
        count,
      }));

      const result = {
        mode: "nft",
        type: resolvedType,
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
}
