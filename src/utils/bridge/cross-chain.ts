/**
 * A cross-chain message from a bridge this server has no marker for, read by
 * its shape.
 *
 * The curated markers in `detect.ts` name a bridge exactly, and a bridge that
 * is not on the list passes them unseen, so the value it carried off Sui reads
 * as consumed by a contract. Whatever the bridge, its outbound message has to
 * say where the value goes: a chain on the far side and a recipient there.
 * This reads every event no curated decoder covers for a field named for a
 * chain (`chain`, `domain`, `eid`) holding a number, beside a byte string of a
 * foreign address's length (20 bytes, or 32 padded), and reports the pair.
 *
 * A lead, never an exit: a shape match on an unrelated app would name a
 * stranger as the beneficiary, which `beneficiary.ts` refuses to do. So no
 * bridge or beneficiary is named, the bytes are reported raw, and the tier is
 * `heuristic`.
 */

import { lookupProtocol } from "../../protocols/registry.js";
import { BRIDGE_PROTOCOLS } from "./detect.js";
import { matchesEvent } from "./event-type.js";
import { CLAIM_EVENT_SUFFIX } from "./sui-native.js";
import type { SuiEventNode } from "./wormhole.js";

export interface CrossChainLead {
  evidence: "heuristic";
  event_type: string;
  /** Path of the field read as the far-side chain, and its value as the event holds it. */
  chain_field: string;
  chain_value: string;
  /** Path of the field read as the far-side recipient, and its bytes as hex. */
  recipient_field: string;
  recipient_raw: string;
  recipient_bytes: 20 | 32;
  /** From the two fields' names: toward another chain, from one, or not stated. */
  direction: "outbound" | "inbound" | "unknown";
}

/** A field named for a chain or a bridge's numbering of chains. */
const CHAIN_FIELD = /chain|domain|(^|_)eid$/i;
/** Names that say a field is where the value goes. */
const OUTBOUND_HINT = /(^|[._ ])(to|dst|dest|destination|target|recipient|receiver|beneficiary)($|[._ ])/i;
/** Names that say a field is where the value came from. */
const INBOUND_HINT = /(^|[._ ])(from|src|source|origin|emitter|sender)($|[._ ])/i;
/** Names that say a field holds a party: who is paid, or who paid. */
const PARTY_FIELD = /(^|[._ ])(to|dst|dest|destination|target|recipient|receiver|beneficiary|from|src|sender|address|account|wallet|user)($|[._ ])/i;
/** Deepest nesting read inside one event. Bridges wrap addresses one or two levels down. */
const MAX_DEPTH = 4;

/** One scalar field of an event, with its dotted path from the event's top level. */
export interface Leaf {
  path: string;
  key: string;
  value: unknown;
}

/** Every scalar field of `value` down to {@link MAX_DEPTH} levels, in field order. */
export function leaves(value: unknown, path: string, key: string, depth: number, out: Leaf[]): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && depth < MAX_DEPTH) {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, k, depth + 1, out);
    return;
  }
  out.push({ path, key, value });
}

/** A chain id: a whole number a u16 to u64 field could hold, as JSON renders it. */
function chainValue(v: unknown): string | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^[1-9][0-9]{0,19}$/.test(v)) return v;
  return null;
}

/**
 * Bytes of a foreign address, 20 or 32 long: a `vector<u8>` as GraphQL renders
 * it (base64) or as an array of numbers, or 20 bytes as hex. A 32-byte hex
 * string is a Sui address or object id and is not read as foreign. 32 random
 * bytes are as often a hash, a GUID or a key as an address, so they count
 * only left-padded like a 20-byte address or under a field named for a party
 * (`path`).
 */
