import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { assessCapHolder, isUnspendableAddress, type CapHolderStatus } from "./upgrade-cap.js";
import { fetchTypeOrigins, type TypeOrigin } from "./package-versions.js";
import { describeAddresses } from "./identity.js";
import { schemeLabel } from "./upgrade-history.js";

/**
 * Capability auditing for a Move package: who holds the powerful capabilities
 * (`UpgradeCap`, `TreasuryCap`, deny/admin caps) and what that means for rug /
 * backdoor risk.
 *
 * Sui has no cap→package index, so we find them via the package's *publish*
 * transaction (which created them), then query each cap object LIVE for its
 * current owner — because the cap may have been transferred, shared, or burned
 * since publish, and that current state is what actually matters.
 */

export type CapKind = "upgrade" | "treasury" | "deny" | "admin";
/**
 * `consensus` is a party object (`ConsensusAddressOwner`): one address owns it,
 * and its transactions are ordered through consensus the way a shared object's
 * are. It is held by that address, not shared: only the owner can use it.
 */
export type OwnerKind = "address" | "consensus" | "shared" | "immutable" | "burned" | "unknown";
export type CapRisk = "high" | "medium" | "low" | "info";

export interface CapabilityInfo {
  kind: CapKind;
  type: string;
  object_id: string;
  owner: OwnerKind;
  owner_address?: string;
  /** UpgradeCap only: on-chain upgrade policy. */
  upgrade_policy?: string;
  /**
   * UpgradeCap only: where the cap ended up relative to the publisher.
   *
   * `burned` and `transferred` are deliberately distinct. Most caps that
   * leave their publisher go to an unspendable address, and reporting both
   * as "moved" would flag that responsible choice as suspicious.
   */
  holder_status?: CapHolderStatus;
  /** UpgradeCap only: the publisher it was compared against. */
  publisher?: string;
  /** How the holder authenticates (single-key scheme, or a multisig m-of-n), when known. */
  signing_scheme?: string;
  risk: CapRisk;
  note: string;
}

export interface CapabilityAudit {
  checked: boolean;
  capabilities: CapabilityInfo[];
  /**
   * Authority-named struct types held one-per-user rather than by a small
   * number of protocol authorities (`USER_HELD_MIN_INSTANCES` or more live
   * instances, or the scan hit its cap), reported as a count rather than one
   * `capabilities` entry per holder. `truncated` means the type has at least
   * `MAX_INSTANCES_PER_STRUCT` instances; `count` is a lower bound then.
   */
  user_held_types?: Array<{ type: string; count: number; truncated: boolean }>;
  /**
   * Authority-named struct types whose instance scan failed outright (a
   * timeout, a 429 after retries). Absence here is not evidence the type has
   * no live instances: the scan never completed.
   */
  incomplete_scans?: Array<{ type: string; reason: string }>;
  note?: string;
}

/** UpgradeCap.policy (u8) → human label. Higher = more restrictive. */
function upgradePolicyLabel(policy: number | undefined): string {
  switch (policy) {
    case 0: return "compatible (any upgrade)";
    case 128: return "additive-only";
    case 192: return "dependency-only";
    case 255: return "immutable";
    default: return `unknown (${policy})`;
  }
}

const ADDR2 = "0x0000000000000000000000000000000000000000000000000000000000000002";

/** Classify a struct type as a capability kind, or null if it isn't cap-like. */
export function classifyCapType(repr: string): CapKind | null {
  const base = repr.split("<")[0]; // strip generics
  if (base === `${ADDR2}::package::UpgradeCap`) return "upgrade";
  if (base === `${ADDR2}::coin::TreasuryCap`) return "treasury";
  if (base === `${ADDR2}::coin::DenyCap` || base === `${ADDR2}::coin::DenyCapV2`) return "deny";
  const last = base.split("::").pop() ?? "";
  if (last.endsWith("Cap")) return "admin";
  return null;
}

/**
 * Assess the risk of a capability given its kind, current owner, and (for
 * upgrade caps) its policy. Pure — the security opinion lives here so it's
 * unit-testable without the chain.
 */
