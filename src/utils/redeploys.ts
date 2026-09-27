/**
 * Other package lineages that carry the same module code: a redeploy (a fresh
 * publish, which mints an unrelated root) rather than an upgrade.
 *
 * No endpoint indexes packages by code, so the search starts from the people
 * who could have published it: the lineage's publisher and the current
 * holder of its UpgradeCap. Every UpgradeCap either address still holds names
 * a lineage it published or controls. Those sharing at least half this
 * lineage's module names are candidates, and every version of each has its
 * modules compared by {@link moduleFingerprint}, nearest-published first,
 * until the read budget runs out. The same bytes give each function's
 * fingerprint ({@link functionFingerprints}), so a function whose module
 * changed around it still shows how old its code is.
 *
 * It finds a redeploy only while one of those two addresses still holds its
 * cap. A lineage whose cap was burned, made immutable or handed elsewhere is
 * not found, and the result says what was searched rather than claiming
 * there is nothing else.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { ROOT_BATCH_SIZE } from "../protocols/package-roots.js";
import { functionFingerprints, type FunctionCode } from "./function-fingerprint.js";
import { moduleFingerprint } from "./module-fingerprint.js";

/** UpgradeCap pages (50 each) read per address. */
export const REDEPLOY_CAP_PAGES = 5;
/** Package versions whose module bytes are read, across this lineage and every candidate. */
export const REDEPLOY_MAX_PACKAGE_READS = 120;
/** Related lineages listed; the rest are counted. */
export const REDEPLOY_MAX_LISTED = 10;
/**
 * Package versions per module-bytes request. A package's modules run to a
 * few hundred KB of base64, so five keep one response near a megabyte.
 */
const BYTES_BATCH = 5;

/** A package version: its id, number and publish time. */
export interface VersionRef {
  version: number;
  package_id: string;
  published_at: string | null;
}

/** One package version's modules and functions, as fingerprints. */
export interface VersionModules extends VersionRef {
  modules: Map<string, string>;
  /** Keyed `module::function`. */
  functions: Map<string, FunctionCode>;
}

export interface IdenticalModule {
  module: string;
  /** The earliest version of this lineage that carries the code. */
  here: VersionRef;
  /** The earliest version of the other lineage that carries it. */
  there: VersionRef;
}

/** A function's code both lineages carry, with how each side declared it. */
export interface IdenticalFunction {
  /** `module::function` */
  function: string;
  here: VersionRef & { declared: string };
  there: VersionRef & { declared: string };
  /** How the newest version of this lineage carrying the code declares it. */
  declared_now: string;
}

const ref = (v: VersionRef): VersionRef => ({ version: v.version, package_id: v.package_id, published_at: v.published_at });

/**
 * For each key `here` has, the earliest version here whose code under that
 * key `there` carries, and the earliest version there carrying it.
 */
function firstShared(
  here: VersionModules[],
  there: VersionModules[],
  keys: string[],
  codeOf: (v: VersionModules, key: string) => string | undefined,
): Array<{ key: string; here: VersionModules; there: VersionModules }> {
  const out: Array<{ key: string; here: VersionModules; there: VersionModules }> = [];
  const hereAsc = [...here].sort((a, b) => a.version - b.version);
  const thereAsc = [...there].sort((a, b) => a.version - b.version);
  for (const key of [...new Set(keys)].sort()) {
    for (const h of hereAsc) {
      const fp = codeOf(h, key);
      const t = fp ? thereAsc.find((v) => codeOf(v, key) === fp) : undefined;
      if (t) {
        out.push({ key, here: h, there: t });
        break;
      }
    }
  }
  return out;
}

/**
 * Modules whose code one lineage's versions share with another's, by
 * fingerprint. For each module name, the earliest version here whose code
 * the other lineage carries, and the earliest version there that carries it.
 * Pure.
 */
export function identicalModules(here: VersionModules[], there: VersionModules[]): IdenticalModule[] {
  return firstShared(
    here,
    there,
    here.flatMap((v) => [...v.modules.keys()]),
    (v, name) => v.modules.get(name),
  ).map((s) => ({ module: s.key, here: ref(s.here), there: ref(s.there) }));
}

/**
 * Functions whose code one lineage's versions share with another's, by
 * function fingerprint, whatever else their modules hold. Chosen as
 * {@link identicalModules} chooses modules. Pure.
 */
