import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { assessCapHolder, isUnspendableAddress, type CapHolderStatus } from "./upgrade-cap.js";
import { fetchTypeOrigins, type TypeOrigin } from "./package-versions.js";
import { describeAddresses } from "./identity.js";
import { schemeLabel } from "./upgrade-history.js";
import { readObjectEnd } from "./object-end.js";
import { readDerivedCurrencies, readRegistryCurrency, type RegistryCurrency, type SupplyState } from "./onchain-coin-registry.js";
import { normalizeCoinType } from "./coin-registry.js";

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
 *
 * `burned` means the object was deleted. `wrapped` means it stopped existing
 * at top level because a transaction stored it inside another object: it is
 * still live, and whatever code owns the wrapper can use it.
 */
export type OwnerKind = "address" | "consensus" | "shared" | "immutable" | "burned" | "wrapped" | "unknown";
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
  /** `wrapped` only: the transaction that stored the cap inside another object. */
  wrapped_in_tx?: string;
  /**
   * TreasuryCap only, when the publish transaction did not create it: how it
   * was found. `coin_registry` is the id `coin_registry::Currency<T>` records,
   * `type_scan` a live top-level object of type `TreasuryCap<T>`.
   */
  found_by?: "coin_registry" | "type_scan";
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
   * Struct types a scan could not complete: an authority-named type whose
   * instance scan failed outright (a timeout, a 429 after retries), or a
   * `key` struct that could not be checked for a coin. Absence here is not
   * evidence the type has no live instances or no coin: the check never
   * completed.
   */
  incomplete_scans?: Array<{ type: string; reason: string }>;
  /**
   * Coin types the package defines whose TreasuryCap was not located, each
   * with what was checked. Mint authority for these is unknown unless the
   * reason says the registry holds the supply.
   */
  coins_without_located_mint_authority?: UnlocatedMintAuthority[];
  note?: string;
}