export function classifyCapabilityRisk(input: {
  kind: CapKind;
  type: string;
  owner: OwnerKind;
  ownerAddress?: string;
  policyLabel?: string;
}): { risk: CapRisk; note: string } {
  const { kind, type, owner, ownerAddress, policyLabel } = input;
  // A party object has exactly one owner, so it is held the way an
  // address-owned object is. Reading it as shared would say anyone might
  // reach a capability that only its owner can use.
  //
  // An address nobody holds a key for is a different case from either:
  // the object still exists and is still owned in the ordinary sense, but
  // nobody can sign a transaction that uses it. A TreasuryCap the publish
  // transaction created already owned by 0x0 cannot mint, so reporting it as
  // a live mint risk names the wrong danger.
  const unspendable = (owner === "address" || owner === "consensus") && !!ownerAddress && isUnspendableAddress(ownerAddress);
  const held = (owner === "address" || owner === "consensus") && !unspendable;
  const who = ownerAddress
    ? owner === "consensus"
      ? `${ownerAddress} (a party object: one owner, transactions ordered through consensus)`
      : ownerAddress
    : owner;
  const shortType = type.split("::").slice(-2).join("::").split("<")[0];

  if (kind === "upgrade") {
    if (owner === "burned") {
      return { risk: "info", note: "UpgradeCap has been destroyed — the package is immutable and can never be changed." };
    }
    if (unspendable) {
      return {
        risk: "info",
        note: `UpgradeCap was sent to ${ownerAddress}, an address nobody holds a key for — upgrade rights are effectively renounced even though the object still exists.`,
      };
    }
    if (policyLabel === "immutable") {
      return { risk: "low", note: "UpgradeCap policy is immutable — the package can no longer be upgraded." };
    }
    if (held) {
      return {
        risk: "high",
        note: `Package is upgradeable by ${who} (policy: ${policyLabel}). A malicious or compromised upgrade could change any logic in this package.`,
      };
    }
    if (owner === "shared") {
      return { risk: "medium", note: `UpgradeCap is a shared object (likely governance) with policy ${policyLabel} — review who can authorize an upgrade.` };
    }
    return { risk: "medium", note: `UpgradeCap owner is ${owner} (policy: ${policyLabel}).` };
  }

  if (kind === "treasury") {
    if (owner === "burned") {
      return { risk: "info", note: `Mint authority (${shortType}) has been renounced — token supply is fixed.` };
    }
    if (unspendable) {
      return {
        risk: "info",
        note: `Mint authority (${shortType}) was sent to ${ownerAddress}, an address nobody holds a key for — no key can sign to mint, so supply is effectively fixed even though the object still exists.`,
      };
    }
    if (held) {
      return { risk: "high", note: `Mint authority (${shortType}) is held by ${who} — new tokens can be minted at will (inflation / rug risk).` };
    }
    if (owner === "shared") {
      return { risk: "medium", note: `Mint authority (${shortType}) is a shared object — review who can mint.` };
    }
    return { risk: "medium", note: `Mint authority (${shortType}) owner is ${owner}.` };
  }

  if (kind === "deny") {
    if (owner === "burned") return { risk: "info", note: `Deny/freeze authority (${shortType}) has been destroyed.` };
    if (unspendable) {
      return {
        risk: "info",
        note: `Denylist/freeze authority (${shortType}) was sent to ${ownerAddress}, an address nobody holds a key for — freeze authority is effectively renounced.`,
      };
    }
    if (held) {
      return { risk: "medium", note: `Denylist/freeze authority (${shortType}) is held by ${who} — can freeze addresses or block transfers of this coin.` };
    }
    return { risk: "low", note: `Denylist/freeze authority (${shortType}) owner is ${owner}.` };
  }

  // admin / other *Cap
  if (owner === "burned") return { risk: "info", note: `Capability ${shortType} has been destroyed.` };
  if (unspendable) {
    return {
      risk: "info",
      note: `Capability ${shortType} was sent to ${ownerAddress}, an address nobody holds a key for — effectively renounced even though the object still exists.`,
    };
  }
  if (held) {
    return { risk: "low", note: `Privileged capability ${shortType} is held by ${who} — review what powers it grants.` };
  }
  return { risk: "info", note: `Capability ${shortType} owner is ${owner}.` };
}

