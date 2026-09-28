/**
 * Shared objects an address operates: ones its recent transactions used
 * mutably whose own fields name it in a control role (members, owner,
 * operator, admin, manager, trader, keeper, controller, signer, authorized).
 * A trading bot that routes every trade through such a vault moves no
 * balance of its own, so its wallet looks small and its flows empty while
 * the capital sits in the vault.
 *
 * The object is not the address's holding (the fields may name others with
 * it), so what it holds stays out of the address's totals and is stated as
 * a lead, with the balances held inside it. Framework objects (kiosks) are
 * left to the tools that read them.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import type { ValuationContext, ValuedAsset } from "./position-value.js";
import { readObjects } from "./valuers/common.js";
import { valueHeld } from "./valuers/held-balances.js";

/** Recent transactions the address sent whose shared inputs are read. */
const RECENT_TRANSACTIONS = 20;
/** Shared objects read per call, the most used first. */
const MAX_CANDIDATES = 20;
/** Addresses named with this one listed per lead. */
const MAX_LISTED_WITH = 10;

const CONTROL_FIELD = /(^|_)(members?|owners?|operators?|admins?|managers?|traders?|keepers?|controllers?|signers?|authori[sz]ed)(_|$)/i;
const FRAMEWORK = /^0x0*[123]::/;
/** Singletons below 0x10000 (the clock, the system state, the deny list). */
const SYSTEM_OBJECT = /^0x0{60}/;

const RECENT_QUERY = `query($a: SuiAddress!, $n: Int!) {
  transactions(filter: { sentAddress: $a }, last: $n) {
    nodes { kind { __typename ... on ProgrammableTransaction { inputs(first: 50) { nodes { __typename ... on SharedInput { address mutable } } } } } }
  }
}`;

interface RecentResponse {
  transactions: {
    nodes: Array<{ kind: { inputs?: { nodes: Array<{ __typename: string; address?: string; mutable?: boolean }> } } | null }>;
  } | null;
}

export interface OperatedObject {
  object_id: string;
  type: string;
  /** The field naming the address. */
  field: string;
  /** Other addresses the same field names. */
  listed_with: string[];
  /** Of the recent transactions read, how many used it mutably. */
  used_in: number;
  holds: ValuedAsset[];
  /** Summed over the priced legs it holds, borrows subtracted; unpriced ones are listed apart. */
  priced_usd: number;
  unpriced_coins: string[];
  method: string | null;
  lead: string;
}

/** Addresses in a field's value: a string, a list, or a set rendered as `{ contents: [...] }`. */
function addressesIn(value: unknown): string[] {
  if (typeof value === "string") return /^0x[0-9a-fA-F]{1,64}$/.test(value) ? [normalizeSuiAddress(value)] : [];
  if (Array.isArray(value)) return value.flatMap(addressesIn);
  if (value && typeof value === "object" && Array.isArray((value as { contents?: unknown }).contents)) return addressesIn((value as { contents: unknown[] }).contents);
  return [];
}

/** The first control-role field, top level or one struct below, whose value names `address`. */
function controlField(json: Record<string, unknown>, address: string, prefix = ""): { field: string; named: string[] } | null {
  for (const [key, value] of Object.entries(json)) {
    if (CONTROL_FIELD.test(key)) {
      const named = addressesIn(value);
      if (named.includes(address)) return { field: `${prefix}${key}`, named };
    }
  }
  if (prefix) return null;
  for (const [key, value] of Object.entries(json)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const hit = controlField(value as Record<string, unknown>, address, `${key}.`);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Shared objects the address's recent transactions used mutably and whose
 * fields name it in a control role, each with the balances held inside it.
 */
export async function operatedSharedObjects(
  address: string,
  ctx: ValuationContext,
): Promise<{ leads: OperatedObject[]; transactions_read: number; objects_read: number }> {
  const owner = normalizeSuiAddress(address);
  const d = await gqlQuery<RecentResponse>(RECENT_QUERY, { a: owner, n: RECENT_TRANSACTIONS });
  const nodes = d.transactions?.nodes ?? [];
  const uses = new Map<string, number>();
  for (const n of nodes) {
    const seen = new Set<string>();
    for (const i of n.kind?.inputs?.nodes ?? []) {
      if (i.__typename !== "SharedInput" || !i.mutable || !i.address || SYSTEM_OBJECT.test(normalizeSuiAddress(i.address))) continue;
      seen.add(normalizeSuiAddress(i.address));
    }
    for (const id of seen) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  const candidates = [...uses].sort((a, b) => b[1] - a[1]).slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) return { leads: [], transactions_read: nodes.length, objects_read: 0 };
  const states = await readObjects(candidates.map(([id]) => id), undefined, ctx.memo);
  const leads: OperatedObject[] = [];
  for (const [id, used] of candidates) {
    const state = states.get(id);
    if (!state?.json || !state.type || FRAMEWORK.test(state.type)) continue;
    const hit = controlField(state.json, owner);
    if (!hit) continue;
    const held = await valueHeld({ object_id: id, type: state.type, json: state.json }, ctx, { ownFields: true });
    const holds = held.positions.flatMap((p) => p.assets);
    const others = hit.named.filter((a) => a !== owner);
    // An object naming only this address and holding nothing says nothing a
    // lead needs; one naming others with it is shared control either way.
    if (holds.length === 0 && others.length === 0) continue;
    // A borrow leg (a lending position the object wraps) is owed, so it nets out.
    const pricedUsd = holds.reduce((s, a) => s + (a.side === "borrow" ? -(a.usd ?? 0) : (a.usd ?? 0)), 0);
    const unpriced = holds.filter((a) => a.usd === null).map((a) => a.coin_type);
    const worth = holds.length
      ? `It holds ${holds.length} coin type(s) worth $${pricedUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}${holds.some((a) => a.side === "borrow") ? " net of what it owes" : ""} at provider prices${unpriced.length ? `, plus ${unpriced.length} with no price` : ""}.`
      : "Nothing inside it that was read held a coin.";
    leads.push({
      object_id: id,
      type: state.type,
      field: hit.field,
      listed_with: others.slice(0, MAX_LISTED_WITH),
      used_in: used,
      holds,
      priced_usd: Math.round(pricedUsd * 100) / 100,
      unpriced_coins: unpriced,
      method: held.positions[0]?.method ?? null,
      lead:
        `Shared object ${id} (${state.type}) names this address in its \`${hit.field}\` field` +
        (others.length ? ` with ${others.length} other address(es), which share that role` : "") +
        `; ${used} of the address's last ${nodes.length} transactions used it mutably. ${worth} ` +
        "The address does not own it, so what it holds is not in the address's totals; what the role lets the address do with it is for the package's functions to say.",
    });
  }
  return { leads, transactions_read: nodes.length, objects_read: candidates.length };
}

/** A lead row for a tool's `leads`: the object, what it holds, and the sentence. */
export function operatedLeadRow(o: OperatedObject): Record<string, unknown> {
  return {
    kind: "operated_shared_object",
    object_id: o.object_id,
    type: o.type,
    field: o.field,
    listed_with: o.listed_with,
    used_in_recent_transactions: o.used_in,
    priced_usd: o.priced_usd,
    holds: o.holds.map((a) => ({ coin_type: a.coin_type, amount: a.amount, side: a.side, usd: a.usd === null ? null : Math.round(a.usd * 100) / 100 })),
    ...(o.unpriced_coins.length ? { unpriced_coins: o.unpriced_coins } : {}),
    ...(o.method ? { method: o.method } : {}),
    lead: o.lead,
  };
}
