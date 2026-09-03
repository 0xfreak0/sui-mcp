/**
 * Which bridge, if any, a transaction used to send value off Sui.
 *
 * Detection and resolution are separate problems, and conflating them is what
 * makes "support every bridge" sound impossible:
 *
 *   - **Detection** — did value leave, and through what? This generalizes
 *     cheaply. It is a curated marker list plus, for free, every package the
 *     protocol registry already types as a `bridge`.
 *   - **Resolution** — where did it land? This does *not* generalize. Each
 *     protocol has its own identity scheme (Wormhole's VAA triple, Circle's
 *     nonce, LayerZero's GUID) and its own index, so every resolver is
 *     bespoke work.
 *
 * Detect-only is still worth a great deal. "Funds exited via Circle CCTP,
 * which this server cannot follow" is an actionable next step for an
 * investigator; a trace that simply ends is not, because it reads as "the
 * money stopped here".
 *
 * There is deliberately no heuristic tier. A "looks bridge-shaped" guess over
 * unknown packages would manufacture exactly the unverifiable attribution this
 * project refuses to ship.
 */

import { lookupProtocol } from "../../protocols/registry.js";

/** How far this server can follow a transfer through a given protocol. */
export type BridgeResolution =
  /** A shared identifier is quoted on both chains; the hop can be followed. */
  | "identifier"
  /** The exit is recognised, but this server cannot follow it. */
  | "detect-only";

export interface BridgeProtocol {
  id: string;
  name: string;
  /** `module::function` suffixes on a Move call that mark an outbound transfer. */
  callMarkers: string[];
  /** Event type suffixes that mark an outbound transfer. */
  eventMarkers: string[];
  resolution: BridgeResolution;
  /** What the caller can do next. */
  note: string;
}

/**
 * Bridges with hand-verified markers.
 *
 * Entries are added only after their marker has been seen on a real mainnet
 * transaction — an unverified marker either never fires (useless) or fires on
 * the wrong call (worse than useless). Everything else is still caught by the
 * registry tier below, which needs no marker at all.
 */
export const BRIDGE_PROTOCOLS: BridgeProtocol[] = [
  {
    id: "wormhole",
    name: "Wormhole",
    callMarkers: ["publish_message::publish_message"],
    eventMarkers: ["publish_message::WormholeMessage"],
    resolution: "identifier",
    note: "Run resolve_bridge_transfer on this transaction to read the VAA identity and, where it has been redeemed, the destination chain and account.",
  },
  {
    id: "sui-native",
    name: "Sui Bridge",
    // send_token matches send_token_v2 by prefix.
    callMarkers: ["bridge::send_token"],
    eventMarkers: ["bridge::TokenDepositedEvent", "bridge::TokenDepositedEventV2"],
    resolution: "identifier",
    note: "Run resolve_bridge_transfer on this transaction. Sui's native bridge puts the destination chain and address in the event itself, so the far side is read from chain data rather than an indexer.",
  },
  {
    id: "mayan-mctp",
    name: "Mayan MCTP",
    // Markers deliberately carry "mctp" rather than the generic `init_order`
    // module, which would collide with DEX order books — `order::OrderCanceled`
    // and friends are among the highest-frequency events on mainnet.
    //
    // Attribution basis: the on-chain module naming (calculate_mctp_fee,
    // log_initialize_mctp), where MCTP is Mayan's cross-chain transfer
    // protocol. MVR has no registration for these packages, so the name is not
    // independently confirmed by a registry — which is why this is a display
    // name on a detect-only entry and gates no behaviour.
    callMarkers: ["calculate_mctp_fee::", "init_order::log_initialize_mctp"],
    eventMarkers: ["init_order::InitMctpLogged"],
    resolution: "detect-only",
    note: "Mayan is a cross-chain swap layer that routes over other bridges — observed on mainnet settling through Wormhole and Circle CCTP in the same transaction. Those legs are reported separately and are what to follow; this entry names the service that initiated the transfer, which its own order id can be looked up against.",
  },
  {
    id: "cctp",
    name: "Circle CCTP",
    callMarkers: ["deposit_for_burn::deposit_for_burn"],
    eventMarkers: ["deposit_for_burn::DepositForBurn", "send_message::MessageSent"],
    resolution: "identifier",
    note: "Run resolve_bridge_transfer on this transaction. CCTP puts the destination domain and recipient in the burn event, so the far side is read from chain data rather than an indexer.",
  },
];

/** One Move call, reduced to what detection needs. */
export interface CallSite {
  packageId: string;
  module: string;
  function: string;
}

export interface BridgeHit {
  protocol: string;
  resolution: BridgeResolution;
  note: string;
  /** How it was recognised, so a reader can judge the claim. */
  matched: "call" | "event" | "protocol-registry";
}

/**
 * `module::function` for a call, which is what a marker matches. Suffix
 * matching keeps a marker working across package upgrades, since an upgrade
 * mints a new package ID but keeps the module and function names.
 */
const callSignature = (c: CallSite) => `${c.module}::${c.function}`;

function matchesCall(marker: string, signature: string): boolean {
  // Prefix, so `deposit_for_burn::deposit_for_burn` also catches the
  // `_with_caller_with_package_auth` variants seen on mainnet.
  return signature === marker || signature.startsWith(marker);
}

/**
 * Every bridge this transaction appears to have used.
 *
 * Two tiers, in order of precision:
 *
 *   1. Curated markers, which identify the protocol exactly and say whether it
 *      can be resolved.
 *   2. The protocol registry — any package typed `bridge` in protocols.json.
 *      This costs nothing to maintain and grows automatically: adding a bridge
 *      to the registry gives detection immediately, and via lineage roots it
 *      keeps working across that bridge's upgrades. Resolution stays opt-in.
 *
 * A protocol matched by marker is not reported twice by the registry tier.
 */
export function detectBridges(calls: CallSite[], eventTypes: string[] = []): BridgeHit[] {
  const hits = new Map<string, BridgeHit>();

  for (const proto of BRIDGE_PROTOCOLS) {
    const byCall = calls.some((c) =>
      proto.callMarkers.some((m) => matchesCall(m, callSignature(c))),
    );
    const byEvent = eventTypes.some((t) =>
      proto.eventMarkers.some((m) => t.endsWith(`::${m}`) || t.endsWith(m)),
    );
    if (byCall || byEvent) {
      hits.set(proto.name, {
        protocol: proto.name,
        resolution: proto.resolution,
        note: proto.note,
        matched: byCall ? "call" : "event",
      });
    }
  }

  // Registry tier: any curated package typed as a bridge. Uses lookupProtocol,
  // so it inherits the lineage tier and keeps identifying a bridge after it
  // upgrades — and stays curated-only, never an MVR name anyone could register.
  for (const call of calls) {
    const proto = lookupProtocol(call.packageId);
    if (proto?.type !== "bridge" || hits.has(proto.name)) continue;
    hits.set(proto.name, {
      protocol: proto.name,
      resolution: "detect-only",
      note: `${proto.name} is a known bridge, but this server has no resolver for it. Value likely left Sui here; follow it manually on the destination chain.`,
      matched: "protocol-registry",
    });
  }

  return [...hits.values()];
}

/** The first hit that can actually be followed, if any. */
export function resolvableHit(hits: BridgeHit[]): BridgeHit | null {
  return hits.find((h) => h.resolution === "identifier") ?? null;
}
