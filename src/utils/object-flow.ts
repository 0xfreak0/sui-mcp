/**
 * What moved that was not a coin.
 *
 * A balance change is derived from `Coin<T>`, so on an object-based chain
 * everything else — an NFT, a Kiosk item, a DeFi position, an admin
 * capability — changes hands without producing one. Measured on mainnet,
 * sampling the transaction that last touched each object: `package::UpgradeCap`
 * 30 of 30 and `package::Publisher` 30 of 30 produced no non-gas balance
 * change; `coin::TreasuryCap` 14 of 30.
 *
 * Reading it costs nothing extra: `objectChanges` rides the same
 * `transaction(digest:)` query the trace already makes, and the archive's gRPC
 * `changedObjects` rides the read mask it already requests.
 *
 * ## Five things that are easy to get wrong, all of them measured
 *
 * - **Framework types are matched in FULL, never by suffix.** A package can
 *   name its module `package` and its struct `UpgradeCap`, and suffix matching
 *   would hand an airdropped fake the loudest warning this tool has. The
 *   mirror is worse: naming a module `coin` and a struct `Coin` would get an
 *   object EXCLUDED here as "already a balance change" while producing no
 *   balance change either — invisible in both channels. `capabilities.ts`
 *   already pins `0x2::…` in full; this follows it.
 * - **A capability sent somewhere unspendable is renounced, not handed over.**
 *   `upgrade-cap.ts` measured 27 of 30 UpgradeCap departures going to
 *   `0x0`/`0x2`. Reporting those as "control changed hands, follow the
 *   recipient" would make the loudest output wrong most of the time for the
 *   type that motivated the feature.
 * - **Custody is not only address-to-address.** A kiosk-held NFT is owned by
 *   the Kiosk object, so a normal NFT trade reads `object -> object`. Measured
 *   against four real wallets, filtering to address-to-address missed 10 of 28
 *   genuine transfers, and `ObjectOwner -> ObjectOwner` was 538 of ~1,240
 *   object changes in a recent sample.
 * - **Old effects do not record the input owner.** Before roughly March 2024
 *   mainnet returns `inputState: null` for EVERY change, not just created
 *   ones: 117 of 117 non-created changes at checkpoint 20,000,000. Reading
 *   that as "unwrapped" and dropping it silently loses every object transfer
 *   over the chain's first year — the era a backward trace reaches. It is
 *   reported as {@link MovementKind} `appeared`, with the ambiguity stated.
 * - **`Coin<T>` is excluded** because the balance changes already state it,
 *   and **mutations are excluded** because an object written to has not
 *   changed hands.
 */

import { isUnspendableAddress } from "./upgrade-cap.js";

/** How an object is held. */
export type OwnerKind = "address" | "object" | "shared" | "immutable" | "consensus" | "unknown";

export interface OwnerRef {
  kind: OwnerKind;
  /** The owning address, or the PARENT object id when `kind` is "object". */
  address: string | null;
}

export type MovementKind =
  | "transferred"
  /**
   * The object existed before this transaction and now belongs to someone, but
   * the chain did not record who held it. Ambiguous between a real transfer
   * and an unwrap; pre-2024 effects never stored input owners.
   */
  | "appeared"
  | "created"
  | "deleted"
  | "wrapped"
  | "unwrapped"
  | "mutated";

export type ObjectCategory =
  | "capability"
  | "coin"
  | "kiosk"
  | "defi-position"
  | "asset"
  | "unknown";

export interface ObjectMovement {
  object_id: string;
  type: string | null;
  /** Short `module::Name` form, for output a human reads. */
  type_short: string | null;
  kind: MovementKind;
  from: OwnerRef | null;
  to: OwnerRef | null;
  category: ObjectCategory;
  /** A framework capability whose powers are stateable. Never suffix-matched. */
  high_consequence: boolean;
  /** The destination is unspendable: this is renunciation, not a handover. */
  renounced?: boolean;
  /** The chain did not record the previous holder. See `appeared`. */
  source_unrecorded?: boolean;
  /** Protocol that defined this type, when the registry knows it. */
  protocol?: string;
  note?: string;
}

const ADDR2 = "0x0000000000000000000000000000000000000000000000000000000000000002";

/**
 * Framework capabilities whose powers can be stated, keyed by FULL type.
 *
 * Suffix matching is not acceptable here — see the module comment. Every key
 * is a `0x2` framework type, which is defined at that address forever, so the
 * full check costs nothing and cannot be spoofed.
 */
