import { z } from "zod";
import { numArg } from "./args.js";
import { getNetwork } from "../config.js";
import { gqlQuery } from "../clients/graphql.js";
import { sui } from "../clients/grpc.js";
import { batchResolveNames } from "../utils/names.js";
import { errorResult } from "../utils/errors.js";
import { resolveCollectionType, knownSlugs } from "../discovery-nft.js";
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

/** How an owner address was arrived at. The two are not equally trustworthy. */
export type OwnerSource = "address" | "kiosk_declared";

/**
 * Resolve the holder of one NFT node.
 *
 * `Kiosk.owner` is a **self-declared, mutable field**, not the cap that
 * controls the kiosk. `set_owner`/`set_owner_custom` write it, and nothing
 * updates it when the `KioskOwnerCap` is transferred, so after a cap changes
 * hands it still names whoever set it last.
 *
 * Measured on mainnet over 300 sampled KioskOwnerCaps, comparing each cap's
 * real holder against the `owner` field of the kiosk it controls: **121
 * disagreed, 40.3%**. The disagreement concentrates — one address is declared
 * by 82 different kiosks. Merging that into the holder list unmarked
 * manufactures a top holder out of a platform address and makes an ownership
 * ranking wrong in the direction a reader will act on.
 *
 * A production Sui NFT indexer resolves this with a five-step waterfall and
 * does NOT use this field at any step: address owner, then PersonalKioskCap,
 * then the latest SALE BUYER for that NFT, then the MINT TRANSACTION SENDER,
 * and only then the kiosk id itself tagged as a kiosk rather than a wallet.
 * Steps three and four are the ones that actually carry a regular kiosk, and
 * both need an indexed sale and mint history that a per-call server does not
 * have — `trace_object_history` answers it for ONE object, not for a scan.
 *
 * So the field is still used, because it is the only owner hint available
 * without a query per kiosk and it is right about 60% of the time, and every
 * entry it produces says so.
 */
