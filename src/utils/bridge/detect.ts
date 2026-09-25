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
import { ALLBRIDGE_CCTP_EVENT, ALLBRIDGE_POOL_EVENT } from "./allbridge.js";
import { AXELAR_TRANSFER_EVENT } from "./axelar.js";
import { MAYAN_SWIFT_PACKAGE } from "./beneficiary.js";
import { CELER_BURN_EVENT } from "./celer.js";
import { matchesEvent } from "./event-type.js";
import { LAYERZERO_PACKET_EVENT } from "./layerzero.js";

/** How far this server can follow a transfer through a given protocol. */
export type BridgeResolution =
  /** A shared identifier is quoted on both chains; the hop can be followed. */
  | "identifier"
  /** The exit is recognised, but this server cannot follow it. */
  | "detect-only";

export interface BridgeProtocol {
  id: string;
  name: string;
  /** `module::function` prefixes on a Move call that mark an outbound transfer. */
  callMarkers: string[];
  /** `module::function` names matched exactly, where a prefix would catch a sibling function. */
  exactCallMarkers?: string[];
  /**
   * Event types that mark an outbound transfer: `module::Name`, or
   * `0xpkg::module::Name` pinned to the defining package (see `matchesEvent`).
   */
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
    // independently confirmed by a registry — which is why the name is a display
    // label and gates no behaviour.
    callMarkers: ["calculate_mctp_fee::", "init_order::log_initialize_mctp"],
    eventMarkers: ["init_order::InitMctpLogged"],
    resolution: "identifier",
    note: "Mayan is a cross-chain swap layer that settles over other bridges, observed on mainnet through Wormhole and Circle CCTP in the same transaction. Those legs pay Mayan's own contracts on the far side, so their recipient is not the beneficiary. resolve_bridge_transfer reads the beneficiary from Mayan's order event (`beneficiaries`).",
  },
  {
    id: "cctp",
    name: "Circle CCTP",
    callMarkers: ["deposit_for_burn::deposit_for_burn"],
    eventMarkers: ["deposit_for_burn::DepositForBurn", "send_message::MessageSent"],
    resolution: "identifier",
    note: "Run resolve_bridge_transfer on this transaction. CCTP puts the destination domain and recipient in the burn event, so the far side is read from chain data rather than an indexer.",
  },
  {
    id: "layerzero",
    name: "LayerZero",
    // Every OApp's send goes through endpoint_v2::send as a top-level PTB
    // call. Exact: `send_compose` shares the prefix and is not an exit.
    callMarkers: [],
    exactCallMarkers: ["endpoint_v2::send"],
    eventMarkers: [LAYERZERO_PACKET_EVENT],
    resolution: "identifier",
    note: "Run resolve_bridge_transfer on this transaction. The LayerZero packet names the destination chain and the GUID, and for an OFT transfer the recipient, all read from chain data; LayerZero Scan supplies the delivery transaction.",
  },
  {
    id: "axelar-its",
    name: "Axelar ITS",
    // The prefix also catches send_interchain_transfer_call, which Axelar's
    // own probe traffic sends through its example package's `its` module.
    callMarkers: ["interchain_token_service::send_interchain_transfer", "its::send_interchain_transfer_call"],
    eventMarkers: [AXELAR_TRANSFER_EVENT],
    resolution: "identifier",
    note: "Run resolve_bridge_transfer on this transaction. Axelar's InterchainTransfer event names the destination chain and address, so the far side is read from chain data. Axelarscan (axelarscan.io) shows the delivery for this Sui digest.",
  },
  {
    id: "allbridge-core",
    name: "Allbridge Core",
    callMarkers: ["cctp_bridge_interface::bridge", "bridge_interface::swap_and_bridge"],
    eventMarkers: [ALLBRIDGE_CCTP_EVENT, ALLBRIDGE_POOL_EVENT],
    resolution: "identifier",
    note: "Run resolve_bridge_transfer on this transaction. Allbridge's TokensSentEvent names the destination chain and the recipient wallet, so the far side is read from chain data. The live route burns through Circle CCTP with the same nonce.",
  },
  {
    id: "celer-cbridge",
    name: "Celer cBridge",
    callMarkers: ["peg_bridge::burn"],
    eventMarkers: [CELER_BURN_EVENT],
    resolution: "identifier",
    note: "Run resolve_bridge_transfer on this transaction. cBridge's BurnEvent names the destination chain and address and carries the burn id that the destination mint quotes back.",
  },
  {
    id: "mayan-swift",
    name: "Mayan Swift",
    // Dormant on Sui since May 2025, but a dormant bridge is still an exit.
    // Its events share the generic `init_order` names, so they are pinned.
    callMarkers: ["calculate_swift_fee::"],
    eventMarkers: [`${MAYAN_SWIFT_PACKAGE}::init_order::OrderCreated`, `${MAYAN_SWIFT_PACKAGE}::init_order::InitOrderLogged`],
    resolution: "identifier",
    note: "Run resolve_bridge_transfer on this transaction. The Swift order event names the destination chain and address, so the beneficiary is read from chain data.",
  },
  {
    id: "meson",
    name: "Meson",
    // Meson's package defines no events, so only the call can mark it.
    callMarkers: ["MesonSwap::postSwapFromInitiator"],
    eventMarkers: [],
    resolution: "detect-only",
    note: "Meson emits no events on Sui and the recipient is not in the Sui transaction, so the destination cannot be read from chain data. The swap's id is the 32-byte encodedSwap passed as the first argument to postSwapFromInitiator; Meson's explorer API (explorer.meson.fi/api/v1/swap/0x<encodedSwap>) reports where it was released.",
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
  /**
   * How it was recognised, so a reader can judge the claim.
   *
   * `address-label` is the weakest and the only one not derived from the
   * transaction: an investigator asserted that the address is a bridge. It is
   * still worth reporting, because a labeled bridge often carries no curated
   * marker — a relayer forward, an unlisted protocol, a plain transfer into a
   * deposit address — and that is precisely the case the label was created for.
   */
  matched: "call" | "event" | "protocol-registry" | "address-label";
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
    const byCall = calls.some((c) => {
      const sig = callSignature(c);
      return proto.callMarkers.some((m) => matchesCall(m, sig)) || (proto.exactCallMarkers?.includes(sig) ?? false);
    });
    const byEvent = eventTypes.some((t) => proto.eventMarkers.some((m) => matchesEvent(m, t)));
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
  //
  // A protocol with curated markers is decided by those markers alone. A call
  // into its package is not an exit: every Pyth price update calls Wormhole's
  // `vaa::parse_and_verify`, which reported a NAVI deposit as value leaving
  // Sui. 14 of 30 sampled NAVI deposits carried that call.
  for (const call of calls) {
    const proto = lookupProtocol(call.packageId);
    if (proto?.type !== "bridge" || hits.has(proto.name)) continue;
    if (BRIDGE_PROTOCOLS.some((b) => b.name === proto.name)) continue;
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
