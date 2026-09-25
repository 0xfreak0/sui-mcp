/**
 * Axelar Interchain Token Service transfers sent from Sui.
 *
 * `events::InterchainTransfer<T>` carries `destination_chain` (Axelar's chain
 * name) and `destination_address` (raw bytes, at the destination's native
 * length: 20 for EVM, 32 for Solana), so the far side is chain-derived. The
 * event is generic, so it is matched with its type argument stripped, and it
 * is pinned to the ITS package that types it: `events` is a module name any
 * package can use. `source_address` is the ITS channel the transfer was sent
 * through, not the sender. The gateway's `ContractCall` only names the ITS hub
 * on Axelar, so it says nothing about where the funds went.
 *
 * Verified on 6YaLkwRs… (INK to Ethereum) and the Axelar probe transfers to
 * Solana, e.g. BYcsyud1….
 */

import { ETHEREUM, SOLANA_MAINNET, SUI_MAINNET, chainDisplayName, type ChainId } from "../chain-id.js";
import type { Beneficiary } from "./beneficiary.js";
import { matchesEvent } from "./event-type.js";
import { decodeRawForeignAddress, foreignAccountId } from "./foreign-address.js";
import type { SuiEventNode } from "./wormhole.js";

/** ITS's original package. Calls go to later versions (0xbaec6524…); events keep this type. */
export const AXELAR_ITS_PACKAGE = "0xc3c0222e59c9d3b34ab804840e271ef9a0e6f0adcc280133c9db9b9e060887ca";
export const AXELAR_TRANSFER_EVENT = `${AXELAR_ITS_PACKAGE}::events::InterchainTransfer`;

/**
 * Axelar chain names → CAIP-2, from Axelar's mainnet config
 * (axelar-contract-deployments, `axelarId` with its `chainId`). Axelar
 * compares chain names case-insensitively, and its own config spells them
 * both ways (`Ethereum`, `arbitrum`), so the key is lower-cased.
 */
const AXELAR_TO_CAIP2: Record<string, ChainId> = {
  ethereum: ETHEREUM,
  binance: "eip155:56",
  polygon: "eip155:137",
  avalanche: "eip155:43114",
  arbitrum: "eip155:42161",
  optimism: "eip155:10",
  base: "eip155:8453",
  solana: SOLANA_MAINNET,
  sui: SUI_MAINNET,
};

export function caip2ForAxelarChain(name: string): ChainId | null {
  return AXELAR_TO_CAIP2[name.toLowerCase()] ?? null;
}

export interface AxelarTransfer {
  destination_chain: ChainId | null;
  destination_chain_label: string;
  axelar_chain: string;
  token_id: string | null;
  coin_type: string | null;
  amount: string | null;
  source_channel: string | null;
  beneficiary: Beneficiary;
}

/** Every ITS transfer this transaction sent. */
export function axelarTransfers(events: SuiEventNode[]): AxelarTransfer[] {
  const out: AxelarTransfer[] = [];
  for (const e of events) {
    const t = e?.contents?.type?.repr;
    if (typeof t !== "string" || !matchesEvent(AXELAR_TRANSFER_EVENT, t)) continue;
    const f = (e.contents?.json ?? {}) as Record<string, unknown>;
    if (typeof f.destination_chain !== "string" || typeof f.destination_address !== "string") continue;
    const raw = Buffer.from(f.destination_address, "base64");
    const chain = caip2ForAxelarChain(f.destination_chain);
    const address = chain ? decodeRawForeignAddress(raw, chain) : null;
    const label = chain ? chainDisplayName(chain) : `Axelar chain ${f.destination_chain}`;
    const amount = typeof f.amount === "string" ? f.amount : null;
    const tokenId = (f.token_id as { id?: unknown } | null)?.id;
    const open = t.indexOf("<");
    out.push({
      destination_chain: chain,
      destination_chain_label: label,
      axelar_chain: f.destination_chain,
      token_id: typeof tokenId === "string" ? tokenId : null,
      coin_type: open >= 0 ? t.slice(open + 1, -1) : null,
      amount,
      source_channel: typeof f.source_address === "string" ? f.source_address : null,
      beneficiary: {
        evidence: "chain-derived",
        protocol: "Axelar ITS",
        source: "axelar-its-destination",
        chain,
        chain_label: label,
        axelar_chain: f.destination_chain,
        address,
        address_raw: `0x${raw.toString("hex")}`,
        account: foreignAccountId(chain, address),
        ...(amount ? { amount, amount_note: "In the Sui coin's units." } : {}),
      },
    });
  }
  return out;
}
