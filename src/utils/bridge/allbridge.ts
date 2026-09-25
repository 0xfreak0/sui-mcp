/**
 * Allbridge Core transfers sent from Sui.
 *
 * Both Allbridge packages emit `events::TokensSentEvent` with the destination
 * as an Allbridge chain id and the recipient as 32-byte hex (no `0x`). The
 * module and event names are generic, so each is pinned to its package.
 *
 * - CCTP interface (the live path): Allbridge burns through Circle CCTP in the
 *   same transaction, with the same nonce. `recipient` is the CCTP mint
 *   recipient; `recipient_wallet_address` is the end user. On Solana they
 *   differ: USDC is minted into the wallet's token account (AyApNXU7…). The
 *   wallet is the beneficiary, so the CCTP leg is reported as Allbridge's
 *   carrier rather than as a second beneficiary. Verified on 9fB7PTQV… (to
 *   Arbitrum) and AyApNXU7… (to Solana).
 * - Pool bridge (deprecated after the July 2026 incident): `recipient` is the
 *   user, `messenger` names the messaging layer. Verified on FmxxWhRo….
 */

import { ETHEREUM, SOLANA_MAINNET, SUI_MAINNET, chainDisplayName, type ChainId } from "../chain-id.js";
import { raw32, type Beneficiary } from "./beneficiary.js";
import { matchesEvent } from "./event-type.js";
import { foreignAccountId, unpadForeignAddress } from "./foreign-address.js";
import type { SuiEventNode } from "./wormhole.js";

export const ALLBRIDGE_CCTP_PACKAGE = "0x647e874d024e3dcbb77ac023ea6a506d2c8ff832ec58c4b2ad14e71ac465546c";
export const ALLBRIDGE_POOL_PACKAGE = "0x83d6f864a6b0f16898376b486699aa6321eb6466d1daf6a2e3764a51908fe99d";
export const ALLBRIDGE_CCTP_EVENT = `${ALLBRIDGE_CCTP_PACKAGE}::events::TokensSentEvent`;
export const ALLBRIDGE_POOL_EVENT = `${ALLBRIDGE_POOL_PACKAGE}::events::TokensSentEvent`;

/**
 * Allbridge chain ids → CAIP-2, from Allbridge's own token-info API
 * (api.core.allbridge.io/token-info, `chainId` per chain symbol). Id 6 is
 * confirmed on chain: 9fB7PTQV… pairs it with CCTP domain 3, Arbitrum.
 */
const ALLBRIDGE_TO_CAIP2: Record<number, ChainId> = {
  1: ETHEREUM,
  4: SOLANA_MAINNET,
  5: "eip155:137",
  6: "eip155:42161",
  8: "eip155:43114",
  9: "eip155:8453",
  10: "eip155:10",
  13: SUI_MAINNET,
};

const ALLBRIDGE_NAMES: Record<number, string> = {
  3: "Tron",
  7: "Stellar",
  14: "Unichain",
  16: "Stacks",
};

export function allbridgeChainLabel(id: number): string {
  const caip2 = ALLBRIDGE_TO_CAIP2[id];
  if (caip2) return chainDisplayName(caip2);
  return ALLBRIDGE_NAMES[id] ?? `Allbridge chain ${id}`;
}

/** Allbridge's `messenger` byte on the pool bridge. */
const MESSENGERS: Record<number, string> = { 1: "Allbridge", 2: "Wormhole" };

export interface AllbridgeTransfer {
  route: "cctp" | "pool";
  nonce: string | null;
  destination_chain: ChainId | null;
  destination_chain_label: string;
  allbridge_chain_id: number;
  /** CCTP route: the account USDC is minted into. Pool route: the recipient. */
  recipient: string | null;
  recipient_raw: string;
  amount: string | null;
  sender: string | null;
  messenger?: string;
  beneficiary: Beneficiary;
}

/** Every Allbridge Core transfer this transaction sent. */
export function allbridgeTransfers(events: SuiEventNode[]): AllbridgeTransfer[] {
  const out: AllbridgeTransfer[] = [];
  for (const e of events) {
    const t = e?.contents?.type?.repr;
    if (typeof t !== "string") continue;
    const route = matchesEvent(ALLBRIDGE_CCTP_EVENT, t) ? "cctp" : matchesEvent(ALLBRIDGE_POOL_EVENT, t) ? "pool" : null;
    if (!route) continue;
    const f = (e.contents?.json ?? {}) as Record<string, unknown>;
    const recipient = raw32(f.recipient);
    if (!recipient || typeof f.destination_chain_id !== "number") continue;
    const id = f.destination_chain_id;
    const chain = ALLBRIDGE_TO_CAIP2[id] ?? null;
    // The CCTP route names the wallet separately; the pool route's recipient is the wallet.
    const wallet = (route === "cctp" ? raw32(f.recipient_wallet_address) : null) ?? recipient;
    const walletAddress = chain ? unpadForeignAddress(wallet, chain) : null;
    const amount =
      typeof f.amount === "string" ? f.amount : typeof f.vusd_amount === "string" ? f.vusd_amount : null;
    const nonce = typeof f.nonce === "string" ? f.nonce : null;
    const messenger = typeof f.messenger === "number" ? (MESSENGERS[f.messenger] ?? `messenger ${f.messenger}`) : undefined;
    out.push({
      route,
      nonce,
      destination_chain: chain,
      destination_chain_label: allbridgeChainLabel(id),
      allbridge_chain_id: id,
      recipient: chain ? unpadForeignAddress(recipient, chain) : null,
      recipient_raw: `0x${recipient.toString("hex")}`,
      amount,
      sender: typeof f.sender === "string" ? f.sender : null,
      ...(messenger ? { messenger } : {}),
      beneficiary: {
        evidence: "chain-derived",
        protocol: "Allbridge Core",
        source: "allbridge-recipient-wallet",
        chain,
        chain_label: allbridgeChainLabel(id),
        allbridge_chain_id: id,
        ...(nonce ? { transfer_id: nonce } : {}),
        address: walletAddress,
        address_raw: `0x${wallet.toString("hex")}`,
        account: foreignAccountId(chain, walletAddress),
        ...(amount
          ? {
              amount,
              amount_note:
                route === "cctp" ? "In the Sui coin's units, as burned through CCTP." : "vusd_amount: Allbridge's internal virtual-USD units.",
            }
          : {}),
      },
    });
  }
  return out;
}
