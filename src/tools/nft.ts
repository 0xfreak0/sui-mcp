import { z } from "zod";
import { numArg, addressArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { registerCollection } from "../discovery-nft.js";
import { clampPageSize } from "../utils/pagination.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// GraphQL returns canonical (zero-padded) addresses, so type checks use
// substring matches that work for both short and canonical forms.
const KIOSK_CAP_TYPE = "0x2::kiosk::KioskOwnerCap";
const KIOSK_CAP_TYPE_SUBSTR = "::kiosk::KioskOwnerCap";
const KIOSK_ITEM_TYPE_SUBSTR = "::kiosk::Item";
const STAKED_SUI_TYPE_SUBSTR = "::staking_pool::StakedSui";
const COIN_TYPE_SUBSTR = "::coin::Coin<";
// PersonalKioskCap wraps a KioskOwnerCap inside a `cap` field. The inner
// KioskOwnerCap is owned by the PersonalKioskCap object, NOT the user's
// address — so the address-filtered KioskOwnerCap query misses it. We must
// query PersonalKioskCap separately and dereference `cap.for` to get the
// underlying kiosk id.
const PERSONAL_KIOSK_CAP_TYPE =
  "0x0cb4bcc0560340eb1a1b929cabe56b33fc6449820ec8c1980d69bb98b649b802::personal_kiosk::PersonalKioskCap";
const PERSONAL_KIOSK_CAP_TYPE_SUBSTR = "::personal_kiosk::PersonalKioskCap";

interface NftEntry {
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

const KIOSK_CAPS_QUERY = `query($owner: SuiAddress!, $cursor: String) {
  address(address: $owner) {
    objects(first: 50, after: $cursor, filter: { type: "${KIOSK_CAP_TYPE}" }) {
      pageInfo { hasNextPage endCursor }
      nodes { contents { json } }
    }
  }
}`;

const PERSONAL_KIOSK_CAPS_QUERY = `query($owner: SuiAddress!, $cursor: String) {
  address(address: $owner) {
    objects(first: 50, after: $cursor, filter: { type: "${PERSONAL_KIOSK_CAP_TYPE}" }) {
      pageInfo { hasNextPage endCursor }
      nodes { contents { json } }
    }
  }
}`;

interface KioskCapsResponse {
  address: {
    objects: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ contents: { json: { for?: string } } | null }>;
    };
  } | null;
}

interface PersonalKioskCapsResponse {
  address: {
    objects: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ contents: { json: { cap?: { for?: string } } } | null }>;
    };
  } | null;
}

