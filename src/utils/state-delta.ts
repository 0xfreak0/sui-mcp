/**
 * What a transaction did to the stored state of the shared objects it
 * changed, compared field by field between each object's input and output
 * versions. Pure: `state-read.ts` reads the objects and their field layouts;
 * everything here compares numbers.
 *
 * No rule here reads a protocol, module, struct or field name. They read
 * magnitudes, `Balance<T>` types, the caller's own pure inputs, and which
 * object references which by id.
 */

import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import type { AttackTx, PoolFlow } from "./attack-analysis.js";
import type { PtbAnomaly } from "./ptb-anomalies.js";
import type { KeyedRow } from "./price-claims.js";
import { pricingScale, toHumanAmount, type PricePoint } from "./valuation.js";

/** One object read at the transaction's input and output versions. */
export interface ObjectState {
  objectId: string;
  objectType: string | null;
  /**
   * `shared`: a consensus object the transaction changed. `holding`: a
   * dynamic field owned by `parent` whose value keeps a `Balance<T>` or a
   * `Supply<T>`.
   * `created`: an object the transaction made, read after only. `supply`: a
   * `TreasuryCap<T>` outside any shared object, read for its total supply.
   * `child`: an object another object owns that is not a dynamic field (a
   * pool or vault kept as a dynamic object field), read for its holdings and
   * the values it copies.
   */
  role: "shared" | "holding" | "created" | "supply" | "child";
  parent: string | null;
  /** Field JSON at the input version; null when the transaction created it. */
  before: unknown;
  /** Field JSON at the output version; null when the transaction deleted it. */
  after: unknown;
  /** JSON paths of the object's `Balance<T>` fields, to the canonical coin type `T`. */
  balances: Record<string, string>;
  /** JSON paths of the object's `Supply<T>` totals (inside a `TreasuryCap<T>` or kept directly), to `T`. */
  supplies: Record<string, string>;
}

export interface StateSnapshot {
  objects: ObjectState[];
  /** Candidates past the read cap, left unread. */
  skipped: Array<{ object_id: string; object_type: string | null; role: ObjectState["role"] }>;
  /** Candidates no node returned at one of the versions needed. */
  unavailable: string[];
  /** Object types whose field layout could not be read: their `Balance<T>` fields compare as plain numbers. */
  layout_unread: string[];
  /** Dynamic fields keyed by a coin's type (a price table's rows), at the output version only, for the prices they state. */
  keyed?: KeyedRow[];
}

/**
 * The factor a stored number has to move by, up or down, within one
 * transaction: two orders of magnitude. An ordinary swap, deposit or
 * accrual moves a reserve, a price or an index by a fraction of itself.
 */
export const STATE_JUMP_FACTOR = 100n;

/**
 * Integers at or above 2^127 read as two's-complement negatives (a signed
 * value stored in an unsigned field) or as "unset" sentinels, so a move to or
 * from one is a sign change, not a magnitude.
 */
const SIGNED_OR_SENTINEL = 2n ** 127n;

/** A value in a field that is copied between objects rather than a small setting shared by chance: 2^16 and up. */
const COPIED_VALUE_MIN = 2n ** 16n;

/**
 * The unsigned numbers of an object's JSON by path, not descending into
 * lists (their entries shift as items are added and removed, so the same
 * index is not the same item) or into `{ bits }` wrappers (a signed integer
 * stored as its two's complement).
 */
export function numericFields(json: unknown, path = "", out = new Map<string, bigint>(), depth = 0): Map<string, bigint> {
  if (depth > 6 || Array.isArray(json)) return out;
  if (typeof json === "string" && /^\d+$/.test(json)) out.set(path, BigInt(json));
  else if (typeof json === "number" && Number.isSafeInteger(json) && json >= 0) out.set(path, BigInt(json));
  else if (json && typeof json === "object") {
    for (const [k, v] of Object.entries(json)) {
      if (k === "bits") continue;
      numericFields(v, path ? `${path}.${k}` : k, out, depth + 1);
    }
  }
  return out;
}

/**
 * The UIDs of collections nested in an object (a Bag, Table or VecSet field
 * renders as `{ id: "0x…", … }`), not the object's own id and not ids it
 * merely stores as values.
 */
function nestedUids(json: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 6 || !json || typeof json !== "object") return out;
  if (Array.isArray(json)) {
    for (const v of json) nestedUids(v, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(json)) {
    if (k === "id" && depth > 0 && typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) out.add(normalizeSuiAddress(v));
    else nestedUids(v, out, depth + 1);
  }
  return out;
}