export const HIGH_CONSEQUENCE_TYPES: Record<string, string> = {
  [`${ADDR2}::package::UpgradeCap`]:
    "Whoever holds this can publish new code for the package. Transferring it transfers the ability to change what the contract does.",
  [`${ADDR2}::coin::TreasuryCap`]:
    "Mint and burn authority for this coin. Whoever holds it can create supply without limit.",
  [`${ADDR2}::coin::DenyCap`]:
    "Authority to freeze addresses for this coin, via the deny list.",
  [`${ADDR2}::coin::DenyCapV2`]:
    "Authority to freeze addresses for this coin, via the deny list.",
  [`${ADDR2}::package::Publisher`]:
    "Proof of publishing rights for the package, used to claim Display and other type-owned privileges.",
};

/** `0x2::coin::Coin`, in full. A look-alike from another package is NOT this. */
const COIN_TYPE = `${ADDR2}::coin::Coin`;
/** Kiosk types, in full. */
const KIOSK_TYPES = new Set([`${ADDR2}::kiosk::Kiosk`, `${ADDR2}::kiosk::KioskOwnerCap`]);

/** A name that looks like a capability but is not a known framework one. */
const CAP_SUFFIX = /Cap(?:ability)?$/;

/** Type names that a protocol uses for a position. Only consulted for a
 *  package the protocol registry already vouches for, never on its own. */
const POSITION_NAME =
  /(?:Position|Obligation|Receipt|Account|Vault|Stake|Staked|Farm|Deposit|Locker|Ticket)/i;

/**
 * Strip generics and pad the defining address.
 *
 * `0x2::coin::Coin<0x2::sui::SUI>` -> `0x0000…0002::coin::Coin`. Both forms
 * occur — the chain reports the padded one, callers and fixtures often write
 * the short one — and matching a framework type in full is worthless if the
 * two spellings do not meet. `protocols.json` normalizes its keys on load for
 * exactly this reason.
 */
export function baseType(type: string): string {
  const base = type.split("<")[0] ?? type;
  const parts = base.split("::");
  if (parts.length < 2 || !parts[0]!.startsWith("0x")) return base;
  const hex = parts[0]!.slice(2).toLowerCase();
  if (hex.length === 0 || hex.length > 64 || !/^[0-9a-f]+$/.test(hex)) return base;
  return [`0x${hex.padStart(64, "0")}`, ...parts.slice(1)].join("::");
}

export function shortType(type: string | null): string | null {
  if (!type) return null;
  const parts = baseType(type).split("::");
  return parts.length >= 3 ? parts.slice(-2).join("::") : baseType(type);
}

/** The package that DEFINED the type. Attribution hangs on this, not on a name. */
export function definingPackage(type: string | null): string | null {
  if (!type) return null;
  const first = baseType(type).split("::")[0];
  return first && first.startsWith("0x") ? first : null;
}

export function isHighConsequence(type: string | null): boolean {
  return type != null && baseType(type) in HIGH_CONSEQUENCE_TYPES;
}

/** What the protocol registry can tell us about a type's package. */
export type ProtocolResolver = (packageId: string) => { name: string; type?: string } | null;

/**
 * Classify an object.
 *
 * `resolveProtocol` is optional and, when given, is what promotes an ordinary
 * `asset` to a `defi-position`. That gate is deliberate: a type named
 * `Position` proves nothing, but a type named `Position` DEFINED BY a package
 * the registry already vouches for as a DEX or lending market is a financial
 * position. Name-matching alone would be the guessing this project refuses.
 */
export function categorize(type: string | null, resolveProtocol?: ProtocolResolver): ObjectCategory {
  if (!type) return "unknown";
  const base = baseType(type);
  if (base === COIN_TYPE) return "coin";
  if (base in HIGH_CONSEQUENCE_TYPES) return "capability";
  if (KIOSK_TYPES.has(base)) return "kiosk";

  const name = base.split("::").pop() ?? "";
  const pkg = definingPackage(type);
  const protocol = pkg && resolveProtocol ? resolveProtocol(pkg) : null;

  if (protocol && POSITION_NAME.test(name)) return "defi-position";
  if (CAP_SUFFIX.test(name)) return "capability";
  if (/^kiosk::/.test(shortType(type) ?? "")) return "kiosk";
  return "asset";
}

/* ------------------------------------------------------------------ */
/* GraphQL                                                             */
/* ------------------------------------------------------------------ */

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

function sameOwner(a: OwnerRef | null, b: OwnerRef | null): boolean {
  if (!a || !b) return false;
  return a.kind === b.kind && a.address === b.address;
}

/**
 * @param inputRecorded whether the transport actually told us the input state.
 *   GraphQL cannot distinguish "there was no input" from "the input owner was
 *   never stored", so it passes `false` when `inputState` is absent; gRPC knows
 *   and passes the real answer.
 */