export function identicalFunctions(here: VersionModules[], there: VersionModules[]): IdenticalFunction[] {
  const code = (v: VersionModules, key: string) => v.functions.get(key)?.code;
  return firstShared(here, there, here.flatMap((v) => [...v.functions.keys()]), code).map((s) => {
    const body = code(s.here, s.key);
    const newest = here.reduce((a, v) => (code(v, s.key) === body && v.version > a.version ? v : a), s.here);
    return {
      function: s.key,
      here: { ...ref(s.here), declared: s.here.functions.get(s.key)!.declared },
      there: { ...ref(s.there), declared: s.there.functions.get(s.key)!.declared },
      declared_now: newest.functions.get(s.key)!.declared,
    };
  });
}

/**
 * The order candidates are compared in: lineages published before this one,
 * nearest first (where copied code most likely came from), then those
 * published after, nearest first. Undated lineages go last. Pure.
 */
export function compareOrder<T extends { published_at: string | null }>(candidates: T[], publishedAt: string | null): T[] {
  const at = publishedAt ? Date.parse(publishedAt) : NaN;
  const t = (c: T) => (c.published_at ? Date.parse(c.published_at) : NaN);
  const before = candidates.filter((c) => !Number.isNaN(at) && t(c) < at).sort((a, b) => t(b) - t(a));
  const after = candidates.filter((c) => !before.includes(c) && !Number.isNaN(t(c))).sort((a, b) => t(a) - t(b));
  const undated = candidates.filter((c) => !before.includes(c) && !after.includes(c));
  return [...before, ...after, ...undated];
}

export interface RelatedLineage {
  root_package_id: string;
  latest_package_id: string;
  version_count: number;
  published_at: string | null;
  /** The address holding this lineage's UpgradeCap, which is why it was a candidate. */
  cap_held_by: string;
  shared_module_names: number;
  identical_modules: IdenticalModule[];
}

export interface RedeploySearch {
  searched_addresses: string[];
  caps_read: number;
  /** An address held more UpgradeCaps than were read. */
  caps_truncated: boolean;
  /** Distinct other lineages those caps name. */
  lineages_found: number;
  /** Lineages sharing at least half this lineage's module names. */
  candidates: number;
  /** Candidates whose every version was compared before the read budget ran out. */
  lineages_compared: number;
  package_reads: number;
  /** Lineages sharing at least one module's code, most modules shared first. */
  related: RelatedLineage[];
  /** Related lineages beyond {@link REDEPLOY_MAX_LISTED}. */
  related_omitted: number;
  /** For each module some compared lineage shares, the earliest version, here or in a compared lineage, carrying that code. */
  module_origins: ModuleOrigin[];
  /** Functions whose code is older than their module's, grouped and ranked by {@link functionOrigins}. */
  function_origins: FunctionOrigin[];
  /** Functions across every `function_origins` group. */
  functions_older_than_module: number;
  /** Shared functions whose origin is their module's origin or later, so module_origins already dates them. */
  functions_dated_by_module: number;
}

export interface ModuleOrigin {
  module: string;
  root_package_id: string;
  /** True when the earliest carrier is the lineage that was queried. */
  queried_lineage: boolean;
  package_id: string;
  version: number;
  /** When that version was published. */
  published_at: string | null;
  /** Compared lineages carrying this module's code, the queried one excluded. */
  lineages_with_it: number;
}

/** Functions of one module whose code first appears in one version, before that module's own origin. */
export interface FunctionOrigin {
  module: string;
  /** Function names, sorted. */
  functions: string[];
  root_package_id: string;
  /** True when the earliest carrier is the lineage that was queried. */
  queried_lineage: boolean;
  package_id: string;
  version: number;
  published_at: string | null;
  /** Compared lineages carrying each of these functions' code, the queried one excluded. */
  lineages_with_it: number;
  /** Where the whole module's code first appears; null when no compared lineage carries the whole module. */
  module_origin: { root_package_id: string; published_at: string | null } | null;
  /** Functions the origin version declared otherwise than this lineage's newest version carrying the code does. */
  declared_changes?: Array<{ function: string; at_origin: string; here: string }>;
}

/** A version with no publish time counts as latest. */
const publishTime = (v: { published_at: string | null }) => (v.published_at ? Date.parse(v.published_at) : Infinity);

interface Carrier<V extends VersionRef> {
  root: string;
  queried: boolean;
  at: V;
  lineages: number;
}

/**
 * For each key, the earliest-published version carrying the shared code,
 * whether in this lineage (`ownRoot`) or a related one, and how many related
 * lineages carry it. On a tie this lineage wins, so an origin never points
 * forward in time from this lineage.
 */
