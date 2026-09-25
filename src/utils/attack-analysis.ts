/**
 * What an exploit transaction did, read from the transaction alone.
 *
 * Pure: the caller reads the transaction (`attack-read.ts`) and prices the
 * coins; everything here is arithmetic over that data, so every number an
 * incident report rests on is covered by a test.
 *
 * Four questions, four tiers of evidence:
 *
 * - **Who gained what.** Balance changes, summed per address and coin. Chain
 *   data, nothing inferred.
 * - **What each pool lost.** Decoded from the pool's own events (swap, add and
 *   remove liquidity, fee collection) by field name. The amounts are the
 *   chain's; the reading of a field called `amount_in` as the amount the pool
 *   received is the interpretation, and an event this does not recognise is
 *   counted rather than guessed at.
 * - **How the price moved.** Only where the event carries the price before and
 *   after (CLMM sqrt prices or ticks). A swap event without them gets no impact
 *   figure rather than one derived from amounts.
 * - **Flash legs, oracle touches, anomalies.** Matched on function and event
 *   names. These are heuristic and are labelled so: a function named
 *   `flash_swap` is a flash swap by convention, not by proof.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { displayCoin, pricingScale, toHumanAmount, type CoinScale, type PricePoint } from "./valuation.js";

/* ------------------------------------------------------------------ *
 * Input shape: what `attack-read.ts` produces from a gRPC transaction
 * ------------------------------------------------------------------ */

export interface AttackCall {
  /** Command index in the PTB. */
  command: number;
  package: string;
  module: string;
  function: string;
  typeArguments: string[];
  /** Object ids passed as arguments (shared, owned or receiving inputs). */
  objectArgs: string[];
}

export interface AttackEvent {
  /** Emission index. */
  index: number;
  type: string;
  json: unknown;
}

export interface AttackBalanceChange {
  address: string;
  coinType: string;
  amount: string;
}

export interface AttackObject {
  objectId: string;
  objectType: string | null;
}

export interface AttackTx {
  digest: string;
  sender: string | null;
  success: boolean;
  timestampMs: number | null;
  checkpoint: string | null;
  /** One entry per command: `MoveCall`, `Publish`, `Upgrade`, `SplitCoins`, … */
  commandKinds: string[];
  calls: AttackCall[];
  events: AttackEvent[];
  balanceChanges: AttackBalanceChange[];
  objects: AttackObject[];
}

/* ------------------------------------------------------------------ *
 * Small parsers
 * ------------------------------------------------------------------ */

/** Padded lowercase address, or null for anything that is not one. */
export function canonicalId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^(0x)?[0-9a-fA-F]{1,64}$/.test(s)) return null;
  return normalizeSuiAddress(s);
}

