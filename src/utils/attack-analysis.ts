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

import { normalizeSuiAddress, normalizeStructTag } from "@mysten/sui/utils";
import { displayCoin, pricingScale, toHumanAmount, type CoinScale, type PricePoint } from "./valuation.js";
import type { CheckRun, PtbAnomaly } from "./ptb-anomalies.js";
import type { ObjectMovement } from "./object-flow.js";
import type { GasPaid } from "./payouts.js";
import { compareStates, holdingTotals, mintedTotals, numericFields, stateAnomaly, STATE_JUMP_FACTOR, VALUE_SHARE_LOST, type StateSnapshot } from "./state-delta.js";
import { signedReading, signedReadings } from "./signed-int.js";

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
  /** Pure inputs passed as arguments, in argument order. */
  pureArgs: PureArg[];
  /** Every argument in order, as a reference, so a value can be followed from the input that carried it to the calls that used it. */
  args: ArgRef[];
}

/** A command argument: a PTB input by index, an earlier command's result (any of its outputs), or the gas coin. */
export type ArgRef = { input: number } | { result: number } | { gas: true };

/** A pure input: its BCS length, and its little-endian unsigned value when the length fits an integer. */
export interface PureArg {
  bytes: number;
  uint: string | null;
}

/** A PTB input, by index. */
export interface AttackInput {
  /** Object id of an object input; null for a pure input. */
  objectId: string | null;
  /** BCS length of a pure input; 0 for an object. */
  bytes: number;
  /**
   * The unsigned integers a pure input can carry: the whole value when its
   * length is an integer width, or each element of a `vector<u64>` or
   * `vector<u128>`. Empty for an object or a pure of another shape.
   */
  values: string[];
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
  /** A consensus object before the transaction: a shared input it changed. */
  shared?: boolean;
  /** For an object owned by another object (a dynamic field), that owner's id. */
  parent?: string | null;
  /** Version before the transaction; null for an object it created. */
  inputVersion?: string | null;
  /** Version after the transaction; null for an object it deleted or wrapped. */
  outputVersion?: string | null;
}

export interface AttackTx {
  digest: string;
  sender: string | null;
  success: boolean;
  timestampMs: number | null;
  checkpoint: string | null;
  /** One entry per command: `MoveCall`, `Publish`, `Upgrade`, `SplitCoins`, … */
  commandKinds: string[];
  /** The transaction's BCS, for `resolvePtb` to read each argument against the called function's signature. Null when the read carried none. */
  bcs: Uint8Array | null;
  /** Objects other than coins that changed hands, from the effects (`readGrpcObjectChanges`). */
  movements: ObjectMovement[];
  /** Who paid gas and how much, from the effects; null when the read carried no cost summary. */
  gas: GasPaid | null;
  calls: AttackCall[];
  events: AttackEvent[];
  balanceChanges: AttackBalanceChange[];
  objects: AttackObject[];
  /** The PTB's inputs. */
  inputs?: AttackInput[];
  /** `MakeMoveVector` commands and their elements. */
  vectors?: Array<{ command: number; elements: ArgRef[] }>;
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

/** Full-length object ids among an event's top-level fields, including `{ id }` / `{ bytes }` wrappers, in field order. */
export function eventObjectIds(json: unknown): string[] {
  const o = asRecord(json);
  if (!o) return [];
  const out: string[] = [];
  for (const v of Object.values(o)) {
    const nested = asRecord(v);
    const s = nested ? (nested.id ?? nested.bytes) : v;
    if (typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s)) out.push(normalizeSuiAddress(s));
  }
  return out;
}

/** Shared objects a transaction changed, id to type: the objects an event can be attributed to. */
export type SharedObjects = ReadonlyMap<string, string | null>;

export function sharedObjectsOf(tx: Pick<AttackTx, "objects">): SharedObjects {
  const out = new Map<string, string | null>();
  for (const o of tx.objects) {
    const id = o.shared ? canonicalId(o.objectId) : null;
    if (id) out.set(id, o.objectType);
  }
  return out;
}

/**
 * The objects an event can be attributed to: the changed shared objects,
 * and, after them, every other changed object that is not a coin or a
 * dynamic field (a pool kept as a dynamic object field of a registry, a
 * position).
 */
export interface EventTargets {
  shared: SharedObjects;
  others: SharedObjects;
}

export function eventTargetsOf(tx: Pick<AttackTx, "objects">): EventTargets {
  const others = new Map<string, string | null>();
  for (const o of tx.objects) {
    const id = canonicalId(o.objectId);
    if (!id || o.shared || /^0x0*2::(coin::Coin|dynamic_field::Field)</.test(o.objectType ?? "")) continue;
    others.set(id, o.objectType);
  }
  return { shared: sharedObjectsOf(tx), others };
}

/**
 * The pool, vault or market an event is about: a changed shared object
 * whose id is the value of one of the event's fields, whatever that field
 * is named, or, when none is, another changed object the event names. Among
 * several, a pool-shaped type ({@link isPoolLikeType}) is preferred, then
 * the first in field order. An event naming no changed object is attributed
 * to none. A bare map is read as the shared objects alone.
 */
export function poolOfEvent(json: unknown, targets: SharedObjects | EventTargets): string | null {
  const ids = eventObjectIds(json);
  const tiers = targets instanceof Map ? [targets as SharedObjects] : [(targets as EventTargets).shared, (targets as EventTargets).others];
  for (const tier of tiers) {
    const named = ids.filter((id) => tier.has(id));
    const hit = named.find((id) => isPoolLikeType(tier.get(id))) ?? named[0];
    if (hit) return hit;
  }
  return null;
}

/**
 * A coin type carried in event JSON, canonicalised with `normalizeStructTag`.
 * A Move `TypeName` serializes its package address without the `0x` prefix
 * (Typus's `lp_pool::SwapEvent` has `from_token_type` reading
 * `0000…0002::sui::SUI`), so a raw string here would not match the `0x…`
 * form the price lookup and the coin registry use.
 */
