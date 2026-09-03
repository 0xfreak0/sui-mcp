import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";

/**
 * Package ID → the root of its upgrade lineage (the version-1 package ID).
 *
 * The problem this closes: a Sui upgrade mints a brand-new package ID, and a
 * `MoveCall` carries whichever version the caller used, so an exact-match
 * registry keyed on package IDs goes stale on every upgrade. Measured on
 * mainnet, Cetus's CLMM lineage is 14 versions deep and `src/data/protocols.json`
 * names two of them — including neither v12 nor v13, both of which were emitting
 * events at the time of writing.
 *
 * The root is the stable identity. It is the same for every version, past and
 * future, so identifying a package by its root turns a hand-maintained list of
 * versions into a list of protocols. It is also the ID that Move type tags carry
 * for any type declared in version 1, which is why type-shaped lookups tend to
 * hit the curated map directly with no resolution at all.
 *
 * Two constraints inherited from ./mvr-names.ts, for the same reasons:
 *
 *   1. **Never on the critical path.** {@link getPackageRoot} is synchronous and
 *      reads only this cache. Callers prefetch before a decode loop; skipping the
 *      prefetch degrades to exact-match identification, never to a blocking call.
 *   2. **Best-effort.** A GraphQL outage leaves IDs unresolved rather than
 *      failing the tool call, and leaves them *uncached* so the outage isn't
 *      sticky for the life of the process.
 *
 * Unlike an MVR name — a string anybody may register — a lineage is a fact the
 * chain enforces: only the holder of the `UpgradeCap` can add a version. So a
 * root-tier hit is as trustworthy as the curated entry it came from, and
 * `lookupProtocol` (which gates behaviour, not just wording) is allowed to use
 * it. See registry.ts.
 */

/**
 * Packages resolved per GraphQL request.
 *
 * The service rejects a request carrying more than 21 queries that "require
 * dedicated access to a backing store" — 21 aliases came back RESOURCE_EXHAUSTED
 * against mainnet — and separately caps the query payload at 5000 bytes. Twenty
 * aliased `packageVersions` calls land at roughly 2.2KB, inside both.
 */
export const ROOT_BATCH_SIZE = 20;

// Keyed `${network}:${normalized id}`. Package IDs are network-specific and one
// process serves several networks, so a mainnet lineage must never answer a
// testnet lookup. A cached `null` means "asked, no lineage" — a non-package or
// an ID that does not exist — and suppresses re-querying it.
const rootCache = new Map<string, string | null>();

const key = (packageId: string) => `${getNetwork()}:${normalizeSuiAddress(packageId)}`;

/**
 * Build the aliased batch query for `count` packages.
 *
 * `packageVersions(first: 1)` returns the oldest version in the lineage from
 * *any* member of it, so one cheap query per package gets the root. Aliases keep
 * it to a single round trip; addresses travel as variables rather than
 * interpolated text.
 */
function batchQuery(count: number): string {
  const decls = Array.from({ length: count }, (_, i) => `$a${i}: SuiAddress!`).join(", ");
  const fields = Array.from(
    { length: count },
    (_, i) => `p${i}: packageVersions(address: $a${i}, first: 1) { nodes { address } }`,
  ).join(" ");
  return `query (${decls}) { ${fields} }`;
}

type BatchResult = Record<string, { nodes: Array<{ address: string }> } | null>;

/** The lineage root for a package if one has been fetched, else null. Never blocks. */
export function getPackageRoot(packageId: string): string | null {
  return rootCache.get(key(packageId)) ?? null;
}

/**
 * Record a lineage root a caller already holds, so the next lookup needs no
 * query.
 *
 * gRPC's `movePackageService.getPackage` returns `originalId` in the same
 * response as the module list, which makes the root free for any tool that was
 * already fetching the package. Seeding it here lets those tools reuse the
 * registry's lineage tier without a GraphQL round trip.
 */
export function notePackageRoot(packageId: string, root: string): void {
  rootCache.set(key(packageId), normalizeSuiAddress(root));
}

/**
 * Resolve the lineage root of every ID in `packageIds` that isn't already
 * cached, and add the results to the cache.
 *
 * Prefer `registry.prefetchProtocolNames`, which strips curated IDs first and
 * chains this into MVR resolution for whatever is left.
 */
export async function prefetchPackageRoots(packageIds: Iterable<string>): Promise<void> {
  const pending = new Set<string>();
  for (const id of packageIds) {
    if (!id) continue;
    if (rootCache.has(key(id))) continue;
    pending.add(normalizeSuiAddress(id));
  }
  if (pending.size === 0) return;

  const ids = [...pending];
  for (let i = 0; i < ids.length; i += ROOT_BATCH_SIZE) {
    const chunk = ids.slice(i, i + ROOT_BATCH_SIZE);
    const vars = Object.fromEntries(chunk.map((id, j) => [`a${j}`, id]));
    try {
      const data = await gqlQuery<BatchResult>(batchQuery(chunk.length), vars);
      chunk.forEach((id, j) => {
        const root = data[`p${j}`]?.nodes?.[0]?.address;
        rootCache.set(key(id), root ? normalizeSuiAddress(root) : null);
      });
    } catch {
      // Leave this chunk uncached rather than poisoning it with nulls: a
      // transient outage shouldn't permanently mark a live lineage as unknown.
      // Later chunks still get their chance.
    }
  }
}

/** Test seam — drops every cached entry across all networks. */
export function clearPackageRootCache(): void {
  rootCache.clear();
}
