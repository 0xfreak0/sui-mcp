/**
 * Recipients on other chains, as bridges write them on Sui.
 *
 * Wormhole, CCTP and Mayan all carry the far-side address left-padded to 32
 * bytes. Un-padding is only unambiguous once the destination chain is known:
 * 12 zero bytes then 20 for EVM, all 32 for Sui, base58 over all 32 for
 * Solana. A value whose "padding" is not zero is refused rather than trimmed
 * into an address that is not the recipient.
 */

import { toBase58 } from "@mysten/sui/utils";
import {
  formatAccountId,
  isKnownChainId,
  namespaceOf,
  normalizeAddressForChain,
  type ChainId,
} from "../chain-id.js";

/** Decode a 32-byte padded address for `chain`, or null when the shape is wrong. */
export function unpadForeignAddress(bytes: Uint8Array, chain: ChainId): string | null {
  if (bytes.length !== 32) return null;
  const hex = Buffer.from(bytes).toString("hex");
  const ns = namespaceOf(chain);
  if (ns === "eip155") {
    if (!bytes.subarray(0, 12).every((b) => b === 0)) return null;
    return `0x${hex.slice(24)}`;
  }
  if (ns === "sui") return `0x${hex}`;
  if (ns === "solana") return toBase58(bytes);
  return null;
}

/**
 * Decode an address a bridge wrote at its native length rather than padded:
 * Axelar and Celer carry an EVM recipient as 20 bytes. 32 bytes go through
 * the padded rule, so either form decodes; any other length is refused.
 */
export function decodeRawForeignAddress(bytes: Uint8Array, chain: ChainId): string | null {
  if (bytes.length === 20 && namespaceOf(chain) === "eip155") return `0x${Buffer.from(bytes).toString("hex")}`;
  return unpadForeignAddress(bytes, chain);
}

/**
 * CAIP-10 for a decoded recipient, or null when the chain is unmapped or the
 * address does not validate for it. An address stored under a guessed chain
 * reads as verified, so the caller reports the raw value instead.
 */
export function foreignAccountId(chain: ChainId | null, address: string | null): string | null {
  if (!chain || !address || !isKnownChainId(chain)) return null;
  try {
    return formatAccountId({ chain, address: normalizeAddressForChain(chain, address) });
  } catch {
    return null;
  }
}
