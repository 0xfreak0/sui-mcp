/**
 * LayerZero V2 packets sent from Sui, read from chain data.
 *
 * Every outbound message, whatever OApp sends it, is a
 * `messaging_channel::PacketSentEvent` typed at the endpoint package, and its
 * `encoded_packet` is the V1 packet the destination endpoint verifies:
 *
 *   version(1) ‖ nonce(8) ‖ srcEid(4) ‖ sender(32) ‖ dstEid(4) ‖ receiver(32)
 *   ‖ guid(32) ‖ message
 *
 * The GUID is LayerZero's transfer identity, quoted by the destination chain
 * on delivery, and `receiver` is the destination OApp: the contract the
 * message is delivered to, never the recipient of funds. For an OFT the
 * message opens with `sendTo(32) ‖ amountSD(u64)`, which names the recipient.
 * That is read only when the packet's sender is the package that emitted an
 * `oft::OFTSentEvent` with the same GUID in the same transaction: the message
 * format is the OApp's own, and a shape match on another app's message would
 * name a stranger.
 *
 * Verified on 4rH8bqFB… (wBTC OFT to Ethereum), where the decoded `sendTo`
 * equals LayerZero Scan's payload and the GUID equals its `guid`.
 */

import { ETHEREUM, SOLANA_MAINNET, SUI_MAINNET, canonicalSuiAddress, chainDisplayName, type ChainId } from "../chain-id.js";
import type { Beneficiary } from "./beneficiary.js";
import { matchesEvent } from "./event-type.js";
import { foreignAccountId, unpadForeignAddress } from "./foreign-address.js";
import type { SuiEventNode } from "./wormhole.js";

/** The endpoint package that types `PacketSentEvent`. Event types keep the original package, so an upgrade does not move this. */
export const LAYERZERO_ENDPOINT_PACKAGE = "0x31beaef889b08b9c3b37d19280fc1f8b75bae5b2de2410fc3120f403e9a36dac";
export const LAYERZERO_PACKET_EVENT = `${LAYERZERO_ENDPOINT_PACKAGE}::messaging_channel::PacketSentEvent`;
const OFT_SENT_EVENT = "oft::OFTSentEvent";

/**
 * LayerZero endpoint ids → CAIP-2, from LayerZero's deployment metadata
 * (metadata.layerzero-api.com, `nativeChainId` per `*-mainnet` entry). Unlike
 * Wormhole's and Circle's numbering, endpoint ids are distinct per
 * environment (mainnet 30xxx, testnet 40xxx), so a mapped id is a mainnet
 * chain wherever the call runs. Deliberately partial: an unmapped id is
 * reported by number.
 */
const EID_TO_CAIP2: Record<number, ChainId> = {
  30101: ETHEREUM,
  30102: "eip155:56",
  30106: "eip155:43114",
  30109: "eip155:137",
  30110: "eip155:42161",
  30111: "eip155:10",
  30168: SOLANA_MAINNET,
  30184: "eip155:8453",
  30378: SUI_MAINNET,
};

/** Names for endpoint ids seen from Sui that have no CAIP-2 rule here. */
const EID_NAMES: Record<number, string> = {
  30390: "Monad",
};

export function caip2ForLayerZeroEid(eid: number): ChainId | null {
  return EID_TO_CAIP2[eid] ?? null;
}

export function layerZeroEidLabel(eid: number): string {
  const caip2 = EID_TO_CAIP2[eid];
  if (caip2) return chainDisplayName(caip2);
  return EID_NAMES[eid] ?? `LayerZero endpoint ${eid}`;
}

export interface LayerZeroPacket {
  nonce: string;
  srcEid: number;
  /** The sending OApp on Sui, as a Sui address. */
  sender: string;
  dstEid: number;
  /** The destination OApp, 32 bytes as the packet holds it. */
  receiverRaw: string;
  guid: string;
  message: Buffer;
}

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

/** Decode `encoded_packet`, or null when it is not a V1 packet. */
export function parsePacket(base64: string): LayerZeroPacket | null {
  const b = Buffer.from(base64, "base64");
  if (b.length < 113 || b[0] !== 1) return null;
  return {
    nonce: b.readBigUInt64BE(1).toString(),
    srcEid: b.readUInt32BE(9),
    sender: hex(b.subarray(13, 45)),
    dstEid: b.readUInt32BE(45),
    receiverRaw: hex(b.subarray(49, 81)),
    guid: hex(b.subarray(81, 113)),
    message: b.subarray(113),
  };
}

