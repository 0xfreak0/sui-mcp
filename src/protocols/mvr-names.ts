import { getNetwork } from "../config.js";
import { reverseResolveBulk } from "../utils/mvr-client.js";

/**
 * Runtime protocol-name enrichment via the Move Registry.
 *
 * `src/data/protocols.json` is a hand-maintained map, so it is always behind
 * the chain: new protocols are missing, and — more insidiously — an existing
 * protocol that ships a package *upgrade* gets a brand-new package ID that the
 * map doesn't know, so decoding silently degrades to a raw 0x address with no
 * error and no signal. MVR closes that gap for packages whose teams registered
 * a name, which turns the static file into a curated override rather than the
 * only source of truth.
 *
 * Two deliberate constraints:
 *
 *   1. **Display only.** Curated entries carry a verified category (dex,
 *      lending, ...) that drives behaviour — most importantly whether fund
 *      tracing treats an address as a pass-through. An MVR name is just a
 *      string someone registered, so it must never widen a trust decision.
 *      See `lookupProtocol` vs `lookupProtocolDisplay` in ./registry.ts.
 *   2. **Never on the critical path.** Lookups stay synchronous and read only
 *      this cache. Callers opportunistically prefetch before a decode loop; if
 *      they don't, or MVR is down, decoding behaves exactly as it did before
 *      this module existed.
 *
 * This module deliberately knows nothing about the curated registry — that
 * dependency runs one way, `registry.ts` → here, so the two don't import each
 * other. `registry.prefetchProtocolNames` is the entry point callers should
 * use; it filters out curated IDs before delegating here.
 */

// Keyed `${network}:${packageId}` — package IDs are network-specific, and a
// single process serves calls for several networks. A cached `null` means
// "asked MVR, not registered" and suppresses re-querying a known-absent ID.
const nameCache = new Map<string, string | null>();

const key = (packageId: string) => `${getNetwork()}:${packageId}`;

/** MVR name for a package if one has been fetched, else null. Never blocks. */
export function getMvrName(packageId: string): string | null {
  return nameCache.get(key(packageId)) ?? null;
}

/**
 * Resolve any of `packageIds` not already cached and add them to the cache.
 * Best-effort: MVR being unavailable is not an error worth failing a tool call
 * over, since every consumer degrades to the raw address.
 *
 * Prefer `registry.prefetchProtocolNames`, which strips curated IDs first.
 */
export async function prefetchMvrNames(packageIds: Iterable<string>): Promise<void> {
  const pending = new Set<string>();
  for (const id of packageIds) {
    if (!id) continue;
    if (nameCache.has(key(id))) continue;
    pending.add(id);
  }
  if (pending.size === 0) return;

  const ids = [...pending];
  try {
    const resolved = await reverseResolveBulk(ids);
    for (const id of ids) nameCache.set(key(id), resolved.get(id) ?? null);
  } catch {
    // Leave the ids uncached rather than poisoning them with null: a transient
    // MVR outage shouldn't permanently mark a registered package as unknown for
    // the life of the process.
  }
}

/** Test seam — drops every cached entry across all networks. */
export function clearMvrNameCache(): void {
  nameCache.clear();
}
