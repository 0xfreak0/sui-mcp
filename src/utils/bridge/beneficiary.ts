/**
 * Who a bridge transfer pays on the far side, read from the Sui transaction.
 *
 * The destination transaction names the contract that redeemed the transfer:
 * the Wormhole Token Bridge, an NTT manager, a relayer, Mayan's settlement
 * contract. That is where the value landed first, not who received it, and a
 * report that files the contract as the destination sends the investigator to
 * a shared contract. The recipient is chain-derived on the Sui side in every
 * case this module decodes:
 *
 * - Wormhole Token Bridge `Transfer` (payload 1) carries `to` and `toChain`.
 * - `TransferWithPayload` (payload 3) carries the contract that consumes the
 *   payload as `to`. When that contract is the Token Bridge Relayer, the inner
 *   payload carries `targetRecipient`.
 * - Wormhole NTT carries `to` and `to_chain` inside its transceiver message.
 * - Mayan's `OrderCreated` and `BridgeSubmittedWithFee` events carry
 *   `addr_dest` with the destination chain.
 *
 * Each decoder is pinned to something that identifies the sender, never to a
 * payload shape alone. A shape match on an unrelated app's payload would name
 * a stranger as the beneficiary, which is worse than naming nobody.
 */

import type { ChainId } from "../chain-id.js";
import { caip2ForCctpDomain, cctpDomainLabel } from "./cctp.js";
import { foreignAccountId, unpadForeignAddress } from "./foreign-address.js";
import {
  caip2ForWormholeChain,
  wormholeChainLabel,
  type SuiEventNode,
  type WormholeMessage,
} from "./wormhole.js";

/**
 * The Sui Token Bridge's emitter (its EmitterCap object id, as the VAA holds
 * it). Verified on mainnet: transfers GkWjxVGi… and Heso3vSy… and the relayed
 * transfer 7oiD7oNk… all carry it. Wormholescan attributes it to
 * PORTAL_TOKEN_BRIDGE.
 */
export const SUI_TOKEN_BRIDGE_EMITTER =
  "ccceeb29348f71bdd22ffef43a2a19c1f5b5e17c5cca5411529120182672ade5";

/**
 * `fromAddress` values of the Token Bridge Relayer on Sui. A payload-3
 * transfer from one of these carries the Relayer's `TransferWithRelay`
 * message, whose last field is the recipient. Verified on 7oiD7oNk…, where
 * the decoded recipient matches Wormholescan's `toAddress` and the Ethereum
 * redemption forwarded the funds to it.
 */
const TOKEN_BRIDGE_RELAYER_SENDERS: Record<string, true> = {
  c4c610707eab9b222996b075f7d07c7d9b07766ab7bcafef621fd53bbf089f4e: true,
};

/** `WH_TRANSCEIVER_PAYLOAD_PREFIX`, which opens every NTT Wormhole message. */
const NTT_TRANSCEIVER_PREFIX = 0x9945ff10;
/** `NTT` prefix of a `NativeTokenTransfer` inside the manager message. */
const NTT_TRANSFER_PREFIX = 0x994e5454;

export type BeneficiarySource =
  | "token-bridge-transfer"
  | "token-bridge-relayer"
  | "ntt-transfer"
  | "mayan-order"
  | "mayan-mctp"
  | "cctp-mint-recipient"
  | "sui-native-bridge";

/** A far-side recipient read from the Sui transaction. Always chain-derived. */
export interface Beneficiary {
  evidence: "chain-derived";
  protocol: string;
  source: BeneficiarySource;
  /** CAIP-2. Null off mainnet (bridge numberings are reused) or when unmapped. */
  chain: ChainId | null;
  chain_label: string;
  wormhole_chain_id?: number;
  cctp_domain?: number;
  /** In the destination chain's own format, when the padding decodes. */
  address: string | null;
  /** The 32-byte value exactly as the chain holds it. */
  address_raw: string;
  account: string | null;
  /** Amount as the message states it; `amount_note` says in what units. */
  amount?: string;
  amount_note?: string;
  /** The Wormhole message this was decoded from, when there is one. */
  vaa_id?: string;
  /** The contract the payload was addressed to, when the recipient is behind it. */
  via_contract?: string;
}