// ---- on-chain lookup ----

interface PublishScanResult {
  package: {
    packageAt: {
      previousTransaction: {
        effects: {
          objectChanges: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{
              idCreated: boolean;
              outputState: { address: string; asMoveObject: { contents: { type: { repr: string } } | null } | null } | null;
            }>;
          };
        } | null;
      } | null;
    } | null;
  } | null;
}

const PUBLISH_SCAN_QUERY = `query ($p: SuiAddress!, $after: String) {
  package(address: $p) {
    packageAt(version: 1) {
      previousTransaction {
        effects {
          objectChanges(first: 50, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              idCreated
              outputState { address asMoveObject { contents { type { repr } } } }
            }
          }
        }
      }
    }
  }
}`;

interface CapStateResult {
  object: {
    owner: { __typename: string; address?: { address: string } } | null;
    asMoveObject: { contents: { json: Record<string, unknown> | null } | null } | null;
  } | null;
}

const CAP_STATE_QUERY = `query ($id: SuiAddress!) {
  object(address: $id) {
    owner {
      __typename
      ... on AddressOwner { address { address } }
      ... on ConsensusAddressOwner { address { address } }
    }
    asMoveObject { contents { json } }
  }
}`;

function ownerKindOf(typename: string | undefined): OwnerKind {
  switch (typename) {
    case "AddressOwner": return "address";
    case "ConsensusAddressOwner": return "consensus";
    case "Shared": return "shared";
    case "Immutable": return "immutable";
    default: return "unknown";
  }
}

/** Struct names already classified by `classifyCapType`; the authority scan below skips them. */
const STANDARD_CAP_NAMES = /^(TreasuryCap|DenyCap|DenyCapV2|UpgradeCap|CoinMetadata)$/;
/** A struct name that marks its holder as an authority over the package. */
const AUTHORITY_NAME = /(Cap|Admin|Operator|Owner|Manager|Authority)$/;
/**
 * A struct name that names a protocol-level authority rather than a per-user
 * object. DeepBook's `TradeCap`/`DepositCap`, 0x2's `KioskOwnerCap` and
 * Suilend's `ObligationOwnerCap` all end in `Cap`/`Owner` and every user of
 * the protocol holds one; `Admin`/`Operator`/`Authority` names do not have
 * that per-user shape. Ranked first so the 12-type cap below keeps them over
 * a package with more generic `*Cap`/`*Owner`/`*Manager` types than fit.
 */
const STRONG_AUTHORITY_NAME = /(Admin|Operator|Authority)/;

/** A package's modules, reduced to what finding authority structs needs. */
export interface CapCandidateModule {
  name: string;
  structs: { name: string; abilities: string[] }[];
}

/**
 * Every `key`-ability struct in the package whose name marks it as an
 * authority (`Cap`, `Admin`, `Operator`, `Owner`, `Manager`, `Authority`),
 * excluding the framework types `classifyCapType` already recognizes.
 *
 * The publish-transaction scan below only finds capabilities minted at
 * publish time. A cap minted in a later transaction and handed to one key is
 * invisible to that scan, so this walks the package's own struct definitions
 * instead of waiting for a cap to turn up in a transaction.
 */
export function findAuthorityStructs(modules: CapCandidateModule[]): Array<{ module: string; name: string }> {
  const out: Array<{ module: string; name: string }> = [];
  for (const m of modules) {
    for (const s of m.structs) {
      if (!s.abilities.includes("key")) continue;
      if (STANDARD_CAP_NAMES.test(s.name)) continue;
      if (!AUTHORITY_NAME.test(s.name)) continue;
      out.push({ module: m.name, name: s.name });
    }
  }
  // Array#sort is stable, so within each rank package/module order is kept.
  out.sort((a, b) => Number(STRONG_AUTHORITY_NAME.test(b.name)) - Number(STRONG_AUTHORITY_NAME.test(a.name)));
  return out;
}

