/**
 * Value arriving on Sui through a cross-chain fulfilment: a package that
 * consumes a message from another chain and pays out on Sui.
 *
 * The curated inbound readers cover the protocols whose redemption event this
 * server knows (the Token Bridge, NTT, Sui's native bridge). A solver-style
 * bridge fulfils through its own package instead, so its redemption names no
 * curated event, and a backward trace dead-ends at a transfer from nowhere.
 * Whatever the protocol, the fulfilment has to consume the other chain's
 * message, and it says which one in its own events:
 *
 *   - A CCTP message is identified by its source domain and nonce. An event
 *     carrying a `source_domain` field beside a `nonce` quotes one, and the
 *     domain names the chain the USDC was burned on.
 *   - A Wormhole message arrives as a VAA among the transaction's inputs. An
 *     event quoting that VAA's payload bytes or its sequence (in a field named
 *     for a sequence) consumed it, and the VAA names its emitter chain.
 *
 * Only a transaction that also credits an address counts: Pyth price updates
 * verify VAAs in ordinary DeFi traffic and pay nobody, and quote no VAA in
 * their events. The beneficiary is the address credited exactly an amount the
 * fulfilling package's events state, in the coin they state, which is a value
 * match on chain data.
 */

import { getLabel } from "../labels.js";
import { canonicalSuiAddress, type ChainId } from "../chain-id.js";
import { caip2ForCctpDomain, cctpDomainLabel, CCTP_SUI_DOMAIN } from "./cctp.js";
import { leaves, type Leaf } from "./cross-chain.js";
import { BRIDGE_PROTOCOLS } from "./detect.js";
import { matchesEvent } from "./event-type.js";
import { CLAIM_EVENT_SUFFIX } from "./sui-native.js";
import { bcsBytes, parseVaa, type PureInputNode } from "./wormhole-inbound.js";
import {
  caip2ForWormholeChain,
  vaaId,
  WORMHOLE_CHAIN_SUI,
  wormholeChainLabel,
  type EvidenceTier,
  type SuiEventNode,
} from "./wormhole.js";

/** One balance change, as the transaction's effects state it. */
export interface BalanceChangeRow {
  address: string;
  coin_type: string;
  amount: string;
}

/** A VAA passed to the transaction as a pure `vector<u8>` input. */
export interface InputVaa {
  vaaId: string;
  emitterChain: number;
  emitter: string;
  sequence: string;
  payload: Buffer;
}

export interface InboundFulfil {
  /** Tier of the origin chain: see `origin_basis`. */
  evidence: EvidenceTier;
  /** The package whose events quote the consumed message. */
  package: string;
  events: string[];
  origin_chain: ChainId | null;
  origin_chain_label: string;
  /** `cctp-source-domain` when a CCTP message is quoted, else `wormhole-vaa`. */
  origin_basis: "cctp-source-domain" | "wormhole-vaa";
  cctp?: {
    /**
     * Chain-derived for an event defined by a package that carries a bridge
     * label (Circle's own), heuristic when the domain is read from another
     * package's field named for it.
     */
    evidence: EvidenceTier;
    event_type: string;
    source_domain_field: string;
    source_domain: number;
    source_domain_label: string;
    nonce: string;
    transfer_id: string;
  };
  vaa?: {
    evidence: "chain-derived";
    vaa_id: string;
    emitter_chain: number;
    emitter_chain_label: string;
    emitter_chain_id: ChainId | null;
    sequence: string;
    quoted_by: Array<{ event_type: string; field: string }>;
    /** The PTB calls Wormhole's `vaa::parse_and_verify`. */
    verified_in_transaction: boolean;
  };
  /** Every amount field of the package's events, with the coin the event names when it names one. */
  amounts: Array<{ event_type: string; field: string; amount: string; coin_type: string | null }>;
  beneficiary: {
    evidence: EvidenceTier;
    address: string;
    coin_type: string;
    amount: string;
    /** The event field whose amount and coin the credit equals; null for the heuristic tier. */
    matched: { event_type: string; field: string } | null;
  } | null;
  /** Every address the transaction credited. */
  paid_to: BalanceChangeRow[];
  /** Every address other than the sender the transaction debited: where the paid-out value was held. */
  released_from: BalanceChangeRow[];
}

/** VAAs among the transaction's pure inputs. */
export function inputVaas(inputs: PureInputNode[]): InputVaa[] {
  return inputs.flatMap((input) => {
    if (input?.type?.repr !== "vector<u8>" || typeof input.bcs !== "string") return [];
    const bytes = bcsBytes(Buffer.from(input.bcs, "base64"));
    const vaa = bytes && parseVaa(bytes);
    return vaa ? [{ ...vaa, vaaId: vaaId(vaa.emitterChain, vaa.emitter, vaa.sequence) }] : [];
  });
}

