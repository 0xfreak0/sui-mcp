/**
 * Which package IDs of a protocol are worth querying.
 *
 * The trap this exists to close: `src/data/protocols.json` maps package IDs to
 * protocol names for *decoding*, so it is full of historical IDs on purpose —
 * recognising Cetus v1 in a 2023 transaction is the point. Used as a list of
 * query targets it is actively misleading, because a package that a protocol
 * upgraded away from years ago emits nothing today. Feeding one to
 * aggregate_events returns zero events and looks like the protocol is dead.
 *
 * The answer is plural, which is the part that surprises. A Sui package upgrade
 * mints a new ID, and an event carries the ID of the version that *defined* it,
 * so a protocol that has upgraded piecemeal emits from several versions at once.
 * Measured on mainnet, three Cetus versions were live simultaneously — v12
 * emitting RemoveLiquidityEvent, v13 ClaimRefFeeEvent, v14 SwapEvent. Resolving
 * "the current package" to a single ID would silently drop two thirds of the
 * protocol's activity, which is worse than the original trap because the result
 * looks complete.
 */

export interface PackageVersion {
  address: string;
  version: number;
}

export interface LineageEntry extends PackageVersion {
  /** Whether this version emitted anything in the probe window. */
  emitting: boolean;
  /** An example event type, when one was seen. */
  sample_event_type?: string;
}

export interface LineageSummary {
  /** Every known version, newest first. */
  versions: LineageEntry[];
  /** The IDs worth querying — pass these to aggregate_events. */
  emitting_package_ids: string[];
  latest_version: number | null;
  /** True when the lineage was found but nothing in it is currently active. */
  all_dormant: boolean;
  guidance: string;
}

/**
 * Fold a probed lineage into something a caller can act on.
 *
 * Pure: the probing is I/O and lives in the tool, so the reasoning about what
 * the result *means* stays testable without touching the chain.
 */
export function summarizeLineage(entries: LineageEntry[]): LineageSummary {
  const versions = [...entries].sort((a, b) => b.version - a.version);
  const emitting = versions.filter((v) => v.emitting);
  const emitting_package_ids = emitting.map((v) => v.address);
  const latest_version = versions[0]?.version ?? null;

  let guidance: string;
  if (versions.length === 0) {
    guidance =
      "No package lineage found for that address. Check the ID — a non-package object or a typo both land here.";
  } else if (emitting.length === 0) {
    guidance =
      "Every version of this package is silent in the probe window. Either the protocol is genuinely inactive, " +
      "or it moved to a package outside this upgrade lineage — a redeploy rather than an upgrade mints an " +
      "unrelated ID that no amount of version-walking will find. Widen the window before concluding it is dead.";
  } else if (emitting.length === 1) {
    guidance =
      `One version is active: ${emitting[0].address}. Use it as the \`module\` filter for aggregate_events.`;
  } else {
    guidance =
      `${emitting.length} versions are emitting at once, which is normal — an event carries the ID of the ` +
      "version that defined it, so a protocol upgraded piecemeal reports from several. Query ALL of them; " +
      "using only the newest would silently drop whatever the older versions still define.";
  }

  return {
    versions,
    emitting_package_ids,
    latest_version,
    all_dormant: versions.length > 0 && emitting.length === 0,
    guidance,
  };
}

/**
 * Candidate package IDs recorded for a protocol name.
 *
 * Matching is case-insensitive and exact on the name — a substring match would
 * make "Bucket" also return "BucketV2"-style entries from unrelated teams, and
 * a wrong package silently produces an empty, confident-looking result.
 */
export function candidatesForProtocol(
  registry: Record<string, { name: string; type?: string }>,
  name: string,
): string[] {
  const want = name.trim().toLowerCase();
  return Object.entries(registry)
    .filter(([, v]) => v.name.toLowerCase() === want)
    .map(([id]) => id);
}