export interface LayerZeroTransfer {
  guid: string;
  nonce: string;
  src_eid: number;
  dst_eid: number;
  destination_chain: ChainId | null;
  destination_chain_label: string;
  sender_oapp: string;
  /** The contract the message is delivered to on the destination chain. */
  destination_oapp: { address: string | null; address_raw: string; account: string | null };
  oft: {
    package: string;
    from_address: string | null;
    amount_sent_ld: string | null;
    amount_received_ld: string | null;
    amount_sd: string;
    has_compose: boolean;
  } | null;
  beneficiary: Beneficiary | null;
}

/** GUIDs arrive as `{ bytes: base64 }` in event JSON. */
function guidOf(v: unknown): string | null {
  const bytes = (v as { bytes?: unknown } | null)?.bytes;
  if (typeof bytes !== "string") return null;
  const b = Buffer.from(bytes, "base64");
  return b.length === 32 ? hex(b) : null;
}

/** Every LayerZero packet this transaction sent, with the OFT recipient where the sender is provably an OFT. */
export function layerZeroTransfers(events: SuiEventNode[]): LayerZeroTransfer[] {
  const ofts = new Map<string, { pkg: string; json: Record<string, unknown> }>();
  const packets: LayerZeroPacket[] = [];
  for (const e of events) {
    const t = e?.contents?.type?.repr;
    if (typeof t !== "string") continue;
    const json = (e.contents?.json ?? {}) as Record<string, unknown>;
    if (matchesEvent(OFT_SENT_EVENT, t)) {
      const guid = guidOf(json.guid);
      const pkg = canonicalSuiAddress(t.slice(0, t.indexOf("::")));
      if (guid && pkg) ofts.set(guid, { pkg, json });
    } else if (matchesEvent(LAYERZERO_PACKET_EVENT, t) && typeof json.encoded_packet === "string") {
      const p = parsePacket(json.encoded_packet);
      if (p) packets.push(p);
    }
  }

  return packets.map((p) => {
    const chain = caip2ForLayerZeroEid(p.dstEid);
    const receiverBytes = Buffer.from(p.receiverRaw.slice(2), "hex");
    const receiver = chain ? unpadForeignAddress(receiverBytes, chain) : null;
    const oftEvent = ofts.get(p.guid);
    // Pinned: the OFT event's own package must be the packet's sender.
    const oft = oftEvent && oftEvent.pkg === p.sender && p.message.length >= 40 ? oftEvent : null;
    const hasCompose = p.message.length > 40;
    const str = (v: unknown) => (typeof v === "string" ? v : null);

    let beneficiary: Beneficiary | null = null;
    if (oft) {
      const sendTo = p.message.subarray(0, 32);
      const address = chain ? unpadForeignAddress(sendTo, chain) : null;
      const received = str(oft.json.amount_received_ld);
      beneficiary = {
        evidence: "chain-derived",
        protocol: "LayerZero OFT",
        source: "layerzero-oft-send-to",
        chain,
        chain_label: layerZeroEidLabel(p.dstEid),
        layerzero_eid: p.dstEid,
        transfer_id: p.guid,
        address,
        address_raw: hex(sendTo),
        account: foreignAccountId(chain, address),
        ...(received ? { amount: received, amount_note: "amount_received_ld, in the Sui coin's units." } : {}),
        ...(hasCompose
          ? {
              note: "The message carries a compose call: sendTo receives the tokens and then runs it, so it may be a contract acting for the end recipient.",
            }
          : {}),
      };
    }

    return {
      guid: p.guid,
      nonce: p.nonce,
      src_eid: p.srcEid,
      dst_eid: p.dstEid,
      destination_chain: chain,
      destination_chain_label: layerZeroEidLabel(p.dstEid),
      sender_oapp: p.sender,
      destination_oapp: {
        address: receiver,
        address_raw: p.receiverRaw,
        account: foreignAccountId(chain, receiver),
      },
      oft: oft
        ? {
            package: oft.pkg,
            from_address: str(oft.json.from_address),
            amount_sent_ld: str(oft.json.amount_sent_ld),
            amount_received_ld: str(oft.json.amount_received_ld),
            amount_sd: p.message.readBigUInt64BE(32).toString(),
            has_compose: hasCompose,
          }
        : null,
      beneficiary,
    };
  });
}
