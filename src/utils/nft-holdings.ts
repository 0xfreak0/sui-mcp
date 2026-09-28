/**
 * What NFTs a wallet holds: the items in every kiosk it controls, and the
 * NFT-like objects it owns directly.
 */
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";
import { registerCollection } from "../discovery-nft.js";
import { canonicalType } from "./nft-sales.js";

// GraphQL returns canonical (zero-padded) addresses, so type checks use
// substring matches that work for both short and canonical forms.
const KIOSK_CAP_TYPE = "0x2::kiosk::KioskOwnerCap";
const KIOSK_CAP_TYPE_SUBSTR = "::kiosk::KioskOwnerCap";
const KIOSK_ITEM_TYPE_SUBSTR = "::kiosk::Item";
const STAKED_SUI_TYPE_SUBSTR = "::staking_pool::StakedSui";
const COIN_TYPE_SUBSTR = "::coin::Coin<";
const PERSONAL_KIOSK_CAP_TYPE =
  "0x0cb4bcc0560340eb1a1b929cabe56b33fc6449820ec8c1980d69bb98b649b802::personal_kiosk::PersonalKioskCap";
const PERSONAL_KIOSK_CAP_TYPE_SUBSTR = "::personal_kiosk::PersonalKioskCap";
const OB_OWNER_TOKEN_TYPE = "0x95a441d389b07437d00dd07e0b6f05f513d7659b13fd7c5d3923c7d9d847199b::ob_kiosk::OwnerToken";
const OB_OWNER_TOKEN_TYPE_SUBSTR = "::ob_kiosk::OwnerToken";

/**
 * Objects an address holds that name a kiosk it controls, and where each
 * names it. A PersonalKioskCap wraps the KioskOwnerCap, so the cap is owned
 * by the wrapper and never by the address. An OriginByte kiosk keeps its own
 * cap and gives its owner an OwnerToken that names it.
 */
const KIOSK_KEYS: Array<{ type: string; kiosk: (json: Record<string, unknown>) => unknown }> = [
  { type: KIOSK_CAP_TYPE, kiosk: (j) => j.for },
  { type: PERSONAL_KIOSK_CAP_TYPE, kiosk: (j) => (j.cap as { for?: unknown } | null | undefined)?.for },
  { type: OB_OWNER_TOKEN_TYPE, kiosk: (j) => j.kiosk },
];

/** Whether an object of this type opens a kiosk, so its items are counted through {@link discoverKiosks}. */
export function isKioskKey(type: string): boolean {
  const t = canonicalType(type);
  return KIOSK_KEYS.some((k) => canonicalType(k.type) === t);
}

export interface NftEntry {
  object_id: string;
  type: string;
  collection: string;
  kiosk_id: string | null;
  name: string | null;
  description: string | null;
  image_url: string | null;
  content: unknown;
}

/**
 * Pull display fields out of either:
 *  - the rendered on-chain Display object (`value.contents.display.output`), preferred
 *  - the raw Move struct fields (`value.contents.json`), as fallback for NFTs without a Display
 */
function pickDisplay(
  display: Record<string, unknown> | null | undefined,
  rawJson: unknown,
): { name: string | null; description: string | null; image_url: string | null } {
  const out = { name: null as string | null, description: null as string | null, image_url: null as string | null };
  if (display && typeof display === "object") {
    if (typeof display.name === "string") out.name = display.name;
    if (typeof display.description === "string") out.description = display.description;
    for (const k of ["image_url", "img_url", "url", "thumbnail"]) {
      if (typeof display[k] === "string" && !out.image_url) out.image_url = display[k] as string;
    }
  }
  if ((!out.name || !out.description || !out.image_url) && rawJson && typeof rawJson === "object") {
    const j = rawJson as Record<string, unknown>;
    if (!out.name && typeof j.name === "string") out.name = j.name;
    if (!out.description && typeof j.description === "string") out.description = j.description;
    if (!out.image_url) {
      for (const k of ["image_url", "img_url", "url", "thumbnail"]) {
        if (typeof j[k] === "string") {
          out.image_url = j[k] as string;
          break;
        }
      }
    }
  }
  return out;
}

interface KioskKeysResponse {
  address: {
    objects: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ contents: { json: Record<string, unknown> } | null }>;
    };
  } | null;
}

/** Every kiosk the address controls, through any object in {@link KIOSK_KEYS}. */
export async function discoverKiosks(owner: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const key of KIOSK_KEYS) {
    const query = `query($owner: SuiAddress!, $cursor: String) {
  address(address: $owner) {
    objects(first: 50, after: $cursor, filter: { type: "${key.type}" }) {
      pageInfo { hasNextPage endCursor }
      nodes { contents { json } }
    }
  }
}`;
    let cursor: string | null = null;
    do {
      const data: KioskKeysResponse = await gqlQuery<KioskKeysResponse>(query, { owner, cursor });
      const conn = data.address?.objects;
      if (!conn) break;
      for (const node of conn.nodes) {
        const id = node.contents?.json ? key.kiosk(node.contents.json) : undefined;
        if (typeof id === "string") ids.add(id);
      }
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
  }
  return [...ids];
}