function earliestCarriers<V extends VersionRef>(
  ownRoot: string,
  lineages: Array<{ root: string; shared: Array<{ key: string; here: V; there: V }> }>,
): Map<string, Carrier<V>> {
  const out = new Map<string, Carrier<V>>();
  const consider = (key: string, root: string, v: V, queried: boolean) => {
    const seen = out.get(key);
    if (seen && (publishTime(seen.at) < publishTime(v) || (publishTime(seen.at) === publishTime(v) && (seen.queried || !queried)))) return;
    out.set(key, { root, queried, at: v, lineages: seen?.lineages ?? 0 });
  };
  for (const l of lineages) {
    for (const s of l.shared) {
      consider(s.key, ownRoot, s.here, true);
      consider(s.key, l.root, s.there, false);
      out.get(s.key)!.lineages++;
    }
  }
  return out;
}

/**
 * For each module, the earliest-published version carrying code this lineage
 * shares with a related one, whether that version is in this lineage
 * (`ownRoot`) or the related one, and how many related lineages carry it. A
 * version with no publish time counts as latest, and on a tie this lineage
 * wins, so an origin never points forward in time from this lineage. Pure.
 */
export function moduleOrigins(ownRoot: string, related: RelatedLineage[]): ModuleOrigin[] {
  const carriers = earliestCarriers(
    ownRoot,
    related.map((l) => ({ root: l.root_package_id, shared: l.identical_modules.map((m) => ({ key: m.module, here: m.here, there: m.there })) })),
  );
  return [...carriers]
    .map(([module, c]) => ({
      module,
      root_package_id: c.root,
      queried_lineage: c.queried,
      package_id: c.at.package_id,
      version: c.at.version,
      published_at: c.at.published_at,
      lineages_with_it: c.lineages,
    }))
    .sort((a, b) => a.module.localeCompare(b.module));
}

/**
 * Functions whose code is older than their module's. Each function a
 * compared lineage shares gets its earliest carrier by the rules of
 * {@link moduleOrigins}, and is kept when that carrier was published before
 * its module's origin, or its module has none. The rest are counted as
 * `implied`: module_origins already dates them. Kept functions are grouped
 * by module, carrier version and lineage count, so no field is lost. Groups
 * rank by how long before the module's origin the code appeared (a module
 * with no origin ranks first), then earliest origin, then most functions,
 * then module name. `functions` counts the kept functions. Pure.
 */
export function functionOrigins(
  ownRoot: string,
  shared: Array<{ root: string; functions: IdenticalFunction[] }>,
  modules: ModuleOrigin[],
): { origins: FunctionOrigin[]; functions: number; implied: number } {
  const declaredNow = new Map<string, string>();
  const carriers = earliestCarriers(
    ownRoot,
    shared.map((l) => ({
      root: l.root,
      shared: l.functions.map((f) => {
        declaredNow.set(f.function, f.declared_now);
        return { key: f.function, here: f.here, there: f.there };
      }),
    })),
  );
  const moduleOf = new Map(modules.map((m) => [m.module, m]));
  const groups = new Map<string, FunctionOrigin>();
  const lead = new Map<FunctionOrigin, number>();
  let kept = 0;
  for (const [key, c] of [...carriers].sort(([a], [b]) => a.localeCompare(b))) {
    const split = key.indexOf("::");
    const module = key.slice(0, split);
    const name = key.slice(split + 2);
    const m = moduleOf.get(module);
    if (m && !(publishTime(c.at) < publishTime(m))) continue;
    kept++;
    const id = `${module} ${c.at.package_id} ${c.lineages}`;
    let group = groups.get(id);
    if (!group) {
      group = {
        module,
        functions: [],
        root_package_id: c.root,
        queried_lineage: c.queried,
        package_id: c.at.package_id,
        version: c.at.version,
        published_at: c.at.published_at,
        lineages_with_it: c.lineages,
        module_origin: m ? { root_package_id: m.root_package_id, published_at: m.published_at } : null,
      };
      groups.set(id, group);
      lead.set(group, m ? publishTime(m) - publishTime(c.at) : Infinity);
    }
    group.functions.push(name);
    const now = declaredNow.get(key)!;
    if (c.at.declared !== now) (group.declared_changes ??= []).push({ function: name, at_origin: c.at.declared, here: now });
  }
  const origins = [...groups.values()].sort(
    (a, b) =>
      lead.get(b)! - lead.get(a)! ||
      publishTime(a) - publishTime(b) ||
      b.functions.length - a.functions.length ||
      a.module.localeCompare(b.module),
  );
  return { origins, functions: kept, implied: carriers.size - kept };
}