function classifyKind(
  opts: { created: boolean; deleted: boolean; hasInput: boolean; hasOutput: boolean },
  from: OwnerRef | null,
  to: OwnerRef | null,
): MovementKind {
  const { created, deleted, hasInput, hasOutput } = opts;
  // Deletion wins over creation: an entry claiming both is contradictory, and
  // "this object is gone" is the safer of the two to report.
  if (deleted) return "deleted";
  if (created) return "created";
  if (!hasInput && hasOutput) return "appeared";
  if (hasInput && !hasOutput) return "wrapped";
  if (sameOwner(from, to)) return "mutated";
  return "transferred";
}

function finish(
  m: Omit<ObjectMovement, "note" | "renounced">,
): ObjectMovement {
  const out: ObjectMovement = { ...m };
  const full = m.type ? baseType(m.type) : null;

  if (m.to?.kind === "address" && m.to.address && isUnspendableAddress(m.to.address)) {
    out.renounced = true;
  }

  if (out.high_consequence && full) {
    const power = HIGH_CONSEQUENCE_TYPES[full]!;
    out.note = out.renounced
      ? `Sent to ${m.to?.address}, an address nobody holds a key for. ${power} Those rights are RENOUNCED, not transferred — a deliberate act and a reduction in risk, not a warning.`
      : power;
  }

  if (out.kind === "appeared") {
    out.source_unrecorded = true;
    out.note =
      (out.note ? out.note + " " : "") +
      "The chain did not record who held this before the transaction, which is normal for transactions before roughly March 2024. It is therefore not knowable from this alone whether it was transferred or unwrapped from something.";
  }

  return out;
}