/** GraphQL's largest page. */
const GQL_PAGE = 50;

const KIOSK_FIELDS_QUERY = `query($kioskId: SuiAddress!, $cursor: String, $first: Int!) {
  object(address: $kioskId) {
    dynamicFields(first: $first, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name { type { repr } }
        value {
          __typename
          ... on MoveObject {
            address
            contents {
              type { repr }
              json
              display { output }
            }
          }
        }
      }
    }
  }
}`;

interface KioskFieldsResponse {
  object: {
    dynamicFields: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        name: { type: { repr: string } };
        value:
          | {
              __typename: "MoveObject";
              address: string;
              contents: {
                type: { repr: string };
                json: unknown;
                display: { output: Record<string, unknown> | null } | null;
              } | null;
            }
          | { __typename: "MoveValue" };
      }>;
    };
  } | null;
}

type KioskDynamicFieldNode = NonNullable<KioskFieldsResponse["object"]>["dynamicFields"]["nodes"][number];

function buildKioskNftEntry(
  node: KioskDynamicFieldNode,
  kioskId: string,
  withDetails: boolean,
): NftEntry | null {
  if (!node.name.type.repr.includes(KIOSK_ITEM_TYPE_SUBSTR)) return null;
  if (node.value.__typename !== "MoveObject") return null;
  const objectId = node.value.address;
  const contents = node.value.contents;
  const collection = contents?.type.repr ?? "unknown";
  if (collection !== "unknown") registerCollection(collection);
  if (!withDetails) {
    return {
      object_id: objectId,
      type: collection,
      collection,
      kiosk_id: kioskId,
      name: null,
      description: null,
      image_url: null,
      content: null,
    };
  }
  const display = pickDisplay(contents?.display?.output ?? null, contents?.json);
  return {
    object_id: objectId,
    type: collection,
    collection,
    kiosk_id: kioskId,
    name: display.name,
    description: display.description,
    image_url: display.image_url,
    content: contents?.json ?? null,
  };
}

/**
 * Walk a single kiosk's `dynamicFields` until at least `target` items are
 * collected or the kiosk is exhausted. Returns whatever the GraphQL page
 * boundary contained — may overshoot `target` (we don't break mid-page).
 *
 * `innerCursor` is the GraphQL cursor inside this kiosk; pass `null` to start
 * from the beginning. The returned `nextInnerCursor` is null when the kiosk
 * is fully drained.
 */
export async function scanKioskPage(
  kioskId: string,
  innerCursor: string | null,
  target: number,
  withDetails: boolean,
): Promise<{ items: NftEntry[]; nextInnerCursor: string | null }> {
  const items: NftEntry[] = [];
  let cursor = innerCursor;
  while (items.length < target) {
    // Nearly every field of a kiosk is an item, so asking for what is still
    // missing keeps a page at `target` instead of a fixed 50.
    const first = Math.min(GQL_PAGE, target - items.length);
    const data: KioskFieldsResponse = await gqlQuery<KioskFieldsResponse>(KIOSK_FIELDS_QUERY, { kioskId, cursor, first });
    const conn = data.object?.dynamicFields;
    if (!conn) {
      cursor = null;
      break;
    }
    for (const node of conn.nodes) {
      const entry = buildKioskNftEntry(node, kioskId, withDetails);
      if (entry) items.push(entry);
    }
    if (!conn.pageInfo.hasNextPage) {
      cursor = null;
      break;
    }
    cursor = conn.pageInfo.endCursor;
    // Another page claimed with no cursor restarts the walk, so the same items
    // would be collected again until the target filled with duplicates.
    if (!cursor) break;
  }
  return { items, nextInnerCursor: cursor };
}

/**
 * Drain a kiosk fully. Used by `list_nft_collections` where we always want
 * complete counts.
 */
async function scanKioskAll(kioskId: string, withDetails: boolean): Promise<NftEntry[]> {
  const out: NftEntry[] = [];
  let cursor: string | null = null;
  do {
    const { items, nextInnerCursor } = await scanKioskPage(kioskId, cursor, Number.POSITIVE_INFINITY, withDetails);
    out.push(...items);
    cursor = nextInnerCursor;
  } while (cursor);
  return out;
}

const DIRECT_OBJECTS_QUERY = `query($owner: SuiAddress!, $cursor: String, $withDetails: Boolean!) {
  address(address: $owner) {
    objects(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        cursor
        node {
          address
          contents {
            type { repr }
            json @include(if: $withDetails)
            display @include(if: $withDetails) { output }
          }
        }
      }
    }
  }
}`;

interface DirectObjectsResponse {
  address: {
    objects: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{
        cursor: string;
        node: {
          address: string;
          contents: {
            type: { repr: string };
            json?: unknown;
            display?: { output: Record<string, unknown> | null } | null;
          } | null;
        };
      }>;
    };
  } | null;
}