function coinTypeField(o: Record<string, unknown>, ...names: string[]): string | null {
  for (const n of names) {
    const v = o[n];
    if (typeof v !== "string" || !v.includes("::")) continue;
    try {
      return normalizeStructTag(v);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * A signed Q64.64 fixed-point field (`{ value, positive }`, Nemo's
 * `FixedPoint64WithSign`), as the raw integer amount it carries: the value
 * shifted down 64 bits, which is the truncation Nemo applies before moving
 * coins.
 */
function signedQ64Field(o: Record<string, unknown>, name: string): { raw: bigint; negative: boolean } | null {
  const rec = asRecord(o[name]);
  if (!rec || typeof rec.positive !== "boolean") return null;
  const v = uintField(rec, "value");
  if (v === null) return null;
  return { raw: v >> 64n, negative: !rec.positive && v !== 0n };
}

/** One amount field an event keys to a pool side and a direction: `amount_x_in`, `token_y_amount_out`, `amount_a_in`. */
export interface SidedAmount {
  field: string;
  /** 0 for the pool's first coin (`x`, `a`), 1 for its second (`y`, `b`). */
  side: 0 | 1;
  /** 1 when the pool took the amount in, -1 when it paid it out. */
  direction: 1 | -1;
  amount: bigint;
  /** The coin type a field on the same side names (`token_x_name`, `token_x_in`), when one does. */
  coin: string | null;
}

const SIDE_TOKENS: Record<string, 0 | 1> = { x: 0, a: 0, y: 1, b: 1 };

/**
 * Amount fields whose name, split at `_`, carries `amount`, exactly one side
 * token (`x`/`a` or `y`/`b`) and exactly one direction token (`in` or
 * `out`), read by that shape rather than by struct or protocol name. The
 * coin of a side is the coin type a non-amount field on the same side names.
 */
export function sidedAmounts(json: unknown): SidedAmount[] {
  const o = asRecord(json);
  if (!o) return [];
  const coinOf: Array<string | null> = [null, null];
  const out: SidedAmount[] = [];
  for (const k of Object.keys(o)) {
    const tokens = k.toLowerCase().split("_");
    const sides = tokens.filter((t) => t in SIDE_TOKENS);
    if (sides.length !== 1) continue;
    const side = SIDE_TOKENS[sides[0]];
    if (!tokens.includes("amount")) {
      coinOf[side] ??= coinTypeField(o, k);
      continue;
    }
    const dirs = tokens.filter((t) => t === "in" || t === "out");
    const amount = uintField(o, k);
    if (dirs.length !== 1 || amount === null) continue;
    out.push({ field: k, side, direction: dirs[0] === "in" ? 1 : -1, amount, coin: null });
  }
  return out.map((s) => ({ ...s, coin: coinOf[s.side] }));
}

/**
 * Key for Nemo's principal token in pool deltas. PT is a balance inside a
 * `PyPosition`, not a coin, so it is keyed apart from coin types; its amounts
 * are in the units of the SY coin `T` it was minted from.
 */
export function nemoPtKey(syCoinType: string): string {
  return `PT<${syCoinType}>`;
}

/**
 * Whether a `PoolFlow.deltas` key is a coin type. The other keys are `A`/`B`
 * (a pool whose type was not read, no `::`) and position units that are not
 * coins ({@link nemoPtKey}, `PT<…>`); neither has a price.
 */
export function isCoinTypeKey(key: string): boolean {
  return key.includes("::") && !key.startsWith("PT<");
}

/**
 * Whether a changed object's type reads as a pool by name. Broader than an
 * exact match on `Pool`, because it also has to catch a DEX-specific name
 * (Typus's `LiquidityPool`) without hard-coding one per protocol.
 */
function isPoolLikeType(type: string | null | undefined): boolean {
  return type !== null && type !== undefined && /pool$/i.test(structName(type));
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

/** Canonical SUI coin type, padded the way the chain reports it. */
const SUI_COIN_TYPE = normalizeStructTag("0x2::sui::SUI");

/**
 * Whether a set of deltas reads as "only paid gas": nothing but SUI moved,
 * and that SUI change is a payment (<= 0) rather than a gain. A sender with
 * no balance-change row at all (a sponsored transaction) counts too: it paid
 * nothing of its own.
 *
 * Deciding this from the netted priced USD instead reads two different
 * things as the same case: an offsetting swap (10,000 USDT for 9,998 USDC)
 * nets near zero without being gas-only, and a sender whose own SUI was
 * genuinely drained reads as gas-only whenever that drain happens to be
 * unpriced. Checking the coins directly catches both.
 */
export function isGasOnly(deltas: Map<string, bigint> | undefined, prices: Map<string, PricePoint>, thresholdUsd: number): boolean {
  if (!deltas || deltas.size === 0) return true;
  for (const [coinType, amount] of deltas) {
    if (coinType !== SUI_COIN_TYPE && amount !== 0n) return false;
  }
  const sui = deltas.get(SUI_COIN_TYPE) ?? 0n;
  if (sui > 0n) return false;
  const point = prices.get(SUI_COIN_TYPE);
  if (point) {
    const scale = pricingScale(SUI_COIN_TYPE, point);
    if (toHumanAmount(sui, scale.decimals) * point.price >= thresholdUsd) return false;
  }
  return true;
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
  /** What the pool received and paid out, raw. */
  amount_in: string | null;
  amount_out: string | null;
  /**
   * The coin (or position unit, see {@link nemoPtKey}) behind each amount,
   * when the event names it. Null for an A/B swap, whose coins come from the
   * pool's type.
   */
  coin_in: string | null;
  coin_out: string | null;
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
 * A swap whose event names the coins that moved rather than an A/B side:
 *
 * - Typus's `lp_pool::SwapEvent`: `from_token_type`/`from_amount` in,
 *   `to_token_type`/`actual_to_amount` out.
 * - Nemo's `market::SwapEvent<T>`: `pt_amount` and `sy_amount` as signed
 *   Q64.64. `sy_amount` is the market's own SY change (negative: it paid SY
 *   out and took PT in); `pt_amount` is negative on both directions, so only
 *   its magnitude is read. SY is a `Balance<T>`, so its coin is `T`.
 */
function typedSwap(ev: AttackEvent, o: Record<string, unknown>): Pick<SwapObservation, "coin_in" | "coin_out" | "amount_in" | "amount_out"> | null {
  const fromType = coinTypeField(o, "from_token_type");
  const toType = coinTypeField(o, "to_token_type");
  const fromAmount = uintField(o, "from_amount");
  const toAmount = uintField(o, "actual_to_amount", "to_amount");
  if (fromType && toType && fromAmount !== null && toAmount !== null) {
    return { coin_in: fromType, coin_out: toType, amount_in: fromAmount.toString(), amount_out: toAmount.toString() };
  }
  const pt = signedQ64Field(o, "pt_amount");
  const sy = signedQ64Field(o, "sy_amount");
  const syArg = typeArgsOf(ev.type)[0];
  if (!pt || !sy || !syArg) return null;
  let syCoin: string;
  try {
    syCoin = normalizeStructTag(syArg);
  } catch {
    return null;
  }
  const ptKey = nemoPtKey(syCoin);
  return sy.negative
    ? { coin_in: ptKey, coin_out: syCoin, amount_in: pt.raw.toString(), amount_out: sy.raw.toString() }
    : { coin_in: syCoin, coin_out: ptKey, amount_in: sy.raw.toString(), amount_out: pt.raw.toString() };
}

/**
 * Read a swap event. Field names cover the CLMM DEXes on Sui that emit the
 * price on both sides: Cetus (`before_sqrt_price`/`after_sqrt_price`,
 * `atob`), Bluefin (`a2b`), FlowX and Momentum (`sqrt_price_before`/
 * `sqrt_price_after`, `x_for_y`) and Turbos (`tick_pre_index`/
 * `tick_current_index`, `a_to_b`), the coin-named shapes in
 * {@link typedSwap}, and amounts keyed by side and direction
 * ({@link sidedAmounts}). A swap event without a price is still listed, with the
 * impact null. `pool` is the changed shared object the event names
 * ({@link poolOfEvent}).
 */
export function readSwap(ev: AttackEvent, shared: SharedObjects | EventTargets = new Map()): SwapObservation | null {
  if (!isSwapEvent(ev.type)) return null;
  const o = asRecord(ev.json);
  if (!o) return null;
  let aToB = boolField(o, "atob", "a2b", "a_to_b", "x_for_y");
  let typed = typedSwap(ev, o);
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
  if (!typed && amountIn === null && amountOut === null) {
    // One side in and the other side out, each keyed by its field name
    // (`amount_x_in`, `amount_y_out`); zero legs are the unused direction.
    const moved = sidedAmounts(o).filter((s) => s.amount > 0n);
    const ins = moved.filter((s) => s.direction === 1);
    const outs = moved.filter((s) => s.direction === -1);
    if (ins.length === 1 && outs.length === 1 && ins[0].side !== outs[0].side) {
      aToB = ins[0].side === 0;
      amountIn = ins[0].amount;
      amountOut = outs[0].amount;
      if (ins[0].coin && outs[0].coin) typed = { coin_in: ins[0].coin, coin_out: outs[0].coin, amount_in: amountIn.toString(), amount_out: amountOut.toString() };
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
    pool: poolOfEvent(ev.json, shared),
    a_to_b: aToB,
    amount_in: typed?.amount_in ?? amountIn?.toString() ?? null,
    amount_out: typed?.amount_out ?? amountOut?.toString() ?? null,
    coin_in: typed?.coin_in ?? null,
    coin_out: typed?.coin_out ?? null,
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
  /**
   * A loss (or gain, if negative) this vault's own event states directly in
   * USD, when its shape carries no raw coin amount to convert (Volo's
   * `OperationValueUpdateChecked`: `total_usd_value_before`/
   * `total_usd_value_after`, already priced). Kept separate from `deltas`,
   * which `valueDeltas` prices from a raw amount: this is already a price.
   */
  recorded_loss_usd?: number;
  /** Numbers this object's own events state before and after a change ({@link recordedChanges}). */
  recorded_changes: RecordedChange[];
}

/** A value an event states on both sides of a change: `X_before`/`X_after`, `before_X`/`after_X`, `old_X`/`new_X` or `X_old`/`X_new`. */
export interface RecordedChange {
  event: number;
  field: string;
  before: string;
  after: string;
}

const CHANGE_PAIRS: Array<[RegExp, (x: string) => string]> = [
  [/^(.+)_before$/, (x) => `${x}_after`],
  [/^before_(.+)$/, (x) => `after_${x}`],
  [/^old_(.+)$/, (x) => `new_${x}`],
  [/^(.+)_old$/, (x) => `${x}_new`],
];

/** Unsigned numeric before/after pairs among an event's top-level fields, by field-name shape. */
export function recordedChanges(ev: AttackEvent): RecordedChange[] {
  const o = asRecord(ev.json);
  if (!o) return [];
  const out: RecordedChange[] = [];
  for (const k of Object.keys(o)) {
    for (const [re, partner] of CHANGE_PAIRS) {
      const x = re.exec(k)?.[1];
      if (!x) continue;
      const before = uintField(o, k);
      const after = uintField(o, partner(x));
      if (before !== null && after !== null) out.push({ event: ev.index, field: x, before: before.toString(), after: after.toString() });
    }
  }
  return out;
}

/** Stated changes folded per field, for display: the first `before`, the last `after`, and every event that stated one. */
export function foldRecordedChanges(changes: RecordedChange[]): Array<{ field: string; before: string; after: string; events: number[] }> {
  const out = new Map<string, { field: string; before: string; after: string; events: number[] }>();
  for (const c of changes) {
    const f = out.get(c.field);
    if (f) {
      f.after = c.after;
      f.events.push(c.event);
    } else out.set(c.field, { field: c.field, before: c.before, after: c.after, events: [c.event] });
  }
  return [...out.values()];
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
 * Fixed decimals of `total_usd_value_before`/`total_usd_value_after`, the
 * one before/after pair whose unit is known (Volo's vault value check, a USD
 * figure at 1e9). Any other pair is kept as a raw before and after.
 */
const VOLO_VAULT_VALUE_SCALE = 1e9;

/**
 * Per-pool reserve changes from the pool's events. Coin A and B are the pool
 * type's first two type arguments, which is how every CLMM on Sui orders them;
 * a pool whose type is not in the changed objects is keyed `A`/`B` so the
 * amounts are kept without a coin name being invented.
 *
 * Events are attributed by value, not by field name: an event belongs to the
 * changed shared object whose id one of its fields carries
 * ({@link poolOfEvent}). Four shapes are read, by field name rather than by
 * struct or module name, so a new protocol needs no registration:
 *
 * - A swap with amounts keyed to the pool's own A/B position (`readSwap`) or
 *   its liquidity fields.
 * - A swap whose event names the coins that moved (`readSwap`'s
 *   `coin_in`/`coin_out`: Typus's `lp_pool::SwapEvent`, Nemo's
 *   `market::SwapEvent`). Read from those coins rather than an assumed A/B
 *   order. One with no pool id of its own (Typus) is attributed to the
 *   transaction's pool-shaped object only when exactly one is touched. With
 *   more than one, which pool an id-less event belongs to is not decidable
 *   from the event.
 * - Amounts whose field names give the side and the direction
 *   ({@link sidedAmounts}: `token_x_amount_in`, `amount_y_out`), for a
 *   liquidity add or removal of any struct name.
 * - A before/after pair ({@link recordedChanges}), kept in
 *   `recorded_changes`; the USD pair at a known scale also feeds
 *   `recorded_loss_usd`.
 *
 * An object appears only when one of its events moved an amount, stated a
 * change, or carried an amount field in a shape not read here.
 */
export function poolFlows(tx: Pick<AttackTx, "events" | "objects">): PoolFlow[] {
  const typeById = new Map<string, string>();
  for (const o of tx.objects) {
    const id = canonicalId(o.objectId);
    if (id && o.objectType) typeById.set(id, o.objectType);
  }
  const shared = eventTargetsOf(tx);
  const poolLikeIds = [...typeById].filter(([, t]) => isPoolLikeType(t)).map(([id]) => id);
  const impliedPool = poolLikeIds.length === 1 ? poolLikeIds[0] : null;

  const flows = new Map<string, PoolFlow>();
  const flowFor = (pool: string): PoolFlow => {
    let f = flows.get(pool);
    if (!f) {
      f = { pool, pool_type: typeById.get(pool) ?? null, deltas: new Map(), events: [], undecoded_events: [], recorded_changes: [] };
      flows.set(pool, f);
    }
    return f;
  };
  const add = (f: PoolFlow, coin: string, v: bigint) => f.deltas.set(coin, (f.deltas.get(coin) ?? 0n) + v);

  for (const ev of tx.events) {
    const o = asRecord(ev.json);
    if (!o) continue;
    const named = poolOfEvent(ev.json, shared);
    const swap = readSwap(ev, shared);
    const changes = named ? recordedChanges(ev) : [];
    if (named && changes.length) flowFor(named).recorded_changes.push(...changes);

    if (swap?.coin_in && swap.coin_out && swap.amount_in !== null && swap.amount_out !== null) {
      const pool = named ?? impliedPool;
      if (pool) {
        const f = flowFor(pool);
        add(f, swap.coin_in, BigInt(swap.amount_in));
        add(f, swap.coin_out, -BigInt(swap.amount_out));
        f.events.push(ev.index);
      }
      continue;
    }

    if (!named) continue;
    const poolType = typeById.get(named);
    const poolArgs = poolType ? typeArgsOf(poolType) : [];
    const coinA = poolArgs[0] ?? "A";
    const coinB = poolArgs[1] ?? "B";

    if (swap && swap.a_to_b !== null && swap.amount_in !== null && swap.amount_out !== null) {
      const f = flowFor(named);
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
      const f = flowFor(named);
      const sign = kind === "add" ? 1n : -1n;
      add(f, coinA, sign * a);
      add(f, coinB, sign * b);
      f.events.push(ev.index);
      continue;
    }
    // Amounts keyed to a side and a direction by their field names
    // (`token_x_amount_in`, `token_y_amount_out`), whatever the struct is
    // called: in is what the pool took, out what it paid.
    const sided = sidedAmounts(o);
    if (sided.some((s) => s.amount > 0n)) {
      const f = flowFor(named);
      for (const s of sided) if (s.amount > 0n) add(f, s.coin ?? (s.side === 0 ? coinA : coinB), BigInt(s.direction) * s.amount);
      f.events.push(ev.index);
      continue;
    }
    const usd = changes.find((c) => c.field === "total_usd_value");
    if (usd) {
      const f = flowFor(named);
      f.recorded_loss_usd = (f.recorded_loss_usd ?? 0) + Number(BigInt(usd.before) - BigInt(usd.after)) / VOLO_VAULT_VALUE_SCALE;
    }
    if (changes.length) {
      flowFor(named).events.push(ev.index);
      continue;
    }
    // An event moves a coin in an unread shape when it has an amount field,
    // or names a coin type beside a non-zero number (Scallop's
    // `SpoolAccountRedeemRewardsEventV2`: `rewards` in `rewards_type`). One
    // with neither (opening a position, say) moves nothing.
    const keys = Object.keys(o);
    const movesCoin =
      keys.some((k) => /amount/i.test(k)) ||
      (keys.some((k) => coinTypeField(o, k) !== null) && keys.some((k) => (uintField(o, k) ?? 0n) > 0n));
    if (movesCoin) flowFor(named).undecoded_events.push(ev.index);
  }
  // Pools with only undecoded events are kept: "this pool was touched and we
  // could not read how" is a finding a reader needs.
  return [...flows.values()];
}

/**
 * The pools a transaction touched: every object `flows` credits an amount,
 * a stated change or an undecoded amount event to. An id-less, type-keyed
 * swap (Typus's `lp_pool::SwapEvent`) is credited to the transaction's one
 * pool-shaped object, and grouping it anywhere else drops its deltas from the
 * group while `analyze_attack_tx`, reading `poolFlows` directly, still shows
 * them. Only when no flow names a pool does a changed object whose struct
 * reads as a pool by name cover a DEX whose events carry no pool id.
 */
export function poolsTouched(tx: Pick<AttackTx, "events" | "objects">, flows: PoolFlow[] = poolFlows(tx)): string[] {
  const out = new Set<string>();
  for (const f of flows) out.add(f.pool);
  if (out.size === 0) {
    for (const o of tx.objects) {
      if (isPoolLikeType(o.objectType)) {
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
 * are paired the same way by the changed shared object they name.
 */
export function pairFlashLegs(calls: AttackCall[], events: AttackEvent[], shared: SharedObjects | EventTargets = new Map()): FlashLeg[] {
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
      if (!eventObjectIds(e.json).some((id) => leg.objects.includes(id))) continue;
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
    const pool = poolOfEvent(e.json, shared);
    const repay = looseRepays.find(
      (r) => r.index > e.index && !usedEv.has(r.index) && (pool === null || poolOfEvent(r.json, shared) === pool),
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
    const pool = poolOfEvent(r.json, shared);
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
 * Anomalies read from events, call arguments and object state
 * ------------------------------------------------------------------ */

/**
 * A pure argument this long is a signature (64 bytes and up) or a signed
 * payload, which travels with an attested update (Switchboard's submitted
 * result, Supra's proofs). A write carrying one may be vouched for by its
 * signer, which lowers the grade of `caller-value-used` by one step without
 * clearing it: a broken signature check is the same exploit.
 */
const SIGNED_PAYLOAD_BYTES = 64;

/**
 * Liquidity per raw unit paid, for an add-liquidity event without tick
 * bounds. At the narrowest range (one tick, a 0.005% sqrt-price width) and
 * the edge of the Q64.64 sqrt-price bounds (2^-32 to 2^32), one raw unit buys
 * at most about 2e4 × 4.3e9 ≈ 8.6e13 liquidity.
 */
const MAX_LIQUIDITY_PER_UNIT = 10n ** 18n;

/**
 * The most liquidity a CLMM position on `[lower, upper)` can hold for
 * amounts `a` and `b`, at any current price, from the concentrated-liquidity
 * identities with real sqrt prices `sa`, `sb`, `sp`:
 *
 * - price at or below the range: `a = L (sb − sa) / (sa sb)`
 * - price at or above the range: `b = L (sb − sa)`
 * - price inside: `a = L (sb − sp) / (sp sb)` and `b = L (sp − sa)`
 *
 * Inside the range, the `L` coin A allows rises with `sp` and the `L` coin B
 * allows falls, so the most either allows is where they meet, found by
 * bisection; that value also bounds both edges. Each amount gets one raw
 * unit added for the protocol's rounding. The bound holds for an add (the
 * amounts paid) and a removal (the amounts returned) alike.
 */
export function maxLiquidity(a: bigint, b: bigint, lower: number, upper: number): number {
  const sa = 1.0001 ** (lower / 2);
  const sb = 1.0001 ** (upper / 2);
  const A = Number(a) + 1;
  const B = Number(b) + 1;
  const fromA = (sp: number) => (A * sp * sb) / (sb - sp);
  const fromB = (sp: number) => B / (sp - sa);
  let lo = sa;
  let hi = sb;
  for (let i = 0; i < 200 && hi > lo; i++) {
    const mid = lo + (hi - lo) / 2;
    if (mid <= lo || mid >= hi) break;
    if (fromA(mid) < fromB(mid)) lo = mid;
    else hi = mid;
  }
  return Math.min(fromB(lo), fromA(hi));
}

/** A signed tick field whose name says which bound it is (`tick_lower`, `lower_tick`, `lower_tick_index`, …). */
function tickBound(o: Record<string, unknown>, side: "lower" | "upper"): number | null {
  const k = Object.keys(o).find((k) => k.toLowerCase().includes(side) && k.toLowerCase().includes("tick"));
  return k ? i32Field(o, k) : null;
}

/**
 * Liquidity events that credit more than the amounts could buy: an event
 * carrying a `liquidity` delta and both amounts, whose delta is above
 * {@link maxLiquidity} for its own tick range, or, with no tick range,
 * above {@link MAX_LIQUIDITY_PER_UNIT} per raw unit. Only the delta is read:
 * `after_liquidity` is the position's total, and a small top-up of a large
 * position is ordinary.
 */
function outsizedMints(events: AttackEvent[], shared: EventTargets): string[] {
  const out: string[] = [];
  for (const e of events) {
    const o = asRecord(e.json);
    if (!o) continue;
    const liquidity = uintField(o, "liquidity", "liquidity_delta");
    const a = uintField(o, "amount_a", "coin_a_amount", "amount_x");
    const b = uintField(o, "amount_b", "coin_b_amount", "amount_y");
    if (liquidity === null || liquidity === 0n || a === null || b === null) continue;
    const lower = tickBound(o, "lower");
    const upper = tickBound(o, "upper");
    const ranged = lower !== null && upper !== null && lower < upper;
    const bound = ranged ? maxLiquidity(a, b, lower, upper) : null;
    const over = bound !== null ? Number(liquidity) > bound * (1 + 1e-9) : liquidity > MAX_LIQUIDITY_PER_UNIT * (a + b > 0n ? a + b : 1n);
    if (!over) continue;
    const pool = poolOfEvent(e.json, shared);
    out.push(
      `${shortEventType(e.type)} (event ${e.index})${pool ? ` on ${pool}` : ""}: liquidity ${liquidity} for amount_a ${a}, amount_b ${b}` +
        (bound !== null ? `; ticks ${lower} to ${upper} allow at most ${bound.toPrecision(4)}` : ""),
    );
  }
  return out;
}

/**
 * How far a minted share of supply may exceed the largest deposited share
 * of the object's holdings. A proportional mint issues at most the smallest
 * deposited share, and reserves kept outside the read `Balance<T>` fields
 * only lower the minted share against the read ones; exceeding it needs an
 * object holding this many times more coin than its share price counts.
 */
const SHARE_MINT_FACTOR = 100n;

/** Field-name tokens of a minted share amount, and tokens that make it a total instead. */
const SHARE_TOKENS = new Set(["lp", "lsp", "share", "shares", "minted", "liquidity"]);
const TOTAL_TOKENS = new Set(["total", "supply", "reserve", "reserves", "before", "after", "old", "new"]);

/**
 * Share mints out of proportion to the deposit, for an object whose state
 * keeps a `Supply<T>` (LP or vault shares). An event naming such an object,
 * stating a minted amount (a field whose name carries `lp`, `lsp`, `share`,
 * `minted` or `liquidity`, and no total) and amounts taken in
 * ({@link sidedAmounts} in, or `amount_a`/`amount_b` on an add), is outsized
 * when minted / supply exceeds {@link SHARE_MINT_FACTOR} times every
 * deposit's share of the object's own holdings of that coin at its input
 * version. Adds on one object are taken in order, each against the supply
 * and holdings the earlier ones left. A first mint (no supply) and a
 * deposit into a coin the object held none of are not bounded.
 */
function outsizedShareMints(tx: Pick<AttackTx, "events" | "objects">, state: StateSnapshot): string[] {
  const targets = eventTargetsOf(tx);
  const byId = new Map(state.objects.filter((o) => o.role === "shared" || o.role === "child").map((o) => [normalizeSuiAddress(o.objectId), o]));
  const supplyOf = new Map<string, bigint>();
  const heldOf = new Map<string, Map<string, bigint>>();
  for (const o of byId.values()) {
    const paths = Object.keys(o.supplies);
    if (paths.length !== 1 || o.before === null) continue;
    const s = numericFields(o.before).get(paths[0]);
    if (s !== undefined) supplyOf.set(normalizeSuiAddress(o.objectId), s);
  }
  for (const h of holdingTotals(state)) {
    if (!supplyOf.has(h.holder)) continue;
    const m = heldOf.get(h.holder) ?? new Map<string, bigint>();
    m.set(h.coin, h.before);
    heldOf.set(h.holder, m);
  }
  const out: string[] = [];
  for (const e of tx.events) {
    const o = asRecord(e.json);
    const pool = o ? poolOfEvent(o, targets) : null;
    if (!o || !pool || !supplyOf.has(pool)) continue;
    const mintedField = Object.keys(o).find((k) => {
      const tokens = k.toLowerCase().split("_");
      return tokens.some((t) => SHARE_TOKENS.has(t)) && !tokens.some((t) => TOTAL_TOKENS.has(t)) && uintField(o, k) !== null;
    });
    const minted = mintedField ? uintField(o, mintedField)! : 0n;
    if (minted === 0n) continue;
    const args = typeArgsOf(byId.get(pool)?.objectType ?? "");
    const coinAt = (side: 0 | 1, named: string | null) => {
      const t = named ?? args[side];
      return t ? coinKey(t) : null;
    };
    const deposits: Array<{ coin: string | null; amount: bigint }> = sidedAmounts(o)
      .filter((s) => s.direction === 1 && s.amount > 0n)
      .map((s) => ({ coin: coinAt(s.side, s.coin), amount: s.amount }));
    if (!deposits.length && liquidityKind(e.type) === "add") {
      const a = uintField(o, "amount_a", "coin_a_amount", "amount_x");
      const b = uintField(o, "amount_b", "coin_b_amount", "amount_y");
      if (a) deposits.push({ coin: coinAt(0, null), amount: a });
      if (b) deposits.push({ coin: coinAt(1, null), amount: b });
    }
    const supply = supplyOf.get(pool)!;
    const held = heldOf.get(pool) ?? new Map<string, bigint>();
    const bounded = deposits.length > 0 && supply > 0n && deposits.every((d) => d.coin !== null && (held.get(d.coin) ?? 0n) > 0n);
    if (bounded && deposits.every((d) => minted * held.get(d.coin!)! > SHARE_MINT_FACTOR * supply * d.amount)) {
      const largest = Math.max(...deposits.map((d) => Number(d.amount) / Number(held.get(d.coin!)!)));
      out.push(
        `${shortEventType(e.type)} (event ${e.index}) on ${pool}: ${mintedField} ${minted} is ${(Number(minted) / Number(supply)).toPrecision(4)} times its share supply of ${supply}, ` +
          `for deposits of at most ${(largest * 100).toPrecision(3)}% of its holdings (${deposits.map((d) => `${d.amount} of ${d.coin}`).join(", ")})`,
      );
    }
    supplyOf.set(pool, supply + minted);
    for (const d of deposits) if (d.coin) held.set(d.coin, (held.get(d.coin) ?? 0n) + d.amount);
    heldOf.set(pool, held);
  }
  return out;
}

/**
 * Values the caller chose: pure inputs, and the results of calls and
 * vectors built only from pure inputs and such results (a
 * `fixed_point64::create_from_raw_value(u128)`, a `MakeMoveVector` of
 * prices). Keyed by command index, to the integers they carry.
 */
function callerDerived(tx: Pick<AttackTx, "calls" | "inputs" | "vectors">): Map<number, string[]> {
  const inputs = tx.inputs ?? [];
  const derived = new Map<number, string[]>();
  const valuesOf = (a: ArgRef): string[] | null => {
    if ("input" in a) {
      const inp = inputs[a.input];
      return inp && inp.objectId === null ? inp.values : null;
    }
    if ("result" in a) return derived.get(a.result) ?? null;
    return null;
  };
  const steps = [
    ...tx.calls.map((c) => ({ command: c.command, args: c.args })),
    ...(tx.vectors ?? []).map((v) => ({ command: v.command, args: v.elements })),
  ].sort((x, y) => x.command - y.command);
  for (const s of steps) {
    if (!s.args.length) continue;
    const vals = s.args.map(valuesOf);
    if (vals.some((v) => v === null)) continue;
    const all = [...new Set(vals.flat() as string[])];
    if (all.length) derived.set(s.command, all);
  }
  return derived;
}

/** An event's unsigned top-level numbers by field name, plain or as `{ value }`. */
function eventNumbers(o: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(o)) {
    const nested = asRecord(v);
    const n = nested ? uintField(nested, "value") : uintField(o, k);
    if (n !== null) out.set(k, n.toString());
  }
  return out;
}

/**
 * The spread across the values one stored field holds within a PTB (before,
 * each write, after) at which a caller's write reads as manipulation: a
 * genuine price or index does not move tenfold inside one transaction. The
 * rule it replaced used the same factor.
 */
const CALLER_SWING = 10n;

/**
 * Below this, a caller value counts only when the field it lands in swings
 * {@link CALLER_SWING} or more within the PTB. Equality is the only
 * evidence a value travelled from the input to the object, and a small
 * number (a flag, a status, a count, zero) equals some stored field by
 * chance: the same floor `state-delta.ts` applies to copied values.
 */
const CALLER_VALUE_MIN = 2n ** 16n;

/**
 * The smallest stated number a product of a caller value may be matched
 * against. A match is equality within one unit, so at 2^32 and above a
 * chance match is about one in two billion per comparison, where at 2^16 it
 * would be one in thirty thousand.
 */
const PRODUCT_MIN = 2n ** 32n;

/** Decimal scales a fixed-point product is divided by: 10^0 through 10^38. */
const MAX_SCALE_DIGITS = 38;

/** How a caller value reached the object. */
export interface CallerValueProduct {
  /** The event field that states the product, and its value as read (signed when its top bit is set). */
  field: string;
  stated: string;
  /** The other number in the same event it was multiplied by, and the power of ten the product was divided by. */
  factor_field: string;
  factor: string;
  scale_digits: number;
}

/** One caller value stored in a changed shared object and then read. */
export interface CallerValueWrite {
  writer: string;
  command: number;
  object: string;
  /**
   * Every field that holds the value after the transaction, or the event
   * field that stated it. When several fields changed to it, the effects do
   * not say which command wrote which, so all are listed.
   */
  fields: string[];
  value: string;
  /** The value's two's-complement reading, when it reads as a negative number. */
  value_signed?: string;
  /** Set when the value reached the object only multiplied by another number the same event states. */
  product?: CallerValueProduct;
  reader: string;
  reader_command: number;
  /** The lowest and highest non-zero value the field holds within the PTB, when they span {@link CALLER_SWING} or more. */
  span?: [string, string];
  /** The writing call carried a signature-length pure argument. */
  signed: boolean;
  line: string;
}

/**
 * The objects each call operates on: the ones it takes as arguments, and
 * every object that reached it inside an earlier command's result (a
 * session or a hot potato wrapping a shared object, a returned object).
 */
function objectsReaching(tx: Pick<AttackTx, "calls" | "inputs" | "vectors">): Map<number, Set<string>> {
  const inputs = tx.inputs ?? [];
  const reach = new Map<number, Set<string>>();
  const steps = [
    ...tx.calls.map((c) => ({ command: c.command, args: c.args, own: c.objectArgs })),
    ...(tx.vectors ?? []).map((v) => ({ command: v.command, args: v.elements, own: [] as string[] })),
  ].sort((x, y) => x.command - y.command);
  for (const s of steps) {
    const set = new Set<string>();
    for (const raw of s.own) {
      const id = canonicalId(raw);
      if (id) set.add(id);
    }
    for (const a of s.args) {
      if ("result" in a) for (const id of reach.get(a.result) ?? []) set.add(id);
      if ("input" in a) {
        const id = canonicalId(inputs[a.input]?.objectId);
        if (id) set.add(id);
      }
    }
    reach.set(s.command, set);
  }
  return reach;
}

const POW10 = Array.from({ length: MAX_SCALE_DIGITS + 1 }, (_, k) => 10n ** BigInt(k));
const abs = (x: bigint) => (x < 0n ? -x : x);

/** log10 of a bigint's magnitude, from its leading 15 digits. */
function log10Abs(x: bigint): number {
  const d = abs(x).toString();
  return Math.log10(Number(d.slice(0, 15))) + Math.max(0, d.length - 15);
}

/**
 * The product search compares at most this many (stated number, factor,
 * caller value) triples per transaction. A pair that could match is found by
 * floating-point logarithms first and confirmed in integers, so a triple
 * costs a few float operations: the cap adds at most about 0.4 s to a
 * transaction (measured on a 500-call, 500-event batch, where the whole
 * search had taken 16 s) however many calls and events a PTB carries.
 */
export const MAX_PRODUCT_CHECKS = 8_000_000;

/** One stated number and one factor of an event, with the logarithm of their ratio. */
interface ProductPair {
  field: string;
  stated: bigint;
  factorField: string;
  factor: bigint;
  logRatio: number;
}

/**
 * An event's candidate (stated, factor) pairs for {@link productMatch}: the
 * stated number {@link PRODUCT_MIN} or more in magnitude, the factor
 * {@link CALLER_VALUE_MIN} or more and not a power of ten (a scale
 * multiplies nothing), and another number than the one stated. Every
 * plausible reading counts ({@link signedReadings}).
 */
function productPairs(nums: Map<string, string>): ProductPair[] {
  const entries = [...nums].map(([name, s]) => ({ name, raw: BigInt(s), readings: signedReadings(BigInt(s)) }));
  const out: ProductPair[] = [];
  for (const x of entries) {
    for (const stated of x.readings) {
      if (abs(stated) < PRODUCT_MIN) continue;
      for (const q of entries) {
        if (q.raw === x.raw) continue;
        for (const factor of q.readings) {
          if (abs(factor) < CALLER_VALUE_MIN || POW10.includes(abs(factor))) continue;
          out.push({ field: x.name, stated, factorField: q.name, factor, logRatio: log10Abs(stated) - log10Abs(factor) });
        }
      }
    }
  }
  return out;
}

/**
 * A number an event states that equals a caller value times another number
 * of the same event, divided by a power of ten, within one unit: `fee ×
 * notional / 10^18`. The signs must agree. The caller value must be
 * {@link CALLER_VALUE_MIN} or more in magnitude and not a positive power of
 * ten, since multiplying by a scale converts units and carries no choice (a
 * negative one flips the sign), and it may not equal the stated number. A
 * match within one unit of a number of 2^32 or more puts the logarithms
 * within 1e-9 of an integer apart, so pairs are filtered on that before the
 * integer check. `budget.left` counts the triples still allowed; at zero the
 * search stops and `budget.capped` is set.
 */
function productMatch(value: bigint, pairs: ProductPair[], budget: { left: number; capped: boolean }): CallerValueProduct | null {
  const readings = signedReadings(value).filter((v) => abs(v) >= CALLER_VALUE_MIN && !POW10.includes(v));
  if (!readings.length) return null;
  const logs = readings.map(log10Abs);
  for (const pr of pairs) {
    for (let i = 0; i < readings.length; i++) {
      if (budget.left-- <= 0) {
        budget.capped = true;
        return null;
      }
      const v = readings[i];
      if (v === pr.stated || (v < 0n) !== (pr.factor < 0n) !== (pr.stated < 0n)) continue;
      const k = Math.round(logs[i] - pr.logRatio);
      if (k < 0 || k > MAX_SCALE_DIGITS || Math.abs(logs[i] - pr.logRatio - k) > 1e-7) continue;
      if (abs((v * pr.factor) / POW10[k] - pr.stated) <= 1n) {
        return { field: pr.field, stated: pr.stated.toString(), factor_field: pr.factorField, factor: pr.factor.toString(), scale_digits: k };
      }
    }
  }
  return null;
}

/**
 * A value the caller chose, written into a shared object the transaction
 * changed, then read by a later call in the same PTB. The chain:
 *
 * - a call operates on a changed shared object, taken directly or inside an
 *   earlier command's result ({@link objectsReaching}), and takes a
 *   caller-chosen value ({@link callerDerived});
 * - the object stores that value: its output version has fields that
 *   changed to it, or an event naming the object states it in a field that
 *   tracks the object's own (an oracle's `PriceEvent { id, price }` for a
 *   `price` field). A field tracks the object when the last value any event
 *   states for it is the value the object holds after the transaction,
 *   whether or not that value changed: a set, a use and a restore to the
 *   prior value leaves the field unchanged, and its events still show the
 *   caller's value in between. An event echoing a delta (`liquidity` added,
 *   `amount_in`) fails this. When the object's state was not read, any event
 *   naming it with the value counts. Failing both, an event naming the
 *   object states the value multiplied by another of its numbers
 *   ({@link productMatch}): the value reached the object's accounting
 *   through arithmetic;
 * - a later command operates on the object.
 *
 * A pull-oracle refresh passes the price as an object (Pyth's
 * `PriceInfoObject`) and does not match. A keeper setting a price and
 * settling against it does, and so does a swap that stops at the caller's
 * price limit; `swing` marks the manipulation shape, where the values the
 * field holds across the PTB (before, each write, after) span
 * {@link CALLER_SWING} or more.
 */
export function callerValueWrites(
  tx: Pick<AttackTx, "calls" | "events" | "inputs" | "vectors" | "objects">,
  state: StateSnapshot | undefined,
  search: { capped: boolean; limit?: number } = { capped: false },
): CallerValueWrite[] {
  const shared = sharedObjectsOf(tx);
  const derived = callerDerived(tx);
  const reach = objectsReaching(tx);
  const inputs = tx.inputs ?? [];
  const states = new Map((state?.objects ?? []).filter((o) => o.role === "shared").map((o) => [normalizeSuiAddress(o.objectId), o]));
  const hits: CallerValueWrite[] = [];
  // The same value and event recur across writers and objects; an event's
  // candidate pairs are built once.
  const products = new Map<string, CallerValueProduct | null>();
  const pairsOf = new Map<number, ProductPair[]>();
  const budget = { left: search.limit ?? MAX_PRODUCT_CHECKS, capped: false };
  const seen = new Set<string>();
  for (const w of tx.calls) {
    if (derived.has(w.command)) continue;
    const values = new Set<string>();
    for (const a of w.args) {
      if ("input" in a && inputs[a.input]?.objectId === null) for (const v of inputs[a.input].values) values.add(v);
      if ("result" in a) for (const v of derived.get(a.result) ?? []) values.add(v);
    }
    if (!values.size) continue;
    const signed = w.pureArgs.some((p) => p.bytes >= SIGNED_PAYLOAD_BYTES);
    for (const id of reach.get(w.command) ?? []) {
      if (!shared.has(id)) continue;
      const user = tx.calls.find((c) => c.command > w.command && reach.get(c.command)?.has(id));
      if (!user) continue;
      const st = states.get(id);
      const before = st?.before ? numericFields(st.before) : null;
      const after = st?.after ? numericFields(st.after) : null;
      const naming = tx.events.flatMap((e) => {
        const o = asRecord(e.json);
        return o && eventObjectIds(o).includes(id) ? [{ e, nums: eventNumbers(o) }] : [];
      });
      // With the state read, an event confirms a write only in a field that
      // tracks the object's own: the last value any event states for it is
      // the value the object holds after the transaction.
      const tracked = after
        ? new Set(
            [...after]
              .map(([p, x]) => ({ name: p.split(".")[0], x: x.toString() }))
              .filter(({ name, x }) => naming.filter((n) => n.nums.has(name)).at(-1)?.nums.get(name) === x)
              .map(({ name }) => name),
          )
        : null;
      // A value equal to what an unchanged field held throughout, with no
      // event stating another value for it, wrote nothing. A round trip
      // (set, use, restore) shows a different value in between.
      const heldThroughout = (name: string, v: string) =>
        !!after &&
        !!before &&
        [...after].some(([p, x]) => p.split(".")[0] === name && x.toString() === v && before.get(p) === x) &&
        naming.every((n) => !n.nums.has(name) || n.nums.get(name) === v);
      for (const v of values) {
        const k = `${w.command} ${id} ${v}`;
        if (seen.has(k)) continue;
        let fields: string[] = [];
        let how = "";
        let product: CallerValueProduct | null = null;
        if (after && before) {
          const paths = [...after].filter(([p, x]) => x.toString() === v && !st?.balances[p] && before.get(p)?.toString() !== v).map(([p]) => p);
          if (paths.length) {
            fields = [...new Set(paths.map((p) => p.split(".")[0]))];
            how =
              paths.length === 1
                ? `its ${paths[0]} holds it after the transaction`
                : `its ${paths.join(" and ")} hold it after the transaction (the effects do not say which command wrote which)`;
          }
        }
        if (!fields.length) {
          for (const { e, nums } of naming) {
            const name = [...nums].find(([n, x]) => x === v && (!tracked || tracked.has(n)) && !heldThroughout(n, v))?.[0];
            if (!name) continue;
            fields = [name];
            how = `event ${e.index} (${shortEventType(e.type)}) states it as ${name}`;
            break;
          }
        }
        if (!fields.length) {
          for (const { e, nums } of naming) {
            const key = `${e.index} ${v}`;
            if (!pairsOf.has(e.index)) pairsOf.set(e.index, productPairs(nums));
            if (!products.has(key) && !budget.capped) products.set(key, productMatch(BigInt(v), pairsOf.get(e.index)!, budget));
            product = products.get(key) ?? null;
            if (!product) continue;
            fields = [product.field];
            how = `event ${e.index} (${shortEventType(e.type)}) states ${product.field} ${product.stated}, which is this value times its ${product.factor_field} ${product.factor}${product.scale_digits ? ` / 10^${product.scale_digits}` : ""}`;
            break;
          }
        }
        if (!fields.length) continue;
        seen.add(k);
        const series = [BigInt(v)];
        if (!product) {
          for (const { nums } of naming) {
            for (const f of fields) {
              const x = nums.get(f);
              if (x !== undefined) series.push(BigInt(x));
            }
          }
          for (const f of fields) {
            const prior = before?.get(f) ?? before?.get(`${f}.value`);
            if (prior !== undefined) series.push(prior);
          }
        }
        const nonzero = series.filter((x) => x > 0n);
        const lo = nonzero.reduce((m, x) => (x < m ? x : m), nonzero[0] ?? 0n);
        const hi = nonzero.reduce((m, x) => (x > m ? x : m), 0n);
        const swing = !product && lo > 0n && hi >= lo * CALLER_SWING;
        if (!swing && !product && BigInt(v) < CALLER_VALUE_MIN) continue;
        const negative = signedReading(v);
        hits.push({
          writer: `${w.module}::${w.function}`,
          command: w.command,
          object: id,
          fields,
          value: v,
          ...(negative ? { value_signed: negative } : {}),
          ...(product ? { product } : {}),
          reader: `${user.module}::${user.function}`,
          reader_command: user.command,
          ...(swing ? { span: [lo.toString(), hi.toString()] as [string, string] } : {}),
          signed,
          line:
            `${w.module}::${w.function} (command ${w.command}) wrote ${v}${negative ? ` (${negative} as a signed 256-bit integer)` : ""}, a value the caller passed, into ${id}: ${how}; ` +
            `${user.module}::${user.function} (command ${user.command}) then took it` +
            (swing ? `; ${fields.join(", ")} spans ${lo} to ${hi} within this PTB` : "") +
            (signed ? "; the writing call also carried a signature-length argument" : ""),
        });
      }
    }
  }
  search.capped = budget.capped;
  return hits;
}

/** Every check {@link tradeAnomalies} and the value reconciliation run, with the rule each applies. */
export const TRADE_CHECKS: readonly CheckRun[] = [
  {
    code: "caller-value-used",
    rule: `a value from a pure input, or from a call built only from pure inputs, is stored in a changed shared object the call operates on, directly or inside an earlier result (its output state, or an event field that tracks the object's own, a set-use-restore included), or an event naming the object states it multiplied by another number of that event over a power of ten (at most ${MAX_PRODUCT_CHECKS.toLocaleString("en-US")} such comparisons per transaction, a stop stated), and a later call operates on that object; high when the field's values span 10x within the PTB, medium otherwise, one step lower when the writing call carries a signature-length argument`,
  },
  {
    code: "outsized-mint",
    rule: `a liquidity event credits more liquidity than its amounts buy on its own tick range at any price, or an event mints a share of an object's Supply<T> more than ${SHARE_MINT_FACTOR}x the largest share of the object's own holdings its deposits make up (high)`,
  },
  {
    code: "shared-state-jump",
    rule: `a changed shared object read at its input and output versions: a stored number moves ${STATE_JUMP_FACTOR}x or more, its Balance<T> holdings of a coin fall ${STATE_JUMP_FACTOR}x or to zero, a holder loses ${VALUE_SHARE_LOST * 100}% or more of its priced value while addresses gain at least half of it, or an object takes a number from an object other than the one it references; high for a caller's value, a drain at least half of whose USD addresses gained in any coin, or a wrong source; medium for another jump; info for a holding drained into other objects or converted by its holder at 90% or more of its value`,
  },
  {
    code: "unreconciled-gain",
    rule: "coins reaching addresses are worth more than decoded pool and vault events and the read objects' balances and mints paid out, or include an unpriced coin nothing read paid out (info)",
  },
];

/**
 * Anomalies that need the events, the call arguments or the objects' state,
 * which `flagPtbAnomalies` does not see. `state` is the transaction's objects
 * at their input and output versions (`state-read.ts`); without it the state
 * rule does not run and the caller-value rule confirms writes from events
 * alone. `prices` lets the state rule value a drain against what addresses
 * gained and what the holder took back.
 */
export function tradeAnomalies(
  tx: Pick<AttackTx, "calls" | "events" | "inputs" | "vectors" | "objects" | "balanceChanges">,
  state?: StateSnapshot,
  flows: PoolFlow[] = poolFlows(tx),
  prices?: Map<string, PricePoint>,
): PtbAnomaly[] {
  const out: PtbAnomaly[] = [];
  const search = { capped: false };
  const writes = callerValueWrites(tx, state, search);
  const cappedNote = search.capped
    ? ` The search for a caller value multiplied into an event's numbers stopped after ${MAX_PRODUCT_CHECKS.toLocaleString("en-US")} comparisons, so values past that point were not tested that way.`
    : "";
  if (search.capped && writes.length === 0) {
    out.push({
      severity: "info",
      code: "caller-value-used",
      title: "No caller value was found stored in a shared object; the product search stopped at its cap",
      detail: `No write matched.${cappedNote} A check that stopped early clears nothing.`,
      evidence: [],
    });
  }
  if (writes.length > 0) {
    const grade = (h: CallerValueWrite) => (h.span ? 0 : 1) + (h.signed ? 1 : 0);
    const best = Math.min(...writes.map(grade));
    const swings = writes.filter((w) => w.span).length;
    const ranked = [...writes].sort((x, y) => grade(x) - grade(y)).map((w) => w.line);
    out.push({
      severity: best === 0 ? "high" : best === 1 ? "medium" : "info",
      code: "caller-value-used",
      title:
        `Writes a value the caller passed into a shared object, then uses that object in the same PTB (${writes.length} write${writes.length === 1 ? "" : "s"})` +
        (swings ? `; ${swings} span ${CALLER_SWING}x or more` : ""),
      detail:
        `A number the transaction passed in as a pure argument, directly or through calls built only from pure arguments, ends up stored in a shared object the transaction changed (or, multiplied by another number an event naming the object states, in that object's accounting), and a later call takes that object. Whoever can make the writing call chooses the value the next call trades, lends or mints at. High when the values that field holds across the PTB (before, each write, after) span ${CALLER_SWING}x or more; medium otherwise, which is also how a keeper's set-and-settle and a swap stopping at the caller's price limit read. A signature-length argument on the writing call lowers the grade by one step and does not clear it. Every write is in caller_value_writes. Read the writing function's checks with get_move_function and disassemble_module.`,
      evidence: [...(ranked.length > 10 ? [...ranked.slice(0, 9), `${ranked.length - 9} more writes in caller_value_writes`] : ranked), ...(cappedNote ? [cappedNote.trim()] : [])],
      commands: [...new Set(writes.flatMap((w) => [w.command, w.reader_command]))].sort((a, b) => a - b),
    });
  }
  const mints = [...outsizedMints(tx.events, eventTargetsOf(tx)), ...(state ? outsizedShareMints(tx, state) : [])];
  if (mints.length > 0) {
    out.push({
      severity: "high",
      code: "outsized-mint",
      title: `Credits more liquidity or shares than its amounts can buy: ${mints.length} event${mints.length === 1 ? "" : "s"}`,
      detail:
        "A liquidity event states a liquidity delta that no price inside or outside its tick range makes consistent with the amounts it moved, even allowing one raw unit of rounding per coin; or an event mints a share of an object's share supply far larger than the share of the object's holdings its deposits make up, where a proportional mint issues at most the deposit's share. The amount charged or credited was computed wrong, or computed against numbers the holdings do not back. Read the function that computed it with get_move_function and disassemble_module.",
      evidence: mints.slice(0, 10),
    });
  }
  if (state) {
    const s = stateAnomaly(compareStates(tx, state, flows, prices), state);
    if (s) out.push(s);
  }
  return out;
}

export interface ValueReconciliation {
  /** USD of the coins that reached addresses: per coin, the sum of every address's change, where positive. */
  reached_addresses_usd: number;
  /** USD the decoded pool and vault events account for: coins those objects paid out on net, plus losses they stated in USD. */
  decoded_usd: number;
  /** USD the read state accounts for: coins the read objects' `Balance<T>` holdings paid out on net, plus what their `Supply<T>` totals minted. Null when no state was read. */
  state_usd: number | null;
  /** Per coin, what reached addresses beyond what either the decoded events or the read state account for. */
  unexplained: Array<{ coin_type: string; amount: string; usd: number | null }>;
  /** USD of the priced coins in `unexplained`. */
  unexplained_usd: number;
  /** Coins in `unexplained` with no price: counted here, never valued at zero. */
  unexplained_unpriced: number;
  /** Changed objects the state read left out (past a read cap, a field whose layout could not be read, or no node returned them): what is unexplained may have come from them. */
  objects_unread: number;
}

/** Canonical coin type, or the input when it does not parse. */
function coinKey(t: string): string {
  try {
    return normalizeStructTag(t);
  } catch {
    return t;
  }
}

/**
 * Compare what reached addresses with what the decoded pools and vaults, and
 * the read objects' holdings and mints, paid out. Coins moving between addresses
 * cancel in the per-coin sum, and a coin passing through several pools of a
 * route cancels in the pools' sum, so what remains on the address side is
 * value that left objects (or was minted), and what remains on the object
 * side is what their events, or their `Balance<T>` fields, say left them.
 * The events and the state can describe the same outflow, so per coin the
 * larger of the two explains it.
 */
export function reconcileValue(
  tx: Pick<AttackTx, "balanceChanges">,
  flows: PoolFlow[],
  prices: Map<string, PricePoint>,
  state?: StateSnapshot,
): ValueReconciliation {
  const reached = new Map<string, bigint>();
  for (const c of tx.balanceChanges) {
    if (/^-?\d+$/.test(c.amount)) reached.set(coinKey(c.coinType), (reached.get(coinKey(c.coinType)) ?? 0n) + BigInt(c.amount));
  }
  const poolOut = new Map<string, bigint>();
  for (const f of flows) for (const [coin, d] of f.deltas) if (isCoinTypeKey(coin)) poolOut.set(coinKey(coin), (poolOut.get(coinKey(coin)) ?? 0n) - d);
  const stateOut = new Map<string, bigint>(state ? mintedTotals(state) : []);
  for (const h of state ? holdingTotals(state) : []) stateOut.set(h.coin, (stateOut.get(h.coin) ?? 0n) + h.before - h.after);
  const usd = (coin: string, raw: bigint): number | null => {
    const point = prices.get(coin);
    return point ? toHumanAmount(raw, pricingScale(coin, point).decimals) * point.price * (raw < 0n ? -1 : 1) : null;
  };
  const stated = flows.reduce((s, f) => s + Math.max(0, f.recorded_loss_usd ?? 0), 0);
  let reachedUsd = 0;
  let decodedUsd = stated;
  let stateUsd = 0;
  let unexplainedUsd = 0;
  const unexplained: ValueReconciliation["unexplained"] = [];
  const cap = (x: bigint, max: bigint) => (x < 0n ? 0n : x > max ? max : x);
  for (const [coin, amount] of reached) {
    if (amount <= 0n) continue;
    const byEvents = cap(poolOut.get(coin) ?? 0n, amount);
    const byState = cap(stateOut.get(coin) ?? 0n, amount);
    reachedUsd += usd(coin, amount) ?? 0;
    decodedUsd += usd(coin, byEvents) ?? 0;
    stateUsd += usd(coin, byState) ?? 0;
    const left = amount - (byEvents > byState ? byEvents : byState);
    if (left <= 0n) continue;
    const v = usd(coin, left);
    unexplained.push({ coin_type: coin, amount: left.toString(), usd: v === null ? null : Number(v.toFixed(2)) });
    unexplainedUsd += v ?? 0;
  }
  return {
    reached_addresses_usd: Number(reachedUsd.toFixed(2)),
    decoded_usd: Number(decodedUsd.toFixed(2)),
    state_usd: state ? Number(stateUsd.toFixed(2)) : null,
    unexplained: unexplained.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)),
    unexplained_usd: Number(Math.max(0, unexplainedUsd - stated).toFixed(2)),
    unexplained_unpriced: unexplained.filter((u) => u.usd === null).length,
    objects_unread: state ? state.skipped.length + state.unavailable.length : 0,
  };
}

/**
 * The `unreconciled-gain` anomaly, graded info: value reached addresses
 * that neither a decoded event nor a read object's holdings account for,
 * worth `thresholdUsd` or more, or in any coin with no price (a receipt or
 * LP coin minted by an object that was not read). A withdrawal from an
 * object past the read cap, or from funds kept where no `Balance<T>` field
 * shows them, reads the same way.
 */
export function reconciliationAnomaly(r: ValueReconciliation, thresholdUsd: number): PtbAnomaly | null {
  if (r.unexplained_usd < thresholdUsd && r.unexplained_unpriced === 0) return null;
  const parts = [
    ...(r.unexplained_usd >= thresholdUsd ? [`coins worth ${r.unexplained_usd} USD`] : []),
    ...(r.unexplained_unpriced ? [`${r.unexplained_unpriced} unpriced coin${r.unexplained_unpriced === 1 ? "" : "s"}`] : []),
  ];
  return {
    severity: "info",
    code: "unreconciled-gain",
    title: `${parts.join(" and ").replace(/^./, (c) => c.toUpperCase())} reached addresses beyond what decoded events and read object holdings paid out`,
    detail:
      "Summed per coin over every address, value entered the address side of this transaction that neither the decoded pool, vault and liquidity events nor the Balance<T> holdings and Supply<T> mints of the objects read in state_deltas account for. The source is an object that was not read, or one holding funds outside a Balance<T> field. Read the changed objects with get_object at the transaction's versions." +
      (r.objects_unread ? ` ${r.objects_unread} changed object(s) were not read (state_deltas.skipped and unavailable), so this can come from the read caps alone.` : ""),
    evidence: r.unexplained
      .slice(0, 8)
      .map((u) => `${u.amount} raw ${u.coin_type} reached addresses with nothing read paying it out${u.usd !== null ? ` (${u.usd} USD)` : " (unpriced)"}`),
  };
}

/* ------------------------------------------------------------------ *
 * Incident: many transactions, grouped by the pool they drained
 * ------------------------------------------------------------------ */

export interface IncidentGroup {
  /** One pool, or several when a transaction touched more than one. */
  pools: string[];
  pool_type: string | null;
  /** `events`: `pool_deltas` summed from the pools' own events. `state`: from their `Balance<T>` holdings at each transaction's input and output versions. */
  basis: "events" | "state";
  digests: string[];
  /** The attacker's net balance change across these transactions. */
  attacker_deltas: Map<string, bigint>;
  /** Reserve change of the pool(s). Negative is drained. */
  pool_deltas: Map<string, bigint>;
  /** Sum of `PoolFlow.recorded_loss_usd` across these transactions' pools. */
  recorded_loss_usd?: number;
}

/** Coins the attacker paid to other addresses in a coin that moved only between addresses in that transaction. */
export interface TransferOut {
  digest: string;
  coin: string;
  /** Raw amount sent, positive. */
  amount: bigint;
  /** Every other address that gained this coin in the transaction, with its gain. */
  to: Array<{ address: string; amount: bigint }>;
}

/** What one transaction's shared objects paid out, read from their holdings. */
export interface StateLoss {
  /** Holders whose `Balance<T>` holdings of at least one coin fell. */
  pools: string[];
  pool_types: Map<string, string | null>;
  /** Net change of those holders' holdings per coin. Negative is paid out. */
  deltas: Map<string, bigint>;
}

/**
 * The holders a transaction's state read shows paying out: every holder
 * whose holdings of some coin fell, with the net change of all its coins.
 * Null when no holding fell.
 */
export function stateLossOf(snap: StateSnapshot): StateLoss | null {
  const totals = holdingTotals(snap);
  const fell = new Set(totals.filter((h) => h.after < h.before).map((h) => h.holder));
  if (fell.size === 0) return null;
  const deltas = new Map<string, bigint>();
  for (const h of totals) if (fell.has(h.holder) && h.after !== h.before) deltas.set(h.coin, (deltas.get(h.coin) ?? 0n) + h.after - h.before);
  const typeOf = new Map(snap.objects.map((o) => [normalizeSuiAddress(o.objectId), o.objectType]));
  const pools = [...fell].sort();
  return { pools, pool_types: new Map(pools.map((p) => [p, typeOf.get(p) ?? null])), deltas };
}

/**
 * Whether a transaction's losses have to come from state: it succeeded,
 * changed a shared object other than a framework singleton, and no event
 * of it decoded into a pool's coin amounts.
 */
export function needsStateLoss(tx: Pick<AttackTx, "success" | "events" | "objects">, flows: PoolFlow[] = poolFlows(tx)): boolean {
  if (!tx.success || flows.some((f) => f.deltas.size > 0 || f.recorded_loss_usd)) return false;
  return tx.objects.some((o) => o.shared && !isSystemObject(o.objectId));
}

/**
 * The subject's side of one transaction, split into what it sent on and the
 * rest. A coin moved only between addresses when every address's change in
 * it sums to zero (for SUI, to minus the gas paid): no object took any in or
 * paid any out. The subject's outflow in such a coin is a transfer to the
 * addresses that gained it, not a loss to the incident. A gain is never split
 * off: a drained wallet pays its thief the same way.
 */
function splitTransfers(tx: AttackTx, all: Map<string, Map<string, bigint>>, subject: string): { take: Map<string, bigint>; sent: TransferOut[] } {
  const mine = all.get(subject) ?? new Map<string, bigint>();
  const take = new Map(mine);
  const sent: TransferOut[] = [];
  for (const [coin, amount] of mine) {
    if (amount >= 0n) continue;
    const isSui = coin === SUI_COIN_TYPE;
    if (isSui && !tx.gas) continue;
    let sum = isSui ? tx.gas!.net : 0n;
    const to: TransferOut["to"] = [];
    for (const [address, deltas] of all) {
      const v = deltas.get(coin) ?? 0n;
      sum += v;
      if (address !== subject && v > 0n) to.push({ address, amount: v });
    }
    if (sum !== 0n || to.length === 0) continue;
    const ownGas = isSui && canonicalId(tx.gas!.payer) === subject ? tx.gas!.net : 0n;
    const received = to.reduce((s, t) => s + t.amount, 0n);
    const out = -amount - ownGas;
    const moved = out < received ? out : received;
    if (moved <= 0n) continue;
    take.set(coin, amount + moved);
    sent.push({ digest: tx.digest, coin, amount: moved, to: to.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)) });
  }
  return { take, sent };
}

export interface IncidentAggregate {
  groups: IncidentGroup[];
  /** Attacker net per coin, across every transaction, transfers out excluded. */
  totals: Map<string, bigint>;
  /** What the attacker sent on to other addresses, kept out of `totals` and the groups. */
  transfers_out: TransferOut[];
  failed: string[];
  /** Successful transactions whose pools could not be identified, and that sent nothing on. */
  unattributed: string[];
  senders: string[];
}

/**
 * Group the attacker's balance changes by the pool each transaction touched.
 *
 * The attacker is `attacker` when given, otherwise each transaction's sender.
 * A transaction touching several pools cannot have one balance change split
 * between them, so it is grouped under the set; the pool-side deltas from
 * events still say what each pool lost. A transaction no event decodes for
 * is grouped by `stateLosses`, the holders its state read shows paying out.
 * Coins the attacker sent on to other addresses are kept out of every sum
 * ({@link splitTransfers}) and listed in `transfers_out`.
 */
export function aggregateIncident(txs: AttackTx[], attacker?: string, stateLosses?: ReadonlyMap<string, StateLoss>): IncidentAggregate {
  const who = attacker ? canonicalId(attacker) : null;
  const groups = new Map<string, IncidentGroup>();
  const totals = new Map<string, bigint>();
  const transfers: TransferOut[] = [];
  const failed: string[] = [];
  const unattributed: string[] = [];
  const senders = new Set<string>();

  for (const tx of txs) {
    const sender = canonicalId(tx.sender);
    if (sender) senders.add(sender);
    const subject = who ?? sender;
    const all = netByAddress(tx.balanceChanges);
    const { take: mine, sent } = subject && tx.success ? splitTransfers(tx, all, subject) : { take: subject ? all.get(subject) ?? new Map<string, bigint>() : new Map<string, bigint>(), sent: [] };
    addDeltas(totals, mine);
    transfers.push(...sent);
    if (!tx.success) {
      failed.push(tx.digest);
      continue;
    }
    const flows = poolFlows(tx);
    const fromState = needsStateLoss(tx, flows) ? stateLosses?.get(tx.digest) : undefined;
    const pools = fromState ? fromState.pools : poolsTouched(tx, flows).sort();
    if (pools.length === 0) {
      if (sent.length === 0) unattributed.push(tx.digest);
      continue;
    }
    const basis = fromState ? "state" : "events";
    const key = `${basis}:${pools.join("+")}`;
    let g = groups.get(key);
    if (!g) {
      const poolType = pools.length === 1
        ? fromState
          ? fromState.pool_types.get(pools[0]) ?? null
          : tx.objects.find((o) => canonicalId(o.objectId) === pools[0])?.objectType ?? null
        : null;
      g = { pools, pool_type: poolType, basis, digests: [], attacker_deltas: new Map(), pool_deltas: new Map() };
      groups.set(key, g);
    }
    g.digests.push(tx.digest);
    addDeltas(g.attacker_deltas, mine);
    if (fromState) addDeltas(g.pool_deltas, fromState.deltas);
    else {
      for (const f of flows) {
        addDeltas(g.pool_deltas, f.deltas);
        if (f.recorded_loss_usd) g.recorded_loss_usd = (g.recorded_loss_usd ?? 0) + f.recorded_loss_usd;
      }
    }
  }
  return { groups: [...groups.values()], totals, transfers_out: transfers, failed, unattributed, senders: [...senders] };
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
 * leaves out. Keys that are not coin types ({@link isCoinTypeKey}) are
 * unpriced by construction: `A`/`B` (a pool whose type was not read) with no
 * scale, and Nemo's PT at the scale of the SY coin it is denominated in.
 */
export function valueDeltas(deltas: Map<string, bigint>, prices: Map<string, PricePoint>): ValuedDeltas {
  const coins: ValuedCoin[] = [];
  let net = 0;
  let gained = 0;
  const unpriced: string[] = [];
  for (const [coinType, raw] of deltas) {
    if (raw === 0n) continue;
    const isCoin = isCoinTypeKey(coinType);
    const ptOf = /^PT<(.+)>$/.exec(coinType)?.[1];
    const point = isCoin ? prices.get(coinType) : undefined;
    const scale = isCoin ? pricingScale(coinType, point) : ptOf ? pricingScale(ptOf) : { decimals: 0, source: "assumed" as const };
    const coin = isCoin
      ? displayCoin(coinType)
      : ptOf
        ? { symbol: `PT of ${displayCoin(ptOf).symbol} (a position balance, not a coin)`, verified: null }
        : { symbol: `coin ${coinType} (pool type not read)`, verified: null };
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