/** A package with more authority-named struct types than this is scanned partially, not skipped. */
const MAX_AUTHORITY_STRUCTS = 12;
/** Live instances read per authority struct type. A count at this limit is a sample, not a full list. */
const MAX_INSTANCES_PER_STRUCT = 50;
/**
 * More instances than this, or hitting the scan cap above, means the type is
 * held one-per-user (DeepBook v3's `balance_manager::{BalanceManager,
 * TradeCap, DepositCap, WithdrawCap}`, one per trader) rather than by a small
 * number of protocol authorities, so it is reported as a count instead of one
 * entry per holder. An operator cap held by a small team stays under this
 * line and is still listed individually.
 */
const USER_HELD_MIN_INSTANCES = 20;

interface TypeInstancesResult {
  objects: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ address: string; owner: { __typename: string; address?: { address: string } } | null }>;
  };
}

const TYPE_INSTANCES_QUERY = `query ($t: String!, $after: String) {
  objects(filter: { type: $t }, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      address
      owner {
        __typename
        ... on AddressOwner { address { address } }
        ... on ConsensusAddressOwner { address { address } }
      }
    }
  }
}`;

/** A `key`-ability struct instance found live on chain, and its current owner. */
export interface CapInstance {
  id: string;
  owner: OwnerKind;
  owner_address?: string;
}

export interface ScanTypeInstancesResult {
  instances: CapInstance[];
  truncated: boolean;
}

/** Every live instance of `type`, up to `MAX_INSTANCES_PER_STRUCT`. */
async function scanTypeInstances(type: string): Promise<ScanTypeInstancesResult> {
  const instances: CapInstance[] = [];
  let after: string | undefined;
  let scanned = 0;
  while (scanned < MAX_INSTANCES_PER_STRUCT) {
    const data: TypeInstancesResult = await gqlQuery<TypeInstancesResult>(TYPE_INSTANCES_QUERY, { t: type, after });
    for (const n of data.objects.nodes) {
      instances.push({ id: n.address, owner: ownerKindOf(n.owner?.__typename), owner_address: n.owner?.address?.address });
    }
    scanned += data.objects.nodes.length;
    if (!data.objects.pageInfo.hasNextPage) return { instances, truncated: false };
    after = data.objects.pageInfo.endCursor ?? undefined;
    if (!after) return { instances, truncated: true };
  }
  return { instances, truncated: true };
}

/**
 * Audit the capabilities of a package. Best-effort: if the publish transaction
 * is unavailable (pruned) or GraphQL fails, returns { checked: false } with a
 * note rather than throwing, because capability info should never break
 * analyze_package.
 *
 * Two ways a capability is found: the package's publish transaction (the
 * common case: UpgradeCap always, plus caps created in module `init`), and,
 * when the caller passes `modules`, every other `key`-ability struct whose
 * name marks it as an authority, whether or not a live instance was minted at
 * publish. The second pass finds a cap minted after publish, such as an
 * OperatorCap handed to one address.
 */
