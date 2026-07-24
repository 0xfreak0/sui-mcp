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
