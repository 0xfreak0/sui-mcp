/**
 * Everything a transaction's events say about value crossing a bridge, read
 * from chain data alone.
 *
 * `resolve_bridge_transfer` and any tool that summarises exits share this, so
 * they agree on who a transfer pays rather than drifting apart. No indexer is
 * consulted here; the Wormholescan and LayerZero Scan lookups stay in the
 * tool.
 *
 * The LayerZero, Axelar, Allbridge and Celer decoders are pinned to mainnet
 * packages, so they are silent on any other network rather than claiming a
 * mainnet chain for a testnet transfer.
 */

import { allbridgeTransfers, type AllbridgeTransfer } from "./allbridge.js";
import { axelarTransfers, type AxelarTransfer } from "./axelar.js";
import {
  decodeWormholePayload,
  mayanBeneficiaries,
  type Beneficiary,
  type DecodedWormholePayload,
} from "./beneficiary.js";
import {
  CCTP_DEPOSIT_EVENT_SUFFIX,
  CCTP_MESSAGE_EVENT_SUFFIX,
  parseDepositForBurn,
  parseMessageHeader,
  type CctpTransfer,
} from "./cctp.js";
import {
  CLAIM_EVENT_SUFFIX,
  DEPOSIT_EVENT_SUFFIXES,
  parseClaimEvent,
  parseDepositEvent,
  type NativeBridgeClaim,
  type NativeBridgeTransfer,
} from "./sui-native.js";
import { celerBurns, type CelerBurn } from "./celer.js";
import { layerZeroTransfers, type LayerZeroTransfer } from "./layerzero.js";
import { tokenBridgeRedemptions, type WormholeInbound } from "./wormhole-inbound.js";
import { extractWormholeMessages, type SuiEventNode, type WormholeMessage } from "./wormhole.js";

export interface BridgeEventReading {
  cctpTransfers: CctpTransfer[];
  nativeTransfers: NativeBridgeTransfer[];
  /** Value ARRIVING on Sui. An entry, never an exit. */
  nativeInboundClaims: NativeBridgeClaim[];
  messages: WormholeMessage[];
  /** Parallel to `messages`; null where the payload is not one this server attributes. */
  decodedMessages: Array<DecodedWormholePayload | null>;
  mayan: Beneficiary[];
  /** True for a CCTP recipient that is Mayan's settlement contract, not the beneficiary. */
  settlesForMayan: (address: string | null) => boolean;
  layerZero: LayerZeroTransfer[];
  axelar: AxelarTransfer[];
  allbridge: AllbridgeTransfer[];
  /** True for a CCTP burn that carries an Allbridge transfer (same nonce): its beneficiary is Allbridge's wallet. */
  carriesAllbridge: (cctpNonce: string | null) => boolean;
  celer: CelerBurn[];
  /** Token Bridge redemptions: value ARRIVING on Sui. NTT redemptions need the inputs; see `nttRedemptions`. */
  wormholeInbound: WormholeInbound[];
  /** Every far-side recipient read from chain data. */
  beneficiaries: Beneficiary[];
}

/** Case-insensitive for hex, exact for base58. */
export function sameForeignAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const typeOf = (e: SuiEventNode) => e?.contents?.type?.repr;

