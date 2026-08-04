import { gqlQuery } from "../clients/graphql.js";

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
export type OwnerKind = "address" | "shared" | "immutable" | "burned" | "unknown";
export type CapRisk = "high" | "medium" | "low" | "info";

export interface CapabilityInfo {
  kind: CapKind;
  type: string;
  object_id: string;
  owner: OwnerKind;
  owner_address?: string;
  /** UpgradeCap only: on-chain upgrade policy. */
  upgrade_policy?: string;
  risk: CapRisk;
  note: string;
}

export interface CapabilityAudit {
  checked: boolean;
  capabilities: CapabilityInfo[];
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
  const who = ownerAddress ? ownerAddress : owner;
  const shortType = type.split("::").slice(-2).join("::").split("<")[0];

  if (kind === "upgrade") {
    if (owner === "burned") {
      return { risk: "info", note: "UpgradeCap has been destroyed — the package is immutable and can never be changed." };
    }
    if (policyLabel === "immutable") {
      return { risk: "low", note: "UpgradeCap policy is immutable — the package can no longer be upgraded." };
    }
    if (owner === "address") {
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
    if (owner === "address") {
      return { risk: "high", note: `Mint authority (${shortType}) is held by ${who} — new tokens can be minted at will (inflation / rug risk).` };
    }
    if (owner === "shared") {
      return { risk: "medium", note: `Mint authority (${shortType}) is a shared object — review who can mint.` };
    }
    return { risk: "medium", note: `Mint authority (${shortType}) owner is ${owner}.` };
  }

  if (kind === "deny") {
    if (owner === "burned") return { risk: "info", note: `Deny/freeze authority (${shortType}) has been destroyed.` };
    if (owner === "address") {
      return { risk: "medium", note: `Denylist/freeze authority (${shortType}) is held by ${who} — can freeze addresses or block transfers of this coin.` };
    }
    return { risk: "low", note: `Denylist/freeze authority (${shortType}) owner is ${owner}.` };
  }

  // admin / other *Cap
  if (owner === "burned") return { risk: "info", note: `Capability ${shortType} has been destroyed.` };
  if (owner === "address") {
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
    }
    asMoveObject { contents { json } }
  }
}`;

function ownerKindOf(typename: string | undefined): OwnerKind {
  switch (typename) {
    case "AddressOwner": return "address";
    case "Shared": case "ConsensusAddressOwner": return "shared";
    case "Immutable": return "immutable";
    default: return "unknown";
  }
}

/**
 * Audit the capabilities of a package. Best-effort: if the publish transaction
 * is unavailable (pruned) or GraphQL fails, returns { checked: false } with a
 * note rather than throwing — capability info should never break analyze_package.
 *
 * Caveat: only finds capabilities minted in the package's PUBLISH transaction
 * (the common case — UpgradeCap always, plus caps created in module `init`).
 * Caps created in a later transaction (e.g. a coin whose currency is created
 * post-publish) are not discovered here.
 */
export async function auditPackageCapabilities(packageId: string): Promise<CapabilityAudit> {
  // 1. Scan the publish tx for created cap-like objects (paginating a few pages).
  const capObjects: Array<{ id: string; type: string; kind: CapKind }> = [];
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

  // 2. Resolve each cap's CURRENT state (owner / policy / burned) in parallel.
  const capabilities = await Promise.all(
    capObjects.map(async ({ id, type, kind }): Promise<CapabilityInfo> => {
      let owner: OwnerKind = "unknown";
      let ownerAddress: string | undefined;
      let policyLabel: string | undefined;
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
      const { risk, note } = classifyCapabilityRisk({ kind, type, owner, ownerAddress, policyLabel });
      return {
        kind,
        type,
        object_id: id,
        owner,
        ...(ownerAddress ? { owner_address: ownerAddress } : {}),
        ...(policyLabel ? { upgrade_policy: policyLabel } : {}),
        risk,
        note,
      };
    }),
  );

  // Most-severe first.
  const order: Record<CapRisk, number> = { high: 0, medium: 1, low: 2, info: 3 };
  capabilities.sort((a, b) => order[a.risk] - order[b.risk]);

  return { checked: true, capabilities };
}
