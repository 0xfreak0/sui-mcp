/**
 * Sui's native bridge (package `0xb`), Sui ↔ Ethereum only.
 *
 * This is the strongest cross-chain evidence available anywhere in this
 * server, and the only case where the destination needs no third party at all:
 * the outbound `TokenDepositedEvent` carries the target chain and the target
 * address as raw bytes, so the far side of the hop is `chain-derived` rather
 * than `indexer-attested`. Wormhole cannot do this — a VAA names an emitter and
 * a sequence, not a recipient — which is why its destination has to come from
 * Wormholescan.
 *
 * `(source_chain, seq_num)` is the bridge's own transfer identifier and is
 * quoted back by the Ethereum side when the transfer is claimed, so it is also
 * the join key for confirming the redemption on Ethereum.
 *
 * Verified against mainnet tx 4xLuY6N68PgqBow9i4iawBvVw3eEkxKQNRQeSWFGwjJi.
 */

import { ETHEREUM, SUI_MAINNET, formatAccountId, normalizeAddressForChain } from "../chain-id.js";

/** Event emitted when value LEAVES Sui. */
export const DEPOSIT_EVENT_SUFFIXES = [
  "::bridge::TokenDepositedEvent",
  // Declared in the deployed package but not yet observed on mainnet; listed
  // so detection keeps working the day they migrate to it.
  "::bridge::TokenDepositedEventV2",
];

/**
 * Event emitted when value ARRIVES on Sui.
 *
 * Named so it is never mistaken for an exit. A trace that reported an inbound
 * claim as "value left Sui" would send an investigator to the wrong chain.
 */
export const CLAIM_EVENT_SUFFIX = "::bridge::TokenTransferClaimed";

/**
 * The bridge's own chain numbering, which is neither CAIP-2 nor Wormhole's.
 *
 * Only the two values observed on mainnet are mapped. `chain_ids` also
 * declares testnet and custom variants, but those appear only off mainnet,
 * where — exactly as with Wormhole — a CAIP-2 claim would name the wrong
 * chain. Anything unmapped is reported by number.
 */
const BRIDGE_CHAIN_TO_CAIP2: Record<number, string> = {
  0: SUI_MAINNET,
  10: ETHEREUM,
};

const BRIDGE_CHAIN_NAMES: Record<number, string> = {
  0: "Sui",
  1: "Sui testnet",
  2: "Sui (custom)",
  10: "Ethereum",
  11: "Ethereum Sepolia",
  12: "Ethereum (custom)",
};

export function suiBridgeChainLabel(id: number): string {
  return BRIDGE_CHAIN_NAMES[id] ?? `Sui-bridge chain ${id}`;
}

/**
 * An inbound claim: value ARRIVING on Sui.
 *
 * Deliberately a separate type from {@link NativeBridgeTransfer}. The two carry
 * the same shape of identity but point in opposite directions, and a single
 * type would make it easy to render an entry as an exit — which sends an
 * investigator to the wrong chain.
 */
export interface NativeBridgeClaim {
  /** `sourceChain/seqNum` — the same identity the origin chain emitted. */
  transferId: string;
  seqNum: string;
  sourceChain: number;
  sourceChainLabel: string;
  /** CAIP-2 for the origin, when the chain is mapped and we are on mainnet. */
  sourceChainId: string | null;
  messageType: number | null;
}

/**
 * Parse a `TokenTransferClaimed` payload.
 *
 * The claim quotes back the origin chain's `(source_chain, seq_num)`, so an
 * inbound transfer is resolvable to its origin from Sui alone — the mirror of
 * what {@link parseDepositEvent} does outbound.
 */
export function parseClaimEvent(json: unknown, qualify: boolean): NativeBridgeClaim | null {
  if (!json || typeof json !== "object") return null;
  const key = (json as Record<string, unknown>).message_key;
  if (!key || typeof key !== "object") return null;
  const f = key as Record<string, unknown>;

  const sourceChain = asNum(f.source_chain);
  const seqNum =
    f.bridge_seq_num === undefined || f.bridge_seq_num === null ? null : String(f.bridge_seq_num);
  if (sourceChain === null || seqNum === null) return null;

  const caip2 = BRIDGE_CHAIN_TO_CAIP2[sourceChain];
  return {
    transferId: `${sourceChain}/${seqNum}`,
    seqNum,
    sourceChain,
    sourceChainLabel: suiBridgeChainLabel(sourceChain),
    sourceChainId: qualify && caip2 ? caip2 : null,
    messageType: asNum(f.message_type),
  };
}

export interface NativeBridgeTransfer {
  /** `sourceChain/seqNum` — the bridge's transfer identity. */
  transferId: string;
  seqNum: string;
  sourceChain: number;
  targetChain: number;
  targetChainLabel: string;
  /** CAIP-10 for the destination, or null when the chain is unmapped. */
  targetAccount: string | null;
  /** Raw destination address, always reported even when unqualified. */
  targetAddress: string | null;
  senderAddress: string | null;
  amount: string | null;
  tokenType: number | null;
}

/**
 * Decode a bridge address field.
 *
 * The event carries raw bytes, which GraphQL renders as base64. Twenty bytes
 * is an EVM address and thirty-two is a Sui one; anything else is not decoded
 * rather than padded into something that looks like an address but is not.
 */
export function decodeBridgeAddress(base64: string): string | null {
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length !== 20 && bytes.length !== 32) return null;
    return `0x${bytes.toString("hex")}`;
  } catch {
    return null;
  }
}

const asNum = (v: unknown): number | null =>
  typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : null;

/**
 * Parse a `TokenDepositedEvent` payload into a transfer.
 *
 * Returns null on anything that does not carry the two fields that make a
 * transfer identifiable, rather than emitting a half-populated record that
 * would read as a finding.
 */
export function parseDepositEvent(json: unknown): NativeBridgeTransfer | null {
  if (!json || typeof json !== "object") return null;
  const f = json as Record<string, unknown>;

  const seqNum = f.seq_num === undefined || f.seq_num === null ? null : String(f.seq_num);
  const sourceChain = asNum(f.source_chain);
  const targetChain = asNum(f.target_chain);
  if (seqNum === null || sourceChain === null || targetChain === null) return null;

  const rawTarget = typeof f.target_address === "string" ? decodeBridgeAddress(f.target_address) : null;
  const caip2 = BRIDGE_CHAIN_TO_CAIP2[targetChain];

  let targetAccount: string | null = null;
  if (caip2 && rawTarget) {
    try {
      targetAccount = formatAccountId({
        chain: caip2,
        address: normalizeAddressForChain(caip2, rawTarget),
      });
    } catch {
      // Width did not match the chain's rule — report the raw bytes instead of
      // filing a malformed address under a real chain.
      targetAccount = null;
    }
  }

  return {
    transferId: `${sourceChain}/${seqNum}`,
    seqNum,
    sourceChain,
    targetChain,
    targetChainLabel: suiBridgeChainLabel(targetChain),
    targetAccount,
    targetAddress: rawTarget,
    senderAddress:
      typeof f.sender_address === "string" ? decodeBridgeAddress(f.sender_address) : null,
    amount: f.amount === undefined || f.amount === null ? null : String(f.amount),
    tokenType: asNum(f.token_type),
  };
}
