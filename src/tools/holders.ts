import { z } from "zod";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { numArg } from "./args.js";
import { getNetwork } from "../config.js";
import { kioskOwnerVersion, loadKioskOwners } from "../utils/store.js";
import { gqlQuery } from "../clients/graphql.js";
import { sui } from "../clients/grpc.js";
import { batchResolveNames } from "../utils/names.js";
import { errorResult } from "../utils/errors.js";
import { resolveCollectionType, knownSlugs } from "../discovery-nft.js";
import { describeAddresses, type AddressKind } from "../utils/identity.js";
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
        contents?: { type?: { repr?: string }; json?: { owner?: unknown } };
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

/** One page of address-balance entries: dynamic fields of the accumulator root. */
interface AddressBalancePage {
  objects: {
    nodes: Array<{
      asMoveObject?: {
        contents?: { json?: { name?: { address?: string }; value?: { value?: string } } };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

/** How an owner address was arrived at. The two are not equally trustworthy. */
/**
 * The framework Kiosk, padded, so a short and a canonical spelling both match.
 * Full-type comparison is deliberate: suffix matching would hand an
 * impersonating package the kiosk path.
 */
const KIOSK_TYPE = `${normalizeSuiAddress("0x2")}::kiosk::Kiosk`;

/** Strip generics and pad the defining address before comparing. */
function baseType(t: string): string {
  const bare = t.split("<")[0]!.trim();
  const parts = bare.split("::");
  if (parts.length < 3) return bare;
  const [addr, ...rest] = parts;
  return [normalizeSuiAddress(addr!.toLowerCase()), ...rest].join("::");
}

export type OwnerSource = "address" | "kiosk_declared";

/**
 * Label a holder by the weakest evidence in its count.
 *
 * A holder whose NFTs all came one way is named for that way; anything with
 * more than one source is `mixed`, so a consumer filtering on this field never
 * treats a partly-inferred holding as fully chain-derived.
 */
function holderKind(
  total: number,
  declared: number,
  fromSale: number,
): "wallet" | "kiosk_declared" | "kiosk_resolved" | "mixed" {
  if (declared === 0 && fromSale === 0) return "wallet";
  if (declared === total) return "kiosk_declared";
  if (fromSale === total) return "kiosk_resolved";
  return "mixed";
}

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
function extractNftOwner(
  node: { owner?: OwnerNode },
): { address?: string; source: OwnerSource; kiosk_id?: string } | null {
  const addr = node.owner?.address;
  if (addr?.address && !addr.asObject) return { address: addr.address, source: "address" };
  const inner = addr?.asObject?.owner?.address;
  if (inner?.address && !inner.asObject) return { address: inner.address, source: "address" };
  // The parent has to BE a Kiosk. `inner.address` only says the grandparent is
  // some object, so treating that as a kiosk counted a Bag-held or
  // TableVec-held NFT as kiosk-held and inflated the denominator the kiosk
  // caveat is stated against. Matched in full, never by suffix — a package can
  // name its own module `kiosk` and its struct `Kiosk`.
  const parentType = inner?.asObject?.asMoveObject?.contents?.type?.repr;
  const isKiosk = !!parentType && baseType(parentType) === KIOSK_TYPE;
  const kioskId = isKiosk ? inner?.address : undefined;
  const kioskOwner = inner?.asObject?.asMoveObject?.contents?.json?.owner;
  // The json blob is untyped, so a non-string here would become a Map key and
  // land in the holder list verbatim.
  if (isKiosk && kioskId) {
    // A kiosk whose declared owner is unusable still has an id, and the store
    // may know who actually holds it. Discarding the id here threw away the
    // only thing that could have resolved it.
    return {
      ...(typeof kioskOwner === "string" && kioskOwner ? { address: kioskOwner } : {}),
      source: "kiosk_declared",
      kiosk_id: kioskId,
    };
  }
  if (isKiosk && typeof kioskOwner === "string" && kioskOwner) {
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
                      address
                      asObject {
                        asMoveObject { contents { type { repr } json } }
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

/** `0x2::coin::Coin<T>`, in the short or padded framework spelling. */
const COIN_WRAPPER = /^0x0*2::coin::Coin<(.+)>$/;

/**
 * The type of one owner's address balance of `T`.
 *
 * Address balances live as dynamic fields of the accumulator root (`0xacc`),
 * one per (owner, coin type), with the owner in `name.address` and the amount
 * in `value.value`. The owner is whatever address was credited, which can be an
 * object as well as a wallet. The service normalises the spelling of `T`
 * inside the filter, so a short or padded package address both match.
 */
function addressBalanceFieldType(coinType: string): string {
  return `0x2::dynamic_field::Field<0x2::accumulator::Key<0x2::balance::Balance<${coinType}>>,0x2::accumulator::U128>`;
}

/**
 * Is this type a coin?
 *
 * Used only to settle an auto-detected mode. A coin type and an NFT type have
 * the same `0xpkg::module::Struct` shape, so nothing in the string separates
 * `0xabc::suipump::SUIPUMP` from a collection — and guessing wrong scanned a
 * real memecoin as NFTs and reported `unique_holders: 0`, which reads as "this
 * has no holders" rather than "this was looked up as the wrong kind of thing".
 *
 * Any one of four objects is proof: a `Coin<T>`, an address-balance entry for
 * `T`, its `CoinMetadata<T>`, or its registry `Currency<T>`. The coin object
 * alone is not enough, because a coin can be held entirely in address balances
 * with no `Coin<T>` in existence (USAD on mainnet: the whole supply sits in one
 * owner's address balance), and probing only for coin objects scanned it as an
 * NFT collection with no holders. All four ask in one request.
 */
const COIN_PROBE_QUERY = `
  query($coin: String!, $addressBalance: String!, $metadata: String!, $currency: String!) {
    coin: objects(filter: { type: $coin }, first: 1) { nodes { address } }
    addressBalance: objects(filter: { type: $addressBalance }, first: 1) { nodes { address } }
    metadata: objects(filter: { type: $metadata }, first: 1) { nodes { address } }
    currency: objects(filter: { type: $currency }, first: 1) { nodes { address } }
  }
`;

type ProbeHits = Record<"coin" | "addressBalance" | "metadata" | "currency", { nodes?: unknown[] } | null>;

async function looksLikeCoin(type: string): Promise<boolean | null> {
  try {
    const data = await gqlQuery<ProbeHits>(COIN_PROBE_QUERY, {
      coin: `0x2::coin::Coin<${type}>`,
      addressBalance: addressBalanceFieldType(type),
      metadata: `0x2::coin::CoinMetadata<${type}>`,
      currency: `0x2::coin_registry::Currency<${type}>`,
    });
    return Object.values(data).some((hit) => (hit?.nodes?.length ?? 0) > 0);
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

const ADDRESS_BALANCE_QUERY = `
  query($type: String!, $first: Int, $after: String) {
    objects(filter: { type: $type }, first: $first, after: $after) {
      nodes {
        asMoveObject {
          contents { json }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/** Aliased `address.balance` reads per request, which keeps a query under the service's 5,000 bytes. */
const BALANCE_BATCH = 20;

export interface HolderBalance {
  balance: string;
  coin_balance: string | null;
  address_balance: string | null;
}

/**
 * Each address's whole balance of `coinType`, read directly.
 *
 * A truncated walk has seen only some of a holder's coin objects, so the sum
 * it built is a floor: XAGM's largest sampled holder summed to 9.1M of the
 * 24.1M it holds. The sample picks WHO to show; this says what each one holds.
 * An address whose read failed is absent from the map.
 */
export async function readHolderBalances(addresses: string[], coinType: string): Promise<Map<string, HolderBalance>> {
  const out = new Map<string, HolderBalance>();
  for (let i = 0; i < addresses.length; i += BALANCE_BATCH) {
    const chunk = addresses.slice(i, i + BALANCE_BATCH);
    const query =
      `query($t: String!, ${chunk.map((_, j) => `$a${j}: SuiAddress!`).join(", ")}) {\n` +
      chunk.map((_, j) => `  h${j}: address(address: $a${j}) { balance(coinType: $t) { totalBalance coinBalance addressBalance } }`).join("\n") +
      "\n}";
    const vars: Record<string, string> = { t: coinType };
    chunk.forEach((a, j) => (vars[`a${j}`] = a));
    try {
      const data = await gqlQuery<
        Record<string, { balance: { totalBalance: string; coinBalance: string | null; addressBalance: string | null } | null } | null>
      >(query, vars);
      chunk.forEach((a, j) => {
        const b = data[`h${j}`]?.balance;
        if (b) out.set(a, { balance: b.totalBalance, coin_balance: b.coinBalance, address_balance: b.addressBalance });
      });
    } catch {
      // Reported per holder as unavailable by the caller.
    }
  }
  return out;
}

/**
 * A truncated scan's holders as a sample: no rank, and what each one holds read
 * directly, since the walk saw only part of each holder's coins. The walk's own
 * sums stay beside it as `*_in_sample`. Ordered by the direct balance.
 */
export async function sampledHolders(holders: TokenHolder[], coinType: string) {
  const direct = await readHolderBalances(
    holders.map((h) => h.address),
    COIN_WRAPPER.exec(coinType)?.[1] ?? coinType,
  );
  return holders
    .map(({ rank: _rank, balance, coin_balance, address_balance, ...rest }) => {
      const read = direct.get(rest.address);
      return {
        ...rest,
        balance: read?.balance ?? null,
        coin_balance: read?.coin_balance ?? null,
        address_balance: read?.address_balance ?? null,
        balance_in_sample: balance,
        coin_balance_in_sample: coin_balance,
        address_balance_in_sample: address_balance,
        ...(read ? {} : { balance_unavailable: "The direct balance read failed; only the sampled sum is known." }),
      };
    })
    .sort((a, b) => {
      const x = a.balance === null ? -1n : BigInt(a.balance);
      const y = b.balance === null ? -1n : BigInt(b.balance);
      return y > x ? 1 : y < x ? -1 : 0;
    });
}

// ---------------------------------------------------------------------------
// Shared helper: scan token top holders
// ---------------------------------------------------------------------------

export interface TokenHolder {
  rank: number;
  address: string;
  /** Coin objects plus address balance, in base units. */
  balance: string;
  /** Held in `Coin<T>` objects. */
  coin_balance: string;
  /** Held in the owner's address balance, which no coin object shows. */
  address_balance: string;
  /** How many `Coin<T>` objects the holder owns. An address balance is not one. */
  count: number;
  /**
   * What lives at the holder's address. An address balance can be credited to
   * an object, such as a bridge's liquidity bank, so the largest holder of a
   * coin is not necessarily anyone's wallet.
   */
  owner_kind: AddressKind;
  /** Move type of the holder, when it is an object. */
  object_type?: string;
  name?: string;
}

export interface TokenHolderResult {
  holders: TokenHolder[];
  /** `coin_objects_scanned + address_balances_scanned`. */
  total_scanned: number;
  coin_objects_scanned: number;
  address_balances_scanned: number;
  unique_holders: number;
  /** Either walk stopped before the end. */
  truncated: boolean;
  coin_walk_truncated: boolean;
  address_balance_walk_truncated: boolean;
  /**
   * Coin objects or address-balance entries counted in `total_scanned` whose
   * owner or amount could not be read, so they are attributed to nobody.
   * Absent when there were none.
   */
  unresolved_owners?: number;
}


/** Which walk of a token scan stopped early, and how far it got, in words. */
export function stoppedWalks(scan: TokenHolderResult): string {
  return [
    ...(scan.coin_walk_truncated ? [`the coin-object walk after ${scan.coin_objects_scanned} objects`] : []),
    ...(scan.address_balance_walk_truncated
      ? [`the address-balance walk after ${scan.address_balances_scanned} entries`]
      : []),
  ].join(" and ");
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
function samplingCaveat(scan: TokenHolderResult): string {
  return (
    `INCOMPLETE: ${stoppedWalks(scan)} stopped before the end (${scan.unique_holders} distinct holders seen). ` +
    `Both are walked in object-id order, which has nothing to do with balance, so these are the largest holders WITHIN THE SAMPLE and not the largest holders of this coin. ` +
    `Scanning further keeps finding bigger ones: on SUI the reported top holder went from 66 to 3,454 SUI between max_scan 200 and 800, with no overlap in the top five. ` +
    `Each holder's balance, coin_balance and address_balance are read directly for that address, since the walk saw only some of its coins; balance_in_sample and count are what the walk saw. ` +
    `Raise max_scan until "truncated" is false to get a real ranking, which is only feasible for coins with few enough objects to enumerate.`
  );
}

/**
 * Walk one `objects(filter: { type })` connection up to `maxScan` nodes.
 *
 * Three ways it stops, and only one is completion:
 *
 * - `hasNextPage: false`, the end.
 * - A null `endCursor` beside `hasNextPage: true`. Without the guard the next
 *   request starts from page one and the SAME nodes are counted again, adding
 *   their balances twice to the same holders (missed by the sweep in #101). It
 *   is a truncated stop: the connection said there is more and would not say
 *   where, and breaking without the flag published a known-incomplete scan as
 *   a complete ranking.
 * - The `maxScan` budget.
 */
async function walkObjects<N>(
  query: string,
  type: string,
  maxScan: number,
  visit: (node: N) => void,
): Promise<{ scanned: number; truncated: boolean }> {
  let cursor: string | undefined;
  let scanned = 0;
  while (scanned < maxScan) {
    const data = await gqlQuery<{
      objects: { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } };
    }>(query, { type, first: Math.min(GQL_PAGE_SIZE, maxScan - scanned), after: cursor });

    for (const node of data.objects.nodes) visit(node);
    scanned += data.objects.nodes.length;

    if (!data.objects.pageInfo.hasNextPage) return { scanned, truncated: false };
    cursor = data.objects.pageInfo.endCursor ?? undefined;
    if (!cursor) break;
    if (scanned >= maxScan) break;
    await sleep(PAGE_DELAY_MS);
  }
  return { scanned, truncated: true };
}

/**
 * Rank a coin's holders by what they hold in `Coin<T>` objects AND in address
 * balances.
 *
 * An address balance is not an object the coin walk can see: it is a dynamic
 * field of the accumulator root, one per (owner, coin type). Walking coins alone
 * published `complete_ranking: true` for XAGM while leaving out its #2 holder,
 * 0xd70a55ed…, whose 5,494,449,074,000 base units (13.74% of supply) are all
 * in its address balance. So both walks run, each with its own `maxScan`
 * budget, and the ranking is complete only when both reached the end.
 */
export async function scanTokenTopHolders(
  coinType: string,
  topN: number,
  maxScan: number,
): Promise<TokenHolderResult> {
  const inner = COIN_WRAPPER.exec(coinType)?.[1] ?? coinType;

  const coinBalances = new Map<string, bigint>();
  const addressBalances = new Map<string, bigint>();
  const holderCounts = new Map<string, number>();
  // Coin objects whose owner or balance this query could not read. The NFT
  // walk counts these; dropping them here meant a holder could vanish from a
  // "complete ranking" whose percentages are computed against the real total
  // supply, with nothing saying a holder was missing.
  let unresolved = 0;

  const coins = await walkObjects<CoinObjectsPage["objects"]["nodes"][number]>(
    COIN_OBJECTS_QUERY,
    `0x2::coin::Coin<${inner}>`,
    maxScan,
    (node) => {
      const addr = node.owner?.address?.address;
      const balanceStr = node.asMoveObject?.contents?.json?.balance;
      if (!addr || !balanceStr) {
        unresolved++;
        return;
      }
      const holder = normalizeSuiAddress(addr);
      coinBalances.set(holder, (coinBalances.get(holder) ?? 0n) + BigInt(balanceStr));
      holderCounts.set(holder, (holderCounts.get(holder) ?? 0) + 1);
    },
  );

  const balances = await walkObjects<AddressBalancePage["objects"]["nodes"][number]>(
    ADDRESS_BALANCE_QUERY,
    addressBalanceFieldType(inner),
    maxScan,
    (node) => {
      const json = node.asMoveObject?.contents?.json;
      const addr = json?.name?.address;
      const value = json?.value?.value;
      if (!addr || !value) {
        unresolved++;
        return;
      }
      const holder = normalizeSuiAddress(addr);
      addressBalances.set(holder, (addressBalances.get(holder) ?? 0n) + BigInt(value));
    },
  );

  const totals = new Map<string, bigint>(coinBalances);
  for (const [holder, amount] of addressBalances) {
    totals.set(holder, (totals.get(holder) ?? 0n) + amount);
  }

  const sorted = [...totals.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .slice(0, topN);

  // Enrichment of the top N only. describeAddresses never throws.
  const identities = await describeAddresses(sorted.map(([address]) => address));

  const holders = sorted.map(([address, balance], i): TokenHolder => {
    const id = identities.get(address);
    return {
      rank: i + 1,
      address,
      balance: balance.toString(),
      coin_balance: (coinBalances.get(address) ?? 0n).toString(),
      address_balance: (addressBalances.get(address) ?? 0n).toString(),
      count: holderCounts.get(address) ?? 0,
      owner_kind: id?.kind ?? "wallet",
      ...(id?.object_type ? { object_type: id.object_type } : {}),
      ...(id?.name ? { name: id.name } : {}),
    };
  });

  return {
    holders,
    total_scanned: coins.scanned + balances.scanned,
    coin_objects_scanned: coins.scanned,
    address_balances_scanned: balances.scanned,
    unique_holders: totals.size,
    truncated: coins.truncated || balances.truncated,
    coin_walk_truncated: coins.truncated,
    address_balance_walk_truncated: balances.truncated,
    ...(unresolved ? { unresolved_owners: unresolved } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerHolderTools(server: McpServer) {
  server.tool(
    "get_top_holders",
    "(Advanced — slow, paginated scan) Scan objects of a given type and return top holders. Works for NFT collections (ranked by count) or tokens (ranked by balance, counting both Coin<T> objects and address balances, with the split and the holder's kind per holder). Kiosk-stored NFTs are attributed using the kiosk's self-declared owner field, which is marked as such because it does not follow the KioskOwnerCap. Accepts a Move type, coin type, or collection name. Results cached 24h.",
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
        .describe("'nft' ranks by count, 'token' ranks by balance. Auto-detected if omitted: a type the chain knows as a coin (a Coin<T> object, an address balance, coin metadata or a registry entry) is scanned as a token, anything else as an NFT collection."),
      limit: numArg()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Top N holders to return (default 20, max 100)"),
      max_scan: numArg()
        .int()
        .min(1)
        .max(50000)
        .optional()
        .describe("Max objects to scan per walk (default 5000, max 50000). Token mode walks Coin<T> objects and address-balance entries separately, each up to this bound."),
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
      // anything else is settled by asking the chain whether it knows this type
      // as a coin, because an arbitrary memecoin type looks exactly like a
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
      // The kiosk-owner table is part of the answer in NFT mode, so it is part
      // of the key. Without it, running get_nft_sales to resolve a scan's
      // kiosks — which this tool's own caveat instructs — changed nothing for
      // the 24 hours the previous payload stayed cached.
      const kioskVersion = effectiveMode === "nft" ? kioskOwnerVersion(getNetwork()) : "-";
      const cacheKey = `${getNetwork()}:${effectiveMode}:${resolvedType}:${maxScan}:${topN}:${kioskVersion}`;
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
                    coin_objects_scanned: 0,
                    address_balances_scanned: 0,
                    unique_holders: 0,
                    truncated: false,
                    complete_ranking: false,
                    cached: false,
                    caveat:
                      `No Coin<${resolvedType}> objects and no address balances of it were found. That reads the same as a mistyped coin type, a coin that exists on another network, or an NFT collection type scanned as a coin. It is not evidence that the coin has no holders.`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const supplyResult = await sui.stateService
          .getCoinInfo({ coinType: resolvedType })
          .then(({ response }) => response.treasury?.totalSupply?.toString() ?? null)
          .catch(() => null);

        const totalSupply = supplyResult ? BigInt(supplyResult) : null;

        const enrichedHolders = scan.holders.map((h) => ({
          ...h,
          name: h.name ?? null,
          percentage:
            totalSupply && totalSupply > 0n
              ? `${(Number(BigInt(h.balance)) / Number(totalSupply) * 100).toFixed(4)}%`
              : null,
        }));

        const scanned = {
          total_scanned: scan.total_scanned,
          coin_objects_scanned: scan.coin_objects_scanned,
          address_balances_scanned: scan.address_balances_scanned,
          unique_holders: scan.unique_holders,
        };

        // A complete scan is a ranking. A truncated one is a sample, and the
        // shape says so: no rank, no percentage of supply (a sampled balance
        // over a real denominator looks authoritative and means nothing).
        const sampled = scan.truncated ? await sampledHolders(scan.holders, resolvedType) : [];
        const result = scan.truncated
          ? {
              mode: "token",
              type: resolvedType,
              total_supply: supplyResult,
              ...scanned,
              truncated: true,
              coin_walk_truncated: scan.coin_walk_truncated,
              address_balance_walk_truncated: scan.address_balance_walk_truncated,
              complete_ranking: false,
              cached: false,
              caveat: samplingCaveat(scan),
              ...(scan.unresolved_owners ? { unresolved_owners: scan.unresolved_owners } : {}),
              sampled_holders: sampled,
            }
          : {
              mode: "token",
              type: resolvedType,
              total_supply: supplyResult,
              ...scanned,
              truncated: false,
              complete_ranking: true,
              cached: false,
              ...(scan.unresolved_owners
                ? {
                    unresolved_owners: scan.unresolved_owners,
                    caveat:
                      `${scan.unresolved_owners} of ${scan.total_scanned} coin objects and address-balance entries have an owner or amount this tool could not read. They are attributed to nobody, so the percentages below are shares of total supply that do not account for them.`,
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
      // Resolved from a sale record. Chain-derived, but a SNAPSHOT at the sale's
      // checkpoint, which may be months old and which a later kiosk sale would
      // have overtaken. Reporting it identically to an NFT read from its own
      // owner field would be the one unmarked weaker answer in the payload.
      const fromSale = new Map<string, number>();
      // Kiosk-held NFTs, held back from the counts until the store has had a
      // chance to name a real owner for them. Keyed by kiosk so one lookup
      // covers every NFT in it.
      const pendingKiosk: Array<{ kiosk_id?: string; declared?: string }> = [];
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
          if (!owner) {
            unresolvedOwners++;
          } else if (owner.source === "kiosk_declared") {
            pendingKiosk.push({
              ...(owner.kiosk_id ? { kiosk_id: owner.kiosk_id } : {}),
              ...(owner.address ? { declared: owner.address } : {}),
            });
          } else if (owner.address) {
            holderCounts.set(owner.address, (holderCounts.get(owner.address) ?? 0) + 1);
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

      // A marketplace sale names the buyer and the buyer's kiosk in one
      // record, so a kiosk seen trading has a chain-derived owner. That beats
      // the kiosk's own declared field, which does not follow the
      // KioskOwnerCap and disagrees 40% of the time. Populate the table with
      // get_nft_sales; this is a single store read whatever the scan's size.
      const resolved = loadKioskOwners(
        getNetwork(),
        [...new Set(pendingKiosk.map((p) => p.kiosk_id).filter((k): k is string => !!k))],
      );
      let kioskResolved = 0;
      let kioskUnresolved = 0;
      for (const p of pendingKiosk) {
        const real = p.kiosk_id ? resolved.get(p.kiosk_id) : undefined;
        const address = real ?? p.declared;
        if (!address) {
          // A kiosk with no resolvable owner at all: the store did not know it
          // and its declared field was unusable. Counted in its own field as
          // well as in unresolvedOwners, so the three kiosk numbers still sum
          // to kiosk_held — a reader checking that would otherwise find it
          // short with nothing saying why.
          kioskUnresolved++;
          unresolvedOwners++;
          continue;
        }
        holderCounts.set(address, (holderCounts.get(address) ?? 0) + 1);
        if (real) {
          kioskResolved++;
          fromSale.set(address, (fromSale.get(address) ?? 0) + 1);
        } else {
          kioskDeclared.set(address, (kioskDeclared.get(address) ?? 0) + 1);
        }
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
        // Four values, because the three ways an owner is arrived at are not
        // equally strong and one address can hold NFTs by more than one of
        // them. `wallet` is read from the object itself; `kiosk_resolved` comes
        // from a sale record, chain-derived but a snapshot; `kiosk_declared` is
        // the kiosk's own mutable field. A holder owning three outright and one
        // through an unresolvable kiosk is `mixed`, not a guess outright — a
        // consumer filtering for verified holders would otherwise drop someone
        // three quarters verified. The counts below carry the split.
        holder_kind: holderKind(
          count,
          kioskDeclared.get(address) ?? 0,
          fromSale.get(address) ?? 0,
        ),
        ...(kioskDeclared.get(address)
          ? { from_kiosk_owner_field: kioskDeclared.get(address) }
          : {}),
        ...(fromSale.get(address) ? { from_sale_records: fromSale.get(address) } : {}),
      }));
      const kioskAttributed = [...kioskDeclared.values()].reduce((a, b) => a + b, 0);
      const kioskTotal = pendingKiosk.length;
      const kioskCaveat = kioskAttributed
        ? `${kioskAttributed} of ${totalScanned} objects are held in kiosks and attributed using the kiosk's own \`owner\` field (\`from_kiosk_owner_field\` per holder). That field is set by the kiosk and is NOT updated when the KioskOwnerCap is transferred: measured over 300 mainnet kiosks, it disagreed with the actual cap holder 40% of the time, and one address was declared by 82 different kiosks. Run get_nft_sales over a window covering these kiosks' trades to replace the guess with the buyer named in the sale itself.`
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
            ...(kioskTotal
              ? {
                  kiosk_held: kioskTotal,
                  kiosk_resolved_from_sales: kioskResolved,
                  kiosk_attributed: kioskAttributed,
                  ...(kioskUnresolved ? { kiosk_unresolved: kioskUnresolved } : {}),
                }
              : {}),
            ...(kioskCaveat ? { kiosk_caveat: kioskCaveat } : {}),
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
            ...(kioskTotal
              ? {
                  kiosk_held: kioskTotal,
                  kiosk_resolved_from_sales: kioskResolved,
                  kiosk_attributed: kioskAttributed,
                  ...(kioskUnresolved ? { kiosk_unresolved: kioskUnresolved } : {}),
                }
              : {}),
            ...(kioskCaveat ? { kiosk_caveat: kioskCaveat } : {}),
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
