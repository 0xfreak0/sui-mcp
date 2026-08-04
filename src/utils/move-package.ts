import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getMvrUrl } from "../config.js";

/**
 * A "package reference" accepted by the developer tools can be either a raw
 * hex package ID (0x...) or a Move Registry (MVR) name (@org/app[/version]).
 *
 * Heads up: MVR coverage is thin — most packages on mainnet are NOT registered.
 * Name resolution is a convenience for the packages that ARE registered; callers
 * should expect to fall back to raw 0x IDs for the long tail.
 */
export function looksLikeMvrName(ref: string): boolean {
  const r = ref.trim();
  if (r.startsWith("0x")) return false;
  return r.startsWith("@") || r.includes("/");
}

/**
 * Resolve a package reference to a hex package ID. Raw 0x IDs pass through
 * (normalized to full 32-byte form). MVR names are resolved via the registry.
 */
export async function resolvePackageId(ref: string): Promise<string> {
  const trimmed = ref.trim();
  if (!looksLikeMvrName(trimmed)) {
    return normalizeSuiAddress(trimmed);
  }
  const mvrUrl = getMvrUrl();
  if (!mvrUrl) {
    throw new Error(
      `'${trimmed}' looks like an MVR name, but the Move Registry is unavailable on this network. Pass the 0x package ID directly.`,
    );
  }
  const res = await fetch(`${mvrUrl}/resolution/${trimmed}`, {
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Could not resolve MVR name '${trimmed}' (HTTP ${res.status}). Most packages are not registered in MVR — pass the 0x package ID directly.`,
    );
  }
  const body = (await res.json()) as { package_id?: string };
  if (!body?.package_id) {
    throw new Error(`MVR name '${trimmed}' did not resolve to a package ID.`);
  }
  return normalizeSuiAddress(body.package_id);
}

interface ModulesPage {
  package: {
    address: string;
    modules: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { name: string }[];
    };
  } | null;
}

const MODULE_NAMES_QUERY = `query ($p: SuiAddress!, $after: String) {
  package(address: $p) {
    address
    modules(first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name }
    }
  }
}`;

/** List every module name in a package (paginates the 50-per-page GraphQL cap). */
export async function fetchModuleNames(packageId: string): Promise<string[]> {
  const names: string[] = [];
  let after: string | null = null;
  for (;;) {
    const data: ModulesPage = await gqlQuery<ModulesPage>(MODULE_NAMES_QUERY, {
      p: packageId,
      after,
    });
    if (!data.package) throw new Error(`Package not found: ${packageId}`);
    for (const n of data.package.modules.nodes) names.push(n.name);
    if (!data.package.modules.pageInfo.hasNextPage) break;
    after = data.package.modules.pageInfo.endCursor;
  }
  return names;
}

interface DisassemblyResult {
  package: {
    module: { name: string; disassembly: string | null } | null;
  } | null;
}

const DISASSEMBLY_QUERY = `query ($p: SuiAddress!, $m: String!) {
  package(address: $p) {
    module(name: $m) {
      name
      disassembly
    }
  }
}`;

/**
 * Fetch the GraphQL-provided disassembly (Move bytecode assembly) for one
 * module. This is the zero-infra alternative to the external move-decompiler
 * binary: lower-level than decompiled source, but always available.
 */
export async function fetchModuleDisassembly(
  packageId: string,
  moduleName: string,
): Promise<string> {
  const data = await gqlQuery<DisassemblyResult>(DISASSEMBLY_QUERY, {
    p: packageId,
    m: moduleName,
  });
  if (!data.package) throw new Error(`Package not found: ${packageId}`);
  if (!data.package.module) {
    throw new Error(`Module '${moduleName}' not found in package ${packageId}`);
  }
  return data.package.module.disassembly ?? "";
}

interface PackageVersionResult {
  package: { version: number } | null;
}

const PACKAGE_VERSION_QUERY = `query ($p: SuiAddress!) {
  package(address: $p) {
    version
  }
}`;

/** Latest on-chain version number of a package family (any version's address works). */
export async function fetchPackageLatestVersion(address: string): Promise<number> {
  const data = await gqlQuery<PackageVersionResult>(PACKAGE_VERSION_QUERY, { p: address });
  if (!data.package) throw new Error(`Package not found: ${address}`);
  return data.package.version;
}

function assertVersion(version: number): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`Invalid version: ${version} (must be a positive integer).`);
  }
}

interface PackageAtResult {
  package: { packageAt: { address: string; version: number } | null } | null;
}

/**
 * Resolve the on-chain address of a specific version in a package's upgrade
 * history. On Sui each upgrade publishes a new package object at a new address.
 *
 * NOTE: this address is for *reporting* only. Do NOT fetch module bytecode via
 * `package(address: <this>)` — that query linkage-resolves to the LATEST
 * version regardless of the historical address, so every version would look
 * identical. Read version-specific bytecode through the `packageAt` node
 * instead (see {@link fetchAllModuleDisassemblyAtVersion}).
 *
 * `version` is a caller-validated integer, interpolated into the query to avoid
 * guessing the GraphQL scalar type for the `version` argument.
 */
export async function resolveVersionAddress(
  address: string,
  version: number,
): Promise<{ address: string; version: number }> {
  assertVersion(version);
  const query = `query ($p: SuiAddress!) {
    package(address: $p) {
      packageAt(version: ${version}) { address version }
    }
  }`;
  const data = await gqlQuery<PackageAtResult>(query, { p: address });
  if (!data.package) throw new Error(`Package not found: ${address}`);
  if (!data.package.packageAt) {
    throw new Error(`Version ${version} not found in the upgrade history of ${address}.`);
  }
  return data.package.packageAt;
}

interface ModuleNamesAtVersionResult {
  package: {
    packageAt: {
      modules: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { name: string }[] };
    } | null;
  } | null;
}

/** List module names in a specific package version (via the `packageAt` node). */
async function fetchModuleNamesAtVersion(address: string, version: number): Promise<string[]> {
  assertVersion(version);
  const names: string[] = [];
  let after: string | null = null;
  for (;;) {
    const query = `query ($p: SuiAddress!, $after: String) {
      package(address: $p) {
        packageAt(version: ${version}) {
          modules(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { name }
          }
        }
      }
    }`;
    const data: ModuleNamesAtVersionResult = await gqlQuery<ModuleNamesAtVersionResult>(query, {
      p: address,
      after,
    });
    if (!data.package) throw new Error(`Package not found: ${address}`);
    if (!data.package.packageAt) {
      throw new Error(`Version ${version} not found in the upgrade history of ${address}.`);
    }
    for (const n of data.package.packageAt.modules.nodes) names.push(n.name);
    if (!data.package.packageAt.modules.pageInfo.hasNextPage) break;
    after = data.package.packageAt.modules.pageInfo.endCursor;
  }
  return names;
}

interface DisassemblyAtVersionResult {
  package: {
    packageAt: { module: { name: string; disassembly: string | null } | null } | null;
  } | null;
}

/** Disassembly of one module at a specific package version (via `packageAt`). */
async function fetchModuleDisassemblyAtVersion(
  address: string,
  version: number,
  moduleName: string,
): Promise<string> {
  assertVersion(version);
  const query = `query ($p: SuiAddress!, $m: String!) {
    package(address: $p) {
      packageAt(version: ${version}) {
        module(name: $m) { name disassembly }
      }
    }
  }`;
  const data = await gqlQuery<DisassemblyAtVersionResult>(query, { p: address, m: moduleName });
  if (!data.package?.packageAt) {
    throw new Error(`Version ${version} not found in the upgrade history of ${address}.`);
  }
  return data.package.packageAt.module?.disassembly ?? "";
}

/**
 * Fetch every module's disassembly for a specific package version, keyed by
 * module name. Reads through `packageAt` so each version's actual bytecode is
 * returned (not the linkage-resolved latest).
 */
export async function fetchAllModuleDisassemblyAtVersion(
  address: string,
  version: number,
): Promise<Map<string, string>> {
  const names = await fetchModuleNamesAtVersion(address, version);
  const entries = await Promise.all(
    names.map(async (name) => [name, await fetchModuleDisassemblyAtVersion(address, version, name)] as const),
  );
  return new Map(entries);
}
