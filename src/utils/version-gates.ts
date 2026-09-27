/**
 * Read a package lineage's code for {@link ungatedOlderVersions}: every
 * version's disassembly, up to a bound, oldest first. An older version stays
 * callable forever, so the versions compared are the oldest ones, where a
 * check added later is missing, and the newest, which sets the policy.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { ungatedOlderVersions, type UngatedVersionLead, type VersionCode } from "./code-guards.js";
import { fetchAllModuleDisassembly } from "./move-package.js";
import { fetchPackageVersions } from "./package-versions.js";

/** Versions whose disassembly is read: the newest and the oldest others. */
export const MAX_VERSIONS_COMPARED = 30;

export interface VersionGateScan {
  leads: UngatedVersionLead[];
  /** Versions in the lineage. */
  version_count: number;
  /** Versions whose code was compared. */
  versions_compared: number[];
  /** Versions past the bound, left uncompared: a count and the range they span. */
  versions_not_compared?: { count: number; from: number; to: number };
  /** Versions whose disassembly could not be read. */
  unreadable?: { version: number; error: string }[];
}

/**
 * Compare every version of `packageId`'s lineage with its newest.
 * `known` is disassembly already read for one version, reused. Null when
 * the lineage has one version, its versions cannot be listed, or every
 * version shares one address: a framework package upgrades in place, so
 * no older code stays callable.
 */
export async function scanVersionGates(
  packageId: string,
  known?: { package_id: string; disassembly: Map<string, string> },
): Promise<VersionGateScan | null> {
  const all = await fetchPackageVersions(packageId);
  if (!all || all.length < 2 || new Set(all.map((v) => normalizeSuiAddress(v.address))).size < 2) return null;
  const sorted = [...all].sort((a, b) => a.version - b.version);
  const picked = sorted.length <= MAX_VERSIONS_COMPARED ? sorted : [...sorted.slice(0, MAX_VERSIONS_COMPARED - 1), sorted[sorted.length - 1]];
  const skipped = sorted.filter((v) => !picked.includes(v));
  const unreadable: { version: number; error: string }[] = [];
  const code: VersionCode[] = [];
  const knownId = known ? normalizeSuiAddress(known.package_id) : null;
  // One version at a time: each read is a whole package's disassembly.
  for (const v of picked) {
    const id = normalizeSuiAddress(v.address);
    try {
      const disassembly = id === knownId && known ? known.disassembly : await fetchAllModuleDisassembly(id);
      code.push({ version: v.version, package_id: id, disassembly });
    } catch (err) {
      unreadable.push({ version: v.version, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const newest = sorted[sorted.length - 1];
  // Without the newest version there is no policy to compare against.
  const leads = code.some((c) => c.version === newest.version) ? ungatedOlderVersions(code) : [];
  return {
    leads,
    version_count: sorted.length,
    versions_compared: code.map((c) => c.version),
    ...(skipped.length ? { versions_not_compared: { count: skipped.length, from: skipped[0].version, to: skipped[skipped.length - 1].version } } : {}),
    ...(unreadable.length ? { unreadable } : {}),
  };
}