/** What a Wormhole message says about the transfer, when this module can read it. */
export interface DecodedWormholePayload {
  kind: "token-bridge-transfer" | "token-bridge-transfer-with-payload" | "ntt-transfer";
  to_chain: number;
  /** The payload's own `to`: the recipient, or the contract that consumes payload 3. */
  to_raw: string;
  beneficiary: Beneficiary | null;
}

function hex(b: Uint8Array): string {
  return `0x${Buffer.from(b).toString("hex")}`;
}

function wormholeBeneficiary(
  protocol: string,
  source: BeneficiarySource,
  toChain: number,
  raw: Uint8Array,
  qualify: boolean,
  extra: Partial<Beneficiary>,
): Beneficiary {
  // A reused chain number keeps its chain family (chain 2 is EVM on every
  // environment), so the address format holds off mainnet; only the CAIP-2
  // claim does not.
  const decodeChain = caip2ForWormholeChain(toChain);
  const chain = qualify ? decodeChain : null;
  const address = decodeChain ? unpadForeignAddress(raw, decodeChain) : null;
  return {
    evidence: "chain-derived",
    protocol,
    source,
    chain,
    chain_label: wormholeChainLabel(toChain),
    wormhole_chain_id: toChain,
    address,
    address_raw: hex(raw),
    account: foreignAccountId(chain, address),
    ...extra,
  };
}

function decodeNtt(b: Buffer, msg: WormholeMessage, qualify: boolean): DecodedWormholePayload | null {
  // prefix(4) sourceManager(32) recipientManager(32) len(2) managerPayload
  if (b.length < 70) return null;
  const managerLen = b.readUInt16BE(68);
  const manager = b.subarray(70, 70 + managerLen);
  // id(32) sender(32) len(2) payload
  if (manager.length !== managerLen || managerLen < 66) return null;
  const payloadLen = manager.readUInt16BE(64);
  const p = manager.subarray(66, 66 + payloadLen);
  // prefix(4) decimals(1) amount(8) sourceToken(32) to(32) toChain(2)
  if (p.length !== payloadLen || p.length < 79 || p.readUInt32BE(0) !== NTT_TRANSFER_PREFIX) return null;
  const decimals = p[4];
  const amount = p.readBigUInt64BE(5).toString();
  const to = p.subarray(45, 77);
  const toChain = p.readUInt16BE(77);
  return {
    kind: "ntt-transfer",
    to_chain: toChain,
    to_raw: hex(to),
    beneficiary: wormholeBeneficiary("Wormhole NTT", "ntt-transfer", toChain, to, qualify, {
      amount,
      amount_note: `NTT trimmed amount at ${decimals} decimals.`,
      vaa_id: msg.vaaId,
    }),
  };
}

function decodeTokenBridge(b: Buffer, msg: WormholeMessage, qualify: boolean): DecodedWormholePayload | null {
  const id = b[0];
  // id(1) amount(32) tokenAddress(32) tokenChain(2) to(32) toChain(2) ...
  if ((id !== 1 && id !== 3) || b.length < 133) return null;
  const amount = BigInt(hex(b.subarray(1, 33))).toString();
  const to = b.subarray(67, 99);
  const toChain = b.readUInt16BE(99);
  const amountNote = "Token Bridge amount, normalised to at most 8 decimals.";

  if (id === 1) {
    return {
      kind: "token-bridge-transfer",
      to_chain: toChain,
      to_raw: hex(to),
      beneficiary: wormholeBeneficiary("Wormhole Token Bridge", "token-bridge-transfer", toChain, to, qualify, {
        amount,
        amount_note: amountNote,
        vaa_id: msg.vaaId,
      }),
    };
  }

  // Payload 3: `to` is the contract that consumes the payload. Only the Token
  // Bridge Relayer's message is decoded, and only from its known sender.
  const from = b.subarray(101, 133).toString("hex");
  const inner = b.subarray(133);
  let beneficiary: Beneficiary | null = null;
  // TransferWithRelay: id(1)=1 targetRelayerFee(32) toNativeTokenAmount(32) targetRecipient(32)
  if (Object.hasOwn(TOKEN_BRIDGE_RELAYER_SENDERS, from) && inner.length === 97 && inner[0] === 1) {
    const decodeChain = caip2ForWormholeChain(toChain);
    beneficiary = wormholeBeneficiary(
      "Wormhole Token Bridge Relayer",
      "token-bridge-relayer",
      toChain,
      inner.subarray(65, 97),
      qualify,
      {
        amount,
        amount_note: amountNote,
        vaa_id: msg.vaaId,
        via_contract: (decodeChain && unpadForeignAddress(to, decodeChain)) ?? hex(to),
      },
    );
  }
  return { kind: "token-bridge-transfer-with-payload", to_chain: toChain, to_raw: hex(to), beneficiary };
}