function extractNftOwner(node: { owner?: OwnerNode }): { address: string; source: OwnerSource } | null {
  const addr = node.owner?.address;
  if (addr?.address && !addr.asObject) return { address: addr.address, source: "address" };
  const inner = addr?.asObject?.owner?.address;
  if (inner?.address && !inner.asObject) return { address: inner.address, source: "address" };
  const kioskOwner = inner?.asObject?.asMoveObject?.contents?.json?.owner;
  // The json blob is untyped, so a non-string here would become a Map key and
  // land in the holder list verbatim.
  if (typeof kioskOwner === "string" && kioskOwner) {
    return { address: kioskOwner, source: "kiosk_declared" };
  }
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
          ... on ConsensusAddressOwner {
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
                  ... on ConsensusAddressOwner {
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

/**
 * Does even one `Coin<T>` exist for this type?
 *
 * Used only to settle an auto-detected mode. A coin type and an NFT type have
 * the same `0xpkg::module::Struct` shape, so nothing in the string separates
 * `0xabc::suipump::SUIPUMP` from a collection — and guessing wrong scanned a
 * real memecoin as NFTs and reported `unique_holders: 0`, which reads as "this
 * has no holders" rather than "this was looked up as the wrong kind of thing".
 * Coins are held as `0x2::coin::Coin<T>`, never as bare `T`, so one object of
 * the wrapped type is proof.
 */
const COIN_PROBE_QUERY = `
  query($type: String!) {
    objects(filter: { type: $type }, first: 1) {
      nodes { address }
    }
  }
`;

async function looksLikeCoin(type: string): Promise<boolean | null> {
  try {
    const data = await gqlQuery<{ objects: { nodes: Array<{ address: string }> } }>(
      COIN_PROBE_QUERY,
      { type: `0x2::coin::Coin<${type}>` },
    );
    return (data.objects.nodes?.length ?? 0) > 0;
  } catch {
    // Null, not false. Returning false reinstated the very guess this probe
    // exists to correct, so one transient GraphQL error produced the original
    // bug — a coin scanned as a collection, reporting no holders — and now
    // labelled a complete ranking. It must never fail the tool either, so the
    // caller carries the uncertainty into the result instead.
    return null;
  }
}

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
  /**
   * Coin objects counted in `total_scanned` whose owner or balance could not be
   * read, so they are attributed to nobody. Absent when there were none.
   */
  unresolved_owners?: number;
}


/**
 * A truncated holder scan is a SAMPLE, and must not be presented as a ranking.
 *
 * The walk reads `objects(filter: Coin<T>)` in object-id order, which is
 * uncorrelated with balance. So a scan that stops early returns the largest
 * holder IT HAPPENED TO SEE, not the largest holder. Measured on SUI, the
 * reported "#1 holder" by scan depth:
 *
 *   max_scan 200  ->     66 SUI
 *   max_scan 400  ->    522 SUI
 *   max_scan 800  ->  3,454 SUI
 *   max_scan 5000 -> 25,000 SUI
 *
 * Zero of the top five at 200 survived to 800. The number climbs with effort
 * and never converges — the real top SUI holder holds millions. Ranking that
 * is not "approximately right", it is an artefact of how far the scan ran.
 *
 * So when the scan is truncated the result carries `sampled_holders` rather
 * than `top_holders`, with no rank and no percentage of supply. This follows
 * `find_shared_multisig`: refusing beats truncating, because a partial search
 * cannot support the claim the caller is asking for.
 */
function samplingCaveat(scanned: number, unique: number): string {
  return (
    `INCOMPLETE: this scan stopped after ${scanned} coin objects (${unique} distinct holders) and did not reach the end. ` +
    `Objects are walked in object-id order, which has nothing to do with balance, so these are the largest holders WITHIN THE SAMPLE and not the largest holders of this coin. ` +
    `Scanning further keeps finding bigger ones: on SUI the reported top holder went from 66 to 3,454 SUI between max_scan 200 and 800, with no overlap in the top five. ` +
    `Raise max_scan until "truncated" is false to get a real ranking — which is only feasible for coins with few enough objects to enumerate.`
  );
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
  // Coin objects whose owner or balance this query could not read. The NFT
  // walk counts these; dropping them here meant a holder could vanish from a
  // "complete ranking" whose percentages are computed against the real total
  // supply, with nothing saying a holder was missing.
  let unresolved = 0;
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
      } else {
        unresolved++;
      }
    }

    totalScanned += data.objects.nodes.length;

    if (!data.objects.pageInfo.hasNextPage) break;
    cursor = data.objects.pageInfo.endCursor ?? undefined;
    // A connection can claim another page and hand back a null cursor.
    // Without this the next request starts from page one and the SAME coin
    // objects are counted again, adding their balances twice to the same
    // holders. Missed by the sweep in #101 that guarded every other walk.
    //
    // It is a TRUNCATED stop, not a complete one: hasNextPage was true, so the
    // connection said there is more and then would not say where. Breaking
    // without setting the flag published a known-incomplete scan as a complete
    // ranking, with ranks and percentages of supply restored.
    if (!cursor) {
      truncated = true;
      break;
    }

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

  return {
    holders,
    total_scanned: totalScanned,
    unique_holders: holderBalances.size,
    truncated,
    ...(unresolved ? { unresolved_owners: unresolved } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerHolderTools(server: McpServer) {
  server.tool(
    "get_top_holders",
    "(Advanced — slow, paginated scan) Scan objects of a given type and return top holders. Works for NFT collections (ranked by count) or tokens (ranked by balance). Kiosk-stored NFTs are attributed using the kiosk's self-declared owner field, which is marked as such because it does not follow the KioskOwnerCap. Accepts a Move type, coin type, or collection name. Results cached 24h.",
    {
      type: z
        .string()
        .optional()
        .describe(
          "Full Move type of the NFT or coin type (e.g. '0xabc::module::NFT' or '0x2::sui::SUI'). Auto-wraps coins in Coin<...> if needed."
        ),
      collection_name: z
        .string()
        .optional()
        .describe(
          "NFT collection name or slug to look up in the registry (e.g. 'gawblenz'). Alternative to 'type'."
        ),
      mode: z
        .enum(["nft", "token"])
        .optional()
        .describe("'nft' ranks by count, 'token' ranks by balance. Auto-detected from type if omitted (Coin<...> = token, otherwise nft)."),
      limit: numArg()
        .optional()
        .describe("Top N holders to return (default 20, max 100)"),
      max_scan: numArg()
        .optional()
        .describe("Max objects to scan (default 5000, max 50000)"),
    },
    async ({ type: rawType, collection_name, mode, limit, max_scan }) => {
      let resolvedType = rawType;
      if (!resolvedType && collection_name) {
        // The collection registry is keyed by PACKAGE ID, and a package id is
        // derived from its publish transaction — so the same id off mainnet is
        // a different package or none at all. Resolving a name here anyway fed
        // a mainnet type into a testnet scan, which then found nothing and said
        // so as if the collection were empty. Same rule as coins.json and
        // protocols.json: off mainnet the answer is "not curated here".
        if (getNetwork() !== "mainnet") {
          return errorResult(
            `Collection names are curated for mainnet only, and a package id does not carry across networks, so "${collection_name}" cannot be resolved on ${getNetwork()}. Pass 'type' with the full Move type for this network.`,
          );
        }
        resolvedType = resolveCollectionType(collection_name) ?? undefined;
        if (!resolvedType) {
          const known = knownSlugs().join(", ");
          return errorResult(`Collection "${collection_name}" not found in registry. Known: ${known}. Use 'type' with the full Move type instead.`);
        }
      }
      if (!resolvedType) {
        return errorResult("Either 'type' or 'collection_name' must be provided.");
      }

      // Clamped at BOTH ends. `?? ` keeps a provided 0, so `max_scan: 0` left
      // the walk's condition false from the start: no request was made and the
      // empty result was reported as a complete ranking. A negative `limit`
      // reached `slice(0, topN)` and silently dropped the last holders.
      const topN = Math.min(Math.max(Math.trunc(limit ?? 20), 1), 100);
      const maxScan = Math.min(
        Math.max(Math.trunc(max_scan ?? DEFAULT_MAX_SCAN), 1),
        MAX_SCAN_LIMIT,
      );

      // Auto-detect mode. The string test catches the common shapes for free;
      // anything else is settled by asking the chain whether a Coin of this
      // type exists, because an arbitrary memecoin type looks exactly like a
      // collection type and defaulting to NFT scanned it as one and reported no
      // holders. An explicit `mode` is always obeyed and never probed.
      const namedLikeCoin =
        resolvedType.includes("::coin::Coin<") ||
        resolvedType.includes("::sui::SUI") ||
        resolvedType.includes("::usdc::USDC");
      const probed = mode || namedLikeCoin ? null : await looksLikeCoin(resolvedType);
      const modeGuessed = probed === null && !mode && !namedLikeCoin;
      const effectiveMode = mode ?? (namedLikeCoin || probed === true ? "token" : "nft");

      // topN is part of the key because it is part of the answer: the cached
      // payload holds exactly `limit` holders, so serving a 20-holder entry to
      // a request for 100 silently returns the wrong list — and it looks like
      // the collection only has 20 holders rather than like a cache hit. The
      // network belongs in the key for the same reason a label does: the same
      // type on mainnet and testnet is a different set of holders.
      const cacheKey = `${getNetwork()}:${effectiveMode}:${resolvedType}:${maxScan}:${topN}`;
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

        // Same rule as the NFT branch: a walk that found nothing has not
        // ranked anything, and saying so beats a complete ranking of zero.
        if (scan.total_scanned === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    mode: "token",
                    type: resolvedType,
                    total_scanned: 0,
                    unique_holders: 0,
                    truncated: false,
                    complete_ranking: false,
                    cached: false,
                    caveat:
                      `No 0x2::coin::Coin<${resolvedType}> objects were found. That reads the same as a mistyped coin type, a coin that exists on another network, or an NFT collection type scanned as a coin — it is not evidence that the coin has no holders.`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

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

        // A complete scan is a ranking. A truncated one is a sample, and the
        // shape says so: no rank, no percentage of supply (a sampled balance
        // over a real denominator looks authoritative and means nothing).
        const result = scan.truncated
          ? {
              mode: "token",
              type: resolvedType,
              total_supply: supplyResult,
              total_scanned: scan.total_scanned,
              unique_holders: scan.unique_holders,
              truncated: true,
              complete_ranking: false,
              cached: false,
              caveat: samplingCaveat(scan.total_scanned, scan.unique_holders),
              ...(scan.unresolved_owners ? { unresolved_owners: scan.unresolved_owners } : {}),
              sampled_holders: enrichedHolders.map(({ rank: _rank, percentage: _pct, ...rest }) => rest),
            }
          : {
              mode: "token",
              type: resolvedType,
              total_supply: supplyResult,
              total_scanned: scan.total_scanned,
              unique_holders: scan.unique_holders,
              truncated: false,
              complete_ranking: true,
              cached: false,
              ...(scan.unresolved_owners
                ? {
                    unresolved_owners: scan.unresolved_owners,
                    caveat:
                      `${scan.unresolved_owners} of ${scan.total_scanned} coin objects have an owner or balance this tool could not read. They are attributed to nobody, so the percentages below are shares of total supply that do not account for them.`,
                  }
                : {}),
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
      // Objects whose owner the query could not resolve — a nesting shape
      // `extractNftOwner` does not unwrap, or an owner kind it does not read.
      // Dropping these silently understates the supply the holder counts are a
      // share of, and makes "could not resolve an owner" look like "nobody
      // holds it". Measured on one mainnet collection: 4 of 2,555.
      let unresolvedOwners = 0;
      // How many of each holder's NFTs were attributed from a kiosk's declared
      // owner rather than read from the object's own owner. Kept per holder
      // because the wrongness concentrates: one mainnet address is declared by
      // 82 kiosks, so an unmarked count would put it at the top of a ranking
      // it does not belong in.
      const kioskDeclared = new Map<string, number>();
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
          const owner = extractNftOwner(node);
          if (owner) {
            holderCounts.set(owner.address, (holderCounts.get(owner.address) ?? 0) + 1);
            if (owner.source === "kiosk_declared") {
              kioskDeclared.set(owner.address, (kioskDeclared.get(owner.address) ?? 0) + 1);
            }
          } else {
            unresolvedOwners++;
          }
        }

        totalScanned += data.objects.nodes.length;

        if (!data.objects.pageInfo.hasNextPage) break;
        cursor = data.objects.pageInfo.endCursor ?? undefined;
        // Same trap as the token scan: a null cursor here restarts the walk
        // and double-counts owners. It stops the scan short of the end, so it
        // is truncation rather than completion.
        if (!cursor) {
          truncated = true;
          break;
        }

        if (totalScanned >= maxScan) {
          truncated = true;
          break;
        }

        await sleep(PAGE_DELAY_MS);
      }


      // Nothing was found. That is "could not look at anything of this type" —
      // a typo, a collection that lives on another network, or a coin type
      // scanned as a collection — and reporting it as a finished ranking of
      // zero holders states the opposite of what is known. Not cached: the next
      // caller should get a real attempt.
      if (totalScanned === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  mode: effectiveMode,
                  type: resolvedType,
                  total_scanned: 0,
                  unique_holders: 0,
                  truncated: false,
                  complete_ranking: false,
                  cached: false,
                  caveat:
                    `No objects of type ${resolvedType} were found${effectiveMode === "nft" ? "" : " (searched as 0x2::coin::Coin<" + resolvedType + ">)"}. ` +
                    `This is not a statement that the type has no holders: it reads the same as a mistyped type, a type that exists on another network, or the wrong mode for this type. ` +
                    (modeGuessed
                      ? "The mode could not be verified because the coin probe failed, so this may be a coin scanned as a collection — pass mode explicitly. "
                      : "Pass mode explicitly if you know which this is. "),
                },
                null,
                2,
              ),
            },
          ],
        };
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
        // Named the way the production indexer names it, so the two can be
        // compared without translating vocabulary.
        holder_kind: kioskDeclared.get(address) ? "kiosk_declared" : "wallet",
        ...(kioskDeclared.get(address)
          ? { from_kiosk_owner_field: kioskDeclared.get(address) }
          : {}),
      }));
      const kioskAttributed = [...kioskDeclared.values()].reduce((a, b) => a + b, 0);
      const kioskCaveat = kioskAttributed
        ? `${kioskAttributed} of ${totalScanned} objects are held in kiosks and attributed using the kiosk's own \`owner\` field (\`from_kiosk_owner_field\` per holder). That field is set by the kiosk and is NOT updated when the KioskOwnerCap is transferred: measured over 300 mainnet kiosks, it disagreed with the actual cap holder 40% of the time, and one address was declared by 82 different kiosks. Confirm any holder carrying this before treating it as one party: the reliable resolution for a regular kiosk is the NFT's latest sale buyer, or its mint transaction sender if it has never traded, which trace_object_history can give you for a single object.`
        : null;

      const result = truncated
        ? {
            mode: "nft",
            type: resolvedType,
            total_scanned: totalScanned,
            unique_holders: holderCounts.size,
            truncated: true,
            complete_ranking: false,
            cached: false,
            caveat:
              `INCOMPLETE: this scan stopped after ${totalScanned} objects (${holderCounts.size} distinct holders) and did not reach the end of the collection. ` +
              `Objects are walked in object-id order, not by how many anyone holds, so these are the biggest holders WITHIN THE SAMPLE and not the biggest holders of the collection. ` +
              `Raise max_scan until "truncated" is false for a real ranking.`,
            ...(unresolvedOwners ? { unresolved_owners: unresolvedOwners } : {}),
            ...(kioskCaveat
              ? { kiosk_attributed: kioskAttributed, kiosk_caveat: kioskCaveat }
              : {}),
            sampled_holders: topHolders.map(({ rank: _rank, ...rest }) => rest),
          }
        : {
            mode: "nft",
            type: resolvedType,
            total_scanned: totalScanned,
            unique_holders: holderCounts.size,
            truncated: false,
            // The walk reached the end, which is what this flag means. An
            // object whose owner could not be read is a separate caveat, and it
            // belongs in its own field: no value of max_scan can clear it, so
            // folding it in here left the flag permanently false for the
            // collection while a ranked list sat beside it saying otherwise.
            complete_ranking: true,
            cached: false,
            ...(kioskCaveat
              ? { kiosk_attributed: kioskAttributed, kiosk_caveat: kioskCaveat }
              : {}),
            ...(unresolvedOwners
              ? {
                  unresolved_owners: unresolvedOwners,
                  caveat:
                    `The whole collection was scanned, but ${unresolvedOwners} of ${totalScanned} objects have an owner this tool could not resolve. ` +
                    `Those objects are counted in total_scanned and attributed to nobody, so holder counts are a ranking of the rest and do not sum to supply.`,
                }
              : {}),
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
