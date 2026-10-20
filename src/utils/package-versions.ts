import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork, type SuiNetwork } from "../config.js";
import { quoteInput } from "../tools/args.js";
import { MAX_ERROR_CHARS } from "./errors.js";

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

/** A parsed Move type: a primitive, a vector, or a struct (a module or package filter when `name` or `module` is absent). */
type TypeNode =
 | { kind: "primitive"; text: string }
 | { kind: "vector"; of: TypeNode }
 | { kind: "struct"; pkg: string; module?: string; name?: string; args: TypeNode[] };

const MOVE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MOVE_PRIMITIVES: Record<string, true> = {
 bool: true, u8: true, u16: true, u32: true, u64: true, u128: true, u256: true, address: true, signer: true,
};

/** Split a type-argument list at its top-level commas; null when the brackets do not balance. */
function splitArgs(text: string): string[] | null {
 const parts: string[] = [];
 let depth = 0;
 let start = 0;
 for (let i = 0; i < text.length; i++) {
  if (text[i] === "<") depth++;
  else if (text[i] === ">" && --depth < 0) return null;
  else if (text[i] === "," && depth === 0) {
   parts.push(text.slice(start, i).trim());
   start = i + 1;
  }
 }
 if (depth !== 0) return null;
 parts.push(text.slice(start).trim());
 return parts;
}

/** Parse a Move type. `filter` admits a bare package or module as the outermost type. */
function parseType(text: string, filter: boolean): TypeNode | null {
 const t = text.trim();
 if (!filter && MOVE_PRIMITIVES[t]) return { kind: "primitive", text: t };
 if (!filter && t.startsWith("vector<") && t.endsWith(">")) {
  const of = parseType(t.slice(7, -1), false);
  return of ? { kind: "vector", of } : null;
 }
 const lt = t.indexOf("<");
 const [pkg, module, name, ...rest] = (lt < 0 ? t : t.slice(0, lt)).split("::");
 if (rest.length || !/^0x[0-9a-fA-F]{1,64}$/.test(pkg ?? "")) return null;
 if (module !== undefined && !MOVE_IDENT.test(module)) return null;
 if (name !== undefined && !MOVE_IDENT.test(name)) return null;
 if (!filter && name === undefined) return null;
 if (lt < 0) return { kind: "struct", pkg: pkg!, module, name, args: [] };
 if (name === undefined || !t.endsWith(">")) return null;
 const parts = splitArgs(t.slice(lt + 1, -1));
 const args = parts?.map((p) => parseType(p, false));
 if (!args?.length || args.some((a) => !a)) return null;
 return { kind: "struct", pkg: pkg!, module, name, args: args as TypeNode[] };
}

function formatType(node: TypeNode): string {
 if (node.kind === "primitive") return node.text;
 if (node.kind === "vector") return `vector<${formatType(node.of)}>`;
 const head = [normalizeSuiAddress(node.pkg), node.module, node.name].filter((p) => p !== undefined).join("::");
 return node.args.length ? `${head}<${node.args.map(formatType).join(",")}>` : head;
}

/** A struct, module or package a type names that its package does not define. */
export interface UnknownTypeName {
 package: string;
 /** The module asked for; absent when the address is not a package. */
 module?: string;
 /** The struct asked for, when the module exists and lacks it. */
 struct?: string;
 /** True when the address holds no package. */
 not_a_package?: true;
 /** Modules of the package that define structs, when the module was not found. */
 modules?: string[];
 /** Structs of the module, when the struct was not found. */
 structs?: string[];
 /** Declared types to suggest for a missing struct (the module's when known, else the package's). */
 candidates?: TypeOrigin[];
 /** True for the outermost struct, module or package; absent for a type argument. */
 outer?: true;
}

export interface DefiningTypeResolution {
 /** Canonical type with every struct at the package that defined it; unknown parts are kept as written, padded. */
 filter: string;
 /** True when any package id in the type was rewritten. */
 rewritten: boolean;
 /** The package the outermost struct, module or package filter was read at. */
 chosen: string;
 /** Other packages defining structs under an outermost module or package filter. */
 other_defining_packages: string[];
 /** Names in the type that their package does not define. */
 unknown: UnknownTypeName[];
 /** Whether the outermost package's origins were unreadable or unavailable. */
 origins_unverified?: "read_failed" | "unavailable";
}

