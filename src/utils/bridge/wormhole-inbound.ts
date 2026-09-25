/**
 * Wormhole transfers ARRIVING on Sui: the origin side of a redemption.
 *
 * An entry is not an exit, but a trace running backwards dead-ends at one
 * without the origin VAA, which names the chain and emitter the value came
 * from. Two sources, both chain-derived:
 *
 * - Token Bridge: `complete_transfer::TransferRedeemed` carries the VAA
 *   triple. Pinned to the Token Bridge package, whose events keep its type
 *   across upgrades. Verified on 84Z1YEze… (from BNB Chain).
 * - NTT: redemption emits no event at all (the only NTT event in the Sui
 *   sources is a governance one), so the VAA is read from the transaction's
 *   own input, the bytes it passes to `vaa::parse_and_verify`. Only a payload
 *   opening with NTT's transceiver prefix is read, and only when its transfer
 *   names Sui as `to_chain`: Pyth price updates verify VAAs too, and are not
 *   transfers. Verified on H2qXS8fT….
 */

import { caip2ForWormholeChain, vaaId, WORMHOLE_CHAIN_SUI, wormholeChainLabel, type SuiEventNode } from "./wormhole.js";
import { NTT_TRANSCEIVER_PREFIX, NTT_TRANSFER_PREFIX } from "./beneficiary.js";
import { matchesEvent } from "./event-type.js";
import type { ChainId } from "../chain-id.js";

export const WORMHOLE_TOKEN_BRIDGE_PACKAGE = "0x26efee2b51c911237888e5dc6702868abca3c7ac12c53f76ef8eba0697695e3d";
const TRANSFER_REDEEMED_EVENT = `${WORMHOLE_TOKEN_BRIDGE_PACKAGE}::complete_transfer::TransferRedeemed`;

export interface WormholeInbound {
  evidence: "chain-derived";
  kind: "token-bridge-redemption" | "ntt-redemption";
  vaa_id: string;
  /** CAIP-2 of the chain the VAA was emitted on. Null off mainnet or when unmapped. */
  origin_chain: ChainId | null;
  origin_chain_label: string;
  wormhole_chain_id: number;
  /** NTT only: the Sui account the transfer pays. */
  recipient?: string;
  amount?: string;
  amount_note?: string;
}

function inbound(
  kind: WormholeInbound["kind"],
  chain: number,
  emitter: string,
  sequence: string,
  qualify: boolean,
): WormholeInbound {
  return {
    evidence: "chain-derived",
    kind,
    vaa_id: vaaId(chain, emitter, sequence),
    origin_chain: qualify ? caip2ForWormholeChain(chain) : null,
    origin_chain_label: wormholeChainLabel(chain),
    wormhole_chain_id: chain,
  };
}

/** Token Bridge redemptions, from their events. */
export function tokenBridgeRedemptions(events: SuiEventNode[], qualify: boolean): WormholeInbound[] {
  const out: WormholeInbound[] = [];
  for (const e of events) {
    const t = e?.contents?.type?.repr;
    if (typeof t !== "string" || !matchesEvent(TRANSFER_REDEEMED_EVENT, t)) continue;
    const f = (e.contents?.json ?? {}) as Record<string, any>;
    const data = f.emitter_address?.value?.data;
    if (typeof f.emitter_chain !== "number" || typeof data !== "string") continue;
    if (typeof f.sequence !== "string" && typeof f.sequence !== "number") continue;
    const emitter = Buffer.from(data, "base64");
    if (emitter.length !== 32) continue;
    out.push(inbound("token-bridge-redemption", f.emitter_chain, emitter.toString("hex"), String(f.sequence), qualify));
  }
  return out;
}

/** A VAA's identity and payload, or null when the bytes are not a version-1 VAA. */
export function parseVaa(b: Buffer): { emitterChain: number; emitter: string; sequence: string; payload: Buffer } | null {
  // version(1) guardianSetIndex(4) signatureCount(1) signatures(66 each), then the body:
  // timestamp(4) nonce(4) emitterChain(2) emitter(32) sequence(8) consistency(1) payload
  if (b.length < 6 || b[0] !== 1) return null;
  const body = 6 + 66 * b[5];
  if (b.length < body + 51) return null;
  return {
    emitterChain: b.readUInt16BE(body + 8),
    emitter: b.subarray(body + 10, body + 42).toString("hex"),
    sequence: b.readBigUInt64BE(body + 42).toString(),
    payload: b.subarray(body + 51),
  };
}

/** The bytes of a BCS `vector<u8>`: a ULEB128 length, then the bytes. */
export function bcsBytes(b: Buffer): Buffer | null {
  let len = 0;
  let shift = 0;
  let i = 0;
  for (; i < b.length && i < 5; i++) {
    len |= (b[i] & 0x7f) << shift;
    shift += 7;
    if ((b[i] & 0x80) === 0) break;
  }
  const start = i + 1;
  return start + len === b.length ? b.subarray(start) : null;
}

/** One pure input as GraphQL returns it. */
export interface PureInputNode {
  __typename?: string;
  type?: { repr?: string } | null;
  bcs?: string | null;
}

/**
 * NTT transfers into Sui that this transaction redeemed, read from the VAA it
 * passed in. `inputs` is the transaction's pure inputs.
 */
export function nttRedemptions(inputs: PureInputNode[], qualify: boolean): WormholeInbound[] {
  const out: WormholeInbound[] = [];
  for (const input of inputs) {
    if (input?.type?.repr !== "vector<u8>" || typeof input.bcs !== "string") continue;
    const bytes = bcsBytes(Buffer.from(input.bcs, "base64"));
    const vaa = bytes && parseVaa(bytes);
    const p = vaa?.payload;
    if (!vaa || !p || p.length < 70 || p.readUInt32BE(0) !== NTT_TRANSCEIVER_PREFIX) continue;
    // prefix(4) sourceManager(32) recipientManager(32) len(2) managerPayload:
    //   id(32) sender(32) len(2) prefix(4) decimals(1) amount(8) sourceToken(32) to(32) toChain(2)
    const manager = p.subarray(70, 70 + p.readUInt16BE(68));
    if (manager.length < 66) continue;
    const t = manager.subarray(66, 66 + manager.readUInt16BE(64));
    if (t.length < 79 || t.readUInt32BE(0) !== NTT_TRANSFER_PREFIX || t.readUInt16BE(77) !== WORMHOLE_CHAIN_SUI) continue;
    out.push({
      ...inbound("ntt-redemption", vaa.emitterChain, vaa.emitter, vaa.sequence, qualify),
      recipient: `0x${t.subarray(45, 77).toString("hex")}`,
      amount: t.readBigUInt64BE(5).toString(),
      amount_note: `NTT trimmed amount at ${t[4]} decimals.`,
    });
  }
  return out;
}
