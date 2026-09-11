/**
 * What moved that was not a coin.
 *
 * `trace_funds` follows balance changes, which is the right primitive on an
 * account-based chain and the wrong one here. Sui is object-based: a balance
 * change is derived from `Coin<T>` objects, so anything that is not a coin
 * moves without producing one. Measured on mainnet, sampling the transaction
 * that last touched each object:
 *
 * | type | sampled | no non-gas balance change |
 * |---|---|---|
 * | `package::UpgradeCap` | 30 | 30 |
 * | `package::Publisher`  | 30 | 30 |
 * | `coin::TreasuryCap`   | 30 | 14 |
 *
 * 74 of 90. So a trace that reads only balance changes reports "nothing moved"
 * for the transfer of mint authority or of the right to replace a package's
 * code — the highest-consequence transfers this chain has. It then picks the
 * story up at the first mint and calls that the origin.
 *
 * The codebase already knew the premise. `CLAUDE.md` says "Scam NFTs need no
 * handling here — they move no coin, so they never appear as an inflow." That
 * reasoning was used once, to dismiss scam NFTs, and never carried to the case
 * where the same invisibility is catastrophic.
 *
 * This module is pure. `objectChanges` rides the same `transaction(digest:)`
 * query the trace already makes, so reading it costs no extra request per hop —
 * the same economics as `detectBridges` reusing a hop's calls.
 */

/** How an object is held. Only `address` names a party a trace can follow. */
export type OwnerKind = "address" | "object" | "shared" | "immutable" | "consensus" | "unknown";

export interface OwnerRef {
  kind: OwnerKind;
  /** The owning address, or the PARENT object id when `kind` is "object". */
  address: string | null;
}

export type MovementKind =
  | "transferred"
  | "created"
  | "deleted"
  | "wrapped"
  | "unwrapped"
  | "mutated";

/**
 * What an object is, for the purpose of deciding whether its movement is worth
 * reporting.
 *
 * `coin` exists to be EXCLUDED. A `Coin<T>` object movement is already stated
 * as a balance change, and reporting it again would double-count the one case
 * the existing trace handles correctly.
 */
export type ObjectCategory = "capability" | "coin" | "kiosk" | "asset" | "unknown";

export interface ObjectMovement {
  object_id: string;
  /** Full Move type, as the chain reports it. Null when it could not be read. */
  type: string | null;
  /** Short `module::Name` form, for output that a human reads. */
  type_short: string | null;
  kind: MovementKind;
  from: OwnerRef | null;
  to: OwnerRef | null;
  category: ObjectCategory;
  /**
   * Whether losing this object means losing control of something — mint
   * authority, upgrade authority, an admin function. See
   * {@link HIGH_CONSEQUENCE_TYPES}.
   */
  high_consequence: boolean;
  note?: string;
}

/**
 * Types whose transfer is a finding on its own.
 *
 * Matched on the `module::Name` suffix, not the full type, because the package
 * id is `0x2` for the framework ones but arbitrary for a protocol's own admin
 * cap — and because a type keeps the package that defined it, so this does not
 * drift across upgrades.
 */
export const HIGH_CONSEQUENCE_TYPES: Record<string, string> = {
  "package::UpgradeCap":
    "Whoever holds this can publish new code for the package. Transferring it transfers the ability to change what the contract does.",
  "coin::TreasuryCap":
    "Mint and burn authority for this coin. Whoever holds it can create supply without limit.",
  "coin::DenyCap":
    "Authority to freeze addresses for this coin, via the deny list.",
  "package::Publisher":
    "Proof of publishing rights for the package, used to claim Display and other type-owned privileges.",
};

/** A type is a capability if it is named like one. Deliberately broad. */
const CAP_SUFFIX = /(?:^|_|::)(?:[A-Za-z0-9]*)(?:Cap|Capability)$/;

function shortType(type: string | null): string | null {
  if (!type) return null;
  // Strip generics first: `0x2::coin::Coin<0x2::sui::SUI>` -> `0x2::coin::Coin`.
  const base = type.split("<")[0] ?? type;
  const parts = base.split("::");
  return parts.length >= 3 ? parts.slice(-2).join("::") : base;
}

/** `0x2::coin::Coin<...>` — already counted as a balance change. */
function isCoin(type: string | null): boolean {
  if (!type) return false;
  const base = (type.split("<")[0] ?? type).split("::").slice(-2).join("::");
  return base === "coin::Coin";
}

export function categorize(type: string | null): ObjectCategory {
  if (!type) return "unknown";
  if (isCoin(type)) return "coin";
  const short = shortType(type) ?? "";
  if (short in HIGH_CONSEQUENCE_TYPES) return "capability";
  if (CAP_SUFFIX.test(short)) return "capability";
  if (/^kiosk::/.test(short)) return "kiosk";
  return "asset";
}

export function isHighConsequence(type: string | null): boolean {
  const short = shortType(type);
  return short != null && short in HIGH_CONSEQUENCE_TYPES;
}