/** Every id a JSON value carries: `0x` strings of full length, at any depth. */
function idsIn(json: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 6) return out;
  if (typeof json === "string" && /^0x[0-9a-fA-F]{64}$/.test(json)) out.add(normalizeSuiAddress(json));
  else if (Array.isArray(json)) for (const v of json) idsIn(v, out, depth + 1);
  else if (json && typeof json === "object") for (const v of Object.values(json)) idsIn(v, out, depth + 1);
  return out;
}

export interface FieldJump {
  object: string;
  object_type: string | null;
  field: string;
  before: string;
  after: string;
  /** `state`: read from the object at both versions. `event`: a before/after pair the object's own event stated. */
  source: "state" | "event";
  /** The new value is a number the caller passed as a pure input. */
  caller_value: boolean;
}

export interface HoldingDrop {
  /** The shared object the balance belongs to, or the dynamic field's owner when no read shared object holds it. */
  holder: string;
  holder_type: string | null;
  coin_type: string;
  before: string;
  after: string;
  /**
   * Addresses whose gains in this transaction cover at least half of what
   * left: by USD across every coin when the coin is priced, in the same coin
   * when it is not.
   */
  paid_to: string[];
  /** Coins the same holder took in, worth at least {@link CONVERSION_SHARE} of everything it paid out by price: a conversion, not a payout. */
  offset_by?: string[];
  /**
   * Share of the holder's priced value, across all its coins, that left in
   * this transaction. Set when every coin the holder moved has a price; a
   * drop under {@link STATE_JUMP_FACTOR} is listed only when this reaches
   * {@link VALUE_SHARE_LOST} and addresses gained at least half of it.
   */
  value_share_lost?: number;
}

/** A number an object received that equals another object's same field, while the object references a third object of that type by id. */
export interface WrongSource {
  object: string;
  object_type: string | null;
  field: string;
  value: string;
  equals_field_of: string;
  references: string;
  references_value: string;
}

export interface StateFindings {
  jumps: FieldJump[];
  drops: HoldingDrop[];
  wrong_source: WrongSource[];
}

const isJump = (b: bigint, a: bigint) =>
  b > 0n && a > 0n && b < SIGNED_OR_SENTINEL && a < SIGNED_OR_SENTINEL && (a >= b * STATE_JUMP_FACTOR || b >= a * STATE_JUMP_FACTOR);

/** Canonical coin type, or the input unchanged when it does not parse. */
function coinKey(t: string): string {
  try {
    return normalizeStructTag(t);
  } catch {
    return t;
  }
}

/**
 * The share of the USD a holder paid out, across all its coins, that it
 * must take back in other coins for its drained holdings to read as a
 * conversion (a pool selling one reserve for another) rather than a loss.
 */
const CONVERSION_SHARE = 0.9;

/**
 * The share of a holder's priced value, across all its coins, that one
 * transaction must move out, with addresses gaining at least half of it,
 * for the drop to count below {@link STATE_JUMP_FACTOR}. An ordinary
 * liquidity removal moves a small share of the holder's value, and a staking
 * buffer redeemed into other objects loses value no address gains, so
 * neither counts.
 */
export const VALUE_SHARE_LOST = 0.5;

/** A shared object's holdings of one coin, before and after the transaction. */
export interface HoldingTotal {
  holder: string;
  coin: string;
  before: bigint;
  after: bigint;
}

/** Net minted per coin: the rise of every read `Supply<T>` total, less any fall. */
export function mintedTotals(snap: StateSnapshot): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const o of snap.objects) {
    if (o.before === null || o.after === null) continue;
    const before = numericFields(o.before);
    const after = numericFields(o.after);
    for (const [path, rawCoin] of Object.entries(o.supplies)) {
      const coin = coinKey(rawCoin);
      out.set(coin, (out.get(coin) ?? 0n) + (after.get(path) ?? 0n) - (before.get(path) ?? 0n));
    }
  }
  return out;
}

/**
 * `Balance<T>` holdings per holder and coin: a read object's own balance
 * fields plus the coin-holding dynamic fields it owns. A dynamic field's
 * owner is a read object's own id, or the UID of a collection nested in it
 * (a Bag or Table field); an id an object only stores as a value (a
 * registry listing its pools) does not make it the holder. An owner no read
 * object accounts for stands for itself.
 */
