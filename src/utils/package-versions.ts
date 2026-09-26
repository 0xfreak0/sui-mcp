import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork, type SuiNetwork } from "../config.js";

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

export interface TypeOrigin {
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

/**
 * Where each struct of a package lineage was defined, or null when the id is
 * not a package. Throws when the read fails, so a caller that must not guess
 * the defining id can tell a failed read from an answer.
 */
export async function fetchTypeOrigins(packageId: string): Promise<TypeOrigin[] | null> {
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
    origins = await fetchTypeOrigins(pkg);
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

export interface ModuleEventFilterSegment {
  /** The `module` value to send for this segment. */
  filter: string;
  /** Overrides the caller's `afterCheckpoint` for this segment only (exclusive), or null for no lower bound. */
  afterCheckpoint: number | null;
  /** Overrides the caller's `beforeCheckpoint` for this segment only (exclusive), or null for no upper bound. */
  beforeCheckpoint: number | null;
}

export interface ModuleEventFilterResolution {
  /**
   * One segment to query when the window sits on one side of the cutover, or
   * when the same id serves both sides; two when the window spans it and the
   * ids differ. Query each and merge the results. They cover disjoint
   * checkpoint ranges, so there is no overlap to de-duplicate.
   */
  segments: ModuleEventFilterSegment[];
  /**
   * Present whenever the filter cannot be taken at face value: it was
   * rewritten, split, covers one version's calls only, or the lineage could
   * not be read.
   */
  resolution?: {
    requested: string;
    queried: string;
    note: string;
    /**
     * The lineage's other package ids when the window reaches the cutover.
     * From it on an event carries the id of the version called, so calls
     * through these versions are not in this result.
     */
    other_version_ids?: string[];
  };
}

/**
 * First checkpoint of each network on which `relocate_event_module` was on,
 * read from each epoch's protocol config. The flag made an event's emitting
 * module version-aware. Before it the adapter tagged a user event with the
 * package's ORIGINAL (runtime) id, regardless of which version was called.
 * From it on it tags the STORAGE id, the id of the version that was actually
 * called. A `module` filter therefore has to match different ids depending on
 * which side of this checkpoint it targets.
 *
 * - mainnet: 69,982,635, first checkpoint of epoch 554 (2024-10-17T17:36:38Z,
 *   protocol 60 -> 63).
 * - testnet: 118,397,835, first checkpoint of epoch 518 (2024-10-09T19:57:36Z,
 *   protocol 60 -> 62).
 * - devnet: 0. Devnet is wiped regularly, and its genesis protocol has the
 *   flag on.
 */
export const RELOCATE_EVENT_MODULE_CHECKPOINT: Readonly<Record<SuiNetwork, number>> = {
  mainnet: 69_982_635,
  testnet: 118_397_835,
  devnet: 0,
};

const RELOCATE_EVENT_MODULE_DATE: Readonly<Record<Exclude<SuiNetwork, "devnet">, string>> = {
  mainnet: "2024-10-17",
  testnet: "2024-10-09",
};

/**
 * Resolve a `module` filter for an EVENT read (`query_events`,
 * `aggregate_events`, `sample_control_addresses`) into one or two segments to
 * query and merge.
 *
 * Before the active network's {@link RELOCATE_EVENT_MODULE_CHECKPOINT}, an
 * event's emitting module carries the package's first-ever address for the
 * life of the lineage, whichever version was called and whatever the module
 * defines, so a filter written with a later version's id matches nothing.
 * From the cutover on, an event carries the id of the version that was
 * CALLED, so a filter rewritten to the original id matches only calls
 * through version 1.
 *
 * `afterCheckpoint`/`beforeCheckpoint` are the caller's already-resolved
 * window bounds (both exclusive, `null` for unbounded). A window entirely
 * before the cutover returns one segment at the original id, one entirely at
 * or after it returns one segment at the requested id unchanged, and a window
 * holding checkpoints on both sides (including an unbounded one) returns
 * both, to be queried and merged, or one when the requested id is the
 * original. Devnet's cutover is its genesis, so a devnet window is always
 * post-cutover.
 *
 * From the cutover on, any single id matches calls through that one version,
 * the original id included, so a window reaching the cutover carries a
 * `resolution` naming the lineage's other ids. Only a lineage with one id
 * passes through without a note: a single-version package, or a framework
 * package upgraded in place (0x2, 0x3…). A lineage that cannot be read is
 * passed through with a note saying so.
 */
export async function resolveModuleEventFilter(
  module: string,
  afterCheckpoint: number | null = null,
  beforeCheckpoint: number | null = null,
): Promise<ModuleEventFilterResolution> {
  const trimmed = module.trim();
  const pkg = trimmed.split("::")[0];
  const passthrough: ModuleEventFilterResolution = {
    segments: [{ filter: trimmed, afterCheckpoint, beforeCheckpoint }],
  };
  if (!pkg?.startsWith("0x")) return passthrough;

  const network = getNetwork();
  const CUT = RELOCATE_EVENT_MODULE_CHECKPOINT[network];
  const cutover =
    network === "devnet"
      ? "Devnet has had relocate_event_module on since genesis, so an event carries the id of the package version actually called."
      : `relocate_event_module turned on at ${network} checkpoint ${CUT} (${RELOCATE_EVENT_MODULE_DATE[network]}). Before it, an event carried the package's original id whichever version was called; from it on, an event carries the id of the version actually called.`;

  let versions: PackageVersion[] | null;
  try {
    versions = await fetchPackageVersions(pkg);
  } catch (err) {
    return {
      ...passthrough,
      resolution: {
        requested: trimmed,
        queried: trimmed,
        note: `The package's version list could not be read (${err instanceof Error ? err.message : String(err)}), so the filter was sent as given. ${cutover} For an upgraded package that means this result can miss events; retry before reading an empty or short result as complete.`,
      },
    };
  }
  if (!versions?.length) return passthrough;
  const ids = [...new Set(versions.map((v) => normalizeSuiAddress(v.address)))];
  if (ids.length < 2) return passthrough;
  const requested = normalizeSuiAddress(pkg);
  const original = ids[0];
  const version = versions.find((v) => normalizeSuiAddress(v.address) === requested)?.version ?? "?";

  const suffix = trimmed.slice(pkg.length);
  // Segments are exclusive on both edges, so each side counts only when it
  // holds at least one checkpoint: the pre side is (after, min(before, CUT)),
  // the post side (max(after, CUT - 1), before).
  const preBefore = beforeCheckpoint != null ? Math.min(beforeCheckpoint, CUT) : CUT;
  const postAfter = CUT > 0 ? Math.max(afterCheckpoint ?? CUT - 1, CUT - 1) : afterCheckpoint;
  const wantsPre = (afterCheckpoint ?? -1) + 1 < preBefore;
  const wantsPost = beforeCheckpoint == null || (postAfter ?? -1) + 1 < beforeCheckpoint;
  // An empty window overall. Fall back to the requested id so the caller
  // still gets a single well-formed segment rather than none.
  if (!wantsPre && !wantsPost) return passthrough;
  // Before the cutover the original id covers every version's calls, so an
  // original-id filter over such a window is complete as written.
  if (!wantsPost && requested === original) return passthrough;

  const segments: ModuleEventFilterSegment[] =
    requested === original
      ? passthrough.segments
      : [
          ...(wantsPre ? [{ filter: original + suffix, afterCheckpoint, beforeCheckpoint: preBefore }] : []),
          ...(wantsPost ? [{ filter: trimmed, afterCheckpoint: postAfter, beforeCheckpoint }] : []),
        ];

  const onlyVersion = `calls through version ${version} (${requested}) only`;
  const coverage = !wantsPost
    ? `This window lies entirely before the cutover, so the filter was rewritten from ${requested} to ${original} and covers calls through every version.`
    : !wantsPre
      ? `${network === "devnet" ? "The filter" : "This window lies entirely at or after the cutover, so the filter"} was queried at the id you gave and covers ${onlyVersion}.`
      : requested === original
        ? `This window spans the cutover. Its checkpoints before ${CUT} cover calls through every version, and the rest cover ${onlyVersion}.`
        : `This window spans the cutover, so checkpoints before ${CUT} were queried at ${original} and cover calls through every version, and the rest were queried at ${requested} and cover ${onlyVersion}, merged.`;
  const others = ids.filter((id) => id !== requested);
  const rest = wantsPost
    ? ` The lineage has ${ids.length} package ids; query the others, listed in other_version_ids, for the events of calls made through them${network === "devnet" ? "" : " from the cutover on"}.`
    : "";

  return {
    segments,
    resolution: {
      requested: trimmed,
      queried: segments.map((s) => s.filter).join(" + "),
      note: `${cutover} ${coverage}${rest}`,
      ...(wantsPost ? { other_version_ids: others } : {}),
    },
  };
}
