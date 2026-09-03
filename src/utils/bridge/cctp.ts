/**
 * Circle's Cross-Chain Transfer Protocol (CCTP).
 *
 * Like Sui's native bridge and unlike Wormhole, CCTP puts the destination in
 * the events, so the far side is **chain-derived** and no indexer is consulted
 * for it. `DepositForBurn` carries `destination_domain` and `mint_recipient`;
 * the paired `MessageSent` carries the raw message whose header holds the
 * source domain and nonce.
 *
 * `(source_domain, nonce)` is CCTP's transfer identity and is quoted back by
 * the destination chain on mint, so it is also the key for confirming the
 * transfer completed.
 *
 * Verified against mainnet tx 4rDEyqGebKd98mc8vpPs3E9jFXe37MhGWFN4tp2HdVvL,
 * where the decoded `mint_recipient` matched, byte for byte, the destination
 * Wormholescan independently reported for the same transfer.
 *
 * Circle also serves an attestation API. It is deliberately not called here: an
 * attestation says Circle signed the message, not that anyone claimed it, so it
 * would add a third-party dependency for weaker information than the events
 * already give.
 */

import { toBase58 } from "@mysten/sui/utils";
import {
  ETHEREUM,
  SOLANA_MAINNET,
  SUI_MAINNET,
  formatAccountId,
  isKnownChainId,
  namespaceOf,
  normalizeAddressForChain,
  type ChainId,
} from "../chain-id.js";

export const CCTP_DEPOSIT_EVENT_SUFFIX = "::deposit_for_burn::DepositForBurn";
export const CCTP_MESSAGE_EVENT_SUFFIX = "::send_message::MessageSent";

/**
 * Circle's domain numbering — its own namespace, neither CAIP-2 nor Wormhole's.
 *
 * Domain 8 (Sui) and domain 3 (Arbitrum) are confirmed from mainnet data: 8
 * appears as the source domain in a Sui transaction's own message header, and
 * a domain-3 transfer's recipient matched what an independent indexer reported.
 * The rest are Circle's published assignments.
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
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: string;
}

/**
 * Read the fixed header of a CCTP message.
 *
 * Layout is version(4) ‖ sourceDomain(4) ‖ destinationDomain(4) ‖ nonce(8),
 * big-endian, then sender/recipient/body. Anything shorter than the header is
 * not a CCTP message and returns null rather than a record of zeros.
 */
export function parseMessageHeader(base64: string): CctpMessageHeader | null {
  try {
    const b = Buffer.from(base64, "base64");
    if (b.length < 20) return null;
    return {
      version: b.readUInt32BE(0),
      sourceDomain: b.readUInt32BE(4),
      destinationDomain: b.readUInt32BE(8),
      // u64: read as BigInt, since a nonce past 2^53 would lose precision as a
      // Number and stop matching the destination chain's copy.
      nonce: b.readBigUInt64BE(12).toString(),
    };
  } catch {
    return null;
  }
}

/**
 * Decode CCTP's 32-byte recipient into the destination chain's own format.
 *
 * CCTP left-pads every address to 32 bytes. Un-padding is only unambiguous
 * once the destination chain is known: 12 leading zero bytes before a 20-byte
 * EVM address, the full 32 bytes for Sui, and base58 over all 32 for Solana.
 * A padded value that does not match its chain's shape returns null rather
 * than being trimmed into something address-shaped.
 */
export function decodeMintRecipient(raw: string, destinationDomain: number): string | null {
  const chain = caip2ForCctpDomain(destinationDomain);
  if (!chain) return null;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw.replace(/^0x/, ""), "hex");
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;

  const ns = namespaceOf(chain);
  if (ns === "eip155") {
    // The first 12 bytes must be padding; if they are not, this is not an EVM
    // address and trimming would invent one.
    if (!bytes.subarray(0, 12).every((b) => b === 0)) return null;
    return `0x${bytes.subarray(12).toString("hex")}`;
  }
  if (ns === "sui") return `0x${bytes.toString("hex")}`;
  if (ns === "solana") return toBase58(bytes);
  return null;
}

export interface CctpTransfer {
  /** `sourceDomain/nonce` — CCTP's transfer identity. */
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

  const nonce = str(f.nonce) ?? header?.nonce ?? null;
  const sourceDomain = header?.sourceDomain ?? null;
  const mintRecipientRaw = str(f.mint_recipient);

  const destinationAddress = mintRecipientRaw
    ? decodeMintRecipient(mintRecipientRaw, destinationDomain)
    : null;

  let destinationAccount: string | null = null;
  const chain = caip2ForCctpDomain(destinationDomain);
  // Off mainnet the domain table names the wrong chains, exactly as Wormhole's
  // numbering does, so the CAIP-2 claim is withheld there.
  if (qualify && chain && destinationAddress && isKnownChainId(chain)) {
    try {
      destinationAccount = formatAccountId({
        chain,
        address: normalizeAddressForChain(chain, destinationAddress),
      });
    } catch {
      destinationAccount = null;
    }
  }

  return {
    transferId: sourceDomain !== null && nonce ? `${sourceDomain}/${nonce}` : null,
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
  };
}
