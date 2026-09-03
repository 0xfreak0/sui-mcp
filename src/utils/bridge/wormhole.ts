/**
 * Wormhole cross-chain transfer identity.
 *
 * A fund trace on Sui currently stops dead at a bridge: `bridge` is a sink
 * category, so the money leaves the traceable surface exactly where attribution
 * becomes possible. This module supplies the join that lets an investigation
 * continue — the identity a Wormhole transfer carries on *both* chains.
 *
 * A Wormhole message is identified by the triple
 * `(emitterChain, emitterAddress, sequence)`. On Sui the core bridge emits it
 * as a `publish_message::WormholeMessage` event whose `sender` is the emitter
 * cap's object ID and whose `sequence` is that emitter's counter. On the
 * destination chain, redeeming the VAA quotes the same triple back. Matching
 * them is therefore an identifier comparison, not an amount-and-timing guess —
 * which is what makes it usable as evidence.
 *
 * What the chain cannot tell you is whether the VAA was ever redeemed, or
 * where. That half necessarily comes from an indexer, and is labelled as such:
 * see {@link EvidenceTier}.
 */

import {
  caip2ForSuiNetwork,
  chainDisplayName,
  formatAccountId,
  normalizeAddressForChain,
  isKnownChainId,
  type ChainId,
} from "../chain-id.js";

/**
 * How firmly a cross-chain link is established. This distinction is the whole
 * point of the module and must survive into any report.
 *
 * - `chain-derived` — read directly from chain data. The VAA triple emitted by
 *   the Sui core bridge is of this kind.
 * - `indexer-attested` — a third party asserts it. The destination transaction
 *   is of this kind: correct in practice, but it is Wormholescan's index, not
 *   a fact this server verified, and it should be re-checked on the
 *   destination chain before it is relied on.
 * - `heuristic` — inferred from amount, timing or asset similarity. Not
 *   produced here. It is a lead, never a finding, and is named so that nothing
 *   silently promotes one to the other.
 */
export type EvidenceTier = "chain-derived" | "indexer-attested" | "heuristic";

export const EVIDENCE_TIER_MEANING: Record<EvidenceTier, string> = {
  "chain-derived": "Read from chain data. No third party is trusted for this.",
  "indexer-attested":
    "Asserted by Wormholescan's index, not verified on-chain by this server. Confirm on the destination chain before relying on it as evidence.",
  heuristic:
    "Inferred from amount/time/asset similarity. A lead to check, never a finding on its own.",
};

/** Wormhole's own chain numbering, which is not EVM chain IDs or CAIP-2. */
export const WORMHOLE_CHAIN_SUI = 21;

/**
 * Wormhole chain id → CAIP-2.
 *
 * Deliberately partial. An unmapped chain is reported by its Wormhole number
 * with no CAIP-2 id rather than guessed at: emitting a wrong chain id would
 * put an address on the wrong chain in a case file, which is precisely the
 * error chain qualification exists to prevent.
 */
const WORMHOLE_TO_CAIP2: Record<number, ChainId> = {
  1: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  2: "eip155:1",
  4: "eip155:56",
  5: "eip155:137",
  6: "eip155:43114",
  21: "sui:mainnet",
  23: "eip155:42161",
  24: "eip155:10",
  30: "eip155:8453",
};

/**
 * Names for Wormhole chains that have no CAIP-2 mapping.
 *
 * Mapped chains take their name from the chain-id registry instead, so the two
 * cannot drift apart into "Ethereum" here and something else there.
 */
const WORMHOLE_CHAIN_NAMES: Record<number, string> = {
  3: "Terra",
  7: "Oasis",
  8: "Algorand",
  9: "Aurora",
  10: "Fantom",
  13: "Klaytn",
  14: "Celo",
  15: "Near",
  16: "Moonbeam",
  18: "Terra 2",
  19: "Injective",
  22: "Aptos",
  25: "Gnosis",
  26: "Pythnet",
  32: "Sei",
  34: "Scroll",
  35: "Mantle",
};

export function caip2ForWormholeChain(chainId: number): ChainId | null {
  return WORMHOLE_TO_CAIP2[chainId] ?? null;
}

/** A name for a Wormhole chain even when it has no CAIP-2 mapping. */
export function wormholeChainLabel(chainId: number): string {
  const caip2 = WORMHOLE_TO_CAIP2[chainId];
  if (caip2) return chainDisplayName(caip2);
  return WORMHOLE_CHAIN_NAMES[chainId] ?? `Wormhole chain ${chainId}`;
}