/**
 * Rewrite every struct of a Move type (`0xpkg`, `0xpkg::module` or
 * `0xpkg::module::Name<…>`, type arguments included) to the package that
 * defined it, from `typeOrigins`. Both an event's type and an object's type
 * carry the defining package, for the outer struct and each type argument,
 * so a type written with an upgraded id matches nothing.
 *
 * A struct name maps to exactly one defining package. An outermost package or
 * module filter can span several when structs were added by upgrades; it
 * keeps the requested package if it defines any of them, else takes the one
 * defining the most, and lists the others.
 *
 * Null when the text is not a Move type. A package read that fails throws, so
 * a caller can tell a failed read from an answer; with `tolerant`, that part
 * of the type is kept as written instead.
 */
export async function resolveDefiningType(type: string, tolerant = false): Promise<DefiningTypeResolution | null> {
 const root = parseType(type, true);
 if (!root || root.kind !== "struct") return null;
 const unknown: UnknownTypeName[] = [];
 let rewritten = false;
 let chosen = normalizeSuiAddress(root.pkg);
 let others: string[] = [];
 let originsUnverified: DefiningTypeResolution["origins_unverified"];
 // One read per package, however many times the type names it.
 const reads = new Map<string, Promise<TypeOrigin[] | null>>();

 const resolve = async (node: TypeNode, outer: boolean): Promise<TypeNode> => {
  if (node.kind === "primitive") return node;
  if (node.kind === "vector") return { kind: "vector", of: await resolve(node.of, false) };
  const args = await Promise.all(node.args.map((a) => resolve(a, false)));
  const requested = normalizeSuiAddress(node.pkg);
  if (!reads.has(requested)) reads.set(requested, fetchTypeOrigins(requested));
  let origins: TypeOrigin[] | null;
  try {
   origins = await reads.get(requested)!;
  } catch (error) {
   if (!tolerant) throw error;
   if (outer) originsUnverified = "read_failed";
   return { ...node, args };
  }
  const flag = outer ? { outer: true as const } : {};
  if (outer && (!origins || !origins.length)) originsUnverified = "unavailable";
  if (origins === null) {
   unknown.push({ package: requested, not_a_package: true, ...flag });
   return { ...node, args };
  }
  const relevant = origins.filter((o) => (!node.module || o.module === node.module) && (!node.name || o.struct === node.name));
  if (!relevant.length) {
   const inModule = node.module ? origins.filter((o) => o.module === node.module) : [];
   unknown.push(inModule.length
    ? { package: requested, module: node.module, struct: node.name, structs: [...new Set(inModule.map((o) => o.struct))].sort(), ...(outer ? { candidates: inModule } : {}), ...flag }
    : { package: requested, module: node.module, modules: [...new Set(origins.map((o) => o.module))].sort(), ...(outer && node.name ? { candidates: origins } : {}), ...flag });
   return { ...node, args };
  }
  const counts = new Map<string, number>();
  for (const o of relevant) {
   const id = normalizeSuiAddress(o.definingId);
   counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const pick = counts.has(requested) ? requested : [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  if (pick !== requested) rewritten = true;
  if (outer) {
   chosen = pick;
   others = [...counts.keys()].filter((id) => id !== pick);
  }
  return { ...node, pkg: pick, args };
 };

 const resolved = await resolve(root, true);
 return { filter: formatType(resolved), rewritten, chosen, other_defining_packages: others, unknown, ...(originsUnverified ? { origins_unverified: originsUnverified } : {}) };
}

export interface EventTypeResolution {
  /** The filter string to send. */
  filter: string;
  /** Present when the filter differs from the input, or cannot cover it in one query. */
  resolution?: {
    requested: string;
    queried: string;
    /** Type origins could not be read, so a zero-match query cannot establish absence. */
    unverified?: boolean;
    note: string;
    /** Other packages defining event types under the same package or module. */
    other_defining_packages?: string[];
  };
}

/**
 * Rewrite an event-type filter through {@link resolveDefiningType}. Refuse
 * names absent from a readable lineage; unreadable origins leave the filter
 * unchanged with an unverified note.
 */
export async function resolveEventTypeFilter(eventType: string): Promise<EventTypeResolution> {
  const trimmed = eventType.trim();
 let resolved: DefiningTypeResolution | null;
  try {
  resolved = await resolveDefiningType(trimmed, true);
  } catch {
    return {
      filter: trimmed,
      resolution: {
        requested: trimmed,
        queried: trimmed,
        unverified: true,
        note: "Package type origins could not be read. The event type was queried unchanged; an empty result does not establish that this type has no events.",
      },
    };
  }
 if (!resolved) return { filter: trimmed };
 if (resolved.origins_unverified) {
    return {
      filter: trimmed,
      resolution: {
        requested: trimmed,
        queried: trimmed,
        unverified: true,
    note: resolved.origins_unverified === "read_failed"
     ? "Package type origins could not be read. The event type was queried unchanged; an empty result does not establish that this type has no events."
     : "No package type origins were available for this ID. The event type was queried unchanged; an empty result does not establish that this type has no events.",
      },
    };
  }
 const root = parseType(trimmed, true) as Extract<TypeNode, { kind: "struct" }>;
 const missing = resolved.unknown.find((u) => u.outer);
 if (missing && root.name) {
  const candidates = missing.candidates ?? [];
    const eventLike = candidates.filter((o) => /Event$/.test(o.struct));
  const words = (root.name.match(/[A-Z]?[a-z]+/g) ?? [root.name])
      .filter((word) => word.length >= 5)
      .map((word) => word.slice(0, 5).toLowerCase());
    const ranked = (eventLike.length ? eventLike : candidates)
      .sort((a, b) =>
        Number(words.some((word) => b.struct.toLowerCase().includes(word))) -
        Number(words.some((word) => a.struct.toLowerCase().includes(word))))
      .map((o) => `${normalizeSuiAddress(o.definingId)}::${o.module}::${o.struct}`);
  // Include only whole candidates within the tool's error limit.
    let message =
      `Event type ${quoteInput(trimmed)} is not a struct in this package lineage. ` +
      "event_type names the defining module; module names the emitting call. " +
      "Candidate declared structs (emission unverified):";
    let listed = 0;
    for (const type of ranked.slice(0, 3)) {
      const next = `${message}${listed ? "," : ""} ${type}`;
      if (next.length + 1 > MAX_ERROR_CHARS) break;
      message = next;
      listed++;
    }
    if (!listed) message += ranked.length ? " too long to list; get_package with detail 'full' lists them" : " none";
    throw new Error(`${message}.`);
  }
 if (missing && root.module) {
    const more = ", and others";
    let message =
      `Event type module ${quoteInput(trimmed)} defines no struct in this package lineage, so no event type belongs to it. ` +
      "To match events emitted by calls into a module, use the module argument. Modules defining structs:";
  const modules = missing.modules ?? [];
    let listed = 0;
    for (const m of modules) {
      const next = `${message}${listed ? "," : ""} ${m}`;
      if (next.length + more.length + 1 > MAX_ERROR_CHARS) break;
      message = next;
      listed++;
    }
    throw new Error(`${message}${listed < modules.length ? more : ""}.`);
  }
 const others = resolved.other_defining_packages;
 if (!resolved.rewritten && !others.length) return { filter: trimmed };
 const { filter, chosen } = resolved;
 const scope = root.name ? "This event type" : root.module ? `Event types in module ${root.module}` : "Event types in this package";
  return {
    filter,
    resolution: {
      requested: trimmed,
      queried: filter,
      note: others.length
    ? `${scope} are defined across ${others.length + 1} package versions, and an event carries the ID of the version that defined its struct, so one filter cannot cover them. This query reads ${chosen}; query the others in other_defining_packages for the rest.`
    : `${scope} ${root.name ? "is" : "are"} defined at ${chosen}, and an event carries the ID of the package version that defined its struct, not the ID it was requested by. The filter was rewritten to it.`,
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
