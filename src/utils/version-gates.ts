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
 /** First older version not compared yet; omit when the newest was the last read. */
 next_offset?: number;
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
 maxVersions = MAX_VERSIONS_COMPARED,
 versionOffset = 0,
): Promise<VersionGateScan | null> {
  const all = await fetchPackageVersions(packageId);
  if (!all || all.length < 2 || new Set(all.map((v) => normalizeSuiAddress(v.address))).size < 2) return null;
  const sorted = [...all].sort((a, b) => a.version - b.version);
 if (versionOffset >= sorted.length - 1) throw new RangeError("version_offset is past the last older package version.");
 const older = sorted.slice(0, -1);
 const pickedOlder = older.slice(versionOffset, versionOffset + maxVersions - 1);
 const picked = [...pickedOlder, sorted[sorted.length - 1]];
 const nextOffset = versionOffset + pickedOlder.length;
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
  ...(older.length > pickedOlder.length ? {
   versions_not_compared: {
    count: older.length - pickedOlder.length,
    from: older[versionOffset > 0 ? 0 : nextOffset].version,
    to: older[nextOffset < older.length ? older.length - 1 : versionOffset - 1].version,
   },
  } : {}),
  ...(nextOffset < older.length ? { next_offset: nextOffset } : {}),
    ...(unreadable.length ? { unreadable } : {}),
  };
}