/** The GraphQL shapes this reads, narrowed to what is used. */
export interface GqlOwner {
  __typename?: string;
  address?: { address?: string } | null;
}
export interface GqlObjectState {
  asMoveObject?: { contents?: { type?: { repr?: string } | null } | null } | null;
  owner?: GqlOwner | null;
}
export interface GqlObjectChange {
  address?: string;
  idCreated?: boolean | null;
  idDeleted?: boolean | null;
  inputState?: GqlObjectState | null;
  outputState?: GqlObjectState | null;
}

export function readOwner(owner: GqlOwner | null | undefined): OwnerRef | null {
  if (!owner) return null;
  switch (owner.__typename) {
    case "AddressOwner":
      return { kind: "address", address: owner.address?.address ?? null };
    case "ObjectOwner":
      return { kind: "object", address: owner.address?.address ?? null };
    case "Shared":
      return { kind: "shared", address: null };
    case "Immutable":
      return { kind: "immutable", address: null };
    case "ConsensusAddressOwner":
      return { kind: "consensus", address: owner.address?.address ?? null };
    default:
      return { kind: "unknown", address: owner.address?.address ?? null };
  }
}

function classifyKind(change: GqlObjectChange, from: OwnerRef | null, to: OwnerRef | null): MovementKind {
  if (change.idCreated) return "created";
  if (change.idDeleted) return "deleted";
  // An object with no input state that was not created existed already and was
  // unwrapped out of whatever held it; the mirror case is being wrapped INTO
  // something, which reads as a disappearance without deletion.
  if (!change.inputState && change.outputState) return "unwrapped";
  if (change.inputState && !change.outputState) return "wrapped";
  if (from && to && (from.kind !== to.kind || from.address !== to.address)) return "transferred";
  return "mutated";
}

/**
 * Turn one transaction's `objectChanges` into movements worth reporting.
 *
 * Excludes, in order:
 * - `Coin<T>`, which the balance changes already state. Reporting it twice
 *   would inflate exactly the case that already works.
 * - `mutated`, which is an object being written to, not changing hands. A
 *   trace that reported every mutation would drown in shared-object traffic;
 *   measured previously at 92% of transactions.
 */
export function readObjectMovements(changes: GqlObjectChange[]): ObjectMovement[] {
  const out: ObjectMovement[] = [];

  for (const change of changes) {
    const type =
      change.outputState?.asMoveObject?.contents?.type?.repr ??
      change.inputState?.asMoveObject?.contents?.type?.repr ??
      null;

    const category = categorize(type);
    if (category === "coin") continue;

    const from = readOwner(change.inputState?.owner);
    const to = readOwner(change.outputState?.owner);
    const kind = classifyKind(change, from, to);
    if (kind === "mutated") continue;

    const high = isHighConsequence(type);
    const short = shortType(type);

    out.push({
      object_id: change.address ?? "",
      type,
      type_short: short,
      kind,
      from,
      to,
      category,
      high_consequence: high,
      ...(high && short ? { note: HIGH_CONSEQUENCE_TYPES[short] } : {}),
    });
  }

  return out;
}

/** Movements where an object actually changed hands between two addresses. */
export function transfersBetweenAddresses(movements: ObjectMovement[]): ObjectMovement[] {
  return movements.filter(
    (m) =>
      m.kind === "transferred" &&
      m.from?.kind === "address" &&
      m.to?.kind === "address" &&
      m.from.address !== m.to.address,
  );
}

export interface ObjectFlowSummary {
  /** Every non-coin movement observed across the hops read. */
  movements: number;
  /** Objects that changed hands between two addresses. */
  transfers: ObjectMovement[];
  /** The subset that carries control of something. */
  capability_transfers: ObjectMovement[];
  note: string;
}

/**
 * Summarise object flow across a trace, or return null when there is nothing
 * to say.
 *
 * Null rather than an empty block, for the same reason the poisoning report is
 * absent rather than empty: a trace with no object movement is a fact about
 * those hops, and a permanently-present `object_flow: { transfers: [] }` would
 * read as a guarantee about the wallet.
 */
export function summarizeObjectFlow(movements: ObjectMovement[]): ObjectFlowSummary | null {
  if (movements.length === 0) return null;

  const transfers = transfersBetweenAddresses(movements);
  const caps = transfers.filter((m) => m.high_consequence);
  if (transfers.length === 0) return null;

  let note: string;
  if (caps.length > 0) {
    const names = [...new Set(caps.map((c) => c.type_short))].join(", ");
    note =
      `${caps.length} object${caps.length === 1 ? "" : "s"} carrying control changed hands in this trace (${names}). ` +
      `A transfer like this moves authority, not value, so it produces no balance change and is invisible to fund tracing — ` +
      `which is why it is reported here separately. Follow the recipient: what they can now do is the finding, and any coin movement may come later.`;
  } else {
    note =
      `${transfers.length} non-coin object${transfers.length === 1 ? "" : "s"} changed hands in this trace. ` +
      `Object transfers produce no balance change, so they do not appear in the hop amounts above. ` +
      `Value carried as an NFT or inside an object moves this way.`;
  }

  return {
    movements: movements.length,
    transfers,
    capability_transfers: caps,
    note,
  };
}
