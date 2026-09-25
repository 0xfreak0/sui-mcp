import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";

/**
 * Filters that name a package match ONE version of it, and a package upgrade
 * mints a new ID.
 *
 * - An event's type carries the package that DEFINED the struct, which is the
 *   version that introduced it, not the version that emitted it. A filter on
 *   `<latest>::margin_manager::LiquidationEvent` matches nothing when the
 *   struct was defined at the original ID, and says so only by being empty.
 *   `typeOrigins` on any version records where each struct was defined, so an
 *   event-type filter is rewritten to the defining package before it is sent.
 * - A `function` filter (and an event `module` filter, the emitting module)
 *   matches calls made through that exact version. Each version sees its own
 *   slice of the protocol's calls, disjoint from the others, so a non-empty
 *   result is still partial. `all_versions` on query_transactions fans out over
 *   `packageVersions`; elsewhere the result names the other versions.
 */

export interface PackageVersion {
  address: string;
  version: number;
}

const VERSIONS_QUERY = `query ($a: SuiAddress!, $after: String) {
  packageVersions(address: $a, first: 50, after: $after) { nodes { address version } pageInfo { hasNextPage endCursor } }
}`;

const TYPE_ORIGINS_QUERY = `query ($a: SuiAddress!) { package(address: $a) { typeOrigins { module struct definingId } } }`;

interface TypeOrigin {
  module: string;
  struct: string;
  definingId: string;
}

// Type origins of a package version never change, so they are cached for the
// process, keyed by network since one process serves several.
const originCache = new Map<string, TypeOrigin[] | null>();

/** Every version of the package lineage `packageId` belongs to, oldest first. Null when it is not a package. */
export async function fetchPackageVersions(packageId: string): Promise<PackageVersion[] | null> {
  const out: PackageVersion[] = [];
  let after: string | undefined;
  // A lineage past 500 versions does not exist; the cap guards a cursor loop.
  for (let page = 0; page < 10; page++) {
    const r = await gqlQuery<{
      packageVersions: {
        nodes: PackageVersion[];
        pageInfo: { hasNextPage: boolean; endCursor?: string | null };
      } | null;
    }>(VERSIONS_QUERY, { a: packageId, after });
    const conn = r.packageVersions;
    if (!conn) return out.length ? out : null;
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
  }
  return out.length ? out : null;
}

async function typeOrigins(packageId: string): Promise<TypeOrigin[] | null> {
  const key = `${getNetwork()}:${normalizeSuiAddress(packageId)}`;
  if (originCache.has(key)) return originCache.get(key) ?? null;
  const r = await gqlQuery<{ package: { typeOrigins: TypeOrigin[] | null } | null }>(TYPE_ORIGINS_QUERY, {
    a: packageId,
  });
  const origins = r.package?.typeOrigins ?? null;
  originCache.set(key, origins);
  return origins;
}

export interface EventTypeResolution {
  /** The filter string to send. */
  filter: string;
  /** Present when the filter differs from the input, or cannot cover it in one query. */
  resolution?: {
    requested: string;
    queried: string;
    note: string;
    /** Other packages defining event types under the same package or module. */
    other_defining_packages?: string[];
  };
}

/**
 * Rewrite an event-type filter (`0xpkg`, `0xpkg::module` or
 * `0xpkg::module::Name<…>`) to the package that defines the type.
 *
 * A struct name maps to exactly one defining package. A package or module
 * filter can span several when structs were added by upgrades; the filter then
 * keeps the requested package if it defines any of them, else takes the one
 * defining the most, and the others are listed so the caller can query them.
 * A package that cannot be read is passed through unchanged: the filter may
 * still be right, and the query will say so.
 */
export async function resolveEventTypeFilter(eventType: string): Promise<EventTypeResolution> {
  const trimmed = eventType.trim();
  const lt = trimmed.indexOf("<");
  const head = lt === -1 ? trimmed : trimmed.slice(0, lt);
  const generics = lt === -1 ? "" : trimmed.slice(lt);
  const [pkg, mod, name] = head.split("::");
  if (!pkg?.startsWith("0x")) return { filter: trimmed };

  let origins: TypeOrigin[] | null;
  try {
    origins = await typeOrigins(pkg);
  } catch {
    return { filter: trimmed };
  }
  if (!origins?.length) return { filter: trimmed };

  const requested = normalizeSuiAddress(pkg);
  const relevant = origins.filter((o) => (!mod || o.module === mod) && (!name || o.struct === name));
  if (!relevant.length) return { filter: trimmed };

  const counts = new Map<string, number>();
  for (const o of relevant) {
    const id = normalizeSuiAddress(o.definingId);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const chosen = counts.has(requested) ? requested : [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const others = [...counts.keys()].filter((id) => id !== chosen);
  if (chosen === requested && !others.length) return { filter: trimmed };

  const filter = [chosen, mod, name].filter(Boolean).join("::") + generics;
  const scope = name ? "This event type" : mod ? `Event types in module ${mod}` : "Event types in this package";
  return {
    filter,
    resolution: {
      requested: trimmed,
      queried: filter,
      note: others.length
        ? `${scope} are defined across ${counts.size} package versions, and an event carries the ID of the version that defined its struct, so one filter cannot cover them. This query reads ${chosen}; query the others in other_defining_packages for the rest.`
        : `${scope} is defined at ${chosen}, and an event carries the ID of the package version that defined its struct, not the ID it was requested by. The filter was rewritten to it.`,
      ...(others.length ? { other_defining_packages: others } : {}),
    },
  };
}

/** Where a single-version filter sits in its package lineage. */
export interface VersionScope {
  package: string;
  version: number;
  version_count: number;
  original_package: string;
  note: string;
}

/**
 * A note for a filter that names one package version of a multi-version
 * lineage, or null when the package has a single version or cannot be read.
 */
export async function versionScopeNote(target: string, kind: "function" | "module"): Promise<VersionScope | null> {
  const pkg = target.trim().split("::")[0];
  if (!pkg?.startsWith("0x")) return null;
  let versions: PackageVersion[] | null;
  try {
    versions = await fetchPackageVersions(pkg);
  } catch {
    return null;
  }
  if (!versions || versions.length < 2) return null;
  const id = normalizeSuiAddress(pkg);
  const self = versions.find((v) => normalizeSuiAddress(v.address) === id);
  const what = kind === "function" ? "calls made through" : "events emitted by calls into";
  return {
    package: id,
    version: self?.version ?? 0,
    version_count: versions.length,
    original_package: versions[0].address,
    note:
      `This ${kind} filter matches ${what} package version ${self?.version ?? "?"} only; the lineage has ${versions.length} versions, rooted at ${versions[0].address}, and each sees its own share of the protocol's activity.` +
      (kind === "function" ? " Set all_versions: true to read every version." : " Query the other versions' IDs to see the rest."),
  };
}