export function holdingTotals(snap: StateSnapshot): HoldingTotal[] {
  const holderOf = new Map<string, string>();
  const owners = snap.objects.filter((o) => o.role === "shared" || o.role === "child");
  for (const o of owners) holderOf.set(normalizeSuiAddress(o.objectId), normalizeSuiAddress(o.objectId));
  for (const o of owners) {
    for (const id of [...nestedUids(o.before), ...nestedUids(o.after)]) if (!holderOf.has(id)) holderOf.set(id, normalizeSuiAddress(o.objectId));
  }
  const out = new Map<string, HoldingTotal>();
  for (const o of snap.objects) {
    if (o.role === "created") continue;
    const holder = o.role === "holding" && o.parent ? holderOf.get(normalizeSuiAddress(o.parent)) ?? normalizeSuiAddress(o.parent) : normalizeSuiAddress(o.objectId);
    const before = o.before === null ? new Map<string, bigint>() : numericFields(o.before);
    const after = o.after === null ? new Map<string, bigint>() : numericFields(o.after);
    for (const [path, rawCoin] of Object.entries(o.balances)) {
      const coin = coinKey(rawCoin);
      const key = `${holder} ${coin}`;
      const h = out.get(key) ?? { holder, coin, before: 0n, after: 0n };
      h.before += before.get(path) ?? 0n;
      h.after += after.get(path) ?? 0n;
      out.set(key, h);
    }
  }
  return [...out.values()];
}

/**
 * Compare every read object's numbers across the transaction:
 *
 * - **Jumps**: a non-balance number of a shared object (a price, an index, a
 *   liquidity, a loss counter) that moved by {@link STATE_JUMP_FACTOR} or
 *   more between two non-zero values, from the object's two versions or
 *   from a before/after pair its own event stated. A move from or to zero is
 *   not a jump here: counters, accumulators and flags reset to zero in
 *   ordinary use.
 * - **Holding drops**: a read object's `Balance<T>` holdings of one coin,
 *   summed over its balance fields and the coin-holding dynamic fields it
 *   owns (created and deleted ones included, so a balance moved between two
 *   fields of the same object nets out), falling by the factor or to zero;
 *   or falling by less as part of the holder losing
 *   {@link VALUE_SHARE_LOST} or more of its priced value across all its
 *   coins while addresses gained at least half of that loss.
 *   Jumps read only consensus objects: an owned child's numbers are often a
 *   user's own position, which a full withdrawal moves by any factor.
 * - **Wrong source**: an object whose new number equals the same field of
 *   one object while it references, by id, a different object of that same
 *   type whose field holds another value. Such a value was taken from an
 *   object other than the one this object is bound to.
 */