function addressBytes(v: unknown, path: string): Buffer | null {
  let bytes: Buffer | null = null;
  if (Array.isArray(v) && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) bytes = Buffer.from(v as number[]);
  else if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) bytes = Buffer.from(v.slice(2), "hex");
  else if (typeof v === "string" && /^[A-Za-z0-9+/]{27}=$|^[A-Za-z0-9+/]{43}=$/.test(v)) bytes = Buffer.from(v, "base64");
  if (!bytes || (bytes.length !== 20 && bytes.length !== 32)) return null;
  // All zeros is an unset field, not a recipient.
  if (bytes.every((b) => b === 0)) return null;
  if (bytes.length === 32 && !bytes.subarray(0, 12).every((b) => b === 0) && !PARTY_FIELD.test(path)) return null;
  return bytes;
}

/** Hex without the prefix or left zero padding, for comparing a recipient across encodings. */
const bare = (hex: string) => hex.toLowerCase().replace(/^0x/, "").replace(/^0+/, "");

/** Decoded by a curated bridge reader already, or defined by a package the registry types as a bridge. */
function covered(eventType: string): boolean {
  if (eventType.split("<")[0].endsWith(CLAIM_EVENT_SUFFIX)) return true;
  if (BRIDGE_PROTOCOLS.some((p) => p.eventMarkers.some((m) => matchesEvent(m, eventType)))) return true;
  return lookupProtocol(eventType.split("::")[0])?.type === "bridge";
}

/**
 * Events that carry a far-side chain and a recipient-sized byte string, from
 * packages no curated reader covers. One lead per event: the recipient field
 * named for a destination when there is one, else the first. A lead whose
 * recipient is one a curated reader already decoded from the same
 * transaction (`decoded`, raw or as an address) restates that transfer, an
 * app's own event beside the bridge's, and is left out.
 */
export function crossChainLeads(events: SuiEventNode[], decoded: string[] = []): CrossChainLead[] {
  const known = new Set(decoded.map(bare));
  const out: CrossChainLead[] = [];
  for (const e of events) {
    const type = e?.contents?.type?.repr;
    const json = e?.contents?.json;
    if (typeof type !== "string" || json === null || typeof json !== "object" || covered(type)) continue;
    const all: Leaf[] = [];
    leaves(json, "", "", 0, all);
    // The destination chain when the event names one, since a message often states its source chain first.
    const chains = all.filter((l) => CHAIN_FIELD.test(l.path) && chainValue(l.value) !== null);
    const chain = chains.find((l) => OUTBOUND_HINT.test(l.path)) ?? chains[0];
    if (!chain) continue;
    const recipients = all
      .filter((l) => l !== chain && !CHAIN_FIELD.test(l.key))
      .map((l) => ({ l, bytes: addressBytes(l.value, l.path) }))
      .filter((r): r is { l: Leaf; bytes: Buffer } => r.bytes !== null);
    const recipient = recipients.find((r) => OUTBOUND_HINT.test(r.l.path)) ?? recipients[0];
    if (!recipient || known.has(bare(recipient.bytes.toString("hex")))) continue;
    const names = `${chain.path} ${recipient.l.path}`;
    out.push({
      evidence: "heuristic",
      event_type: type,
      chain_field: chain.path,
      chain_value: chainValue(chain.value)!,
      recipient_field: recipient.l.path,
      recipient_raw: `0x${recipient.bytes.toString("hex")}`,
      recipient_bytes: recipient.bytes.length as 20 | 32,
      direction: OUTBOUND_HINT.test(names) ? "outbound" : INBOUND_HINT.test(names) ? "inbound" : "unknown",
    });
  }
  return out;
}

/** What a lead is worth, stated once beside any list of them. */
export const CROSS_CHAIN_LEAD_MEANING =
  "Events from a package no bridge reader here covers that carry a field named for a chain holding a number and a " +
  "20- or 32-byte string the length of an address on another chain. That is the shape of a cross-chain message, so the " +
  "value may have left Sui through a bridge this server has no marker for. A lead to check against the package, never " +
  "an exit on its own: an app can carry the same two fields for other reasons, and the recipient bytes are shown raw.";
