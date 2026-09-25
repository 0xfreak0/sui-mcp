/**
 * Pure helpers for object provenance: describe an owner and detect ownership
 * transitions across an object's version history. Kept pure for unit-testing.
 */

/**
 * `consensus` is a party object (`ConsensusAddressOwner`, e.g. sent with
 * `transfer::party_transfer`): exactly one address owns it and only that
 * address can use it, while its transactions are ordered through consensus
 * the way a shared object's are. It is address-held, not shared.
 */
export type OwnerDesc =
  | { kind: "address"; address: string }
  | { kind: "consensus"; address: string }
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
    case "ConsensusAddressOwner":
      return { kind: "consensus", address: o.address?.address ?? "" };
    case "Shared":
      return { kind: "shared" };
    case "Immutable":
      return { kind: "immutable" };
    default:
      return { kind: "unknown" };
  }
}

/** Stable identity key for an owner (the address distinguishes held owners). */
export function ownerKey(o: OwnerDesc): string {
  return o.kind === "address" || o.kind === "consensus" ? `${o.kind}:${o.address}` : o.kind;
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