export function compareStates(
  tx: Pick<AttackTx, "balanceChanges" | "inputs">,
  snap: StateSnapshot,
  flows: PoolFlow[] = [],
  prices?: Map<string, PricePoint>,
): StateFindings {
  const callerValues = new Set((tx.inputs ?? []).flatMap((i) => i.values));
  const byId = new Map(snap.objects.map((o) => [normalizeSuiAddress(o.objectId), o]));
  const shared = snap.objects.filter((o) => o.role === "shared");

  const jumps: FieldJump[] = [];
  for (const o of shared) {
    if (o.before === null || o.after === null) continue;
    const before = numericFields(o.before);
    const after = numericFields(o.after);
    for (const [path, b] of before) {
      const a = after.get(path);
      if (a === undefined || o.balances[path] || !isJump(b, a)) continue;
      jumps.push({
        object: o.objectId,
        object_type: o.objectType,
        field: path,
        before: b.toString(),
        after: a.toString(),
        source: "state",
        caller_value: callerValues.has(a.toString()),
      });
    }
  }
  for (const f of flows) {
    for (const c of f.recorded_changes) {
      const b = BigInt(c.before);
      const a = BigInt(c.after);
      if (!isJump(b, a)) continue;
      jumps.push({ object: f.pool, object_type: f.pool_type, field: c.field, before: c.before, after: c.after, source: "event", caller_value: callerValues.has(c.after) });
    }
  }

  const holdings = holdingTotals(snap);
  const usd = (coin: string, raw: bigint): number | null => {
    const point = prices?.get(coin);
    return point ? toHumanAmount(raw, pricingScale(coin, point).decimals) * point.price : null;
  };
  // Per coin, each address's net change; per address, its net USD across
  // the priced coins.
  const gained = new Map<string, Map<string, bigint>>();
  const netUsd = new Map<string, number>();
  for (const c of tx.balanceChanges) {
    if (!/^-?\d+$/.test(c.amount)) continue;
    const coin = coinKey(c.coinType);
    const per = gained.get(coin) ?? new Map<string, bigint>();
    const addr = normalizeSuiAddress(c.address);
    per.set(addr, (per.get(addr) ?? 0n) + BigInt(c.amount));
    gained.set(coin, per);
  }
  for (const [coin, per] of gained) {
    for (const [addr, raw] of per) {
      const v = usd(coin, raw < 0n ? -raw : raw);
      if (v !== null) netUsd.set(addr, (netUsd.get(addr) ?? 0) + (raw < 0n ? -v : v));
    }
  }
  const usdWinners = [...netUsd].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const usdGained = usdWinners.reduce((s, [, v]) => s + v, 0);
  // A holder that took back in other coins nearly all the USD it paid out,
  // counted once across all its coins, converted rather than lost.
  const converted = new Map<string, string[]>();
  for (const holder of new Set(holdings.map((h) => h.holder))) {
    const mine = holdings.filter((h) => h.holder === holder && h.after !== h.before);
    const outs = mine.filter((h) => h.after < h.before).map((h) => usd(h.coin, h.before - h.after));
    const ins = mine.filter((h) => h.after > h.before);
    const backs = ins.map((h) => usd(h.coin, h.after - h.before));
    if (!ins.length || [...outs, ...backs].some((x) => x === null)) continue;
    const out = outs.reduce((s: number, x) => s + x!, 0);
    const back = backs.reduce((s: number, x) => s + x!, 0);
    if (out > 0 && back >= out * CONVERSION_SHARE) converted.set(holder, ins.map((h) => h.coin));
  }
  // Per holder, the share of its priced value that left, across all its
  // coins; unknown when a coin it moved has no price.
  const valueShare = new Map<string, { share: number; lost: number } | null>();
  for (const holder of new Set(holdings.map((h) => h.holder))) {
    let before = 0;
    let after = 0;
    let known = true;
    for (const h of holdings.filter((x) => x.holder === holder)) {
      const b = usd(h.coin, h.before);
      const a = usd(h.coin, h.after);
      if (b === null || a === null) {
        if (h.before !== h.after) known = false;
        continue;
      }
      before += b;
      after += a;
    }
    valueShare.set(holder, known && before > 0 ? { share: (before - after) / before, lost: before - after } : null);
  }
  const drops: HoldingDrop[] = [];
  for (const h of holdings) {
    if (h.before <= 0n || h.after >= h.before) continue;
    const offset = converted.get(h.holder);
    const value = valueShare.get(h.holder) ?? null;
    const jumped = h.after * STATE_JUMP_FACTOR <= h.before;
    // Under the factor, a fall counts only as part of a holder losing most
    // of its value to addresses in this transaction.
    if (!jumped && (offset || !value || value.share < VALUE_SHARE_LOST || usdGained * 2 < value.lost)) continue;
    const lost = usd(h.coin, h.before - h.after);
    let paid: string[] = [];
    if (!offset && lost !== null) {
      // Priced: what addresses gained, net and in any coin, pays for it; a
      // drain swapped or repaid inside the PTB still reaches someone.
      if (usdGained * 2 >= (jumped ? lost : value!.lost)) paid = usdWinners.map(([a]) => a);
    } else if (!offset) {
      const winners = [...(gained.get(h.coin) ?? new Map<string, bigint>())].filter(([, v]) => v > 0n);
      if (winners.reduce((s, [, v]) => s + v, 0n) * 2n >= h.before - h.after) paid = winners.map(([a]) => a);
    }
    drops.push({
      holder: h.holder,
      holder_type: byId.get(h.holder)?.objectType ?? null,
      coin_type: h.coin,
      before: h.before.toString(),
      after: h.after.toString(),
      paid_to: paid,
      ...(offset ? { offset_by: offset } : {}),
      ...(value && value.share > 0 ? { value_share_lost: Number(value.share.toFixed(4)) } : {}),
    });
  }

  const wrong_source: WrongSource[] = [];
  const sharedFields = shared
    .filter((o) => o.after !== null)
    .map((o) => ({ o, id: normalizeSuiAddress(o.objectId), fields: numericFields(o.after) }));
  for (const o of snap.objects) {
    if (o.after === null || o.role === "holding") continue;
    const id = normalizeSuiAddress(o.objectId);
    const after = numericFields(o.after);
    const before = o.before === null ? null : numericFields(o.before);
    const refs = [...idsIn(o.after)].filter((r) => r !== id);
    const referenced = sharedFields.filter((s) => refs.includes(s.id));
    for (const [path, v] of after) {
      if (v < COPIED_VALUE_MIN || o.balances[path] || (before && before.get(path) === v)) continue;
      // The objects this one is bound to, by id, that carry the same field;
      // none of them may hold the value, or it came from where it should.
      const bound = referenced.filter((s) => s.fields.has(path));
      if (!bound.length || bound.some((s) => s.fields.get(path) === v)) continue;
      const source = sharedFields.find((s) => s.id !== id && s.fields.get(path) === v && bound.some((b) => b.o.objectType === s.o.objectType));
      if (!source) continue;
      const ref = bound.find((b) => b.o.objectType === source.o.objectType)!;
      wrong_source.push({
        object: o.objectId,
        object_type: o.objectType,
        field: path,
        value: v.toString(),
        equals_field_of: source.o.objectId,
        references: ref.o.objectId,
        references_value: ref.fields.get(path)!.toString(),
      });
    }
  }
  return { jumps, drops, wrong_source };
}