/**
 * Decode a Wormhole message's payload, or null when it is not one this module
 * can attribute. The Token Bridge is recognised by its emitter, NTT by the
 * transceiver prefix, which Wormhole reserves for it.
 */
export function decodeWormholePayload(msg: WormholeMessage, qualify: boolean): DecodedWormholePayload | null {
  if (!msg.payloadBase64) return null;
  let b: Buffer;
  try {
    b = Buffer.from(msg.payloadBase64, "base64");
  } catch {
    return null;
  }
  if (b.length >= 4 && b.readUInt32BE(0) === NTT_TRANSCEIVER_PREFIX) return decodeNtt(b, msg, qualify);
  if (msg.emitter === SUI_TOKEN_BRIDGE_EMITTER) return decodeTokenBridge(b, msg, qualify);
  return null;
}

const MAYAN_MARKER_EVENT = "::init_order::InitMctpLogged";

/** `pkg::module::Name` without type arguments, split into package and tail. */
function splitType(t: string): { pkg: string; tail: string } {
  const bare = t.split("<")[0];
  const i = bare.indexOf("::");
  return { pkg: bare.slice(0, i), tail: bare.slice(i) };
}

function raw32(v: unknown): Buffer | null {
  if (typeof v !== "string") return null;
  const h = v.replace(/^0x/, "");
  return /^[0-9a-fA-F]{64}$/.test(h) ? Buffer.from(h, "hex") : null;
}

/**
 * Mayan's destination, from the package that emitted `InitMctpLogged` in the
 * same transaction.
 *
 * `init_order` is a generic module name that DEX order books also use, so an
 * `OrderCreated` is only read when Mayan's own marker event came from the same
 * package. `OrderCreated.chain_dest` is a Wormhole chain id (2 with CCTP
 * domain 0 on 6jMEFeap…); `BridgeSubmittedWithFee.dest_domain` is a CCTP
 * domain (6, Base, on 777Emr4V…).
 */
export function mayanBeneficiaries(events: SuiEventNode[], qualify: boolean): Beneficiary[] {
  const mayanPackages = new Set<string>();
  for (const e of events) {
    const t = e?.contents?.type?.repr;
    if (typeof t !== "string") continue;
    const { pkg, tail } = splitType(t);
    if (tail === MAYAN_MARKER_EVENT) mayanPackages.add(pkg);
  }
  if (mayanPackages.size === 0) return [];

  const out: Beneficiary[] = [];
  for (const e of events) {
    const t = e?.contents?.type?.repr;
    if (typeof t !== "string") continue;
    const { pkg, tail } = splitType(t);
    if (!mayanPackages.has(pkg)) continue;
    const f = (e.contents?.json ?? {}) as Record<string, unknown>;
    const dest = raw32(f.addr_dest);
    if (!dest) continue;

    if (tail === "::init_order::OrderCreated" && typeof f.chain_dest === "number") {
      out.push(
        wormholeBeneficiary("Mayan", "mayan-order", f.chain_dest, dest, qualify, {
          ...(typeof f.amount_in === "string" ? { amount: f.amount_in, amount_note: "amount_in, in the source coin's units." } : {}),
        }),
      );
    } else if (tail === "::bridge_with_fee::BridgeSubmittedWithFee" && typeof f.dest_domain === "number") {
      const decodeChain = caip2ForCctpDomain(f.dest_domain);
      const chain = qualify ? decodeChain : null;
      const address = decodeChain ? unpadForeignAddress(dest, decodeChain) : null;
      out.push({
        evidence: "chain-derived",
        protocol: "Mayan",
        source: "mayan-mctp",
        chain,
        chain_label: cctpDomainLabel(f.dest_domain),
        cctp_domain: f.dest_domain,
        address,
        address_raw: hex(dest),
        account: foreignAccountId(chain, address),
        ...(typeof f.amount_bridged === "string"
          ? { amount: f.amount_bridged, amount_note: "amount_bridged, in USDC base units." }
          : {}),
      });
    }
  }
  return out;
}
