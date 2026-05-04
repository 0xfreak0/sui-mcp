import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { registerCollection } from "../discovery-nft.js";
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

const KIOSK_FIELDS_QUERY = `query($kioskId: SuiAddress!, $cursor: String) {
  object(address: $kioskId) {
    dynamicFields(first: 50, after: $cursor) {
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

/**
 * Scan a single kiosk's dynamic fields via GraphQL. Returns one entry per
 * `kiosk::Item` (skipping `kiosk::Lock` boolean entries). Each entry already
 * carries display + raw struct contents — no follow-up object fetch needed.
 */
async function scanKioskItems(kioskId: string, opts: { withDetails: boolean }): Promise<NftEntry[]> {
  const items: NftEntry[] = [];
  let cursor: string | null = null;
  do {
    const data: KioskFieldsResponse = await gqlQuery<KioskFieldsResponse>(KIOSK_FIELDS_QUERY, { kioskId, cursor });
    const conn = data.object?.dynamicFields;
    if (!conn) break;
    for (const node of conn.nodes) {
      if (!node.name.type.repr.includes(KIOSK_ITEM_TYPE_SUBSTR)) continue;
      if (node.value.__typename !== "MoveObject") continue;
      const objectId = node.value.address;
      const contents = node.value.contents;
      const collection = contents?.type.repr ?? "unknown";
      if (collection !== "unknown") registerCollection(collection);
      if (!opts.withDetails) {
        items.push({
          object_id: objectId,
          type: collection,
          collection,
          kiosk_id: kioskId,
          name: null,
          description: null,
          image_url: null,
          content: null,
        });
        continue;
      }
      const display = pickDisplay(contents?.display?.output ?? null, contents?.json);
      items.push({
        object_id: objectId,
        type: collection,
        collection,
        kiosk_id: kioskId,
        name: display.name,
        description: display.description,
        image_url: display.image_url,
        content: contents?.json ?? null,
      });
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return items;
}

const DIRECT_OBJECTS_QUERY = `query($owner: SuiAddress!, $cursor: String, $withDetails: Boolean!) {
  address(address: $owner) {
    objects(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        address
        contents {
          type { repr }
          json @include(if: $withDetails)
          display @include(if: $withDetails) { output }
        }
      }
    }
  }
}`;

interface DirectObjectsResponse {
  address: {
    objects: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        address: string;
        contents: {
          type: { repr: string };
          json?: unknown;
          display?: { output: Record<string, unknown> | null } | null;
        } | null;
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
 * Fetch directly-owned (non-kiosk) objects. Excludes coins, KioskOwnerCaps,
 * and staked SUI. Walks pages until the limit is hit.
 */
async function listDirectNfts(owner: string, max: number, withDetails: boolean): Promise<NftEntry[]> {
  const out: NftEntry[] = [];
  let cursor: string | null = null;
  while (out.length < max) {
    const data: DirectObjectsResponse = await gqlQuery<DirectObjectsResponse>(DIRECT_OBJECTS_QUERY, {
      owner,
      cursor,
      withDetails,
    });
    const conn = data.address?.objects;
    if (!conn) break;
    for (const node of conn.nodes) {
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
      if (out.length >= max) break;
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    if (!cursor) break;
  }
  return out;
}

export function registerNftTools(server: McpServer) {
  server.tool(
    "list_nfts",
    "(Recommended for NFTs) List NFTs owned by a wallet, including kiosk-stored NFTs. Returns display metadata (name, description, image URL) and raw Move struct contents inline. Backed by GraphQL — single query per kiosk, no fullnode rate-limit risk. Use list_nft_collections for a cheaper count-only summary.",
    {
      address: z.string().describe("Owner wallet address (0x...)"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Max NFTs to return (default 50, max 200)"),
    },
    async ({ address, limit }) => {
      const effectiveLimit = Math.min(Math.max(limit ?? 50, 1), 200);

      // Step 1: Discover kiosks (1 GraphQL query, paginated).
      const kioskIds = await discoverKiosks(address);

      // Step 2: Scan each kiosk's items in parallel — one query per kiosk page.
      // GraphQL public endpoint tolerates parallel queries; a wallet with 43
      // kiosks fires 43 requests, far below the gRPC fan-out the old impl had.
      const kioskScans = await Promise.allSettled(
        kioskIds.map((id) => scanKioskItems(id, { withDetails: true })),
      );
      const allKioskNfts: NftEntry[] = [];
      for (const r of kioskScans) {
        if (r.status === "fulfilled") allKioskNfts.push(...r.value);
      }

      // Step 3: Take up to `limit` from kiosks first, then top up with direct-owned.
      const kioskSlice = allKioskNfts.slice(0, effectiveLimit);
      const remaining = effectiveLimit - kioskSlice.length;
      const directNfts = remaining > 0 ? await listDirectNfts(address, remaining, true) : [];
      const nfts = [...kioskSlice, ...directNfts];
      const truncated = allKioskNfts.length > kioskSlice.length;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address,
                nfts,
                total_found: nfts.length,
                kiosk_count: kioskIds.length,
                total_kiosk_nfts: allKioskNfts.length,
                truncated,
                ...(truncated && {
                  truncation_note:
                    "Result was capped by `limit`. Raise `limit` (max 200) or call list_nft_collections for a complete summary.",
                }),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "list_nft_collections",
    "Get a lightweight summary of NFT collections owned by a wallet. Walks kiosks plus direct-owned objects and returns deduplicated collection types with counts. Backed by GraphQL.",
    {
      address: z.string().describe("Owner wallet address (0x...)"),
    },
    async ({ address }) => {
      const kioskIds = await discoverKiosks(address);
      const [kioskScans, directNfts] = await Promise.all([
        Promise.allSettled(kioskIds.map((id) => scanKioskItems(id, { withDetails: false }))),
        listDirectNfts(address, 200, false),
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