const short = (t: string | null) => (t ? t.split("<")[0].split("::").slice(1).join("::") : "unknown type");

/**
 * The `shared-state-jump` anomaly. High for a jump to a number the caller
 * passed, for a holding drop at least half of whose value addresses gained
 * in the same transaction, and for a wrong source; medium for any other
 * jump; info for a holding drop addresses gained less than half of (it
 * moved into other objects, such as a staking pool or a vault's other
 * positions) or whose holder took back nearly all it paid out in other
 * coins.
 */
export function stateAnomaly(findings: StateFindings, snap: StateSnapshot): PtbAnomaly | null {
  const lines: Array<{ rank: number; text: string }> = [];
  for (const w of findings.wrong_source) {
    lines.push({
      rank: 0,
      text: `${w.object} (${short(w.object_type)}) ${w.field} became ${w.value}, the value of the same field of ${w.equals_field_of}, while it references ${w.references}, an object of the same type whose ${w.field} is ${w.references_value}`,
    });
  }
  for (const j of findings.jumps) {
    lines.push({
      rank: j.caller_value ? 0 : 1,
      text:
        `${j.object} (${short(j.object_type)}) ${j.field} ${j.before} -> ${j.after}` +
        (j.source === "event" ? " (stated by its own event)" : "") +
        (j.caller_value ? ", a number the caller passed" : ""),
    });
  }
  for (const d of findings.drops) {
    const share = d.value_share_lost !== undefined ? ` (the holder lost ${(d.value_share_lost * 100).toFixed(1)}% of its priced value)` : "";
    lines.push({
      rank: d.paid_to.length ? 0 : 2,
      text:
        `${d.holder} (${short(d.holder_type)}) Balance<${d.coin_type}> ${d.before} -> ${d.after}${share}` +
        (d.paid_to.length
          ? `; ${d.paid_to.slice(0, 3).join(", ")} gained at least half its value in the same transaction`
          : d.offset_by
            ? `; the same holder took in ${d.offset_by.join(", ")} worth at least ${CONVERSION_SHARE * 100}% of all it paid out, a conversion`
            : "; addresses gained less than half its value, so it moved into other objects"),
    });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => a.rank - b.rank);
  const top = lines[0].rank;
  const n = findings.jumps.length + findings.drops.length + findings.wrong_source.length;
  const unread = snap.skipped.length + snap.unavailable.length;
  return {
    severity: top === 0 ? "high" : top === 1 ? "medium" : "info",
    code: "shared-state-jump",
    title: `Shared-object state moved by ${STATE_JUMP_FACTOR}x or more, a holder lost most of its value to addresses, or a value was set from another object: ${n} change${n === 1 ? "" : "s"}`,
    detail:
      `Read at the transaction's input and output versions, a shared object's stored number (a price, an index, a liquidity, a counter) moved by ${STATE_JUMP_FACTOR}x or more between non-zero values, or its Balance<T> holdings of a coin fell by ${STATE_JUMP_FACTOR}x or to zero, or a holder lost ${VALUE_SHARE_LOST * 100}% or more of its priced value across all its coins while addresses gained at least half of that, or an object took a number from an object other than the one it references. Ordinary swaps, deposits and accruals move these by fractions. High: the new number is one the caller passed, addresses gained at least half the drained value (in any coin) in this transaction, or a value came from the wrong object. A drained holding reads info when its holder took back nearly all of it in other coins, or when addresses gained less than half of it. Read the functions that took these objects with get_move_function and disassemble_module.` +
      (unread ? ` ${unread} candidate object(s) were not read; see state_deltas.` : ""),
    evidence: lines.length > 6 ? [...lines.slice(0, 5).map((l) => l.text), `${lines.length - 5} more in state_deltas`] : lines.map((l) => l.text),
  };
}