/** The type arguments of a Move type, split at top-level commas. */
export function typeArgsOf(type: string): string[] {
  const open = type.indexOf("<");
  if (open < 0 || !type.endsWith(">")) return [];
  const inner = type.slice(open + 1, -1);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = inner.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** `pkg::module::Name<…>` → `Name`. */
export function structName(type: string): string {
  const base = type.split("<")[0];
  const parts = base.split("::");
  return parts[parts.length - 1] ?? base;
}

/** `pkg::module::Name<…>` → `module::Name`, for display. */
export function shortEventType(type: string): string {
  const parts = type.split("<")[0].split("::");
  return parts.length >= 3 ? `${parts[1]}::${parts[2]}` : type;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** An unsigned integer field, as a bigint. Strings and safe numbers only. */
function uintField(o: Record<string, unknown>, ...names: string[]): bigint | null {
  for (const n of names) {
    const v = o[n];
    if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  }
  return null;
}

function boolField(o: Record<string, unknown>, ...names: string[]): boolean | null {
  for (const n of names) if (typeof o[n] === "boolean") return o[n] as boolean;
  return null;
}

/** A Move `I32` as JSON (`{ bits: u32 }`), read as a signed tick index. */
function i32Field(o: Record<string, unknown>, ...names: string[]): number | null {
  for (const n of names) {
    const rec = asRecord(o[n]);
    const bits = rec ? rec.bits : o[n];
    const num = typeof bits === "string" && /^\d+$/.test(bits) ? Number(bits) : typeof bits === "number" ? bits : null;
    if (num === null || !Number.isInteger(num) || num < 0 || num > 0xffffffff) continue;
    return num >= 0x80000000 ? num - 0x100000000 : num;
  }
  return null;
}

/** The pool an event is about, when it names one. */
export function poolOfEvent(json: unknown): string | null {
  const o = asRecord(json);
  if (!o) return null;
  for (const k of ["pool", "pool_id", "pool_address", "poolId"]) {
    const direct = canonicalId(o[k]);
    if (direct) return direct;
    // `ID` sometimes renders as `{ id: "0x…" }` or `{ bytes: "0x…" }`.
    const nested = asRecord(o[k]);
    const inner = nested ? canonicalId(nested.id ?? nested.bytes) : null;
    if (inner) return inner;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Who gained what
 * ------------------------------------------------------------------ */

/** Net raw amount per address and coin. Canonical addresses. */
export function netByAddress(changes: AttackBalanceChange[]): Map<string, Map<string, bigint>> {
  const out = new Map<string, Map<string, bigint>>();
  for (const c of changes) {
    const addr = canonicalId(c.address);
    if (!addr || !/^-?\d+$/.test(c.amount)) continue;
    const coins = out.get(addr) ?? new Map<string, bigint>();
    coins.set(c.coinType, (coins.get(c.coinType) ?? 0n) + BigInt(c.amount));
    out.set(addr, coins);
  }
  return out;
}

/** Add `b` into `a`, coin by coin. */
export function addDeltas(a: Map<string, bigint>, b: Map<string, bigint>): void {
  for (const [coin, v] of b) a.set(coin, (a.get(coin) ?? 0n) + v);
}

/* ------------------------------------------------------------------ *
 * Swaps: amounts, direction and price impact
 * ------------------------------------------------------------------ */

const Q64 = 2 ** 64;

export interface SwapObservation {
  event: number;
  event_type: string;
  pool: string | null;
  a_to_b: boolean | null;
  amount_in: string | null;
  amount_out: string | null;
  /** `raw coin B per raw coin A`, from the event's sqrt price or tick. */
  price_before: number | null;
  price_after: number | null;
  /** Change in the pool price (B per A) across this swap, in percent. */
  price_change_pct: number | null;
  price_basis: "sqrt_price" | "tick" | null;
}

/** Is this event a swap, by its struct name. Flash events are legs, not swaps. */
export function isSwapEvent(type: string): boolean {
  const name = structName(type);
  return /swap/i.test(name) && !/flash|repay/i.test(name);
}

/**
 * Read a swap event. Field names cover the CLMM DEXes on Sui that emit the
 * price on both sides: Cetus (`before_sqrt_price`/`after_sqrt_price`,
 * `atob`), Bluefin (`a2b`), FlowX and Momentum (`sqrt_price_before`/
 * `sqrt_price_after`, `x_for_y`) and Turbos (`tick_pre_index`/
 * `tick_current_index`, `a_to_b`). A swap event without them is still listed,
 * with the impact null.
 */
export function readSwap(ev: AttackEvent): SwapObservation | null {
  if (!isSwapEvent(ev.type)) return null;
  const o = asRecord(ev.json);
  if (!o) return null;
  const aToB = boolField(o, "atob", "a2b", "a_to_b", "x_for_y");
  let amountIn = uintField(o, "amount_in");
  let amountOut = uintField(o, "amount_out");
  if (amountIn === null && amountOut === null && aToB !== null) {
    const a = uintField(o, "amount_a", "amount_x");
    const b = uintField(o, "amount_b", "amount_y");
    if (a !== null && b !== null) {
      amountIn = aToB ? a : b;
      amountOut = aToB ? b : a;
    }
  }

  let before: number | null = null;
  let after: number | null = null;
  let basis: SwapObservation["price_basis"] = null;
  const sb = uintField(o, "before_sqrt_price", "sqrt_price_before");
  const sa = uintField(o, "after_sqrt_price", "sqrt_price_after");
  if (sb !== null && sa !== null && sb > 0n) {
    before = (Number(sb) / Q64) ** 2;
    after = (Number(sa) / Q64) ** 2;
    basis = "sqrt_price";
  } else {
    const tb = i32Field(o, "tick_pre_index", "tick_before");
    const ta = i32Field(o, "tick_current_index", "tick_after");
    if (tb !== null && ta !== null) {
      before = 1.0001 ** tb;
      after = 1.0001 ** ta;
      basis = "tick";
    }
  }
  const change = before !== null && after !== null && before > 0 ? (after / before - 1) * 100 : null;

  return {
    event: ev.index,
    event_type: shortEventType(ev.type),
    pool: poolOfEvent(ev.json),
    a_to_b: aToB,
    amount_in: amountIn?.toString() ?? null,
    amount_out: amountOut?.toString() ?? null,
    price_before: before,
    price_after: after,
    price_change_pct: change === null ? null : Number(change.toFixed(6)),
    price_basis: basis,
  };
}

/* ------------------------------------------------------------------ *
 * What each pool gained or lost, from its own events
 * ------------------------------------------------------------------ */

export interface PoolFlow {
  pool: string;
  /** The pool object's type, from the transaction's changed objects. */
  pool_type: string | null;
  /** Net change in the POOL's reserves per coin type. Negative is drained. */
  deltas: Map<string, bigint>;
  /** Events that contributed to `deltas`. */
  events: number[];
  /** Events naming this pool whose shape is not one read here. */
  undecoded_events: number[];
}

type LiquidityKind = "add" | "remove" | "collect";

function liquidityKind(type: string): LiquidityKind | null {
  const name = structName(type);
  if (/^(AddLiquidity|LiquidityProvided|Mint)(Event)?$/i.test(name)) return "add";
  if (/^(RemoveLiquidity|LiquidityRemoved|Burn)(Event)?$/i.test(name)) return "remove";
  if (/^(CollectFee|CollectProtocolFee|FeeCollected)(Event)?$/i.test(name)) return "collect";
  return null;
}

/**
 * Per-pool reserve changes from the pool's events. Coin A and B are the pool
 * type's first two type arguments, which is how every CLMM on Sui orders them;
 * a pool whose type is not in the changed objects is keyed `A`/`B` so the
 * amounts are kept without a coin name being invented.
 */
export function poolFlows(tx: Pick<AttackTx, "events" | "objects">): PoolFlow[] {
  const typeById = new Map<string, string>();
  for (const o of tx.objects) {
    const id = canonicalId(o.objectId);
    if (id && o.objectType) typeById.set(id, o.objectType);
  }
  const flows = new Map<string, PoolFlow>();
  const flowFor = (pool: string): PoolFlow => {
    let f = flows.get(pool);
    if (!f) {
      f = { pool, pool_type: typeById.get(pool) ?? null, deltas: new Map(), events: [], undecoded_events: [] };
      flows.set(pool, f);
    }
    return f;
  };
  const add = (f: PoolFlow, coin: string, v: bigint) => f.deltas.set(coin, (f.deltas.get(coin) ?? 0n) + v);

  for (const ev of tx.events) {
    const pool = poolOfEvent(ev.json);
    if (!pool) continue;
    const f = flowFor(pool);
    const poolArgs = f.pool_type ? typeArgsOf(f.pool_type) : [];
    const coinA = poolArgs[0] ?? "A";
    const coinB = poolArgs[1] ?? "B";
    const o = asRecord(ev.json)!;

    const swap = readSwap(ev);
    if (swap && swap.a_to_b !== null && swap.amount_in !== null && swap.amount_out !== null) {
      const [cin, cout] = swap.a_to_b ? [coinA, coinB] : [coinB, coinA];
      add(f, cin, BigInt(swap.amount_in));
      add(f, cout, -BigInt(swap.amount_out));
      f.events.push(ev.index);
      continue;
    }
    const kind = liquidityKind(ev.type);
    const a = uintField(o, "amount_a", "coin_a_amount", "amount_x");
    const b = uintField(o, "amount_b", "coin_b_amount", "amount_y");
    if (kind && a !== null && b !== null) {
      const sign = kind === "add" ? 1n : -1n;
      add(f, coinA, sign * a);
      add(f, coinB, sign * b);
      f.events.push(ev.index);
      continue;
    }
    // An event with no amount field (opening a position, say) moves nothing.
    if (Object.keys(o).some((k) => /amount/i.test(k))) f.undecoded_events.push(ev.index);
  }
  // Pools with only undecoded events are kept: "this pool was touched and we
  // could not read how" is a finding a reader needs.
  return [...flows.values()];
}

/**
 * The pools a transaction touched. Pools named by events come first; a
 * changed object whose struct is named `Pool` covers a DEX whose events carry
 * no pool id.
 */
export function poolsTouched(tx: Pick<AttackTx, "events" | "objects">): string[] {
  const out = new Set<string>();
  for (const ev of tx.events) {
    const p = poolOfEvent(ev.json);
    if (p) out.add(p);
  }
  if (out.size === 0) {
    for (const o of tx.objects) {
      if (o.objectType && structName(o.objectType) === "Pool") {
        const id = canonicalId(o.objectId);
        if (id) out.add(id);
      }
    }
  }
  return [...out];
}

/* ------------------------------------------------------------------ *
 * Flash legs
 * ------------------------------------------------------------------ */

export interface FlashLeg {
  kind: "flash_swap" | "flash_loan" | "borrow_repay";
  /** `calls` when paired from Move calls, `events` when only events show it. */
  basis: "calls" | "events";
  borrow: { command?: number; event?: number; target: string };
  repay: { command?: number; event?: number; target: string } | null;
  coin_types: string[];
  /** Object ids both legs were passed: the pool or lending market. */
  objects: string[];
  /** Flash events and swap events on the same pool, by emission index. */
  related_events: number[];
}

const FLASH_BORROW = /^(flash_?(swap|loan|borrow|mint)|borrow_?flash|flashloan|flash)(_|$)/i;
const REPAY = /repay/i;
const GENERIC_BORROW = /^borrow(_|$)/i;

function legKind(fn: string): FlashLeg["kind"] {
  if (/swap/i.test(fn)) return "flash_swap";
  if (/flash/i.test(fn)) return "flash_loan";
  return "borrow_repay";
}

const target = (c: AttackCall) => `${c.package}::${c.module}::${c.function}`;

/**
 * Framework singletons below 0x10000: the Clock (`0x6`), Random (`0x8`), the
 * deny list (`0x403`) and the like. Nearly every DeFi call takes the Clock, so
 * counting it as the object two calls share would pair any borrow with any
 * repay.
 */
function isSystemObject(id: string): boolean {
  return /^0x0{60}/.test(canonicalId(id) ?? "");
}

/**
 * Pair borrows with their repayments.
 *
 * A borrow is a call named like a flash borrow, or any `borrow_*` that is
 * repaid in the same PTB (Nemo's `py::borrow_pt_amount` / `repay_pt_amount`).
 * The repayment is the first later `repay` call in the same package and
 * module, preferring one passed the same object, which is the pool or market
 * the loan came from. An unpaired flash borrow is reported with `repay: null`
 * because it is either repaid inside another call or not at all.
 *
 * Where the calls do not show it (a wrapper package made them), flash events
 * are paired the same way by pool id.
 */
export function pairFlashLegs(calls: AttackCall[], events: AttackEvent[]): FlashLeg[] {
  const legs: FlashLeg[] = [];
  const used = new Set<number>();
  const repays = calls.filter((c) => REPAY.test(c.function));

  for (const c of calls) {
    if (REPAY.test(c.function)) continue;
    const own = c.objectArgs.filter((o) => !isSystemObject(o));
    const flashy = FLASH_BORROW.test(c.function);
    if (!flashy && !GENERIC_BORROW.test(c.function)) continue;
    const later = repays.filter((r) => r.command > c.command && !used.has(r.command));
    const sameModule = later.filter((r) => r.package === c.package && r.module === c.module);
    const samePackage = later.filter((r) => r.package === c.package);
    const shares = (r: AttackCall) => r.objectArgs.some((o) => own.includes(o));
    const repay =
      sameModule.find(shares) ?? sameModule[0] ?? (flashy ? samePackage.find(shares) ?? samePackage[0] : undefined);
    // A plain borrow with no repayment is ordinary lending, not a flash leg.
    if (!repay && !flashy) continue;
    if (repay) used.add(repay.command);
    legs.push({
      kind: legKind(c.function),
      basis: "calls",
      borrow: { command: c.command, target: target(c) },
      repay: repay ? { command: repay.command, target: target(repay) } : null,
      coin_types: c.typeArguments,
      objects: repay ? own.filter((o) => repay.objectArgs.includes(o)) : own,
      related_events: [],
    });
  }

  // Attach flash events, and the swaps on the same pool.
  const flashEvents = events.filter((e) => /flash/i.test(structName(e.type)));
  const attached = new Set<number>();
  for (const leg of legs) {
    for (const e of events) {
      const pool = poolOfEvent(e.json);
      if (!pool || !leg.objects.includes(pool)) continue;
      if (/flash/i.test(structName(e.type)) || (leg.kind === "flash_swap" && isSwapEvent(e.type))) {
        leg.related_events.push(e.index);
        attached.add(e.index);
      }
    }
  }

  // Flash events no call explains.
  const loose = flashEvents.filter((e) => !attached.has(e.index));
  const looseRepays = loose.filter((e) => REPAY.test(structName(e.type)));
  const usedEv = new Set<number>();
  for (const e of loose) {
    if (REPAY.test(structName(e.type))) continue;
    const pool = poolOfEvent(e.json);
    const repay = looseRepays.find(
      (r) => r.index > e.index && !usedEv.has(r.index) && (pool === null || poolOfEvent(r.json) === pool),
    );
    if (repay) usedEv.add(repay.index);
    legs.push({
      kind: legKind(structName(e.type)),
      basis: "events",
      borrow: { event: e.index, target: e.type },
      repay: repay ? { event: repay.index, target: repay.type } : null,
      coin_types: typeArgsOf(e.type),
      objects: pool ? [pool] : [],
      related_events: [e.index, ...(repay ? [repay.index] : [])],
    });
  }
  // A repay event with no borrow event is still a flash leg that happened.
  for (const r of looseRepays) {
    if (usedEv.has(r.index)) continue;
    const pool = poolOfEvent(r.json);
    legs.push({
      kind: legKind(structName(r.type)),
      basis: "events",
      borrow: { target: "(not visible: the borrow emitted no event and was not a top-level call)" },
      repay: { event: r.index, target: r.type },
      coin_types: typeArgsOf(r.type),
      objects: pool ? [pool] : [],
      related_events: [r.index],
    });
  }
  return legs;
}

/* ------------------------------------------------------------------ *
 * Oracle touches
 * ------------------------------------------------------------------ */

const ORACLE_NAME = /oracle|price_?feed|pyth|supra|switchboard|price_?info|update_?price|price_?voucher|price_?update/i;

export interface OracleTouch {
  kind: "call" | "event";
  target: string;
  count: number;
  /** First command or event index. */
  first: number;
  /** Pyth price updates decoded from their events. */
  decoded?: Array<{ feed_id: string | null; price: number | null; publish_time: number | null }>;
}

function signedI64(v: unknown): number | null {
  const o = asRecord(v);
  if (!o) return null;
  const mag = uintField(o, "magnitude");
  if (mag === null) return null;
  return o.negative === true ? -Number(mag) : Number(mag);
}

function feedIdHex(v: unknown): string | null {
  const o = asRecord(v);
  const bytes = o ? o.bytes : v;
  if (Array.isArray(bytes) && bytes.every((b) => typeof b === "number")) {
    return "0x" + bytes.map((b: number) => b.toString(16).padStart(2, "0")).join("");
  }
  if (typeof bytes === "string") {
    if (/^0x[0-9a-f]+$/i.test(bytes)) return bytes.toLowerCase();
    try {
      return "0x" + Buffer.from(bytes, "base64").toString("hex");
    } catch {
      return null;
    }
  }
  return null;
}

/** Pyth's `PriceFeedUpdateEvent`, read into a USD price. */
export function decodePythUpdate(json: unknown): { feed_id: string | null; price: number | null; publish_time: number | null } {
  const feed = asRecord(asRecord(json)?.price_feed);
  const price = asRecord(feed?.price);
  const p = signedI64(price?.price);
  const expo = signedI64(price?.expo);
  const ts = price ? uintField(price, "timestamp") : null;
  return {
    feed_id: feedIdHex(feed?.price_identifier),
    price: p !== null && expo !== null ? p * 10 ** expo : null,
    publish_time: ts !== null ? Number(ts) : null,
  };
}

/**
 * Calls and events that read or write a price, matched by name. Grouped by
 * target with a count, because an exploit that refreshes an oracle a hundred
 * times does it in a loop.
 */
export function oracleTouches(calls: AttackCall[], events: AttackEvent[]): OracleTouch[] {
  const out = new Map<string, OracleTouch>();
  for (const c of calls) {
    if (!ORACLE_NAME.test(`${c.module}::${c.function}`)) continue;
    const t = target(c);
    const cur = out.get(`call ${t}`);
    if (cur) cur.count++;
    else out.set(`call ${t}`, { kind: "call", target: t, count: 1, first: c.command });
  }
  for (const e of events) {
    const parts = e.type.split("<")[0].split("::");
    if (!ORACLE_NAME.test(`${parts[1] ?? ""}::${parts[2] ?? ""}`)) continue;
    const key = `event ${e.type}`;
    let cur = out.get(key);
    if (cur) cur.count++;
    else {
      cur = { kind: "event", target: e.type, count: 1, first: e.index };
      out.set(key, cur);
    }
    if (structName(e.type) === "PriceFeedUpdateEvent") (cur.decoded ??= []).push(decodePythUpdate(e.json));
  }
  return [...out.values()];
}

/* ------------------------------------------------------------------ *
 * Incident: many transactions, grouped by the pool they drained
 * ------------------------------------------------------------------ */

export interface IncidentGroup {
  /** One pool, or several when a transaction touched more than one. */
  pools: string[];
  pool_type: string | null;
  digests: string[];
  /** The attacker's net balance change across these transactions. */
  attacker_deltas: Map<string, bigint>;
  /** Reserve change of the pool(s), from their events. Negative is drained. */
  pool_deltas: Map<string, bigint>;
}

export interface IncidentAggregate {
  groups: IncidentGroup[];
  /** Attacker net per coin, across every transaction. */
  totals: Map<string, bigint>;
  failed: string[];
  /** Successful transactions whose pools could not be identified. */
  unattributed: string[];
  senders: string[];
}

/**
 * Group the attacker's balance changes by the pool each transaction touched.
 *
 * The attacker is `attacker` when given, otherwise each transaction's sender.
 * A transaction touching several pools cannot have one balance change split
 * between them, so it is grouped under the set; the pool-side deltas from
 * events still say what each pool lost.
 */
export function aggregateIncident(txs: AttackTx[], attacker?: string): IncidentAggregate {
  const who = attacker ? canonicalId(attacker) : null;
  const groups = new Map<string, IncidentGroup>();
  const totals = new Map<string, bigint>();
  const failed: string[] = [];
  const unattributed: string[] = [];
  const senders = new Set<string>();

  for (const tx of txs) {
    const sender = canonicalId(tx.sender);
    if (sender) senders.add(sender);
    const subject = who ?? sender;
    const mine = subject ? netByAddress(tx.balanceChanges).get(subject) ?? new Map<string, bigint>() : new Map<string, bigint>();
    addDeltas(totals, mine);
    if (!tx.success) {
      failed.push(tx.digest);
      continue;
    }
    const pools = poolsTouched(tx).sort();
    if (pools.length === 0) {
      unattributed.push(tx.digest);
      continue;
    }
    const key = pools.join("+");
    let g = groups.get(key);
    if (!g) {
      const poolType = pools.length === 1
        ? tx.objects.find((o) => canonicalId(o.objectId) === pools[0])?.objectType ?? null
        : null;
      g = { pools, pool_type: poolType, digests: [], attacker_deltas: new Map(), pool_deltas: new Map() };
      groups.set(key, g);
    }
    g.digests.push(tx.digest);
    addDeltas(g.attacker_deltas, mine);
    for (const f of poolFlows(tx)) if (pools.includes(f.pool)) addDeltas(g.pool_deltas, f.deltas);
  }
  return { groups: [...groups.values()], totals, failed, unattributed, senders: [...senders] };
}

/* ------------------------------------------------------------------ *
 * USD
 * ------------------------------------------------------------------ */

export interface ValuedCoin {
  coin_type: string;
  symbol: string;
  /** False: the symbol is whatever the minter chose. See `verified` in analyze_token. */
  verified: boolean | null;
  /** Signed raw amount. */
  amount: string;
  /** Signed amount in whole tokens, at `decimals_source`'s scale. */
  amount_human: number;
  decimals_source: CoinScale["source"];
  /** Null when the coin has no price. Never zero for "unknown". */
  usd: number | null;
}

export interface ValuedDeltas {
  coins: ValuedCoin[];
  /** Sum over priced coins, signed. */
  usd_net: number;
  /** Sum of the priced positive amounts. */
  usd_gained: number;
  /** Coin types in `coins` that have no price. */
  unpriced: string[];
}

/**
 * Value a set of signed deltas. Unpriced coins stay in the list with `usd:
 * null` and are named in `unpriced`, so a total is always read beside what it
 * leaves out. `A`/`B` placeholders (a pool whose type was not read) are
 * unpriced by construction.
 */
export function valueDeltas(deltas: Map<string, bigint>, prices: Map<string, PricePoint>): ValuedDeltas {
  const coins: ValuedCoin[] = [];
  let net = 0;
  let gained = 0;
  const unpriced: string[] = [];
  for (const [coinType, raw] of deltas) {
    if (raw === 0n) continue;
    const placeholder = !coinType.includes("::");
    const point = placeholder ? undefined : prices.get(coinType);
    const scale = placeholder ? { decimals: 0, source: "assumed" as const } : pricingScale(coinType, point);
    const coin = placeholder ? { symbol: `coin ${coinType} (pool type not read)`, verified: null } : displayCoin(coinType);
    const human = (raw < 0n ? -1 : 1) * toHumanAmount(raw, scale.decimals);
    const usd = point ? human * point.price : null;
    if (usd === null) unpriced.push(coinType);
    else {
      net += usd;
      if (usd > 0) gained += usd;
    }
    coins.push({
      coin_type: coinType,
      symbol: coin.symbol,
      verified: coin.verified,
      amount: raw.toString(),
      amount_human: human,
      decimals_source: scale.source,
      usd: usd === null ? null : Number(usd.toFixed(2)),
    });
  }
  coins.sort((a, b) => Math.abs(b.usd ?? 0) - Math.abs(a.usd ?? 0));
  return { coins, usd_net: Number(net.toFixed(2)), usd_gained: Number(gained.toFixed(2)), unpriced };
}