const SOURCE_DOMAIN_FIELD = /(^|_)(source|src)_domain$/i;
const NONCE_FIELD = /(^|_)nonce$/i;
const SEQUENCE_FIELD = /sequence/i;
const AMOUNT_FIELD = /amount/i;
/** A Move type as an event renders it, with or without the `0x`. */
const MOVE_TYPE = /^(0x)?[0-9a-fA-F]{1,64}::[A-Za-z_]\w*::[A-Za-z_]\w*/;
/** The shortest payload compared by bytes: shorter ones collide with ordinary values. */
const MIN_QUOTED_PAYLOAD = 20;

const whole = (v: unknown): string | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? String(v) : typeof v === "string" && /^[0-9]{1,20}$/.test(v) ? v : null;

/** A byte string as an event renders it (hex, base64 or a byte array), as lowercase hex. */
function leafHex(v: unknown): string | null {
  if (Array.isArray(v) && v.length > 0 && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return Buffer.from(v as number[]).toString("hex");
  if (typeof v !== "string") return null;
  if (/^0x([0-9a-fA-F]{2})+$/.test(v)) return v.slice(2).toLowerCase();
  if (v.length >= 28 && v.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(v)) return Buffer.from(v, "base64").toString("hex");
  return null;
}

/** A coin type with its address unpadded, for comparing an event's rendering with the effects'. */
function coinKey(t: string): string {
  const [addr, ...rest] = t.split("::");
  return [addr.replace(/^0x/i, "").replace(/^0+/, "").toLowerCase(), ...rest].join("::");
}

/** Decoded by a curated reader already: an outbound marker event, a native-bridge claim, a Token Bridge redemption. */
function curated(type: string): boolean {
  const bare = type.split("<")[0];
  return (
    bare.endsWith(CLAIM_EVENT_SUFFIX) ||
    bare.endsWith("::complete_transfer::TransferRedeemed") ||
    BRIDGE_PROTOCOLS.some((p) => p.eventMarkers.some((m) => matchesEvent(m, type)))
  );
}

export interface InboundFulfilInput {
  events: SuiEventNode[];
  vaas: InputVaa[];
  /** VAA ids a curated inbound reader already reported. */
  reported: string[];
  verifiedVaa: boolean;
  balanceChanges: BalanceChangeRow[];
  sender: string | null;
  qualify: boolean;
}

/**
 * Inbound fulfilments in this transaction, one per package whose events quote
 * a consumed cross-chain message, when the transaction credits an address.
 */
export function inboundFulfilments(input: InboundFulfilInput): InboundFulfil[] {
  const paidTo = input.balanceChanges.filter((b) => BigInt(b.amount) > 0n);
  if (paidTo.length === 0) return [];
  const sender = input.sender ? canonicalSuiAddress(input.sender) : null;
  const releasedFrom = input.balanceChanges.filter((b) => BigInt(b.amount) < 0n && canonicalSuiAddress(b.address) !== sender);
  const vaas = input.vaas.filter((v) => v.emitterChain !== WORMHOLE_CHAIN_SUI && !input.reported.includes(v.vaaId));

  const parsed = input.events.flatMap((e) => {
    const type = e?.contents?.type?.repr;
    const json = e?.contents?.json;
    const pkg = typeof type === "string" ? canonicalSuiAddress(type.split("::")[0]) : null;
    if (typeof type !== "string" || !pkg || json === null || typeof json !== "object" || curated(type)) return [];
    const all: Leaf[] = [];
    leaves(json, "", "", 0, all);
    return [{ type, pkg, all }];
  });

  const byPackage = new Map<string, InboundFulfil>();
  for (const ev of parsed) {
    const domain = ev.all.find((l) => SOURCE_DOMAIN_FIELD.test(l.key) && whole(l.value) !== null);
    const nonce = ev.all.find((l) => NONCE_FIELD.test(l.key) && whole(l.value) !== null);
    const cctpDomain = domain && nonce ? Number(whole(domain.value)) : null;
    const cctp =
      cctpDomain !== null && cctpDomain !== CCTP_SUI_DOMAIN && domain && nonce
        ? {
            evidence: getLabel(ev.pkg)?.category === "bridge" ? ("chain-derived" as const) : ("heuristic" as const),
            event_type: ev.type,
            source_domain_field: domain.path,
            source_domain: cctpDomain,
            source_domain_label: cctpDomainLabel(cctpDomain),
            nonce: whole(nonce.value)!,
            transfer_id: `${cctpDomain}/${whole(nonce.value)}`,
          }
        : null;
    const quotes = vaas.flatMap((v) => {
      const payload = v.payload.length >= MIN_QUOTED_PAYLOAD ? v.payload.toString("hex") : null;
      const fields = ev.all.filter(
        (l) => (payload !== null && leafHex(l.value) === payload) || (SEQUENCE_FIELD.test(l.key) && whole(l.value) === v.sequence),
      );
      return fields.length ? [{ v, fields }] : [];
    });
    if (!cctp && quotes.length === 0) continue;

    const f = byPackage.get(ev.pkg) ?? {
      evidence: "heuristic" as EvidenceTier,
      package: ev.pkg,
      events: [],
      origin_chain: null,
      origin_chain_label: "",
      origin_basis: "wormhole-vaa" as const,
      amounts: [],
      beneficiary: null,
      paid_to: paidTo,
      released_from: releasedFrom,
    };
    if (!f.events.includes(ev.type)) f.events.push(ev.type);
    if (cctp && !f.cctp) f.cctp = cctp;
    const q = quotes[0];
    if (q && !f.vaa) {
      f.vaa = {
        evidence: "chain-derived",
        vaa_id: q.v.vaaId,
        emitter_chain: q.v.emitterChain,
        emitter_chain_label: wormholeChainLabel(q.v.emitterChain),
        emitter_chain_id: input.qualify ? caip2ForWormholeChain(q.v.emitterChain) : null,
        sequence: q.v.sequence,
        quoted_by: [],
        verified_in_transaction: input.verifiedVaa,
      };
    }
    if (q && f.vaa?.vaa_id === q.v.vaaId) f.vaa.quoted_by.push(...q.fields.map((l) => ({ event_type: ev.type, field: l.path })));
    byPackage.set(ev.pkg, f);
  }

  for (const f of byPackage.values()) {
    // The CCTP domain names where the value was burned; a VAA beside it is
    // the protocol's own message, such as an auction result.
    if (f.cctp) {
      f.origin_basis = "cctp-source-domain";
      f.evidence = f.cctp.evidence;
      f.origin_chain = input.qualify ? caip2ForCctpDomain(f.cctp.source_domain) : null;
      f.origin_chain_label = f.cctp.source_domain_label;
    } else if (f.vaa) {
      f.evidence = "chain-derived";
      f.origin_chain = f.vaa.emitter_chain_id;
      f.origin_chain_label = f.vaa.emitter_chain_label;
    }

    for (const ev of parsed.filter((p) => p.pkg === f.package)) {
      const coins = [...new Set(ev.all.flatMap((l) => (typeof l.value === "string" && MOVE_TYPE.test(l.value) ? [l.value] : [])))];
      for (const l of ev.all) {
        const amount = AMOUNT_FIELD.test(l.key) ? whole(l.value) : null;
        if (amount === null || amount === "0") continue;
        f.amounts.push({ event_type: ev.type, field: l.path, amount, coin_type: coins.length === 1 ? coins[0] : null });
        if (f.beneficiary) continue;
        const credited = paidTo.filter((b) => b.amount === amount && (coins.length === 0 || coins.some((c) => coinKey(c) === coinKey(b.coin_type))));
        if (new Set(credited.map((b) => canonicalSuiAddress(b.address))).size === 1) {
          const b = credited[0];
          f.beneficiary = { evidence: "chain-derived", address: b.address, coin_type: b.coin_type, amount: b.amount, matched: { event_type: ev.type, field: l.path } };
        }
      }
    }
    // No credit equals a stated amount: the only address other than the
    // sender that was credited is a lead.
    const others = paidTo.filter((b) => canonicalSuiAddress(b.address) !== sender);
    if (!f.beneficiary && new Set(others.map((b) => canonicalSuiAddress(b.address))).size === 1) {
      const b = others[0];
      f.beneficiary = { evidence: "heuristic", address: b.address, coin_type: b.coin_type, amount: b.amount, matched: null };
    }
  }
  return [...byPackage.values()];
}

/** What an inbound fulfilment is worth, stated once beside the list. */
export const INBOUND_FULFIL_MEANING =
  "This transaction PAID OUT value that arrived from another chain: a package's events quote the cross-chain message it " +
  "consumed (a CCTP source domain and nonce, or the payload or sequence of a VAA passed in), and the transaction credited " +
  "an address. That is an entry, not an exit. To trace the money BACK, look up the CCTP transfer id or the VAA id on the " +
  "origin chain. A beneficiary marked chain-derived was credited exactly an amount and coin the package's events state; " +
  "a heuristic one is the only address credited besides the sender.";
