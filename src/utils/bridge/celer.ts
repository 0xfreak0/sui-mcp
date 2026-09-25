/**
 * Celer cBridge pegged-token burns sent from Sui.
 *
 * `peg_bridge::BurnEvent` carries `to_chain` (Celer names EVM chains by their
 * EIP-155 id, as a decimal string) and `to_addr` (20 raw bytes), so the far
 * side is chain-derived. `burn_id` is cBridge's transfer id, which its
 * `getTransferStatus` API and the destination mint quote back. Pinned to the
 * package, since `peg_bridge` is not a name Celer owns. Verified on
 * AkW2h1WQ… (USDC to Ethereum).
 *
 * Celer also gives non-EVM chains ids in the same space (Sui is 12370001), so
 * `eip155:<to_chain>` is only claimed for a chain this server knows to be EVM.
 */

import { chainDisplayName, isKnownChainId, type ChainId } from "../chain-id.js";
import type { Beneficiary } from "./beneficiary.js";
import { matchesEvent } from "./event-type.js";
import { decodeRawForeignAddress, foreignAccountId } from "./foreign-address.js";
import type { SuiEventNode } from "./wormhole.js";

export const CELER_PACKAGE = "0x94e7a8e71830d2b34b3edaa195dc24c45d142584f06fa257b73af753d766e690";
export const CELER_BURN_EVENT = `${CELER_PACKAGE}::peg_bridge::BurnEvent`;

export interface CelerBurn {
  transfer_id: string | null;
  destination_chain: ChainId | null;
  destination_chain_label: string;
  celer_chain_id: number;
  coin: string | null;
  amount: string | null;
  burner: string | null;
  beneficiary: Beneficiary;
}

/** Every cBridge burn this transaction sent. */
export function celerBurns(events: SuiEventNode[]): CelerBurn[] {
  const out: CelerBurn[] = [];
  for (const e of events) {
    const t = e?.contents?.type?.repr;
    if (typeof t !== "string" || !matchesEvent(CELER_BURN_EVENT, t)) continue;
    const f = (e.contents?.json ?? {}) as Record<string, unknown>;
    const id = typeof f.to_chain === "string" ? Number(f.to_chain) : NaN;
    if (!Number.isSafeInteger(id) || typeof f.to_addr !== "string") continue;
    const evm = `eip155:${id}`;
    const chain = isKnownChainId(evm) ? evm : null;
    const raw = Buffer.from(f.to_addr, "base64");
    const address = chain ? decodeRawForeignAddress(raw, chain) : null;
    const burnId = typeof f.burn_id === "string" ? `0x${Buffer.from(f.burn_id, "base64").toString("hex")}` : null;
    const label = chain ? chainDisplayName(chain) : `Celer chain ${id}`;
    const amount = typeof f.amt === "string" ? f.amt : null;
    out.push({
      transfer_id: burnId,
      destination_chain: chain,
      destination_chain_label: label,
      celer_chain_id: id,
      coin: typeof f.coin_id === "string" ? f.coin_id : null,
      amount,
      burner: typeof f.burner === "string" ? f.burner : null,
      beneficiary: {
        evidence: "chain-derived",
        protocol: "Celer cBridge",
        source: "celer-burn-recipient",
        chain,
        chain_label: label,
        celer_chain_id: id,
        ...(burnId ? { transfer_id: burnId } : {}),
        address,
        address_raw: `0x${raw.toString("hex")}`,
        account: foreignAccountId(chain, address),
        ...(amount ? { amount, amount_note: "amt, in the Sui coin's units." } : {}),
      },
    });
  }
  return out;
}
