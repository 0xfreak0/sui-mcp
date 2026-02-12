import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { protoValueToJson } from "../utils/proto.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function extractDisplay(content: unknown): Record<string, string | null> {
  const display: Record<string, string | null> = {
    name: null,
    description: null,
    image_url: null,
    project_url: null,
  };
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const c = content as Record<string, unknown>;
    if (typeof c.name === "string") display.name = c.name;
    if (typeof c.description === "string") display.description = c.description;
    // Check multiple possible image fields
    for (const field of ["image_url", "img_url", "url", "thumbnail"]) {
      if (typeof c[field] === "string" && !display.image_url) {
        display.image_url = c[field] as string;
      }
    }
    if (typeof c.project_url === "string") display.project_url = c.project_url;
  }
  return display;
}

const NFT_READ_MASK = {
  paths: ["object_id", "version", "digest", "object_type", "json"],
};

interface KioskInfo {
  kiosk_id: string;
  cap_id: string;
}

/**
 * Discover all kiosks owned by an address by finding KioskOwnerCap objects
 * and extracting the kiosk ID from their `for` field.
 */
async function discoverKiosks(address: string): Promise<KioskInfo[]> {
  const caps = await sui.listOwnedObjects({
    owner: address,
    type: "0x2::kiosk::KioskOwnerCap",
    limit: 50,
    cursor: null,
  });

  const results = await Promise.allSettled(
    caps.objects.map(async (cap) => {
      const { response } = await sui.ledgerService.getObject({
        objectId: cap.objectId,
        readMask: { paths: ["object_id", "json"] },
      });
      const content = protoValueToJson(response.object?.json);
      if (content && typeof content === "object" && !Array.isArray(content)) {
        const forField = (content as Record<string, unknown>).for;
        if (typeof forField === "string") {
          return { kiosk_id: forField, cap_id: cap.objectId };
        }
      }
      return null;
    })
  );

  const kiosks: KioskInfo[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      kiosks.push(result.value);
    }
  }
  return kiosks;
}

interface KioskNftEntry {
  object_id: string;
  field_id: string;
  collection: string;
  kiosk_id: string;
}

/**
 * Scan a kiosk's dynamic fields and return NFT items (filtering out Lock entries).
 * Resolves actual NFT object IDs from the wrapper field's `value`.
 */
async function scanKioskItems(kioskId: string): Promise<KioskNftEntry[]> {
  // First, collect all Item field IDs and their collection types
  const fieldEntries: { fieldId: string; collection: string }[] = [];
  let cursor: string | null = null;
  do {
    const res = await sui.listDynamicFields({
      parentId: kioskId,
      limit: 50,
      cursor,
    });
    for (const df of res.dynamicFields) {
      // kiosk::Item entries hold the NFTs; kiosk::Lock entries are bool locks
      if (df.type?.includes("kiosk::Item") && !df.valueType?.includes("bool")) {
        fieldEntries.push({
          fieldId: df.fieldId,
          collection: df.valueType ?? "unknown",
        });
      }
    }
    cursor = res.hasNextPage ? (res.cursor ?? null) : null;
  } while (cursor);

  // Resolve actual NFT object IDs by reading the wrapper field's `value`
  const results = await Promise.allSettled(
    fieldEntries.map(async (entry) => {
      const { response } = await sui.ledgerService.getObject({
        objectId: entry.fieldId,
        readMask: { paths: ["json"] },
      });
      const content = protoValueToJson(response.object?.json);
      let nftId = entry.fieldId; // fallback
      if (content && typeof content === "object" && !Array.isArray(content)) {
        const val = (content as Record<string, unknown>).value;
        if (typeof val === "string") nftId = val;
      }
      return {
        object_id: nftId,
        field_id: entry.fieldId,
        collection: entry.collection,
        kiosk_id: kioskId,
      };
    })
  );

  const items: KioskNftEntry[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      items.push(result.value);
    }
  }
  return items;
}

/**
 * Lightweight kiosk scan that only returns collection types (no NFT ID resolution).
 * Used by list_nft_collections where we only need type counts.
 */
async function scanKioskCollections(kioskId: string): Promise<string[]> {
  const collections: string[] = [];
  let cursor: string | null = null;
  do {
    const res = await sui.listDynamicFields({
      parentId: kioskId,
      limit: 50,
      cursor,
    });
    for (const df of res.dynamicFields) {
      if (df.type?.includes("kiosk::Item") && !df.valueType?.includes("bool")) {
        collections.push(df.valueType ?? "unknown");
      }
    }
    cursor = res.hasNextPage ? (res.cursor ?? null) : null;
  } while (cursor);
  return collections;
}

