/**
 * Circle's Cross-Chain Transfer Protocol (CCTP).
 *
 * Like Sui's native bridge and unlike Wormhole, CCTP puts the destination in
 * the events, so the far side is **chain-derived** and no indexer is consulted
 * for it. `DepositForBurn` carries `destination_domain` and `mint_recipient`;
 * the paired `MessageSent` carries the raw message whose header holds the
 * source domain and nonce.
 *
 * In V1, `(source_domain, nonce)` is the transfer identity, quoted back by the
 * destination chain on mint. V2 (message version 1, `max_fee` in the burn
 * event) leaves the 32-byte nonce zero in the source chain's message, since
 * Circle's attester assigns it, so a V2 transfer is found by its source domain
 * and burn transaction (Circle's `/v2/messages/{sourceDomain}?transactionHash=`).
 *
 * Circle also serves an attestation API. It is deliberately not called here: an
 * attestation says Circle signed the message, not that anyone claimed it, so it
 * would add a third-party dependency for weaker information than the events
 * already give.
 */

import { ETHEREUM, SOLANA_MAINNET, SUI_MAINNET, type ChainId } from "../chain-id.js";
import { foreignAccountId, unpadForeignAddress } from "./foreign-address.js";

export const CCTP_DEPOSIT_EVENT_SUFFIX = "::deposit_for_burn::DepositForBurn";
export const CCTP_MESSAGE_EVENT_SUFFIX = "::send_message::MessageSent";
/** Circle's domain for Sui: the source domain of a burn made here. */
export const CCTP_SUI_DOMAIN = 8;

/**
 * Circle's domain numbering: its own namespace, neither CAIP-2 nor Wormhole's.
 *
 * Domain 8 (Sui) appears as the source domain in a Sui transaction's own
 * message header. The rest, domain 3 (Arbitrum) included, are Circle's
 * published assignments.
 *
 * Only domains whose chain this server can normalize for are mapped; the others
 * are named but reported by number, so an address is never filed under a chain
 * that was guessed.
 */
const DOMAIN_TO_CAIP2: Record<number, ChainId> = {
  0: ETHEREUM,
  1: "eip155:43114",
  2: "eip155:10",
  3: "eip155:42161",
  5: SOLANA_MAINNET,
  6: "eip155:8453",
  7: "eip155:137",
  8: SUI_MAINNET,
};

const DOMAIN_NAMES: Record<number, string> = {
  0: "Ethereum", 1: "Avalanche", 2: "OP Mainnet", 3: "Arbitrum", 4: "Noble",
  5: "Solana", 6: "Base", 7: "Polygon PoS", 8: "Sui", 9: "Aptos",
  10: "Unichain", 11: "Linea", 12: "Codex", 13: "Sonic", 14: "World Chain",
};

export function cctpDomainLabel(domain: number): string {
  return DOMAIN_NAMES[domain] ?? `Circle domain ${domain}`;
}

export function caip2ForCctpDomain(domain: number): ChainId | null {
  return DOMAIN_TO_CAIP2[domain] ?? null;
}

/** CCTP message header, which is where the transfer's identity lives. */
export interface CctpMessageHeader {
  /** Message format version: 0 is CCTP V1, 1 is CCTP V2. */
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  /**
   * V1: the u64 nonce the source chain assigned. V2: null while the message's
   * 32-byte nonce is still zero, which it always is in the source chain's own
   * copy, since Circle's attester assigns it.
   */
  nonce: string | null;
  /** V2 only: the finality the burner asked for (1000 fast, 2000 standard). */
  minFinalityThreshold?: number;
}

/** CCTP V2 message: nonce(32) at 12, then sender, recipient, caller (32 each), two u32 thresholds. */
const V2_HEADER_LEN = 148;
const V2_MIN_FINALITY_AT = 140;

/**
 * Read the fixed header of a CCTP message.
 *
 * V1 (version 0): version(4) ‖ sourceDomain(4) ‖ destinationDomain(4) ‖
 * nonce(8), big-endian. V2 (version 1): the nonce is 32 bytes, and the header
 * runs on to the sender, recipient, destination caller and finality
 * thresholds. Anything shorter than its version's header is not a CCTP
 * message and returns null rather than a record of zeros. An unknown
 * version keeps its domains and reports no nonce.
 */
export function parseMessageHeader(base64: string): CctpMessageHeader | null {
  try {
    const b = Buffer.from(base64, "base64");
    if (b.length < 12) return null;
    const version = b.readUInt32BE(0);
    const head = { version, sourceDomain: b.readUInt32BE(4), destinationDomain: b.readUInt32BE(8) };
    if (version === 0) {
      if (b.length < 20) return null;
      // u64: read as BigInt, since a nonce past 2^53 would lose precision as a
      // Number and stop matching the destination chain's copy.
      return { ...head, nonce: b.readBigUInt64BE(12).toString() };
    }
    if (version === 1) {
      if (b.length < V2_HEADER_LEN) return null;
      const nonce = BigInt(`0x${b.subarray(12, 44).toString("hex")}`);
      return { ...head, nonce: nonce === 0n ? null : nonce.toString(), minFinalityThreshold: b.readUInt32BE(V2_MIN_FINALITY_AT) };
    }
    return { ...head, nonce: null };
  } catch {
    return null;
  }
}

