/**
 * Concentrated-liquidity (CLMM) positions: coin amounts from a position's
 * liquidity and tick range at the pool's current sqrt price, with the tick
 * math the Cetus family and its forks share.
 *
 * One rule covers every family whose position JSON carries a pool reference,
 * a liquidity and an I32 `{bits}` tick range, and whose pool carries a Q64.64
 * sqrt price and a current tick. A family is valued only once its own tick
 * math and removal amounts have been checked against this code; other
 * positions of that shape are listed as unread.
 */

import type { SuiClientTypes } from "@mysten/sui/client";
import { bcs } from "@mysten/sui/bcs";
import { deriveDynamicFieldID, normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";
import { sui } from "../../clients/grpc.js";
import { prefetchPackageRoots } from "../../protocols/package-roots.js";
import { lookupProtocol } from "../../protocols/registry.js";
import { normalizeCoinType } from "../coin-registry.js";
import { listOwnedWithJson } from "../owned-objects.js";
import {
  registerValuer,
  type ObjectToValue,
  type ValuationContext,
  type ValuedPosition,
  type ValuerResult,
} from "../position-value.js";
import { assemblePosition, bigField, priceCoinTypes, readObjects, stateNote, type Leg, type ObjectState } from "./common.js";

// ---------------------------------------------------------------------------
// Tick math, as the Cetus clmm `tick_math` module computes it
// ---------------------------------------------------------------------------

export const Q64 = 1n << 64n;
export const MAX_TICK = 443636;
export const MIN_TICK = -MAX_TICK;
export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673515401279992447579055n;

/** Q64 factors for |tick| bits 1..18 of a negative tick, applied with `mul_shr(_, _, 64)`. */
const NEG_FACTORS = [
  18444899583751176498n, 18443055278223354162n, 18439367220385604838n, 18431993317065449817n,
  18417254355718160513n, 18387811781193591352n, 18329067761203520168n, 18212142134806087854n,
  17980523815641551639n, 17526086738831147013n, 16651378430235024244n, 15030750278693429944n,
  12247334978882834399n, 8131365268884726200n, 3584323654723342297n, 696457651847595233n,
  26294789957452057n, 37481735321082n,
];
/** Q96 factors for tick bits 1..18 of a positive tick, applied with `mul_shr(_, _, 96)`. */
const POS_FACTORS = [
  79236085330515764027303304731n, 79244008939048815603706035061n, 79259858533276714757314932305n,
  79291567232598584799939703904n, 79355022692464371645785046466n, 79482085999252804386437311141n,
  79736823300114093921829183326n, 80248749790819932309965073892n, 81282483887344747381513967011n,
  83390072131320151908154831281n, 87770609709833776024991924138n, 97234110755111693312479820773n,
  119332217159966728226237229890n, 179736315981702064433883588727n, 407748233172238350107850275304n,
  2098478828474011932436660412517n, 55581415166113811149459800483533n,
  38992368544603139932233054999993551n,
];

/**
 * sqrt(1.0001^tick) in Q64.64, bit for bit as `tick_math::get_sqrt_price_at_tick`:
 * a negative tick multiplies Q64 factors, a positive one Q96 factors and
 * shifts the result right by 32. Each step floors.
 */
export function sqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick ${tick} is outside [${MIN_TICK}, ${MAX_TICK}]`);
  const abs = Math.abs(tick);
  if (tick < 0) {
    let r = abs & 1 ? 18445821805675392311n : Q64;
    NEG_FACTORS.forEach((f, i) => {
      if (abs & (2 << i)) r = (r * f) >> 64n;
    });
    return r;
  }
  let r = abs & 1 ? 79232123823359799118286999567n : 79228162514264337593543950336n;
  POS_FACTORS.forEach((f, i) => {
    if (abs & (2 << i)) r = (r * f) >> 96n;
  });
  return r >> 32n;
}

/** Token A for `liquidity` between two sqrt prices: L * |Δ√P| << 64 / (√Pa * √Pb), as `clmm_math::get_delta_a`. */
export function deltaA(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp = false): bigint {
  const diff = sqrtA > sqrtB ? sqrtA - sqrtB : sqrtB - sqrtA;
  if (diff === 0n || liquidity === 0n) return 0n;
  const num = (liquidity * diff) << 64n;
  const den = sqrtA * sqrtB;
  const q = num / den;
  return roundUp && q * den !== num ? q + 1n : q;
}

/** Token B for `liquidity` between two sqrt prices: L * |Δ√P| >> 64, as `clmm_math::get_delta_b`. */
export function deltaB(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp = false): bigint {
  const diff = sqrtA > sqrtB ? sqrtA - sqrtB : sqrtB - sqrtA;
  if (diff === 0n || liquidity === 0n) return 0n;
  const prod = liquidity * diff;
  const q = prod >> 64n;
  return roundUp && (prod & (Q64 - 1n)) !== 0n ? q + 1n : q;
}

/**
 * Coin amounts `liquidity` over [tickLower, tickUpper) is worth at the pool's
 * current tick and sqrt price, rounded down as on removal
 * (`clmm_math::get_amount_by_liquidity(.., false)`): all A below the range,
 * all B at or above its upper tick, both inside.
 */
export function amountsForLiquidity(
  tickLower: number,
  tickUpper: number,
  currentTick: number,
  currentSqrtPrice: bigint,
  liquidity: bigint,
): { a: bigint; b: bigint } {
  if (liquidity === 0n) return { a: 0n, b: 0n };
  if (tickLower >= tickUpper) throw new RangeError(`tick range [${tickLower}, ${tickUpper}) is empty`);
  const lower = sqrtPriceAtTick(tickLower);
  const upper = sqrtPriceAtTick(tickUpper);
  if (currentTick < tickLower) return { a: deltaA(lower, upper, liquidity), b: 0n };
  if (currentTick < tickUpper) {
    return { a: deltaA(currentSqrtPrice, upper, liquidity), b: deltaB(lower, currentSqrtPrice, liquidity) };
  }
  return { a: 0n, b: deltaB(lower, upper, liquidity) };
}

/** A Move `I32 { bits }` as a signed number; null when the value is not one. */
export function i32FromBits(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const bits = Number((v as { bits?: unknown }).bits);
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) return null;
  return bits | 0;
}

// ---------------------------------------------------------------------------
// Families and field shapes
// ---------------------------------------------------------------------------

export const CETUS_POSITION_TYPE = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::Position";
export const BLUEFIN_POSITION_TYPE = "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::position::Position";
export const MOMENTUM_POSITION_TYPE = "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::position::Position";
export const FLOWX_CLMM_POSITION_TYPE = "0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d::position::Position";
export const MAGMA_POSITION_TYPE = "0x4a35d3dfef55ed3631b7158544c6322a23bc434fe4fca1234cb680ce0505f82d::position::Position";
/** A Turbos position is an NFT naming its pool and the position object that holds the liquidity. */
export const TURBOS_POSITION_NFT_TYPE = "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::position_nft::TurbosPositionNFT";

/** Position types whose tick math and removal amounts were checked against this module. */
export const VERIFIED_POSITION_TYPES = [
  CETUS_POSITION_TYPE,
  BLUEFIN_POSITION_TYPE,
  MOMENTUM_POSITION_TYPE,
  FLOWX_CLMM_POSITION_TYPE,
  MAGMA_POSITION_TYPE,
  TURBOS_POSITION_NFT_TYPE,
].map((t) => normalizeStructTag(t));
const VERIFIED = new Set(VERIFIED_POSITION_TYPES);

/** Positions of one type read per owner before the list is reported as truncated. */
const MAX_POSITIONS_PER_TYPE = 1000;
/** Owned objects scanned for CLMM-shaped positions of families not checked here. */
const MAX_SCANNED_OBJECTS = 2000;

function typeKey(type: string): string | null {
  try {
    const tag = parseStructTag(type);
    return normalizeStructTag({ ...tag, typeParams: [] });
  } catch {
    return null;
  }
}

function coinTypeOf(v: unknown): string | null {
  if (typeof v !== "string" || v === "") return null;
  const s = v.startsWith("0x") ? v : `0x${v}`;
  const plain = normalizeCoinType(s);
  if (plain) return plain;
  try {
    return normalizeStructTag(s);
  } catch {
    return null;
  }
}

function idField(v: unknown): string | null {
  return typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? normalizeSuiAddress(v) : null;
}

export interface ClmmPositionFields {
  pool: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  /** Fees the position object itself stores as owed, when it stores them. */
  feesOwed: { a: bigint; b: bigint; field: string } | null;
  /** Rewards the position object stores as owed, by the pool's reward index. */
  rewardsOwed: bigint[];
}

const FEE_OWED_PAIRS: Array<[string, string]> = [
  ["fee_owed_a", "fee_owed_b"],
  ["token_a_fee", "token_b_fee"],
  ["tokens_owed_a", "tokens_owed_b"],
  ["coins_owed_x", "coins_owed_y"],
  ["owed_coin_x", "owed_coin_y"],
];

function rewardsOwedOf(v: unknown): bigint[] {
  if (!Array.isArray(v)) return [];
  return v.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return bigField(o.coins_owed_reward ?? o.amount_owed ?? o.amount_owned) ?? 0n;
  });
}

/**
 * The CLMM fields of a position's JSON: a pool reference (`pool` or
 * `pool_id`), a liquidity and an I32 tick range (`tick_lower_index`/
 * `tick_upper_index` or `lower_tick`/`upper_tick`). `poolOverride` supplies
 * the pool for a position object that does not name it (Turbos).
 */
export function parsePositionFields(json: Record<string, unknown>, poolOverride?: string): ClmmPositionFields | null {
  const pool = poolOverride ?? idField(json.pool) ?? idField(json.pool_id);
  const tickLower = i32FromBits(json.tick_lower_index ?? json.lower_tick);
  const tickUpper = i32FromBits(json.tick_upper_index ?? json.upper_tick);
  const liquidity = bigField(json.liquidity);
  if (!pool || tickLower === null || tickUpper === null || liquidity === null) return null;
  let feesOwed: ClmmPositionFields["feesOwed"] = null;
  for (const [fa, fb] of FEE_OWED_PAIRS) {
    const a = bigField(json[fa]);
    const b = bigField(json[fb]);
    if (a !== null && b !== null) {
      feesOwed = { a, b, field: `${fa}/${fb}` };
      break;
    }
  }
  return { pool, tickLower, tickUpper, liquidity, feesOwed, rewardsOwed: rewardsOwedOf(json.reward_infos) };
}

export interface ClmmPoolFields {
  coinA: string;
  coinB: string;
  sqrtPrice: bigint;
  currentTick: number;
  /** Reward coin types by reward index. */
  rewardCoins: Array<string | null>;
  /** The linked table of per-position records (Cetus family), when the pool keeps one. */
  positionTable: string | null;
  /** What the pool holds of each coin, when its JSON states it; null when not. */
  reserveA: bigint | null;
  reserveB: bigint | null;
}

/** A pool's sqrt price, current tick, coin types (its first two type arguments) and reward coins. */
export function parsePoolFields(type: string, json: Record<string, unknown>): ClmmPoolFields | null {
  let params: string[];
  try {
    params = parseStructTag(type).typeParams.map((p) => (typeof p === "string" ? p : normalizeStructTag(p)));
  } catch {
    return null;
  }
  const coinA = coinTypeOf(params[0]);
  const coinB = coinTypeOf(params[1]);
  const sqrtPrice = bigField(json.current_sqrt_price ?? json.sqrt_price);
  const currentTick = i32FromBits(json.current_tick_index ?? json.tick_index ?? json.tick_current_index);
  if (!coinA || !coinB || sqrtPrice === null || currentTick === null) return null;
  const rewardInfos = Array.isArray(json.reward_infos)
    ? json.reward_infos
    : ((json.rewarder_manager as { rewarders?: unknown } | undefined)?.rewarders ?? []);
  const rewardCoins = (Array.isArray(rewardInfos) ? rewardInfos : []).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return coinTypeOf(o.reward_coin_type ?? o.vault_coin_type ?? o.reward_coin);
  });
  const table = (json.position_manager as { positions?: { id?: unknown } } | undefined)?.positions?.id;
  const reserveA = bigField(json.coin_a ?? json.balance_a ?? json.reserve_a ?? json.reserve_x);
  const reserveB = bigField(json.coin_b ?? json.balance_b ?? json.reserve_b ?? json.reserve_y);
  return { coinA, coinB, sqrtPrice, currentTick, rewardCoins, positionTable: idField(table), reserveA, reserveB };
}

/** Id of a Cetus-family pool's per-position record: the linked-table node keyed by the position id. */
export function positionInfoId(table: string, positionId: string): string {
  return deriveDynamicFieldID(table, "0x2::object::ID", bcs.Address.serialize(positionId).toBytes());
}

export interface PositionInfoFields {
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  fees: { a: bigint; b: bigint };
  rewards: bigint[];
}

/**
 * A Cetus-family pool's own record of a position. Its liquidity and range
 * are what the pool removes and what its `get_position_amounts_v2` reports,
 * and they can differ from the position object's (the pool may cut a
 * record's liquidity without touching the object).
 */
export function parsePositionInfo(json: Record<string, unknown>): PositionInfoFields | null {
  const info = ((json.value as Record<string, unknown> | undefined)?.value ?? null) as Record<string, unknown> | null;
  if (!info) return null;
  const liquidity = bigField(info.liquidity);
  const tickLower = i32FromBits(info.tick_lower_index);
  const tickUpper = i32FromBits(info.tick_upper_index);
  const a = bigField(info.fee_owned_a);
  const b = bigField(info.fee_owned_b);
  if (liquidity === null || tickLower === null || tickUpper === null || a === null || b === null) return null;
  return { liquidity, tickLower, tickUpper, fees: { a, b }, rewards: rewardsOwedOf(info.rewards) };
}

// ---------------------------------------------------------------------------
// Valuing
// ---------------------------------------------------------------------------

/** A position as read: the object that proves it and its JSON. */
interface PositionRead {
  object_id: string;
  type: string;
  json: Record<string, unknown>;
  current: boolean;
}

const protocolName = (type: string): string | null => {
  try {
    return lookupProtocol(parseStructTag(type).address)?.name ?? null;
  } catch {
    return null;
  }
};

/** Value positions of verified families, reading pools (and Turbos position objects) at the valuation checkpoint. */
async function valueReads(reads: PositionRead[], ctx: ValuationContext): Promise<ValuerResult> {
  const unread: ValuerResult["unread"] = [];
  const positions: ValuedPosition[] = [];
  if (reads.length === 0) return { positions, unread };

  // Turbos NFTs point at the position object holding the liquidity.
  const turbos = normalizeStructTag(TURBOS_POSITION_NFT_TYPE);
  const inner = reads.filter((r) => typeKey(r.type) === turbos).map((r) => idField(r.json.position_id)).filter((x): x is string => !!x);
  const pools = reads.map((r) => idField(r.json.pool) ?? idField(r.json.pool_id)).filter((x): x is string => !!x);
  const first = await readObjects([...pools, ...inner], ctx.atCheckpoint, ctx.memo);

  interface Parsed {
    read: PositionRead;
    pos: ClmmPositionFields;
    pool: ClmmPoolFields;
    poolState: ObjectState;
    current: boolean;
    infoId: string | null;
  }
  const parsed: Parsed[] = [];
  for (const read of reads) {
    let posJson = read.json;
    let current = read.current;
    let poolOverride: string | undefined;
    if (typeKey(read.type) === turbos) {
      const innerId = idField(read.json.position_id);
      const innerState = innerId ? first.get(innerId) : undefined;
      if (!innerState) {
        unread.push({ what: read.object_id, reason: `Turbos position object ${innerId ?? "(no position_id)"} could not be read` });
        continue;
      }
      posJson = innerState.json;
      current ||= innerState.current;
      poolOverride = idField(read.json.pool_id) ?? undefined;
    }
    const pos = parsePositionFields(posJson, poolOverride);
    if (!pos) {
      unread.push({ what: read.object_id, reason: "position JSON lacks a pool, liquidity or I32 tick range" });
      continue;
    }
    const poolState = first.get(pos.pool);
    if (!poolState) {
      unread.push({ what: read.object_id, reason: `pool ${pos.pool} could not be read` });
      continue;
    }
    const pool = parsePoolFields(poolState.type, poolState.json);
    if (!pool) {
      unread.push({ what: read.object_id, reason: `pool ${pos.pool} lacks a sqrt price, current tick or two coin type arguments` });
      continue;
    }
    const infoId = pool.positionTable ? positionInfoId(pool.positionTable, read.object_id) : null;
    parsed.push({ read, pos, pool, poolState, current: current || poolState.current, infoId });
  }

  const infoIds = parsed.map((p) => p.infoId).filter((x): x is string => !!x);
  const infos = infoIds.length > 0 ? await readObjects(infoIds, ctx.atCheckpoint, ctx.memo) : new Map<string, ObjectState>();

  const allCoins = new Set<string>();
  for (const p of parsed) {
    allCoins.add(p.pool.coinA).add(p.pool.coinB);
    for (const c of p.pool.rewardCoins) if (c) allCoins.add(c);
  }
  await prefetchPackageRoots(reads.map((r) => parseStructTag(r.type).address)).catch(() => undefined);
  const prices = await priceCoinTypes([...allCoins], ctx);

  for (const p of parsed) {
    const { pos, pool } = p;
    let liquidity = pos.liquidity;
    let tickLower = pos.tickLower;
    let tickUpper = pos.tickUpper;
    let fees = pos.feesOwed ? { a: pos.feesOwed.a, b: pos.feesOwed.b } : null;
    let rewards = pos.rewardsOwed;
    let source = "the position's liquidity";
    let owedSource = pos.feesOwed ? `the position's ${pos.feesOwed.field}` : "the position's reward_infos";
    let current = p.current;
    if (p.infoId) {
      const infoState = infos.get(p.infoId);
      const info = infoState ? parsePositionInfo(infoState.json) : null;
      if (infoState && info) {
        ({ liquidity, tickLower, tickUpper, fees, rewards } = info);
        source = "the pool's record of the position (liquidity";
        source += liquidity === pos.liquidity ? ")" : `, where the position object says ${pos.liquidity})`;
        owedSource = "the pool's record (fee_owned_a/b, rewards amount_owned)";
        current ||= infoState.current;
      } else {
        source = "the position object's liquidity, because the pool's record of it could not be read,";
        unread.push({ what: `${p.read.object_id} owed fees`, reason: `the pool's record ${p.infoId} for this position could not be read` });
      }
    }
    let amounts: { a: bigint; b: bigint };
    try {
      amounts = amountsForLiquidity(tickLower, tickUpper, pool.currentTick, pool.sqrtPrice, liquidity);
    } catch (e) {
      unread.push({ what: p.read.object_id, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    // A position can be worth no more than the pool holds: liquidity minted
    // through an overflow reads as more of a coin than exists there.
    const over = [
      pool.reserveA !== null && amounts.a > pool.reserveA ? `${amounts.a} ${pool.coinA} against ${pool.reserveA} held` : null,
      pool.reserveB !== null && amounts.b > pool.reserveB ? `${amounts.b} ${pool.coinB} against ${pool.reserveB} held` : null,
    ].filter(Boolean);
    if (over.length > 0) {
      unread.push({ what: p.read.object_id, reason: `its liquidity claims more than pool ${pos.pool} holds (${over.join("; ")}), so it is not valued` });
      continue;
    }
    const legs: Leg[] = [
      { coin_type: pool.coinA, amount: amounts.a, side: "liquidity" },
      { coin_type: pool.coinB, amount: amounts.b, side: "liquidity" },
    ];
    // Owed amounts of zero add nothing; the detail keeps them.
    if (fees?.a) legs.push({ coin_type: pool.coinA, amount: fees.a, side: "reward" });
    if (fees?.b) legs.push({ coin_type: pool.coinB, amount: fees.b, side: "reward" });
    rewards.forEach((amount, i) => {
      if (amount === 0n) return;
      const coin = pool.rewardCoins[i];
      if (coin) legs.push({ coin_type: coin, amount, side: "reward" });
      else unread.push({ what: `${p.read.object_id} reward ${i}`, reason: `pool ${pos.pool} names no coin type for reward index ${i}` });
    });

    const inRange = pool.currentTick >= tickLower && pool.currentTick < tickUpper;
    const owedNote = fees || rewards.length > 0
      ? `; owed fees and rewards as last stored in ${owedSource}, without fees accrued since the position was last updated`
      : "; fees accrued since the position was last updated are not counted";
    const method =
      `Coin amounts from ${source} ${liquidity} over ticks [${tickLower}, ${tickUpper}) at the pool's ` +
      `sqrt price ${pool.sqrtPrice} (tick ${pool.currentTick}) with the Cetus-family tick math, rounded down as on removal, ` +
      `${stateNote(ctx, current)}${owedNote}.`;
    positions.push(
      assemblePosition(
        {
          protocol: protocolName(p.read.type),
          kind: "clmm",
          object_id: p.read.object_id,
          method,
          detail: {
            pool: pos.pool,
            pool_version: p.poolState.version,
            liquidity: liquidity.toString(),
            ...(liquidity === pos.liquidity ? {} : { position_object_liquidity: pos.liquidity.toString() }),
            tick_lower_index: tickLower,
            tick_upper_index: tickUpper,
            current_sqrt_price: pool.sqrtPrice.toString(),
            current_tick_index: pool.currentTick,
            in_range: inRange,
            ...(fees ? { fee_owed_a: fees.a.toString(), fee_owed_b: fees.b.toString() } : {}),
            ...Object.fromEntries(rewards.map((amount, i) => [`reward_amount_owed_${i}`, amount.toString()])),
          },
        },
        legs,
        prices,
      ),
    );
  }
  return { positions, unread };
}

/** Owned objects' types, bounded; the flag says the scan stopped with objects left. */
async function scanOwnedTypes(owner: string, max: number): Promise<{ objects: Array<{ objectId: string; type: string }>; complete: boolean }> {
  const objects: Array<{ objectId: string; type: string }> = [];
  let cursor: string | null = null;
  for (;;) {
    const page: SuiClientTypes.ListOwnedObjectsResponse = await sui.listOwnedObjects({ owner, limit: Math.min(1000, max - objects.length), cursor });
    for (const o of page.objects) objects.push({ objectId: o.objectId, type: o.type });
    if (!page.hasNextPage) return { objects, complete: true };
    if (!page.cursor || objects.length >= max) return { objects, complete: false };
    cursor = page.cursor;
  }
}

async function value(ctx: ValuationContext): Promise<ValuerResult> {
  const unread: ValuerResult["unread"] = [];
  const reads: PositionRead[] = [];
  for (const type of VERIFIED_POSITION_TYPES) {
    const { objects, complete } = await listOwnedWithJson(ctx.owner, type, MAX_POSITIONS_PER_TYPE);
    if (!complete) unread.push({ what: type, reason: `more than ${MAX_POSITIONS_PER_TYPE} positions of this type; the rest were not read` });
    for (const o of objects) {
      if (o.json) reads.push({ object_id: o.objectId, type: o.type, json: o.json, current: false });
      else unread.push({ what: o.objectId, reason: "position JSON not returned" });
    }
  }

  // Historical: the positions the owner holds now, each as it stood at the checkpoint.
  let valued = reads;
  if (ctx.atCheckpoint !== undefined && reads.length > 0) {
    const then = await readObjects(reads.map((r) => r.object_id), ctx.atCheckpoint);
    valued = [];
    for (const r of reads) {
      const s = then.get(r.object_id);
      if (s && !s.current) valued.push({ ...r, json: s.json });
      else unread.push({ what: r.object_id, reason: `position not readable at checkpoint ${ctx.atCheckpoint}; it may not have existed then` });
    }
  }
  const result = await valueReads(valued, ctx);
  unread.push(...result.unread);

  // Other families: one bounded scan of owned object types, then the JSON of
  // `Position`-named objects, to report CLMM-shaped positions not valued here.
  const scan = await scanOwnedTypes(ctx.owner, MAX_SCANNED_OBJECTS);
  const candidates = scan.objects.filter((o) => {
    const key = typeKey(o.type);
    return key !== null && !VERIFIED.has(key) && /::[A-Za-z_]*Position[A-Za-z_]*$/.test(key);
  });
  if (candidates.length > 0) {
    const states = await readObjects(candidates.map((c) => c.objectId));
    for (const c of candidates) {
      const s = states.get(normalizeSuiAddress(c.objectId)) ?? states.get(c.objectId);
      if (s && parsePositionFields(s.json) !== null) {
        unread.push({ what: c.objectId, reason: `CLMM-shaped position of type ${c.type}, a family whose tick math has not been checked against this reader` });
      }
    }
  }
  if (!scan.complete) {
    unread.push({ what: "owned objects", reason: `only the first ${MAX_SCANNED_OBJECTS} owned objects were scanned for positions of families not listed by type` });
  }
  return { positions: result.positions, unread };
}

function handles(type: string): boolean {
  const key = typeKey(type);
  return key !== null && VERIFIED.has(key);
}

async function valueObject(obj: ObjectToValue, ctx: ValuationContext): Promise<ValuerResult> {
  if (!obj.json) return { positions: [], unread: [{ what: obj.object_id, reason: "position JSON not available" }] };
  return valueReads([{ object_id: obj.object_id, type: obj.type, json: obj.json, current: false }], ctx);
}

registerValuer({ name: "clmm", value, handles, valueObject });