const CAPS_QUERY = `query ($a: SuiAddress!, $after: String) {
  address(address: $a) {
    objects(first: 50, after: $after, filter: { type: "0x2::package::UpgradeCap" }) {
      pageInfo { hasNextPage endCursor }
      nodes { contents { json } }
    }
  }
}`;

interface CapsResult {
  address: {
    objects: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ contents: { json: { package?: unknown } | null } | null }>;
    } | null;
  } | null;
}

/** The newest package of every lineage whose UpgradeCap `holder` holds, up to the page bound. */
async function capPackages(holder: string): Promise<{ packages: string[]; truncated: boolean }> {
  const packages: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < REDEPLOY_CAP_PAGES; page++) {
    const r: CapsResult = await gqlQuery<CapsResult>(CAPS_QUERY, { a: holder, after });
    const conn = r.address?.objects;
    if (!conn) return { packages, truncated: false };
    for (const n of conn.nodes) {
      const pkg = n.contents?.json?.package;
      if (typeof pkg === "string") packages.push(normalizeSuiAddress(pkg));
    }
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return { packages, truncated: false };
    after = conn.pageInfo.endCursor;
  }
  return { packages, truncated: true };
}

/** Run one aliased query per chunk of `ids`, each alias built by `field(j)`. */
async function batched<T>(ids: string[], size: number, field: (j: number) => string, take: (id: string, value: T | null) => void): Promise<void> {
  for (let i = 0; i < ids.length; i += size) {
    const chunk = ids.slice(i, i + size);
    const decls = chunk.map((_, j) => `$a${j}: SuiAddress!`).join(", ");
    const fields = chunk.map((_, j) => `p${j}: ${field(j)}`).join(" ");
    const data = await gqlQuery<Record<string, T | null>>(`query (${decls}) { ${fields} }`, Object.fromEntries(chunk.map((id, j) => [`a${j}`, id])));
    chunk.forEach((id, j) => take(id, data[`p${j}`] ?? null));
  }
}

interface Lineage {
  root: string;
  published_at: string | null;
  versions: VersionRef[];
}

type VersionsNode = { nodes: Array<{ address: string; version: number; previousTransaction: { effects: { timestamp: string | null } | null } | null }> };

/** Each package's whole lineage (up to 50 versions) and when its root was published. */
async function lineagesOf(packageIds: string[]): Promise<Map<string, Lineage>> {
  const out = new Map<string, Lineage>();
  await batched<VersionsNode>(
    packageIds,
    ROOT_BATCH_SIZE,
    (j) => `packageVersions(address: $a${j}, first: 50) { nodes { address version previousTransaction { effects { timestamp } } } }`,
    (id, v) => {
      const nodes = v?.nodes ?? [];
      if (nodes.length === 0) return;
      out.set(id, {
        root: normalizeSuiAddress(nodes[0].address),
        published_at: nodes[0].previousTransaction?.effects?.timestamp ?? null,
        versions: nodes.map((n) => ({
          version: n.version,
          package_id: normalizeSuiAddress(n.address),
          published_at: n.previousTransaction?.effects?.timestamp ?? null,
        })),
      });
    },
  );
  return out;
}

type ModulesNode = { asMovePackage: { modules: { nodes: Array<{ name: string; bytes?: string | null }> } } | null };

/** Module names of many packages. */
async function moduleNames(packageIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  await batched<ModulesNode>(
    packageIds,
    ROOT_BATCH_SIZE,
    (j) => `object(address: $a${j}) { asMovePackage { modules(first: 50) { nodes { name } } } }`,
    (id, v) => {
      const nodes = v?.asMovePackage?.modules.nodes;
      if (nodes) out.set(id, nodes.map((n) => n.name));
    },
  );
  return out;
}

/** Fingerprints of each package version's modules (the first 50 of each) and of their functions. */
async function versionModules(list: VersionRef[]): Promise<VersionModules[]> {
  const fps = new Map<string, Pick<VersionModules, "modules" | "functions">>();
  await batched<ModulesNode>(
    list.map((v) => v.package_id),
    BYTES_BATCH,
    (j) => `object(address: $a${j}) { asMovePackage { modules(first: 50) { nodes { name bytes } } } }`,
    (id, v) => {
      const modules = new Map<string, string>();
      const functions = new Map<string, FunctionCode>();
      for (const m of v?.asMovePackage?.modules.nodes ?? []) {
        if (!m.bytes) continue;
        const bytes = Buffer.from(m.bytes, "base64");
        const fp = moduleFingerprint(bytes);
        if (fp) modules.set(m.name, fp);
        for (const [name, code] of functionFingerprints(bytes) ?? []) functions.set(`${m.name}::${name}`, code);
      }
      fps.set(id, { modules, functions });
    },
  );
  return list.map((v) => ({ ...v, ...(fps.get(v.package_id) ?? { modules: new Map(), functions: new Map() }) }));
}