export function readBridgeEvents(events: SuiEventNode[], qualify: boolean): BridgeEventReading {
  const messages = extractWormholeMessages(events);

  // CCTP: the burn event carries destination domain and recipient, so this
  // half is chain-derived. The paired MessageSent supplies the source
  // domain, which completes the transfer id.
  const cctpHeader = (() => {
    for (const e of events) {
      const t = typeOf(e);
      if (typeof t !== "string" || !t.endsWith(CCTP_MESSAGE_EVENT_SUFFIX)) continue;
      const msg = (e.contents?.json as { message?: unknown } | undefined)?.message;
      if (typeof msg === "string") {
        const header = parseMessageHeader(msg);
        if (header) return header;
      }
    }
    return null;
  })();

  const cctpTransfers = events
    .filter((e) => {
      const t = typeOf(e);
      return typeof t === "string" && t.endsWith(CCTP_DEPOSIT_EVENT_SUFFIX);
    })
    .map((e) => parseDepositForBurn(e.contents?.json, cctpHeader, qualify))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  // Sui's native bridge carries its destination in the event, so this half
  // is chain-derived — no indexer is consulted for it at all.
  const nativeTransfers = events
    .filter((e) => {
      const t = typeOf(e);
      return typeof t === "string" && DEPOSIT_EVENT_SUFFIXES.some((sfx) => t.endsWith(sfx));
    })
    .map((e) => parseDepositEvent(e.contents?.json))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  // Inbound claims are value ARRIVING on Sui. Reporting one as an exit
  // would send an investigator to the wrong chain entirely — but an entry
  // is still worth resolving, since the claim quotes the origin chain's own
  // transfer identity and a trace running backwards dead-ends without it.
  const nativeInboundClaims = events
    .filter((e) => {
      const t = typeOf(e);
      return typeof t === "string" && t.endsWith(CLAIM_EVENT_SUFFIX);
    })
    .map((e) => parseClaimEvent(e.contents?.json, qualify))
    .filter((cl): cl is NonNullable<typeof cl> => cl !== null);

  // Who each transfer pays on the far side. Mayan settles over CCTP and
  // Wormhole into its own contracts, so its order event names the
  // beneficiary and a CCTP leg of the same transaction that mints to a
  // different address is settlement, not the destination.
  const mayan = mayanBeneficiaries(events, qualify);
  const settlesForMayan = (address: string | null) =>
    mayan.length > 0 && !mayan.some((b) => sameForeignAddress(b.address, address));
  const decodedMessages = messages.map((m) => decodeWormholePayload(m, qualify));
  const layerZero = layerZeroTransfers(events);
  const axelar = axelarTransfers(events);
  const allbridge = allbridgeTransfers(events);
  const celer = celerBurns(events);
  // Allbridge's live route burns through CCTP with its own nonce. The burn's
  // mint recipient is where USDC lands (on Solana, the wallet's token
  // account); Allbridge's event names the wallet, so that is the beneficiary.
  const allbridgeNonces = new Set(allbridge.filter((a) => a.route === "cctp").map((a) => a.nonce));
  const carriesAllbridge = (cctpNonce: string | null) => cctpNonce !== null && allbridgeNonces.has(cctpNonce);
  const beneficiaries: Beneficiary[] = [
    ...mayan,
    ...decodedMessages.flatMap((d) => (d?.beneficiary ? [d.beneficiary] : [])),
    ...layerZero.flatMap((l) => (l.beneficiary ? [l.beneficiary] : [])),
    ...axelar.map((a) => a.beneficiary),
    ...allbridge.map((a) => a.beneficiary),
    ...celer.map((c) => c.beneficiary),
    ...cctpTransfers
      .filter((t) => !settlesForMayan(t.destinationAddress) && !carriesAllbridge(t.nonce))
      .map((t): Beneficiary => ({
        evidence: "chain-derived",
        protocol: "Circle CCTP",
        source: "cctp-mint-recipient",
        chain: t.destinationAccount ? t.destinationAccount.split(":").slice(0, 2).join(":") : null,
        chain_label: t.destinationChainLabel,
        cctp_domain: t.destinationDomain,
        address: t.destinationAddress,
        address_raw: t.mintRecipientRaw ?? "",
        account: t.destinationAccount,
        ...(t.amount ? { amount: t.amount } : {}),
      })),
    ...nativeTransfers.map((t): Beneficiary => ({
      evidence: "chain-derived",
      protocol: "Sui Bridge",
      source: "sui-native-bridge",
      chain: t.targetAccount ? t.targetAccount.split(":").slice(0, 2).join(":") : null,
      chain_label: t.targetChainLabel,
      address: t.targetAddress,
      address_raw: t.targetAddress ?? "",
      account: t.targetAccount,
      ...(t.amount ? { amount: t.amount } : {}),
    })),
  ];

  return {
    cctpTransfers,
    nativeTransfers,
    nativeInboundClaims,
    messages,
    decodedMessages,
    mayan,
    settlesForMayan,
    layerZero,
    axelar,
    allbridge,
    carriesAllbridge,
    celer,
    wormholeInbound: tokenBridgeRedemptions(events, qualify),
    beneficiaries,
  };
}