function isLikelyNft(typeRepr: string): boolean {
  if (typeRepr.includes(COIN_TYPE_SUBSTR)) return false;
  if (typeRepr.includes(STAKED_SUI_TYPE_SUBSTR)) return false;
  if (typeRepr.includes(KIOSK_CAP_TYPE_SUBSTR)) return false;
  if (typeRepr.includes(PERSONAL_KIOSK_CAP_TYPE_SUBSTR)) return false;
  if (typeRepr.includes(OB_OWNER_TOKEN_TYPE_SUBSTR)) return false;
  return true;
}

/**
 * Walk directly-owned (non-kiosk) objects until at least `target` NFTs are
 * collected or the address is exhausted. Excludes coins, KioskOwnerCaps,
 * PersonalKioskCaps, OriginByte OwnerTokens, and staked SUI. Stops at exactly `target`: when it fills
 * mid-page, the next cursor is the last kept object's edge cursor. Returning
 * the whole page would send every NFT on it, SVG images included, for
 * `limit: 1`.
 */
export async function listDirectNftsPage(
  owner: string,
  startCursor: string | null,
  target: number,
  withDetails: boolean,
): Promise<{ items: NftEntry[]; nextCursor: string | null }> {
  const out: NftEntry[] = [];
  let cursor = startCursor;
  while (out.length < target) {
    const data: DirectObjectsResponse = await gqlQuery<DirectObjectsResponse>(DIRECT_OBJECTS_QUERY, {
      owner,
      cursor,
      withDetails,
    });
    const conn = data.address?.objects;
    if (!conn) {
      cursor = null;
      break;
    }
    for (const [i, { node }] of conn.edges.entries()) {
      if (out.length >= target) {
        // Full mid-page: resume after the last object kept.
        return { items: out, nextCursor: conn.edges[i - 1].cursor };
      }
      const typeRepr = node.contents?.type.repr ?? "unknown";
      if (typeRepr === "unknown" || !isLikelyNft(typeRepr)) continue;
      registerCollection(typeRepr);
      if (!withDetails) {
        out.push({
          object_id: node.address,
          type: typeRepr,
          collection: typeRepr,
          kiosk_id: null,
          name: null,
          description: null,
          image_url: null,
          content: null,
        });
      } else {
        const display = pickDisplay(node.contents?.display?.output ?? null, node.contents?.json);
        out.push({
          object_id: node.address,
          type: typeRepr,
          collection: typeRepr,
          kiosk_id: null,
          name: display.name,
          description: display.description,
          image_url: display.image_url,
          content: node.contents?.json ?? null,
        });
      }
    }
    if (!conn.pageInfo.hasNextPage) {
      cursor = null;
      break;
    }
    cursor = conn.pageInfo.endCursor;
    // Another page claimed with no cursor restarts the walk, so the same items
    // would be collected again until the target filled with duplicates.
    if (!cursor) break;
  }
  return { items: out, nextCursor: cursor };
}

/**
 * Drain all directly-owned NFTs for an address. Used by `list_nft_collections`.
 */
async function listDirectNftsAll(owner: string, withDetails: boolean): Promise<NftEntry[]> {
  const { items } = await listDirectNftsPage(owner, null, Number.POSITIVE_INFINITY, withDetails);
  return items;
}

export interface HeldCollections {
  /** Items held per collection type. */
  counts: Map<string, number>;
  /** Of `counts`, the items the wallet owns directly rather than in a kiosk. */
  direct: Map<string, number>;
  kiosk_count: number;
  /** Kiosks whose items could not be read, so their items are missing from `counts`. */
  kiosks_unread: number;
}

/** A wallet's holdings are re-read after this long, so the calls one request makes share one walk. */
const HOLDINGS_CACHE_MS = 60_000;
const holdingsCache = new Map<string, { at: number; value: Promise<HeldCollections> }>();

/** Test seam: forget every cached walk. */
export function clearHeldCollections(): void {
  holdingsCache.clear();
}

/** Every collection a wallet holds, with counts, across all its kiosks and its directly owned objects. */
export function readHeldCollections(owner: string): Promise<HeldCollections> {
  const key = `${getNetwork()}:${normalizeSuiAddress(owner)}`;
  const hit = holdingsCache.get(key);
  if (hit && Date.now() - hit.at < HOLDINGS_CACHE_MS) return hit.value;
  const value = (async (): Promise<HeldCollections> => {
    const kioskIds = await discoverKiosks(owner);
    const [kioskScans, directNfts] = await Promise.all([
      Promise.allSettled(kioskIds.map((id) => scanKioskAll(id, false))),
      listDirectNftsAll(owner, false),
    ]);
    const counts = new Map<string, number>();
    const direct = new Map<string, number>();
    const bump = (map: Map<string, number>, type: string) => map.set(type, (map.get(type) ?? 0) + 1);
    let kiosksUnread = 0;
    for (const r of kioskScans) {
      if (r.status === "fulfilled") for (const item of r.value) bump(counts, item.collection);
      else kiosksUnread++;
    }
    for (const item of directNfts) {
      bump(counts, item.collection);
      bump(direct, item.collection);
    }
    return { counts, direct, kiosk_count: kioskIds.length, kiosks_unread: kiosksUnread };
  })();
  value.catch(() => holdingsCache.delete(key));
  holdingsCache.set(key, { at: Date.now(), value });
  return value;
}