/**
 * The Move event the Sui core bridge emits for every outbound message.
 *
 * Matched by suffix rather than by full type. The core bridge package ID
 * changes when it is upgraded, and pinning it would make this silently stop
 * finding messages after an upgrade — the exact failure the protocol registry's
 * lineage tier exists to avoid.
 */
export const WORMHOLE_MESSAGE_EVENT_SUFFIX = "::publish_message::WormholeMessage";

/** One outbound Wormhole message, as read from Sui chain data. */
export interface WormholeMessage {
  /** Emitter address: the emitter cap object ID, without 0x, as the VAA uses. */
  emitter: string;
  /** Per-emitter counter. A string because it is a u64. */
  sequence: string;
  /** `emitterChain/emitterAddress/sequence` — the VAA's canonical identity. */
  vaaId: string;
  nonce: number | null;
  consistencyLevel: number | null;
  /** Base64 as the GraphQL layer returns it; the token payload is inside. */
  payloadBase64: string | null;
  /** Full Move type, so a reader can see which core package emitted it. */
  eventType: string;
}

/** Shape of one event as the GraphQL layer returns it. */
export interface SuiEventNode {
  contents?: { type?: { repr?: string }; json?: unknown } | null;
}

/** Strip the 0x prefix and left-pad to 32 bytes, which is how a VAA holds it. */
function toEmitterHex(objectId: string): string {
  return objectId.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

/** `chain/emitter/sequence`, the form Wormholescan and the guardians use. */
export function vaaId(emitterChain: number, emitter: string, sequence: string): string {
  return `${emitterChain}/${toEmitterHex(emitter)}/${sequence}`;
}

/**
 * Pull every Wormhole message out of a transaction's events.
 *
 * Returns an array because one PTB can publish several messages, and a trace
 * that assumed a single exit would follow only the first.
 *
 * Malformed events are skipped rather than thrown on: this runs over
 * transactions nobody curated, and one unexpected event shape must not cost
 * the whole lookup.
 */
export function extractWormholeMessages(events: SuiEventNode[]): WormholeMessage[] {
  const out: WormholeMessage[] = [];

  for (const node of events) {
    const repr = node?.contents?.type?.repr;
    if (typeof repr !== "string" || !repr.endsWith(WORMHOLE_MESSAGE_EVENT_SUFFIX)) continue;

    const json = node.contents?.json;
    if (!json || typeof json !== "object") continue;
    const fields = json as Record<string, unknown>;

    const sender = fields.sender;
    const sequence = fields.sequence;
    // Both are required to name a VAA; without either there is nothing to join on.
    if (typeof sender !== "string" || sender === "") continue;
    if (typeof sequence !== "string" && typeof sequence !== "number") continue;

    const emitter = toEmitterHex(sender);
    out.push({
      emitter,
      sequence: String(sequence),
      vaaId: vaaId(WORMHOLE_CHAIN_SUI, emitter, String(sequence)),
      nonce: typeof fields.nonce === "number" ? fields.nonce : null,
      consistencyLevel:
        typeof fields.consistency_level === "number" ? fields.consistency_level : null,
      payloadBase64: typeof fields.payload === "string" ? fields.payload : null,
      eventType: repr,
    });
  }

  return out;
}

/**
 * Render a counterparty on another chain as a CAIP-10 account id.
 *
 * Returns null when the chain is unmapped or the address does not validate for
 * it, so the caller reports the raw string instead. An address stored under a
 * guessed chain is worse than one stored unqualified — it reads as verified.
 */
export function toForeignAccount(wormholeChain: number, address: string): string | null {
  const chain = caip2ForWormholeChain(wormholeChain);
  if (!chain || !isKnownChainId(chain)) return null;
  try {
    return formatAccountId({ chain, address: normalizeAddressForChain(chain, address) });
  } catch {
    return null;
  }
}

/** The CAIP-10 for a Sui address on the network a call is running against. */
export function suiAccount(address: string, network: Parameters<typeof caip2ForSuiNetwork>[0]) {
  return formatAccountId({
    chain: caip2ForSuiNetwork(network),
    address: normalizeAddressForChain(caip2ForSuiNetwork(network), address),
  });
}