export async function auditPackageCapabilities(
  packageId: string,
  /**
   * The address that published the lineage ROOT (version 1), when the caller
   * already resolved it.
   *
   * The caps scanned here are the ones version 1's publish transaction
   * minted, so that publisher is the only one they can be compared against.
   * The sender of a later version's upgrade is whoever held the cap at the
   * time; comparing against it would report a cap that has since left the
   * deployer as still held by the publisher. Passed in rather than looked up
   * here so `analyze_package` does not resolve it twice.
   */
  publisher?: string | null,
  /** The package's own modules, for the authority-struct scan. Omit to skip it. */
  modules?: CapCandidateModule[],
): Promise<CapabilityAudit> {
  // 1. Scan the publish tx for created cap-like objects (paginating a few pages).
  const capObjects: Array<{ id: string; type: string; kind: CapKind; knownOwner?: { owner: OwnerKind; ownerAddress?: string } }> = [];
  let after: string | null = null;
  let pages = 0;
  try {
    for (; pages < 6; pages++) {
      const data: PublishScanResult = await gqlQuery<PublishScanResult>(PUBLISH_SCAN_QUERY, { p: packageId, after });
      const changes = data.package?.packageAt?.previousTransaction?.effects?.objectChanges;
      if (!changes) {
        return { checked: false, capabilities: [], note: "Publish transaction unavailable (pruned or not found) — cannot audit capabilities." };
      }
      for (const n of changes.nodes) {
        const repr = n.outputState?.asMoveObject?.contents?.type?.repr;
        const id = n.outputState?.address;
        if (!n.idCreated || !repr || !id) continue;
        const kind = classifyCapType(repr);
        if (kind) capObjects.push({ id, type: repr, kind });
      }
      if (!changes.pageInfo.hasNextPage) break;
      after = changes.pageInfo.endCursor;
    }
  } catch (err) {
    return { checked: false, capabilities: [], note: `Capability audit failed: ${(err as Error).message}` };
  }

  // 1b. Every other authority-named struct the package defines, whether or
  // not a live instance was minted at publish. Object ids the publish scan
  // already found are not duplicated. A type held one-per-user (more than
  // USER_HELD_MIN_INSTANCES live instances, or the scan hit its cap) is
  // reported as a count in `user_held_types` instead of one `capObjects`
  // entry per holder: DeepBook's `TradeCap`, 0x2's `KioskOwnerCap` and
  // Suilend's `ObligationOwnerCap` all match `AUTHORITY_NAME` and every user
  // of the protocol holds one. A struct whose scan fails is reported in
  // `incompleteScans` rather than silently dropped: the answer must say the
  // check did not run, never render identically to "no such capability".
  let structsSkipped = 0;
  const userHeldTypes: Array<{ type: string; count: number; truncated: boolean }> = [];
  const incompleteScans: Array<{ type: string; reason: string }> = [];
  if (modules?.length) {
    const seen = new Set(capObjects.map((c) => c.id));
    const candidates = findAuthorityStructs(modules);
    structsSkipped = Math.max(0, candidates.length - MAX_AUTHORITY_STRUCTS);
    const scanned = candidates.slice(0, MAX_AUTHORITY_STRUCTS);
    // A struct may have been defined by an earlier version, and an object is
    // indexed under the id that defined its type (the rule an event's type
    // follows), so a scan under the requested id finds nothing. The origins
    // are read once for every candidate; when that read fails, every
    // candidate is reported unscanned rather than scanned under an id that
    // may be wrong and read as "no such capability".
    let origins: TypeOrigin[] | null = null;
    let originsError: string | null = null;
    if (scanned.length) {
      try {
        origins = await fetchTypeOrigins(packageId);
      } catch (err) {
        originsError = (err as Error).message;
      }
    }
    await Promise.all(
      scanned.map(async ({ module, name }) => {
        const requested = `${packageId}::${module}::${name}`;
        if (originsError !== null) {
          incompleteScans.push({
            type: requested,
            reason: `type origins unreadable (${originsError}), so the package version defining this struct is unknown`,
          });
          return;
        }
        const definingId = origins?.find((o) => o.module === module && o.struct === name)?.definingId;
        const type =
          definingId && normalizeSuiAddress(definingId) !== normalizeSuiAddress(packageId)
            ? `${normalizeSuiAddress(definingId)}::${module}::${name}`
            : requested;
        let scan: ScanTypeInstancesResult;
        try {
          scan = await scanTypeInstances(type);
        } catch (err) {
          incompleteScans.push({ type, reason: (err as Error).message });
          return;
        }
        if (scan.instances.length > USER_HELD_MIN_INSTANCES || scan.truncated) {
          userHeldTypes.push({ type, count: scan.instances.length, truncated: scan.truncated });
          return;
        }
        for (const inst of scan.instances) {
          if (seen.has(inst.id)) continue;
          seen.add(inst.id);
          // The scan already read each instance's current owner live, so
          // reusing it here skips an otherwise-redundant CAP_STATE_QUERY per
          // instance (up to MAX_AUTHORITY_STRUCTS * MAX_INSTANCES_PER_STRUCT
          // of them).
          capObjects.push({ id: inst.id, type, kind: "admin", knownOwner: { owner: inst.owner, ownerAddress: inst.owner_address } });
        }
      }),
    );
  }

  // 2. Resolve each cap's current state (owner / policy / burned) in
  // parallel, except one already known from the authority-struct scan
  // above, which read it live moments ago.
  const capabilities = await Promise.all(
    capObjects.map(async ({ id, type, kind, knownOwner }): Promise<CapabilityInfo> => {
      let owner: OwnerKind = "unknown";
      let ownerAddress: string | undefined;
      let policyLabel: string | undefined;
      if (knownOwner) {
        owner = knownOwner.owner;
        ownerAddress = knownOwner.ownerAddress;
      } else {
        try {
          const state: CapStateResult = await gqlQuery<CapStateResult>(CAP_STATE_QUERY, { id });
          if (!state.object) {
            owner = "burned"; // object no longer exists → destroyed
          } else {
            owner = ownerKindOf(state.object.owner?.__typename);
            ownerAddress = state.object.owner?.address?.address;
            if (kind === "upgrade") {
              const policy = state.object.asMoveObject?.contents?.json?.policy;
              policyLabel = upgradePolicyLabel(typeof policy === "number" ? policy : undefined);
            }
          }
        } catch {
          owner = "unknown";
        }
      }
      const { risk, note } = classifyCapabilityRisk({ kind, type, owner, ownerAddress, policyLabel });

      // An UpgradeCap's holder means nothing on its own. Compared against the
      // publisher it says whether upgrade authority changed hands, which is
      // the question worth asking about the most consequential capability on
      // the chain. Skipped when the object itself is gone: `assessCapHolder`
      // reads a missing holder as "shared, immutable or wrapped", which is
      // wrong for a cap that was destroyed outright and already has its own
      // note above.
      const held = kind === "upgrade" && owner !== "burned" ? assessCapHolder(ownerAddress, publisher) : null;

      return {
        kind,
        type,
        object_id: id,
        owner,
        ...(ownerAddress ? { owner_address: ownerAddress } : {}),
        ...(policyLabel ? { upgrade_policy: policyLabel } : {}),
        ...(held ? { holder_status: held.status } : {}),
        ...(held?.publisher ? { publisher: held.publisher } : {}),
        risk,
        // The holder assessment is appended rather than replacing the risk
        // note: the two say different things, and a burn is the one case where
        // the cap being elsewhere makes the package SAFER.
        note: held ? `${note} ${held.note}` : note,
      };
    }),
  );

  // 3. Signing scheme for every held cap, one batched identity lookup.
  const ownerAddrs = [...new Set(capabilities.filter((c) => c.owner_address).map((c) => c.owner_address!))];
  if (ownerAddrs.length) {
    const identities = await describeAddresses(ownerAddrs, { authentication: true }).catch(() => new Map());
    for (const cap of capabilities) {
      const id = cap.owner_address ? identities.get(cap.owner_address) : undefined;
      if (id?.authentication) cap.signing_scheme = schemeLabel(id.authentication);
    }
  }

  // Most-severe first.
  const order: Record<CapRisk, number> = { high: 0, medium: 1, low: 2, info: 3 };
  capabilities.sort((a, b) => order[a.risk] - order[b.risk]);

  const noteParts: string[] = [];
  if (structsSkipped > 0) {
    noteParts.push(
      `${structsSkipped} additional authority-named struct type(s) were not scanned (capped at ${MAX_AUTHORITY_STRUCTS}); their instances may be missing.`,
    );
  }
  if (incompleteScans.length) {
    noteParts.push(
      `${incompleteScans.length} authority-named struct type(s) could not be scanned: ${incompleteScans
        .map((s) => s.type.split("::").slice(-2).join("::"))
        .join(", ")}. Their instances may be missing from this audit — see incomplete_scans.`,
    );
  }

  return {
    checked: true,
    capabilities,
    ...(userHeldTypes.length ? { user_held_types: userHeldTypes } : {}),
    ...(incompleteScans.length ? { incomplete_scans: incompleteScans } : {}),
    ...(noteParts.length ? { note: noteParts.join(" ") } : {}),
  };
}
