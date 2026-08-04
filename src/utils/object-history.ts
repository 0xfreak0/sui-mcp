/**
 * Pure helpers for object provenance: describe an owner and detect ownership
 * transitions across an object's version history. Kept pure for unit-testing.
 */

export type OwnerDesc =
  | { kind: "address"; address: string }
  | { kind: "shared" }
  | { kind: "immutable" }
  | { kind: "unknown" };

export interface VersionEntry {
  version: string;
  tx: string | null;
  timestamp: string | null;
  checkpoint: string | null;
  owner: OwnerDesc;
}

export interface OwnerChange {
  from: OwnerDesc;
  to: OwnerDesc;
  at_version: string;
  tx: string | null;
  timestamp: string | null;
}

/** Parse a GraphQL object owner union into an OwnerDesc. */
export function ownerDesc(o: { __typename?: string; address?: { address: string } } | null | undefined): OwnerDesc {
  switch (o?.__typename) {
    case "AddressOwner":
      return { kind: "address", address: o.address?.address ?? "" };
    case "Shared":
    case "ConsensusAddressOwner":
      return { kind: "shared" };
    case "Immutable":
      return { kind: "immutable" };
    default:
      return { kind: "unknown" };
  }
}

/** Stable identity key for an owner (address value distinguishes address owners). */
export function ownerKey(o: OwnerDesc): string {
  return o.kind === "address" ? `address:${o.address}` : o.kind;
}

/**
 * Detect ownership transitions across a chronological (oldest-first) version
 * history. Each entry where the owner differs from the previous version yields
 * one change — this is the provenance signal (transfers, sharing, freezing).
 */
export function computeOwnerChanges(entries: VersionEntry[]): OwnerChange[] {
  const changes: OwnerChange[] = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1].owner;
    const cur = entries[i].owner;
    if (ownerKey(prev) !== ownerKey(cur)) {
      changes.push({
        from: prev,
        to: cur,
        at_version: entries[i].version,
        tx: entries[i].tx,
        timestamp: entries[i].timestamp,
      });
    }
  }
  return changes;
}