export function registerNftTools(server: McpServer) {
  server.tool(
    "list_nfts",
    "List NFTs owned by a wallet address, including kiosk-stored NFTs. Discovers kiosks via KioskOwnerCap, scans their contents, and also finds directly-owned non-coin objects. Returns display metadata like name, description, and image URL.",
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

      // Step 1 & 2: Discover kiosks and direct-owned non-coin objects in parallel
      const [kiosks, directRes] = await Promise.all([
        discoverKiosks(address),
        sui.listOwnedObjects({
          owner: address,
          limit: 200,
          cursor: null,
        }),
      ]);

      // Step 2b: Filter direct-owned objects to non-coins, non-KioskOwnerCap
      const directNfts = directRes.objects.filter(
        (obj) =>
          !obj.type?.includes("0x2::coin::Coin<") &&
          !obj.type?.includes("0x2::kiosk::KioskOwnerCap") &&
          !obj.type?.includes("0x3::staking_pool::StakedSui")
      );

      // Step 3: Scan all kiosks for NFT items in parallel
      const kioskResults = await Promise.allSettled(
        kiosks.map((k) => scanKioskItems(k.kiosk_id))
      );

      const allKioskNfts: KioskNftEntry[] = [];
      for (const result of kioskResults) {
        if (result.status === "fulfilled") {
          allKioskNfts.push(...result.value);
        }
      }

      // Step 4: Fetch full details for kiosk NFTs (up to limit)
      const kioskNftsToFetch = allKioskNfts.slice(0, effectiveLimit);
      const kioskNftDetails = await Promise.allSettled(
        kioskNftsToFetch.map(async (entry) => {
          try {
            const { response } = await sui.ledgerService.getObject({
              objectId: entry.object_id,
              readMask: NFT_READ_MASK,
            });
            const full = response.object;
            const content = protoValueToJson(full?.json);
            const display = extractDisplay(content);
            return {
              object_id: full?.objectId ?? entry.object_id,
              type: full?.objectType ?? entry.collection,
              collection: entry.collection,
              kiosk_id: entry.kiosk_id,
              name: display.name,
              description: display.description,
              image_url: display.image_url,
              content,
            };
          } catch {
            return {
              object_id: entry.object_id,
              type: entry.collection,
              collection: entry.collection,
              kiosk_id: entry.kiosk_id,
              name: null,
              description: null,
              image_url: null,
              content: null,
            };
          }
        })
      );

      const nfts: Record<string, unknown>[] = [];
      for (const result of kioskNftDetails) {
        if (result.status === "fulfilled") {
          nfts.push(result.value);
        }
      }

      // Also fetch details for direct-owned NFTs (fill remaining slots)
      const directSlots = Math.max(0, effectiveLimit - nfts.length);
      const directToFetch = directNfts.slice(0, directSlots);
      const directDetails = await Promise.allSettled(
        directToFetch.map(async (obj) => {
          try {
            const { response } = await sui.ledgerService.getObject({
              objectId: obj.objectId,
              readMask: NFT_READ_MASK,
            });
            const full = response.object;
            const content = protoValueToJson(full?.json);
            const display = extractDisplay(content);
            return {
              object_id: full?.objectId ?? obj.objectId,
              type: full?.objectType ?? obj.type ?? "unknown",
              collection: full?.objectType ?? obj.type ?? "unknown",
              kiosk_id: null,
              name: display.name,
              description: display.description,
              image_url: display.image_url,
              content,
            };
          } catch {
            return {
              object_id: obj.objectId,
              type: obj.type ?? "unknown",
              collection: obj.type ?? "unknown",
              kiosk_id: null,
              name: null,
              description: null,
              image_url: null,
              content: null,
            };
          }
        })
      );

      for (const result of directDetails) {
        if (result.status === "fulfilled") {
          nfts.push(result.value);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                address,
                nfts,
                total_found: nfts.length,
                kiosk_count: kiosks.length,
                total_kiosk_nfts: allKioskNfts.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "list_nft_collections",
    "Get a lightweight summary of NFT collections owned by a wallet. Discovers kiosks and returns deduplicated collection names with counts. Much cheaper than fetching full NFT details.",
    {
      address: z.string().describe("Owner wallet address (0x...)"),
    },
    async ({ address }) => {
      // Discover kiosks and direct-owned objects in parallel
      const [kiosks, directRes] = await Promise.all([
        discoverKiosks(address),
        sui.listOwnedObjects({
          owner: address,
          limit: 200,
          cursor: null,
        }),
      ]);

      // Scan all kiosks for collection types (lightweight, no ID resolution)
      const kioskResults = await Promise.allSettled(
        kiosks.map((k) => scanKioskCollections(k.kiosk_id))
      );

      // Count collections from kiosks
      const collectionCounts = new Map<string, number>();
      for (const result of kioskResults) {
        if (result.status === "fulfilled") {
          for (const collection of result.value) {
            collectionCounts.set(
              collection,
              (collectionCounts.get(collection) ?? 0) + 1
            );
          }
        }
      }

      // Count direct-owned non-coin objects as collections
      const directNfts = directRes.objects.filter(
        (obj) =>
          !obj.type?.includes("0x2::coin::Coin<") &&
          !obj.type?.includes("0x2::kiosk::KioskOwnerCap") &&
          !obj.type?.includes("0x3::staking_pool::StakedSui")
      );
      for (const obj of directNfts) {
        const type = obj.type ?? "unknown";
        collectionCounts.set(type, (collectionCounts.get(type) ?? 0) + 1);
      }

      const collections = Array.from(collectionCounts.entries())
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
                kiosk_count: kiosks.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

}
