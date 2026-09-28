/**
 * LP shares of constant-product and weighted AMMs: the holder's share of the
 * pool's reserves, lp / supply x each reserve, rounded down as a
 * proportional withdrawal rounds, with the pool read at the valuation
 * checkpoint.
 *
 * Families, each by one rule:
 * - Aftermath: any `<package>::af_lp::AF_LP` coin whose `pool::Pool<LP>`
 *   exists in the Aftermath AMM package.
 * - FlowX v2: any `pair::LP<X, Y>` coin, its pair kept in the factory's bag
 *   under `LP-<X>-<Y>`.
 * - Kriya v2: any `spot_dex::KriyaLPToken<X, Y>` object, which names its pool.
 */

import type { SuiClientTypes } from "@mysten/sui/client";
import { bcs } from "@mysten/sui/bcs";
import { deriveDynamicFieldID, normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";
import { gqlQuery } from "../../clients/graphql.js";
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

export const AFTERMATH_AMM_PACKAGE = "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c";
export const FLOWX_V2_PACKAGE = "0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0";
/** FlowX v2's shared factory: its bag holds every pair, its treasury names the protocol-fee recipient. */
export const FLOWX_V2_CONTAINER = "0xb65dcbf63fd3ad5d0ebfbf334780dc9f785eff38a4459e37ab08fa79576ee511";
export const KRIYA_V2_PACKAGE = "0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66";
export const KRIYA_LP_TOKEN_TYPE = `${KRIYA_V2_PACKAGE}::spot_dex::KriyaLPToken`;

/** Coin balances read per owner before the list is reported as truncated. */
const MAX_BALANCES = 2000;
/** Kriya LP token objects read per owner before the list is reported as truncated. */
const MAX_LP_TOKENS = 1000;
/** Aftermath pool lookups per GraphQL request, which is capped at 5,000 bytes. */
const POOL_LOOKUPS_PER_QUERY = 8;

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/** Each reserve times lp / supply, rounded down. */
export function shareOfReserves(lp: bigint, supply: bigint, reserves: bigint[]): bigint[] {
  if (supply <= 0n) throw new RangeError("the pool's LP supply is zero");
  return reserves.map((r) => (lp * r) / supply);
}

/** Floor square root. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("square root of a negative number");
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length + 1) >> 1n);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * LP a Uniswap-v2 style pair mints to its fee recipient before any burn:
 * supply x (√k - √k_last) / (5√k + √k_last) when fees are on and k grew,
 * as FlowX v2's `pair::mint_fee`.
 */
export function uniswapV2FeeMint(supply: bigint, reserveX: bigint, reserveY: bigint, kLast: bigint, feeOn: boolean): bigint {
  if (!feeOn || kLast === 0n) return 0n;
  const rootK = isqrt(reserveX * reserveY);
  const rootKLast = isqrt(kLast);
  if (rootK <= rootKLast) return 0n;
  return (supply * (rootK - rootKLast)) / (rootK * 5n + rootKLast);
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

type Family = "aftermath" | "flowx_v2" | "kriya_v2";

interface Holding {
  family: Family;
  /** The LP coin type, or the Kriya token's object type. */
  lpType: string;
  /** The object proving the holding, when it is one object. */
  objectId: string | null;
  amount: bigint;
  /** Kriya tokens name their pool. */
  poolId?: string;
}

function tagOf(type: string): { address: string; module: string; name: string; typeParams: string[] } | null {
  try {
    const t = parseStructTag(type);
    return {
      address: normalizeSuiAddress(t.address),
      module: t.module,
      name: t.name,
      typeParams: t.typeParams.map((p) => (typeof p === "string" ? p : normalizeStructTag(p))),
    };
  } catch {
    return null;
  }
}

/** Which family an LP coin type belongs to, by its shape alone. */
export function lpCoinFamily(coinType: string): Family | null {
  const t = tagOf(coinType);
  if (!t) return null;
  if (t.module === "af_lp" && t.name === "AF_LP" && t.typeParams.length === 0) return "aftermath";
  if (t.address === FLOWX_V2_PACKAGE && t.module === "pair" && t.name === "LP" && t.typeParams.length === 2) return "flowx_v2";
  return null;
}

function isKriyaToken(type: string): boolean {
  const t = tagOf(type);
  return t !== null && t.address === KRIYA_V2_PACKAGE && t.module === "spot_dex" && t.name === "KriyaLPToken";
}

/** The inner type of `0x2::coin::Coin<T>`, or null. */
function coinInner(type: string): string | null {
  const t = tagOf(type);
  return t && t.address === normalizeSuiAddress("0x2") && t.module === "coin" && t.name === "Coin" ? t.typeParams[0] ?? null : null;
}

function coinTypeOf(v: string): string | null {
  const s = v.startsWith("0x") ? v : `0x${v}`;
  try {
    return normalizeCoinType(s) ?? normalizeStructTag(s);
  } catch {
    return null;
  }
}

/** A type as Move's `type_name::into_string` renders it: full addresses without `0x`. */
function typeNameString(type: string): string {
  return normalizeStructTag(type).replace(/0x([0-9a-f]{64})/g, "$1");
}

/** Id of FlowX v2's bag entry for pair <X, Y>. */
export function flowxPairFieldId(bagId: string, coinX: string, coinY: string): string {
  const name = `LP-${typeNameString(coinX)}-${typeNameString(coinY)}`;
  return deriveDynamicFieldID(bagId, "0x1::string::String", bcs.string().serialize(name).toBytes());
}

/** Reserves, supply and coin types of a pool in one family's JSON shape. */
export interface PoolReserves {
  coins: string[];
  reserves: bigint[];
  supply: bigint;
  /** LP the next burn mints to the protocol first (FlowX v2). */
  feeMint: bigint;
}

/** Aftermath `pool::Pool<LP>`: balances are stored multiplied by each coin's decimal scalar. */
export function aftermathReserves(json: Record<string, unknown>): PoolReserves | null {
  const names = json.type_names;
  const normalized = json.normalized_balances;
  const scalars = json.decimal_scalars;
  const supply = bigField((json.lp_supply as { value?: unknown } | undefined)?.value);
  if (!Array.isArray(names) || !Array.isArray(normalized) || !Array.isArray(scalars) || supply === null) return null;
  if (names.length !== normalized.length || names.length !== scalars.length) return null;
  const coins = names.map((n) => (typeof n === "string" ? coinTypeOf(n) : null));
  const reserves = normalized.map((b, i) => {
    const bal = bigField(b);
    const scalar = bigField(scalars[i]);
    return bal !== null && scalar ? bal / scalar : null;
  });
  if (coins.some((c) => c === null) || reserves.some((r) => r === null)) return null;
  return { coins: coins as string[], reserves: reserves as bigint[], supply, feeMint: 0n };
}

/** FlowX v2 bag entry `Field<String, PairMetadata<X, Y>>`; `feeOn` when the factory's treasurer is set. */
export function flowxReserves(json: Record<string, unknown>, coinX: string, coinY: string, feeOn: boolean): PoolReserves | null {
  const pair = json.value as Record<string, unknown> | undefined;
  if (!pair) return null;
  const x = bigField((pair.reserve_x as { balance?: unknown } | undefined)?.balance);
  const y = bigField((pair.reserve_y as { balance?: unknown } | undefined)?.balance);
  const supply = bigField((pair.lp_supply as { value?: unknown } | undefined)?.value);
  const kLast = bigField(pair.k_last);
  if (x === null || y === null || supply === null || kLast === null) return null;
  return { coins: [coinX, coinY], reserves: [x, y], supply, feeMint: uniswapV2FeeMint(supply, x, y, kLast, feeOn) };
}

/** Kriya v2 `spot_dex::Pool<X, Y>`. */
export function kriyaReserves(type: string, json: Record<string, unknown>): PoolReserves | null {
  const t = tagOf(type);
  const x = bigField(json.token_x);
  const y = bigField(json.token_y);
  const supply = bigField((json.lsp_supply as { value?: unknown } | undefined)?.value);
  const coinX = t?.typeParams[0] ? coinTypeOf(t.typeParams[0]) : null;
  const coinY = t?.typeParams[1] ? coinTypeOf(t.typeParams[1]) : null;
  if (x === null || y === null || supply === null || !coinX || !coinY) return null;
  return { coins: [coinX, coinY], reserves: [x, y], supply, feeMint: 0n };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const PROTOCOL_PACKAGE: Record<Family, string> = {
  aftermath: AFTERMATH_AMM_PACKAGE,
  flowx_v2: FLOWX_V2_PACKAGE,
  kriya_v2: KRIYA_V2_PACKAGE,
};

const FORMULA: Record<Family, string> = {
  aftermath: "the pool's normalized_balances divided by decimal_scalars, before the pool's withdrawal fees",
  flowx_v2: "the pair's reserve_x/reserve_y, with lp_supply raised by the protocol-fee LP the pair mints before any burn",
  kriya_v2: "the pool's token_x/token_y over lsp_supply",
};

/** Aftermath pool ids by LP coin type; absent when no pool of that LP exists. */
async function aftermathPoolIds(lpTypes: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < lpTypes.length; i += POOL_LOOKUPS_PER_QUERY) {
    const chunk = lpTypes.slice(i, i + POOL_LOOKUPS_PER_QUERY);
    const vars = Object.fromEntries(chunk.map((t, j) => [`t${j}`, `${AFTERMATH_AMM_PACKAGE}::pool::Pool<${t}>`]));
    const query = `query(${chunk.map((_, j) => `$t${j}: String!`).join(", ")}) { ${chunk
      .map((_, j) => `p${j}: objects(filter: { type: $t${j} }, first: 1) { nodes { address } }`)
      .join(" ")} }`;
    const d = await gqlQuery<Record<string, { nodes: Array<{ address: string }> }>>(query, vars);
    chunk.forEach((t, j) => {
      const id = d[`p${j}`]?.nodes?.[0]?.address;
      if (id) out.set(t, normalizeSuiAddress(id));
    });
  }
  return out;
}

async function valueHoldings(holdings: Holding[], ctx: ValuationContext): Promise<ValuerResult> {
  const unread: ValuerResult["unread"] = [];
  const positions: ValuedPosition[] = [];
  if (holdings.length === 0) return { positions, unread };

  // Where each holding's pool state lives.
  const afTypes = [...new Set(holdings.filter((h) => h.family === "aftermath").map((h) => h.lpType))];
  const afPools = afTypes.length > 0 ? await aftermathPoolIds(afTypes) : new Map<string, string>();
  const hasFlowx = holdings.some((h) => h.family === "flowx_v2");
  const container = hasFlowx ? (await readObjects([FLOWX_V2_CONTAINER], ctx.atCheckpoint, ctx.memo)).get(FLOWX_V2_CONTAINER) : undefined;
  const bagId = (container?.json.pairs as { id?: unknown } | undefined)?.id;
  const treasurer = (container?.json.treasury as { treasurer?: unknown } | undefined)?.treasurer;
  const feeOn = typeof treasurer === "string" && normalizeSuiAddress(treasurer) !== normalizeSuiAddress("0x0");

  const stateIdOf = (h: Holding): string | null => {
    if (h.family === "aftermath") return afPools.get(h.lpType) ?? null;
    if (h.family === "kriya_v2") return h.poolId ?? null;
    const t = tagOf(h.lpType);
    return typeof bagId === "string" && t ? flowxPairFieldId(bagId, t.typeParams[0], t.typeParams[1]) : null;
  };
  const ids = holdings.map(stateIdOf);
  const states = await readObjects(ids.filter((x): x is string => !!x), ctx.atCheckpoint, ctx.memo);

  const parsed: Array<{ h: Holding; state: ObjectState; pool: PoolReserves }> = [];
  holdings.forEach((h, i) => {
    const what = h.objectId ?? h.lpType;
    const id = ids[i];
    if (!id) {
      const reason =
        h.family === "aftermath"
          ? `no Aftermath pool of LP coin ${h.lpType} was found`
          : h.family === "flowx_v2"
            ? "the FlowX v2 factory could not be read"
            : "the LP token names no pool";
      unread.push({ what, reason });
      return;
    }
    const state = states.get(id);
    if (!state) {
      unread.push({ what, reason: `pool state ${id} could not be read` });
      return;
    }
    const t = tagOf(h.lpType);
    const pool =
      h.family === "aftermath"
        ? aftermathReserves(state.json)
        : h.family === "flowx_v2"
          ? t && flowxReserves(state.json, coinTypeOf(t.typeParams[0]) ?? t.typeParams[0], coinTypeOf(t.typeParams[1]) ?? t.typeParams[1], feeOn)
          : kriyaReserves(state.type, state.json);
    if (!pool || pool.supply + pool.feeMint === 0n) {
      unread.push({ what, reason: `pool state ${id} lacks reserves or an LP supply` });
      return;
    }
    parsed.push({ h, state, pool });
  });

  await prefetchPackageRoots(new Set(parsed.map((p) => PROTOCOL_PACKAGE[p.h.family]))).catch(() => undefined);
  const prices = await priceCoinTypes(parsed.flatMap((p) => p.pool.coins), ctx);
  for (const { h, state, pool } of parsed) {
    const supply = pool.supply + pool.feeMint;
    const amounts = shareOfReserves(h.amount, supply, pool.reserves);
    const legs: Leg[] = pool.coins.map((coin_type, i) => ({ coin_type, amount: amounts[i], side: "liquidity" }));
    const current = state.current || (h.family === "flowx_v2" && container?.current === true);
    const method =
      `Share of reserves: ${h.amount} LP of supply ${supply} times each reserve, rounded down, from ${FORMULA[h.family]}, ` +
      `pool state ${state.object_id} ${stateNote(ctx, current)}.`;
    positions.push(
      assemblePosition(
        {
          protocol: lookupProtocol(PROTOCOL_PACKAGE[h.family])?.name ?? null,
          kind: "lp",
          object_id: h.objectId,
          method,
          detail: {
            pool: h.family === "flowx_v2" ? ((state.json.value as { id?: unknown } | undefined)?.id ?? state.object_id) : state.object_id,
            pool_version: state.version,
            lp_amount: h.amount.toString(),
            lp_supply: supply.toString(),
            reserves: pool.reserves.map((r) => r.toString()),
            ...(pool.feeMint > 0n ? { pending_fee_mint: pool.feeMint.toString() } : {}),
            // A coin-held share is also a coin balance; this lets a caller count it once.
            ...(h.family === "kriya_v2" ? {} : { receipt_coin_types: [h.lpType] }),
          },
        },
        legs,
        prices,
      ),
    );
  }
  return { positions, unread };
}

async function listLpBalances(owner: string): Promise<{ holdings: Holding[]; complete: boolean }> {
  const holdings: Holding[] = [];
  let cursor: string | null = null;
  let seen = 0;
  for (;;) {
    const page: SuiClientTypes.ListBalancesResponse = await sui.listBalances({ owner, limit: 1000, cursor });
    for (const b of page.balances) {
      seen++;
      const family = lpCoinFamily(b.coinType);
      const amount = BigInt(b.balance);
      if (family && amount > 0n) holdings.push({ family, lpType: normalizeStructTag(b.coinType), objectId: null, amount });
    }
    if (!page.hasNextPage) return { holdings, complete: true };
    if (!page.cursor || seen >= MAX_BALANCES) return { holdings, complete: false };
    cursor = page.cursor;
  }
}

function kriyaHolding(objectId: string, type: string, json: Record<string, unknown>): Holding | null {
  const amount = bigField((json.lsp as { balance?: unknown } | undefined)?.balance);
  const pool = json.pool_id;
  if (amount === null || typeof pool !== "string") return null;
  return { family: "kriya_v2", lpType: normalizeStructTag(type), objectId, amount, poolId: normalizeSuiAddress(pool) };
}

async function value(ctx: ValuationContext): Promise<ValuerResult> {
  const unread: ValuerResult["unread"] = [];
  const { holdings, complete } = await listLpBalances(ctx.owner);
  if (!complete) unread.push({ what: "coin balances", reason: `only the first ${MAX_BALANCES} coin balances were checked for LP coins` });

  const tokens = await listOwnedWithJson(ctx.owner, KRIYA_LP_TOKEN_TYPE, MAX_LP_TOKENS);
  if (!tokens.complete) unread.push({ what: KRIYA_LP_TOKEN_TYPE, reason: `more than ${MAX_LP_TOKENS} Kriya LP tokens; the rest were not read` });
  let kriya = tokens.objects;
  // Historical: the tokens the owner holds now, each as it stood at the checkpoint.
  if (ctx.atCheckpoint !== undefined && kriya.length > 0) {
    const then = await readObjects(kriya.map((o) => o.objectId), ctx.atCheckpoint);
    kriya = kriya.flatMap((o) => {
      const s = then.get(normalizeSuiAddress(o.objectId));
      if (s && !s.current) return [{ ...o, json: s.json }];
      unread.push({ what: o.objectId, reason: `LP token not readable at checkpoint ${ctx.atCheckpoint}; it may not have existed then` });
      return [];
    });
  }
  for (const o of kriya) {
    const h = o.json ? kriyaHolding(o.objectId, o.type, o.json) : null;
    if (!h) unread.push({ what: o.objectId, reason: "LP token JSON lacks its pool or LP balance" });
    else if (h.amount > 0n) holdings.push(h);
  }

  const result = await valueHoldings(holdings, ctx);
  return { positions: result.positions, unread: [...unread, ...result.unread] };
}

function handles(type: string): boolean {
  if (isKriyaToken(type)) return true;
  const inner = coinInner(type);
  return inner !== null && lpCoinFamily(inner) !== null;
}

async function valueObject(obj: ObjectToValue, ctx: ValuationContext): Promise<ValuerResult> {
  if (!obj.json) return { positions: [], unread: [{ what: obj.object_id, reason: "object JSON not available" }] };
  let holding: Holding | null = null;
  if (isKriyaToken(obj.type)) holding = kriyaHolding(obj.object_id, obj.type, obj.json);
  else {
    const inner = coinInner(obj.type);
    const family = inner ? lpCoinFamily(inner) : null;
    const amount = bigField(obj.json.balance);
    if (inner && family && amount !== null) holding = { family, lpType: normalizeStructTag(inner), objectId: obj.object_id, amount };
  }
  if (!holding) return { positions: [], unread: [{ what: obj.object_id, reason: "object JSON lacks an LP amount or pool" }] };
  return valueHoldings([holding], ctx);
}

registerValuer({ name: "amm_lp", value, handles, valueObject });