export function readObjectMovements(
  changes: GqlObjectChange[],
  resolveProtocol?: ProtocolResolver,
): ObjectMovement[] {
  const out: ObjectMovement[] = [];

  for (const change of changes) {
    const type =
      change.outputState?.asMoveObject?.contents?.type?.repr ??
      change.inputState?.asMoveObject?.contents?.type?.repr ??
      null;

    const category = categorize(type, resolveProtocol);
    if (category === "coin") continue;

    const from = readOwner(change.inputState?.owner);
    const to = readOwner(change.outputState?.owner);
    const kind = classifyKind(
      {
        created: !!change.idCreated,
        deleted: !!change.idDeleted,
        hasInput: !!change.inputState,
        hasOutput: !!change.outputState,
      },
      from,
      to,
    );
    if (kind === "mutated") continue;

    const pkg = definingPackage(type);
    const protocol = pkg && resolveProtocol ? resolveProtocol(pkg) : null;

    out.push(
      finish({
        object_id: change.address ?? "",
        type,
        type_short: shortType(type),
        kind,
        from,
        to,
        category,
        high_consequence: isHighConsequence(type),
        ...(protocol ? { protocol: protocol.name } : {}),
      }),
    );
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* gRPC — the archive path                                             */
/* ------------------------------------------------------------------ */

/**
 * The archive DOES report object changes.
 *
 * An earlier version of this file claimed it does not, and disclaimed object
 * flow on every archive hop. Verified false against mainnet: for a digest the
 * fullnode has pruned, the archive returns `changedObjects` carrying
 * `objectType`, `inputOwner` and `outputOwner` in full. It is also the only
 * transport that can resolve the pre-2024 ambiguity, because it exposes
 * `inputState` as an explicit EXISTS / DOES_NOT_EXIST rather than a null.
 */
export interface GrpcOwner {
  kind?: number;
  address?: string;
}
export interface GrpcChangedObject {
  objectId?: string;
  objectType?: string;
  inputState?: number;
  idOperation?: number;
  inputOwner?: GrpcOwner | null;
  outputOwner?: GrpcOwner | null;
}

/** Owner kind numbers, from `sui.rpc.v2.Owner.OwnerKind`. */
const GRPC_OWNER_KIND: Record<number, OwnerKind> = {
  0: "unknown",
  1: "address",
  2: "object",
  3: "shared",
  4: "immutable",
  5: "consensus",
};

export function readGrpcOwner(owner: GrpcOwner | null | undefined): OwnerRef | null {
  if (!owner || owner.kind === undefined) return null;
  return {
    kind: GRPC_OWNER_KIND[owner.kind] ?? "unknown",
    address: owner.address ?? null,
  };
}

/** `sui.rpc.v2.ChangedObject.InputObjectState` */
const INPUT_DOES_NOT_EXIST = 1;
const INPUT_EXISTS = 2;
/** `sui.rpc.v2.ChangedObject.IdOperation` */
const ID_CREATED = 2;
const ID_DELETED = 3;

export function readGrpcObjectChanges(
  changes: GrpcChangedObject[],
  resolveProtocol?: ProtocolResolver,
): ObjectMovement[] {
  const out: ObjectMovement[] = [];

  for (const change of changes) {
    const type = change.objectType ?? null;
    const category = categorize(type, resolveProtocol);
    if (category === "coin") continue;

    const from = readGrpcOwner(change.inputOwner);
    const to = readGrpcOwner(change.outputOwner);

    // Unlike GraphQL, this transport states whether an input existed, so a
    // missing owner on an existing input is knowable as "not recorded" rather
    // than guessed.
    const inputExisted = change.inputState === INPUT_EXISTS;
    const inputAbsent = change.inputState === INPUT_DOES_NOT_EXIST;
    const hasInput = inputExisted && from !== null;

    const kind = classifyKind(
      {
        created: change.idOperation === ID_CREATED,
        deleted: change.idOperation === ID_DELETED,
        hasInput,
        hasOutput: to !== null,
      },
      from,
      to,
    );
    if (kind === "mutated") continue;
    // An input that genuinely did not exist and was not created is an unwrap,
    // which is a different claim from an unrecorded owner.
    const resolved: MovementKind = kind === "appeared" && inputAbsent ? "unwrapped" : kind;

    const pkg = definingPackage(type);
    const protocol = pkg && resolveProtocol ? resolveProtocol(pkg) : null;

    out.push(
      finish({
        object_id: change.objectId ?? "",
        type,
        type_short: shortType(type),
        kind: resolved,
        from,
        to,
        category,
        high_consequence: isHighConsequence(type),
        ...(protocol ? { protocol: protocol.name } : {}),
      }),
    );
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

/**
 * Movements where custody actually changed.
 *
 * NOT restricted to address-to-address. A kiosk-held NFT is owned by the Kiosk
 * object, so the ordinary NFT trade is `object -> object`; requiring both ends
 * to be addresses missed 10 of 28 real transfers across four mainnet wallets.
 * `appeared` is included because dropping it loses the chain's first year.
 */
export function custodyChanges(movements: ObjectMovement[]): ObjectMovement[] {
  return movements.filter((m) => {
    if (m.kind === "transferred") return !sameOwner(m.from, m.to);
    return m.kind === "appeared" || m.kind === "unwrapped" || m.kind === "wrapped";
  });
}

/** Every address that took part in a custody change, for identity and labelling. */
export function objectCounterparties(movements: ObjectMovement[]): string[] {
  const out = new Set<string>();
  for (const m of custodyChanges(movements)) {
    for (const ref of [m.from, m.to]) {
      if (ref?.kind === "address" && ref.address) out.add(ref.address);
    }
  }
  return [...out];
}

export interface ObjectFlowSummary {
  /** Every non-coin movement read, including creations and deletions. */
  movements: number;
  /** Movements where custody changed. */
  transfers: ObjectMovement[];
  /** Transfers of a framework capability that were NOT renunciations. */
  capability_transfers: ObjectMovement[];
  /** Capabilities sent somewhere unspendable — a risk reduction, not a warning. */
  renounced_capabilities: ObjectMovement[];
  /** True when a transaction reported more object changes than were read. */
  truncated?: boolean;
  note: string;
}

/**
 * Summarise object flow, or return null when there is nothing to say.
 *
 * Takes the FULL movement list, not a pre-filtered one, so `movements` counts
 * what its name says and the caller cannot silently narrow the input.
 */
export function summarizeObjectFlow(
  movements: ObjectMovement[],
  opts?: { truncated?: boolean },
): ObjectFlowSummary | null {
  const transfers = custodyChanges(movements);
  if (transfers.length === 0 && !opts?.truncated) return null;

  const caps = transfers.filter((m) => m.high_consequence && !m.renounced);
  const renounced = transfers.filter((m) => m.high_consequence && m.renounced);

  const parts: string[] = [];
  if (caps.length > 0) {
    const names = [...new Set(caps.map((c) => c.type_short))].join(", ");
    parts.push(
      `${caps.length} object${caps.length === 1 ? "" : "s"} carrying control changed hands (${names}). A transfer like this moves authority, not value, so it produces no balance change and is invisible to fund tracing. Follow the recipient: what they can now do is the finding, and any coin movement may come later.`,
    );
  }
  if (renounced.length > 0) {
    parts.push(
      `${renounced.length} capability object${renounced.length === 1 ? " was" : "s were"} sent to an address nobody holds a key for. Those rights are renounced rather than transferred — a deliberate act and a reduction in risk, not a warning.`,
    );
  }
  if (transfers.length > caps.length + renounced.length) {
    parts.push(
      `Non-coin objects changed hands, which produces no balance change and so does not appear in the hop amounts. Value carried as an NFT, a kiosk item or a DeFi position moves this way.`,
    );
  }
  if (opts?.truncated) {
    parts.push(
      `At least one transaction reported more object changes than were read, so this list is incomplete — absence of a transfer here is not evidence it did not happen.`,
    );
  }

  return {
    movements: movements.length,
    transfers,
    capability_transfers: caps,
    renounced_capabilities: renounced,
    ...(opts?.truncated ? { truncated: true } : {}),
    note: parts.join(" "),
  };
}