/**
 * Decode CCTP's 32-byte recipient into the destination chain's own format.
 * See {@link unpadForeignAddress}: a padded value that does not match its
 * chain's shape returns null rather than being trimmed into something
 * address-shaped.
 */
export function decodeMintRecipient(raw: string, destinationDomain: number): string | null {
  const chain = caip2ForCctpDomain(destinationDomain);
  if (!chain) return null;
  const hex = raw.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return unpadForeignAddress(Buffer.from(hex, "hex"), chain);
}

export interface CctpTransfer {
  /** 1 or 2, from the message version or the event's shape; null when neither says. */
  cctpVersion: 1 | 2 | null;
  /**
   * `sourceDomain/nonce`, CCTP V1's transfer identity. Null for V2, whose
   * nonce is assigned by Circle's attester after the burn: a V2 transfer is
   * identified by its source domain and burn transaction instead.
   */
  transferId: string | null;
  nonce: string | null;
  sourceDomain: number | null;
  destinationDomain: number;
  destinationChainLabel: string;
  /** CAIP-10 destination, or null when the chain is unmapped or the shape wrong. */
  destinationAccount: string | null;
  /** Recipient in the destination chain's own format, when decodable. */
  destinationAddress: string | null;
  /** The raw 32-byte value, always reported so nothing is hidden. */
  mintRecipientRaw: string | null;
  depositor: string | null;
  amount: string | null;
  burnToken: string | null;
  /** V2: the most of `amount` the burner lets the relayer keep as a fee. */
  maxFee: string | null;
  /** V2: 1000 or below asks for fast transfer, 2000 for standard finality. */
  minFinalityThreshold: number | null;
  /**
   * V2: bytes the destination passes to a hook. Non-empty, the recipient is
   * a contract that may act on the USDC rather than hold it.
   */
  hookData: string | null;
}

/** A `vector<u8>` field as hex: GraphQL renders it as base64. */
function hexOf(v: string): string {
  if (/^0x[0-9a-fA-F]*$/.test(v)) return v.toLowerCase();
  return `0x${Buffer.from(v, "base64").toString("hex")}`;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;

/**
 * Build a transfer from a `DepositForBurn` payload, using the paired message
 * header for the source domain when one is present.
 *
 * The header is what makes the transfer id complete; without it the
 * destination and recipient are still reported, since those are the parts an
 * investigator follows.
 */
export function parseDepositForBurn(
  json: unknown,
  header: CctpMessageHeader | null,
  qualify: boolean,
): CctpTransfer | null {
  if (!json || typeof json !== "object") return null;
  const f = json as Record<string, unknown>;

  const destinationDomain =
    typeof f.destination_domain === "number" ? f.destination_domain : header?.destinationDomain;
  if (destinationDomain === undefined) return null;

  // V1's event carries a nonce; V2's carries max_fee and no nonce.
  const cctpVersion: CctpTransfer["cctpVersion"] =
    header?.version === 1 || "max_fee" in f ? 2 : header?.version === 0 || "nonce" in f ? 1 : null;
  const nonce = str(f.nonce) ?? header?.nonce ?? null;
  const sourceDomain = header?.sourceDomain ?? null;
  const minFinality =
    typeof f.min_finality_threshold === "number" ? f.min_finality_threshold : (header?.minFinalityThreshold ?? null);
  const hook = str(f.hook_data);
  const mintRecipientRaw = str(f.mint_recipient);

  const destinationAddress = mintRecipientRaw
    ? decodeMintRecipient(mintRecipientRaw, destinationDomain)
    : null;

  // Off mainnet the domain table names the wrong chains, exactly as Wormhole's
  // numbering does, so the CAIP-2 claim is withheld there.
  const destinationAccount = qualify
    ? foreignAccountId(caip2ForCctpDomain(destinationDomain), destinationAddress)
    : null;

  return {
    cctpVersion,
    transferId: cctpVersion !== 2 && sourceDomain !== null && nonce ? `${sourceDomain}/${nonce}` : null,
    nonce,
    sourceDomain,
    destinationDomain,
    destinationChainLabel: cctpDomainLabel(destinationDomain),
    destinationAccount,
    destinationAddress,
    mintRecipientRaw,
    depositor: str(f.depositor),
    amount: str(f.amount),
    burnToken: str(f.burn_token),
    maxFee: cctpVersion === 2 ? str(f.max_fee) : null,
    minFinalityThreshold: cctpVersion === 2 ? minFinality : null,
    hookData: cctpVersion === 2 && hook ? hexOf(hook) : null,
  };
}