async function discoverKiosks(owner: string): Promise<string[]> {
  const ids = new Set<string>();

  // Standard KioskOwnerCap (directly address-owned)
  let cursor: string | null = null;
  do {
    const data: KioskCapsResponse = await gqlQuery<KioskCapsResponse>(KIOSK_CAPS_QUERY, { owner, cursor });
    const conn = data.address?.objects;
    if (!conn) break;
    for (const node of conn.nodes) {
      const forField = node.contents?.json?.for;
      if (typeof forField === "string") ids.add(forField);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  // PersonalKioskCap (wraps a KioskOwnerCap; kiosk id is at cap.for)
  cursor = null;
  do {
    const data: PersonalKioskCapsResponse = await gqlQuery<PersonalKioskCapsResponse>(
      PERSONAL_KIOSK_CAPS_QUERY,
      { owner, cursor },
    );
    const conn = data.address?.objects;
    if (!conn) break;
    for (const node of conn.nodes) {
      const forField = node.contents?.json?.cap?.for;
      if (typeof forField === "string") ids.add(forField);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

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
async function scanKioskPage(
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
  return true;
}

/**
 * Walk directly-owned (non-kiosk) objects until at least `target` NFTs are
 * collected or the address is exhausted. Excludes coins, KioskOwnerCaps,
 * PersonalKioskCaps, and staked SUI. Stops at exactly `target`: when it fills
 * mid-page, the next cursor is the last kept object's edge cursor. Returning
 * the whole page would send every NFT on it, SVG images included, for
 * `limit: 1`.
 */
async function listDirectNftsPage(
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

// ---------------------------------------------------------------------------
// Cursor encoding for resumable list_nfts
// ---------------------------------------------------------------------------

interface ListNftsCursor {
  v: 1;
  // Kiosk IDs captured at first call. Stored on the cursor so subsequent
  // pages don't re-discover (which protects ordering if the wallet mints
  // a new kiosk mid-pagination).
  kiosks: string[];
  // Index of the kiosk currently being scanned. When >= kiosks.length we're
  // past the kiosk phase and into direct-owned.
  ki: number;
  // GraphQL cursor inside the current kiosk's dynamicFields connection.
  // null = start of that kiosk.
  kc: string | null;
  // GraphQL cursor for direct-owned objects pagination. Only consulted once
  // ki >= kiosks.length.
  dc: string | null;
  // Kiosks the wallet had in total. The cursor carries only the kiosks not
  // yet drained, so this keeps kiosk_count whole across pages.
  n?: number;
}

/** Drained kiosks are dropped from the cursor; `ki` then restarts at the first kept one. */
function encodeCursor(c: ListNftsCursor): string {
  const rest = { ...c, kiosks: c.kiosks.slice(c.ki), ki: 0, n: c.n ?? c.kiosks.length };
  return Buffer.from(JSON.stringify(rest)).toString("base64url");
}

function decodeCursor(s: string): ListNftsCursor {
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as ListNftsCursor;
    if (parsed.v !== 1 || !Array.isArray(parsed.kiosks) || typeof parsed.ki !== "number") {
      throw new Error("malformed cursor");
    }
    return parsed;
  } catch (err) {
    throw new Error(`invalid cursor: ${(err as Error).message}`);
  }
}

export function registerNftTools(server: McpServer) {
  server.tool(
    "list_nfts",
    "(Recommended for NFTs) List NFTs owned by a wallet, including kiosk-stored NFTs. Returns each NFT's id, collection (its struct type), kiosk, and display metadata (name, description, image URL); `detail: 'full'` adds the raw Move struct contents. Backed by GraphQL — single query per kiosk page, no fullnode rate-limit risk. Pagination: pass `cursor` from a prior response to fetch the next page; the response omits `next_cursor` when the wallet is fully enumerated. Returns at most `limit` NFTs. Use list_nft_collections for a cheaper count-only summary.",
    {
      address: addressArg().describe("Owner wallet address (0x...)"),
      limit: numArg()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Most NFTs to return (default 50, max 1000)."),
      cursor: z
        .string()
        .optional()
        .describe("Opaque pagination token from a prior response's `next_cursor`. Omit on first call."),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("'summary' (default): display fields only, and `omitted` counts the NFTs whose raw contents were left out. 'full' adds each NFT's raw Move struct contents."),
    },
    async ({ address, limit, cursor, detail }) => {
      const target = clampPageSize(limit);
      const buildResponse = (state: ListNftsCursor, nfts: NftEntry[], done: boolean) =>
        nftPage(address, state, nfts, done, detail === "full");

      // Initialize state: either resume from cursor or discover kiosks fresh.
      let state: ListNftsCursor;
      if (cursor) {
        state = decodeCursor(cursor);
      } else {
        const kiosks = await discoverKiosks(address);
        state = { v: 1, kiosks, ki: 0, kc: null, dc: null };
      }

      const nfts: NftEntry[] = [];

      // Phase 1: walk kiosks. Each iteration either fills the current kiosk's
      // remaining items or advances to the next kiosk.
      while (state.ki < state.kiosks.length && nfts.length < target) {
        const remaining = target - nfts.length;
        const kioskId = state.kiosks[state.ki];
        try {
          const { items, nextInnerCursor } = await scanKioskPage(kioskId, state.kc, remaining, true);
          nfts.push(...items);
          if (nextInnerCursor) {
            // Hit the target mid-kiosk; pause here. The next call resumes
            // exactly where we left off.
            state.kc = nextInnerCursor;
            return buildResponse(state, nfts, /*done*/ false);
          }
          // Kiosk drained — advance to the next one.
          state.ki += 1;
          state.kc = null;
        } catch {
          // Kiosk fetch failed (e.g. destroyed mid-pagination). Skip it
          // rather than wedging the entire walk.
          state.ki += 1;
          state.kc = null;
        }
      }

      // The target can land exactly on a kiosk boundary: the kiosk just
      // scanned drains with no remainder, so `nextInnerCursor` above is null
      // while kiosks the walk has not reached still sit in `state.kiosks`.
      // Unvisited kiosks mean more remains, so the page is not done, and no
      // extra query is needed to know it.
      if (state.ki < state.kiosks.length) {
        return buildResponse(state, nfts, /*done*/ false);
      }

      // Phase 2: walk direct-owned objects. Only entered after every kiosk is
      // drained. We rely on `state.dc` to resume across calls.
      //
      // Runs even when the target is already met by kiosks alone: the target
      // can also land exactly where the kiosks end, so the wallet is declared
      // fully enumerated only after checking that no direct-owned object
      // follows. With no budget left, this probes for one item without
      // keeping it or moving `state.dc`, so a `limit`-sized page never grows
      // and the probed item is picked up cleanly on the next real page.
      const remaining = target - nfts.length;
      const probing = remaining <= 0;
      const { items, nextCursor: nextDc } = await listDirectNftsPage(
        address,
        state.dc,
        probing ? 1 : remaining,
        !probing,
      );
      const moreDirect = probing ? items.length > 0 || nextDc !== null : nextDc !== null;
      if (!probing) nfts.push(...items);
      if (moreDirect) {
        if (!probing) state.dc = nextDc;
        return buildResponse(state, nfts, /*done*/ false);
      }
      state.dc = null;

      // Both phases drained.
      return buildResponse(state, nfts, /*done*/ true);
    },
  );

  server.tool(
    "list_nft_collections",
    "Get a lightweight summary of NFT collections owned by a wallet. Walks all kiosks plus direct-owned objects and returns deduplicated collection types with counts. Backed by GraphQL.",
    {
      address: addressArg().describe("Owner wallet address (0x...)"),
    },
    async ({ address }) => {
      const kioskIds = await discoverKiosks(address);
      const [kioskScans, directNfts] = await Promise.all([
        Promise.allSettled(kioskIds.map((id) => scanKioskAll(id, false))),
        listDirectNftsAll(address, false),
      ]);

      const counts = new Map<string, number>();
      const bump = (type: string) => counts.set(type, (counts.get(type) ?? 0) + 1);
      for (const r of kioskScans) {
        if (r.status === "fulfilled") {
          for (const item of r.value) bump(item.collection);
        }
      }
      for (const item of directNfts) bump(item.collection);

      const collections = Array.from(counts.entries())
        .map(([collection, count]) => ({ collection, count }))
        .sort((a, b) => b.count - a.count);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address,
                collections,
                total_collections: collections.length,
                total_nfts: collections.reduce((sum, c) => sum + c.count, 0),
                kiosk_count: kioskIds.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

/**
 * One page of list_nfts. A row's `collection` is its struct type, and fields
 * with no value are left out. The summary view leaves out raw contents and
 * counts them under `omitted`, naming the same call with detail: 'full'.
 */
function nftPage(
  address: string,
  state: ListNftsCursor,
  nfts: NftEntry[],
  done: boolean,
  full: boolean,
) {
  const withContent = nfts.filter((n) => n.content !== null).length;
  const rows = nfts.map((n) => ({
    object_id: n.object_id,
    collection: n.collection,
    ...(n.kiosk_id ? { kiosk_id: n.kiosk_id } : {}),
    ...(n.name !== null ? { name: n.name } : {}),
    ...(n.description !== null ? { description: n.description } : {}),
    ...(n.image_url !== null ? { image_url: n.image_url } : {}),
    ...(full && n.content !== null ? { content: n.content } : {}),
  }));
  const payload = {
    ...(!full && withContent
      ? {
          truncated: true,
          omitted: {
            content: { count: withContent },
            next_call: { tool: "list_nfts", repeat_with: { detail: "full" } },
          },
        }
      : {}),
    address,
    nfts: rows,
    page_size: nfts.length,
    kiosk_count: state.n ?? state.kiosks.length,
    ...(done ? {} : { next_cursor: encodeCursor(state) }),
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}