/**
 * Search the lineages whose UpgradeCaps `addresses` hold for module code this
 * lineage also carries. `versions` is this lineage, oldest first, each with
 * its publish time; the first is the root.
 */
export async function findRedeploys(root: string, versions: VersionRef[], addresses: string[]): Promise<RedeploySearch> {
  const ownRoot = normalizeSuiAddress(root);
  const searched = [...new Set(addresses.map((a) => normalizeSuiAddress(a)))];
  let capsRead = 0;
  let capsTruncated = false;
  const holderOf = new Map<string, string>();
  for (const holder of searched) {
    const { packages, truncated } = await capPackages(holder);
    capsRead += packages.length;
    capsTruncated ||= truncated;
    for (const p of packages) if (!holderOf.has(p)) holderOf.set(p, holder);
  }

  const own = versions.slice(0, REDEPLOY_MAX_PACKAGE_READS).map((v) => ({ ...ref(v), package_id: normalizeSuiAddress(v.package_id) }));
  const publishedAt = own[0]?.published_at ?? null;
  // Names only until a candidate exists: this lineage's module bytes are
  // read after that, and not at all when nothing is compared.
  const ownNameLists = await moduleNames(own.map((v) => v.package_id));
  const ownNames = new Set([...ownNameLists.values()].flat());
  let reads = own.length;

  const capPkgs = [...holderOf.keys()];
  const lineages = await lineagesOf(capPkgs);
  const byRoot = new Map<string, Lineage & { latest: string; holder: string }>();
  for (const p of capPkgs) {
    const l = lineages.get(p);
    if (!l || l.root === ownRoot || byRoot.has(l.root)) continue;
    byRoot.set(l.root, { ...l, latest: p, holder: holderOf.get(p)! });
  }
  const names = await moduleNames([...byRoot.values()].map((l) => l.latest));
  // Half the module names in common marks a copy of this code base rather
  // than a package that happens to reuse a name.
  const minShared = Math.max(1, Math.ceil(ownNames.size / 2));
  const candidates = [...byRoot.values()]
    .map((l) => ({ ...l, shared: (names.get(l.latest) ?? []).filter((n) => ownNames.has(n)).length }))
    .filter((l) => l.shared >= minShared);

  const toCompare: typeof candidates = [];
  for (const c of compareOrder(candidates, publishedAt)) {
    if (reads + c.versions.length > REDEPLOY_MAX_PACKAGE_READS) break;
    reads += c.versions.length;
    toCompare.push(c);
  }
  if (toCompare.length === 0) reads = 0;
  const here = toCompare.length > 0 ? await versionModules(own) : [];
  const there = await versionModules(toCompare.flatMap((c) => c.versions));
  const byPackage = new Map(there.map((v) => [v.package_id, v]));

  const related: RelatedLineage[] = [];
  const sharedFunctions: Array<{ root: string; functions: IdenticalFunction[] }> = [];
  for (const c of toCompare) {
    const versionsThere = c.versions.map((v) => byPackage.get(v.package_id)!);
    const functions = identicalFunctions(here, versionsThere);
    if (functions.length > 0) sharedFunctions.push({ root: c.root, functions });
    const identical = identicalModules(here, versionsThere);
    if (identical.length === 0) continue;
    related.push({
      root_package_id: c.root,
      latest_package_id: c.versions[c.versions.length - 1].package_id,
      version_count: c.versions.length,
      published_at: c.published_at,
      cap_held_by: c.holder,
      shared_module_names: c.shared,
      identical_modules: identical,
    });
  }
  // Most shared code first; `toCompare` order (nearest published first) breaks ties.
  const ranked = [...related].sort((a, b) => b.identical_modules.length - a.identical_modules.length);
  const modules = moduleOrigins(ownRoot, related);
  const functions = functionOrigins(ownRoot, sharedFunctions, modules);
  return {
    searched_addresses: searched,
    caps_read: capsRead,
    caps_truncated: capsTruncated,
    lineages_found: byRoot.size,
    candidates: candidates.length,
    lineages_compared: toCompare.length,
    package_reads: reads,
    related: ranked.slice(0, REDEPLOY_MAX_LISTED),
    related_omitted: Math.max(0, ranked.length - REDEPLOY_MAX_LISTED),
    module_origins: modules,
    function_origins: functions.origins,
    functions_older_than_module: functions.functions,
    functions_dated_by_module: functions.implied,
  };
}