/** A coin the package defines whose TreasuryCap was not found. */
export interface UnlocatedMintAuthority {
  coin_type: string;
  risk: CapRisk;
  reason: string;
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
  /** `wrapped` only: the transaction that stored the cap inside another object. */
  wrappedInTx?: string;
  /** The cap no longer exists at top level. */
  gone?: boolean;
  /** `burned` TreasuryCap only: the on-chain coin registry's supply state, or `unread` when the read failed. */
  supplyState?: SupplyState | "unread";
}): { risk: CapRisk; note: string } {
  const { kind, type, owner, ownerAddress, policyLabel, wrappedInTx, gone, supplyState } = input;
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
  const shortType = type.replace(/>+$/, "").split("::").slice(-2).join("::").split("<")[0];
  const capName = type.split("<")[0].split("::").slice(-2).join("::");
  const inside = `stored inside another object${wrappedInTx ? ` by transaction ${wrappedInTx}` : ""}, not destroyed`;

  if (owner === "unknown" && gone) {
    return {
      // An admin cap reads low when wrapped and info when destroyed.
      risk: kind === "admin" ? "low" : "medium",
      note: `${capName}${type.includes("<") ? ` for ${shortType}` : ""} no longer exists at top level. Whether it was destroyed or stored inside another object could not be read.`,
    };
  }

  if (kind === "upgrade") {
    if (owner === "burned") {
      return { risk: "info", note: "UpgradeCap has been destroyed — the package is immutable and can never be changed." };
    }
    if (owner === "wrapped") {
      return {
        risk: "medium",
        note: `UpgradeCap was ${inside}. The module that owns the wrapper decides who can upgrade (a governance or timelock contract, or custody); read that object and its code.`,
      };
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
      return {
        risk: "high",
        note: `UpgradeCap is a shared object (policy: ${policyLabel ?? "unread"}). package::authorize_upgrade and commit_upgrade are public and take the cap by &mut, and any transaction can pass a shared object that way, so anyone can upgrade this package.`,
      };
    }
    if (owner === "immutable") {
      return {
        risk: "info",
        note: "UpgradeCap is frozen. package::authorize_upgrade and commit_upgrade take it by &mut, which a frozen object cannot give, so nobody can upgrade this package.",
      };
    }
    return { risk: "medium", note: `UpgradeCap owner is ${owner}${policyLabel ? ` (policy: ${policyLabel})` : ""}.` };
  }

  if (kind === "treasury") {
    if (owner === "burned") {
      // Deleting a TreasuryCap always leaves its Supply<T>: `balance::destroy_supply`
      // is package-private. `coin_registry::make_supply_fixed` and
      // `make_supply_burn_only` store it where nothing can mint; anywhere else,
      // `balance::increase_supply` mints through it.
      if (supplyState === "fixed") {
        return { risk: "info", note: `The TreasuryCap for ${shortType} was destroyed and the on-chain coin registry records its supply as fixed.` };
      }
      if (supplyState === "burn_only") {
        return { risk: "info", note: `The TreasuryCap for ${shortType} was destroyed and the on-chain coin registry records its supply as burn-only: it can only decrease.` };
      }
      if (supplyState === "unread") {
        return {
          risk: "medium",
          note: `The TreasuryCap for ${shortType} was destroyed. Destroying it leaves its Supply, which can still mint for whatever holds it, and the on-chain coin registry could not be read to tell whether that Supply was fixed.`,
        };
      }
      return {
        risk: "medium",
        note: `The TreasuryCap for ${shortType} was destroyed, and the on-chain coin registry does not record its supply as fixed. Destroying the cap leaves its Supply, which can still mint through balance::increase_supply for whatever holds it; supply is fixed only if that holder's module cannot mint with it.`,
      };
    }
    if (owner === "wrapped") {
      return {
        risk: "medium",
        note: `Mint authority (${shortType}) was ${inside}. Supply is fixed only if the module owning the wrapper cannot mint with it and cannot be upgraded into code that can; read that module and who holds its UpgradeCap.`,
      };
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
      return {
        risk: "high",
        note: `Mint authority (${shortType}) is a shared object. coin::mint and mint_balance are public and take the cap by &mut, and any transaction can pass a shared object that way, so anyone can mint this coin.`,
      };
    }
    if (owner === "immutable") {
      return {
        risk: "medium",
        note: `Mint authority (${shortType}) is frozen. Minting needs it by &mut, so supply is fixed, but coin::update_name, update_symbol, update_description and update_icon_url, coin_registry::claim_metadata_cap and token::new_policy take it by &, so anyone can change this coin's metadata where it is not frozen or claimed, and create its token policy.`,
      };
    }
    return { risk: "medium", note: `Mint authority (${shortType}) owner is ${owner}.` };
  }

  if (kind === "deny") {
    if (owner === "burned") return { risk: "info", note: `Deny/freeze authority (${shortType}) has been destroyed.` };
    if (owner === "wrapped") {
      return { risk: "medium", note: `Denylist/freeze authority (${shortType}) was ${inside}; the module owning the wrapper decides who can freeze.` };
    }
    if (unspendable) {
      return {
        risk: "info",
        note: `Denylist/freeze authority (${shortType}) was sent to ${ownerAddress}, an address nobody holds a key for — freeze authority is effectively renounced.`,
      };
    }
    if (held) {
      return { risk: "medium", note: `Denylist/freeze authority (${shortType}) is held by ${who} — can freeze addresses or block transfers of this coin.` };
    }
    if (owner === "shared") {
      return {
        risk: "high",
        note: `Denylist/freeze authority (${shortType}) is a shared object. coin::deny_list_v2_add and deny_list_add are public and take the cap by &mut, and any transaction can pass a shared object that way, so anyone can freeze holders of this coin.`,
      };
    }
    if (owner === "immutable") {
      return {
        risk: "info",
        note: `Denylist/freeze authority (${shortType}) is frozen. coin::deny_list_v2_add and deny_list_add take it by &mut, which a frozen object cannot give, so nobody can freeze holders with it.`,
      };
    }
    return { risk: "low", note: `Denylist/freeze authority (${shortType}) owner is ${owner}.` };
  }

  // admin / other *Cap
  if (owner === "burned") return { risk: "info", note: `Capability ${shortType} has been destroyed.` };
  if (owner === "wrapped") return { risk: "low", note: `Capability ${shortType} was ${inside}; the module owning the wrapper decides who can use it.` };
  if (unspendable) {
    return {
      risk: "info",
      note: `Capability ${shortType} was sent to ${ownerAddress}, an address nobody holds a key for — effectively renounced even though the object still exists.`,
    };
  }
  if (held) {
    return { risk: "low", note: `Privileged capability ${shortType} is held by ${who} — review what powers it grants.` };
  }
  if (owner === "shared" || owner === "immutable") {
    return {
      risk: "low",
      note:
        owner === "shared"
          ? `Capability ${shortType} is a shared object: any transaction can pass it to the functions that take it. What that grants depends on each function's own checks; read the ones that take this type.`
          : `Capability ${shortType} is frozen: any transaction can pass it to the functions that take it by &, which is how most capability checks are written. What that grants depends on each function's own checks; read the ones that take this type.`,
    };
  }
  return { risk: "info", note: `Capability ${shortType} owner is ${owner}.` };
}

