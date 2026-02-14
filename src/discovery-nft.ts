import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const collectionsData = require("./data/nft-collections.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NftCollectionInfo {
  collection_type: string;
  name: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Registry: static seed + runtime discoveries
// ---------------------------------------------------------------------------

const registry = new Map<string, NftCollectionInfo>();

// Bootstrap from static JSON
for (const col of collectionsData.collections as NftCollectionInfo[]) {
  registry.set(col.collection_type, col);
}

/**
 * Extract a slug from a Move type string.
 * e.g. "0xabc::gawblenz::Gawblen" -> "gawblenz" (module name)
 */
function slugFromType(moveType: string): string {
  const parts = moveType.split("::");
  if (parts.length >= 2) {
    return parts[parts.length - 2].toLowerCase().replace(/_/g, "-");
  }
  return moveType.toLowerCase();
}

/**
 * Extract a display name from a Move type string.
 * e.g. "0xabc::gawblenz::Gawblen" -> "Gawblen" (struct name)
 */
function nameFromType(moveType: string): string {
  const parts = moveType.split("::");
  return parts[parts.length - 1] ?? moveType;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a collection type discovered at runtime (e.g. from kiosk scans).
 * No-op if already known. Auto-generates slug and name from the Move type.
 */
export function registerCollection(
  collectionType: string,
  name?: string,
): void {
  if (registry.has(collectionType)) return;
  registry.set(collectionType, {
    collection_type: collectionType,
    name: name ?? nameFromType(collectionType),
    slug: slugFromType(collectionType),
  });
}

/**
 * Resolve a collection name/slug to its full Move type.
 * Tries: exact slug match, then case-insensitive name/slug contains.
 */
export function resolveCollectionType(query: string): string | null {
  const q = query.toLowerCase();
  // Exact slug match
  for (const col of registry.values()) {
    if (col.slug === q) return col.collection_type;
  }
  // Fuzzy: name or slug contains
  for (const col of registry.values()) {
    if (
      col.name.toLowerCase().includes(q) ||
      col.slug.includes(q)
    ) {
      return col.collection_type;
    }
  }
  return null;
}

/**
 * Return all known collection slugs (for error messages).
 */
export function knownSlugs(): string[] {
  return [...registry.values()].map((c) => c.slug);
}

/**
 * Return full registry for inspection.
 */
export function getAllCollections(): NftCollectionInfo[] {
  return [...registry.values()];
}