// ---- on-chain lookup ----

interface PublishScanResult {
  package: {
    packageAt: {
      address?: string;
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
      address
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

/** A package's modules, reduced to what finding authority structs and coin types needs. */
export interface CapCandidateModule {
  name: string;
  structs: { name: string; abilities: string[]; typeParameters?: number }[];
  /** Each function's parameter types, as `analyze_package` formats them. */
  functions?: { params: string[] }[];
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

/** A capability found by one of the scans, before step 2 reads its state. */
interface CapObject {
  id: string;
  type: string;
  kind: CapKind;
  /** State the scan that found it already read, so step 2 does not read it again. */
  known?: { owner: OwnerKind; ownerAddress?: string; gone?: boolean; supplyState?: SupplyState };
  foundBy?: CapabilityInfo["found_by"];
}

/** An object whose type argument is a coin type. One created in the publish transaction shows a coin of that type exists. */
const COIN_OBJECT = /^0x0*2::(?:coin::(?:CoinMetadata|TreasuryCap|Coin)|coin_registry::Currency)<(.+)>$/;

/** The coin type a `TreasuryCap`, `CoinMetadata`, `Coin` or registry `Currency` is for, canonical, or null for any other type. */
function coinTypeOf(repr: string): string | null {
  const m = COIN_OBJECT.exec(repr);
  return m ? normalizeCoinType(m[1]) : null;
}

/**
 * After publish, a coin of a package's own type comes only from
 * `coin_registry::new_currency<T: key>`, which the module defining `T` calls:
 * `init` never runs for a module an upgrade adds, and a one-time witness
 * cannot be packed, so every coin made through a one-time witness shows in
 * version 1's publish effects. Every non-generic `key` struct is therefore a
 * candidate, checked at its derived registry id.
 */
const MAX_REGISTRY_PROBES = 200;

/**
 * `new_currency` takes `&mut CoinRegistry`, a shared object a function can
 * only receive as a parameter. A generic `key` struct in a package with no
 * such function cannot become a coin through this version's code.
 */
const COIN_REGISTRY_PARAM = /0x0*2::coin_registry::CoinRegistry\b/;

/**
 * Find the `TreasuryCap<T>` of a coin the publish transaction did not show
 * holding one: the id the on-chain registry records (`knownRegistry` when
 * the caller already read the entry), then any live top-level object of that
 * type. When neither finds it, the answer says what was checked. A cap stored
 * inside another object when it was created never exists at top level and is
 * absent from both, so an empty search leaves mint authority unknown rather
 * than renounced.
 */
async function locateTreasuryCap(
  coinType: string,
  knownRegistry?: RegistryCurrency,
): Promise<{ caps: CapObject[] } | { unlocated: UnlocatedMintAuthority }> {
  const capType = `${ADDR2}::coin::TreasuryCap<${coinType}>`;
  const short = coinType.split("::").slice(-2).join("::");
  const checked: string[] = [];

  let registry: RegistryCurrency | null = knownRegistry ?? null;
  if (!registry) {
    try {
      registry = await readRegistryCurrency(coinType);
      if (!registry) checked.push("the on-chain coin registry has no entry for it");
    } catch (err) {
      checked.push(`the on-chain coin registry could not be read (${(err as Error).message})`);
    }
  }
  if (registry) {
    // `make_supply_fixed` and `make_supply_burn_only` take the cap by value
    // and turn it into the registry's Supply, so a Fixed or BurnOnly entry
    // means the cap no longer exists and nothing can mint.
    const consumed = registry.supply === "fixed" || registry.supply === "burn_only" ? registry.supply : null;
    if (registry.treasury_cap_id) {
      return {
        caps: [
          {
            id: registry.treasury_cap_id,
            type: capType,
            kind: "treasury",
            foundBy: "coin_registry",
            ...(consumed ? { known: { owner: "burned" as const, gone: true, supplyState: consumed } } : {}),
          },
        ],
      };
    }
    if (consumed) {
      return {
        unlocated: {
          coin_type: coinType,
          risk: "info",
          reason: `The on-chain coin registry names no TreasuryCap for ${short} but records its supply as ${consumed === "fixed" ? "fixed" : "burn-only"}. Recording that consumes the cap, so nothing can mint.`,
        },
      };
    }
    checked.push("the on-chain coin registry's entry names no TreasuryCap");
  }

  try {
    const scan = await scanTypeInstances(capType);
    if (scan.instances.length) {
      return {
        caps: scan.instances.map((inst) => ({
          id: inst.id,
          type: capType,
          kind: "treasury" as const,
          foundBy: "type_scan" as const,
          known: { owner: inst.owner, ownerAddress: inst.owner_address },
        })),
      };
    }
    checked.push(`no top-level TreasuryCap<${short}> exists`);
  } catch (err) {
    checked.push(`the search for a top-level TreasuryCap<${short}> failed (${(err as Error).message})`);
  }

  return {
    unlocated: {
      coin_type: coinType,
      risk: "medium",
      reason: `Mint authority for ${short} was not located: ${checked.join("; ")}. The TreasuryCap may be stored inside another object, at creation or later, or turned into a Supply kept inside one, and whatever module owns that object decides who can mint. Who can mint is unknown.`,
    },
  };
}

/**
 * Audit the capabilities of a package. Best-effort: if the publish transaction
 * is unavailable (pruned) or GraphQL fails, returns { checked: false } with a
 * note rather than throwing, because capability info should never break
 * analyze_package.
 *
 * Three ways a capability is found: the package's publish transaction (the
 * common case: UpgradeCap always, plus caps created in module `init`), and,
 * when the caller passes `modules`, every other `key`-ability struct whose
 * name marks it as an authority, whether or not a live instance was minted at
 * publish. The second pass finds a cap minted after publish, such as an
 * OperatorCap handed to one address. The third looks for the TreasuryCap of
 * every coin the package defines that the publish transaction did not show at
 * top level, and names each coin whose cap it cannot find.
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
  // 1. Scan the publish tx for created cap-like objects (paginating a few pages),
  // and for the coins it created: a CoinMetadata, TreasuryCap, Coin or
  // registry Currency of a type this package defines.
  const capObjects: CapObject[] = [];
  const publishedCoins = new Set<string>();
  let rootId = normalizeSuiAddress(packageId);
  let after: string | null = null;
  let pages = 0;
  try {
    for (; pages < 6; pages++) {
      const data: PublishScanResult = await gqlQuery<PublishScanResult>(PUBLISH_SCAN_QUERY, { p: packageId, after });
      const published = data.package?.packageAt;
      const changes = published?.previousTransaction?.effects?.objectChanges;
      if (!changes) {
        return { checked: false, capabilities: [], note: "Publish transaction unavailable (pruned or not found) — cannot audit capabilities." };
      }
      if (published?.address) rootId = normalizeSuiAddress(published.address);
      for (const n of changes.nodes) {
        const repr = n.outputState?.asMoveObject?.contents?.type?.repr;
        const id = n.outputState?.address;
        if (!n.idCreated || !repr || !id) continue;
        const kind = classifyCapType(repr);
        if (kind) capObjects.push({ id, type: repr, kind });
        const coin = coinTypeOf(repr);
        if (coin) publishedCoins.add(coin);
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
  // Read at most once, by whichever scan below needs it first.
  let originsRead: Promise<TypeOrigin[] | null> | undefined;
  const readOrigins = () => (originsRead ??= fetchTypeOrigins(packageId));
  const seen = new Set(capObjects.map((c) => c.id));
  if (modules?.length) {
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
        origins = await readOrigins();
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
          capObjects.push({ id: inst.id, type, kind: "admin", known: { owner: inst.owner, ownerAddress: inst.owner_address } });
        }
      }),
    );
  }

  // 1c. Mint authority for every coin the package defines. The publish
  // transaction shows the coins version 1's `init` created; a `key` struct
  // with a registry entry at its derived id adds one `new_currency` created
  // later. Only coins of this lineage's own types count: a coin another
  // package's call created in the same transaction is that package's.
  let registryProbesSkipped = 0;
  const coinTypes = new Set([...publishedCoins].filter((t) => t.startsWith(`${rootId}::`)));
  const registryEntries = new Map<string, RegistryCurrency>();
  if (modules?.length) {
    const keyStructs = modules.flatMap((m) => m.structs.filter((s) => s.abilities.includes("key")).map((s) => ({ module: m.name, ...s })));
    // The registry id depends on the type argument, so a generic struct's
    // coins cannot be derived. Named only where this version's code can
    // reach `new_currency` at all.
    if (modules.some((m) => m.functions?.some((f) => f.params.some((p) => COIN_REGISTRY_PARAM.test(p))))) {
      for (const s of keyStructs.filter((k) => (k.typeParameters ?? 0) > 0)) {
        incompleteScans.push({
          type: `${packageId}::${s.module}::${s.name}`,
          reason:
            "a generic key struct in a package whose functions take the CoinRegistry: coin_registry::new_currency can make a coin of any instantiation of it, and no coin of this type was looked up, since a registry entry's id depends on the type argument",
        });
      }
    }
    let plain = keyStructs.filter((k) => !(k.typeParameters ?? 0));
    // Version 1 defines every struct it has, so only a later version needs the origins.
    let origins: TypeOrigin[] | null = null;
    if (plain.length && normalizeSuiAddress(packageId) !== rootId) {
      try {
        origins = await readOrigins();
      } catch (err) {
        for (const s of plain) {
          incompleteScans.push({
            type: `${packageId}::${s.module}::${s.name}`,
            reason: `type origins unreadable (${(err as Error).message}), so whether this struct is a coin was not checked`,
          });
        }
        plain = [];
      }
    }
    const candidates = plain
      .map((s) => normalizeCoinType(`${origins?.find((o) => o.module === s.module && o.struct === s.name)?.definingId ?? rootId}::${s.module}::${s.name}`))
      .filter((t): t is string => !!t && !coinTypes.has(t));
    registryProbesSkipped = Math.max(0, candidates.length - MAX_REGISTRY_PROBES);
    const probed = candidates.slice(0, MAX_REGISTRY_PROBES);
    if (probed.length) {
      try {
        for (const [type, entry] of await readDerivedCurrencies(probed)) {
          coinTypes.add(type);
          registryEntries.set(type, entry);
        }
      } catch (err) {
        for (const type of probed) {
          incompleteScans.push({ type, reason: `whether this key struct is a coin could not be read from the coin registry (${(err as Error).message})` });
        }
      }
    }
  }
  const minted = new Set(capObjects.filter((c) => c.kind === "treasury").map((c) => coinTypeOf(c.type)));
  const unlocated: UnlocatedMintAuthority[] = [];
  await Promise.all(
    [...coinTypes]
      .filter((t) => !minted.has(t))
      .map(async (coinType) => {
        const found = await locateTreasuryCap(coinType, registryEntries.get(coinType));
        if ("unlocated" in found) {
          unlocated.push(found.unlocated);
          return;
        }
        for (const cap of found.caps) {
          if (seen.has(cap.id)) continue;
          seen.add(cap.id);
          capObjects.push(cap);
        }
      }),
  );
  unlocated.sort((a, b) => (a.coin_type < b.coin_type ? -1 : a.coin_type > b.coin_type ? 1 : 0));

  // 2. Resolve each cap's current state (owner / policy / burned) in
  // parallel, except one whose state the scan that found it already read.
  const capabilities = await Promise.all(
    capObjects.map(async ({ id, type, kind, known, foundBy }): Promise<CapabilityInfo> => {
      let owner: OwnerKind = "unknown";
      let ownerAddress: string | undefined;
      let policyLabel: string | undefined;
      let wrappedInTx: string | undefined;
      let gone = false;
      let supplyState: SupplyState | "unread" | undefined;
      if (known) {
        owner = known.owner;
        ownerAddress = known.ownerAddress;
        gone = known.gone ?? false;
        supplyState = known.supplyState;
      } else {
        try {
          const state: CapStateResult = await gqlQuery<CapStateResult>(CAP_STATE_QUERY, { id });
          if (!state.object) {
            // Gone from top level: deleted, or stored inside another object. A
            // wrapped TreasuryCap can still mint through the wrapper's module.
            gone = true;
            const end = await readObjectEnd(id);
            if (end?.kind === "deleted") {
              owner = "burned";
              if (kind === "treasury") {
                const coinType = type.slice(type.indexOf("<") + 1, type.lastIndexOf(">"));
                supplyState = await readRegistryCurrency(coinType).then(
                  (c) => c?.supply ?? "unknown",
                  () => "unread" as const,
                );
              }
            } else if (end?.kind === "wrapped") {
              owner = "wrapped";
              wrappedInTx = end.tx;
            }
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
      const { risk, note } = classifyCapabilityRisk({ kind, type, owner, ownerAddress, policyLabel, wrappedInTx, gone, supplyState });

      // An UpgradeCap's holder means nothing on its own. Compared against the
      // publisher it says whether upgrade authority changed hands, which is
      // the question worth asking about the most consequential capability on
      // the chain. Skipped when no address holds it: the note above already
      // says who can upgrade a destroyed, wrapped, shared or frozen cap, and
      // `assessCapHolder` reads a missing holder as "whoever can reach it can
      // still upgrade", which a frozen cap contradicts.
      const held = kind === "upgrade" && (owner === "address" || owner === "consensus") ? assessCapHolder(ownerAddress, publisher) : null;

      return {
        kind,
        type,
        object_id: id,
        owner,
        ...(ownerAddress ? { owner_address: ownerAddress } : {}),
        ...(policyLabel ? { upgrade_policy: policyLabel } : {}),
        ...(wrappedInTx ? { wrapped_in_tx: wrappedInTx } : {}),
        ...(foundBy ? { found_by: foundBy } : {}),
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
  if (registryProbesSkipped > 0) {
    noteParts.push(
      `${registryProbesSkipped} additional key struct type(s) were not checked for a coin (capped at ${MAX_REGISTRY_PROBES}); a coin one of them names, and its mint authority, may be missing.`,
    );
  }
  if (incompleteScans.length) {
    noteParts.push(
      `${incompleteScans.length} struct type(s) could not be scanned: ${incompleteScans
        .map((s) => s.type.split("::").slice(-2).join("::"))
        .join(", ")}. Their instances, or a coin of that type and its mint authority, may be missing from this audit — see incomplete_scans.`,
    );
  }
  if (unlocated.length) {
    noteParts.push(
      `No TreasuryCap was located for ${unlocated.length} coin type(s) this package defines: ${unlocated
        .map((u) => u.coin_type.split("::").slice(-2).join("::"))
        .join(", ")}. See coins_without_located_mint_authority for what was checked.`,
    );
  }

  return {
    checked: true,
    capabilities,
    ...(userHeldTypes.length ? { user_held_types: userHeldTypes } : {}),
    ...(incompleteScans.length ? { incomplete_scans: incompleteScans } : {}),
    ...(unlocated.length ? { coins_without_located_mint_authority: unlocated } : {}),
    ...(noteParts.length ? { note: noteParts.join(" ") } : {}),
  };
}
