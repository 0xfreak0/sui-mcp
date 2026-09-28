/**
 * NAVI lending. Balances live in each market's `Storage`, keyed by address:
 * a wallet's own address, or the `owner` field of an `AccountCap` it holds.
 * Each reserve keeps one table of scaled supply balances and one of scaled
 * borrow balances; a scaled balance times the reserve's current index (a
 * 1e27 ray) is the amount in NAVI's 9-decimal internal units. Prices come
 * from NAVI's `PriceOracle`, keyed by the reserve's `oracle_id`.
 */

import { registerValuer, type ObjectToValue, type PositionValuer, type ValuationContext, type ValuerResult } from "../position-value.js";
import { coinScale } from "../valuation.js";
import { SUI_TYPE, stateNote, valuationTime } from "./common.js";
import {
  RAY,
  addressKey,
  assembleLending,
  coinTypeOf,
  fixed,
  isOutOfRange,
  memo,
  mulDiv,
  normalizeAddress,
  objectsOfType,
  priceLendingLegs,
  readFields,
  TABLE_IDS_TTL_MS,
  u8Key,
  uint,
  valueOwnedObjects,
  type LendingLeg,
} from "./lending.js";

/** The package that defined NAVI's `Storage`, which every market is an instance of. */
const STORAGE_TYPE = "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3061e7b6bb6eebf73fa5bc4c81ca::storage::Storage";
/** NAVI's price oracle, a singleton created when its package was published. */
const PRICE_ORACLE_TABLE = "0xc0601facd3b98d1e82905e660bf9f5998097dedcf86ed802cf485865e3e3667c";
const ACCOUNT_CAP_TYPE = "0x66c91a8560cd64d73d93dd1ec7b61f3f21ad2f66553dd3d7038ca69255479bb7::account::AccountCap";

/** NAVI stores every amount scaled to this many decimals. */
const NAVI_DECIMALS = 9;

type Json = Record<string, unknown>;

interface NaviMarket {
  storage_id: string;
  reserves_table: string;
  reserves_count: number;
  user_info_table: string;
}

export interface NaviReserve {
  id: number;
  oracle_id: number;
  coin_type: string;
  supply_index: bigint;
  borrow_index: bigint;
  supply_table: string;
  borrow_table: string;
  updated_ms: number;
}

export function parseNaviReserve(r: Json): NaviReserve {
  const coinType = coinTypeOf(r.coin_type);
  if (!coinType) throw new Error("NAVI reserve without a coin type");
  const table = (b: unknown) => String(((b as Json).user_state as Json).id);
  return {
    id: Number(r.id),
    oracle_id: Number(r.oracle_id),
    coin_type: coinType,
    supply_index: uint(r.current_supply_index),
    borrow_index: uint(r.current_borrow_index),
    supply_table: table(r.supply_balance),
    borrow_table: table(r.borrow_balance),
    updated_ms: Number(r.last_update_timestamp ?? 0),
  };
}

/** The reserve ids a `UserInfo` lists, which Move JSON renders as base64 `vector<u8>`. */
export function naviReserveIds(v: unknown): number[] {
  if (typeof v === "string") return [...Buffer.from(v, "base64")];
  if (Array.isArray(v)) return v.map(Number);
  return [];
}

/**
 * A scaled balance as base units of the coin: times the reserve index, then
 * from NAVI's 9 decimals to the coin's own. Null decimals keep the 9-decimal
 * amount.
 */
export function naviAmount(scaled: bigint, index: bigint, coinDecimals: number | null): bigint {
  const internal = mulDiv(scaled, index, RAY);
  if (coinDecimals === null || coinDecimals === NAVI_DECIMALS) return internal;
  return coinDecimals > NAVI_DECIMALS
    ? internal * 10n ** BigInt(coinDecimals - NAVI_DECIMALS)
    : internal / 10n ** BigInt(NAVI_DECIMALS - coinDecimals);
}

/**
 * Every NAVI market's `Storage` table ids. A table's id never changes, so
 * the markets are listed at the latest state and reused for any checkpoint;
 * a market created after that checkpoint simply has no entry for the
 * account there.
 */
function naviMarkets(): Promise<NaviMarket[]> {
  return memo("navi-markets", TABLE_IDS_TTL_MS, async () =>
    (await objectsOfType(STORAGE_TYPE, undefined)).flatMap(({ object_id, json: j }) =>
      j
        ? [
            {
              storage_id: object_id,
              reserves_table: String((j.reserves as Json).id),
              reserves_count: Number(j.reserves_count),
              user_info_table: String((j.user_info as Json).id),
            },
          ]
        : [],
    ),
  );
}

/**
 * Which coin each oracle id belongs to in a market: the first reserve listed
 * with it. A reserve using an oracle id an earlier reserve of another coin
 * uses is priced as that coin. Read at the latest state and reused, since a
 * reserve's coin and oracle id are set when it is listed.
 */
export function naviOracleOwners(reserves: Array<{ id: number; oracle_id: number; coin_type: string }>): Map<number, string> {
  const owners = new Map<number, string>();
  for (const r of [...reserves].sort((a, b) => a.id - b.id)) if (!owners.has(r.oracle_id)) owners.set(r.oracle_id, r.coin_type);
  return owners;
}

function marketOracleOwners(market: NaviMarket): Promise<Map<number, string>> {
  return memo(`navi-oracle-owners:${market.storage_id}`, TABLE_IDS_TTL_MS, async () => {
    const [rows] = await readFields([{ parent: market.reserves_table, keys: Array.from({ length: market.reserves_count }, (_v, i) => u8Key(i)) }]);
    return naviOracleOwners(rows.flatMap((r) => (r ? [parseNaviReserve(r as Json)] : [])));
  });
}

interface AccountRead {
  market: NaviMarket;
  legs: Array<{ reserve: NaviReserve; side: "supply" | "borrow"; scaled: bigint }>;
  prices: Map<number, { price: number; at_ms: number }>;
  owners: Map<number, string>;
  sui_oracle_id: number | undefined;
}

/**
 * Every market position of one NAVI account, read at one state in three
 * rounds: the account's reserve lists in every market, the reserves it
 * names, then its balances and their oracle prices together.
 */
async function readAccount(account: string, atCheckpoint: string | undefined): Promise<AccountRead[]> {
  const markets = await naviMarkets();
  const infos = await readFields(
    markets.map((m) => ({ parent: m.user_info_table, keys: [addressKey(account)] })),
    atCheckpoint,
  );
  const held = markets.flatMap((market, i) => {
    const info = infos[i][0] as Json | null;
    if (!info) return [];
    const ids = [...naviReserveIds(info.collaterals).map((id) => ({ id, side: "supply" as const })), ...naviReserveIds(info.loans).map((id) => ({ id, side: "borrow" as const }))];
    return ids.length > 0 ? [{ market, ids }] : [];
  });
  if (held.length === 0) return [];
  const [reserveRows, ownerMaps] = await Promise.all([
    readFields(
      held.map((h) => ({ parent: h.market.reserves_table, keys: [...new Set(h.ids.map((x) => x.id))].map((id) => u8Key(id)) })),
      atCheckpoint,
    ),
    Promise.all(held.map((h) => marketOracleOwners(h.market))),
  ]);
  // Every market reads one price oracle, so SUI's oracle id is the same in each.
  const suiOracleId = ownerMaps.flatMap((m) => [...m].filter(([, coin]) => coin === SUI_TYPE).map(([id]) => id))[0];
  const wanted = held.map((h, i) => {
    const byId = new Map<number, NaviReserve>();
    for (const row of reserveRows[i]) {
      if (row) {
        const r = parseNaviReserve(row as Json);
        byId.set(r.id, r);
      }
    }
    return { market: h.market, owners: ownerMaps[i], legs: h.ids.flatMap(({ id, side }) => (byId.has(id) ? [{ reserve: byId.get(id)!, side }] : [])) };
  });
  const flat = wanted.flatMap((w) => w.legs);
  const oracleIds = [...new Set([...flat.map((l) => l.reserve.oracle_id), ...(suiOracleId === undefined ? [] : [suiOracleId])])];
  const rows = await readFields(
    [
      ...flat.map((l) => ({ parent: l.side === "supply" ? l.reserve.supply_table : l.reserve.borrow_table, keys: [addressKey(account)] })),
      { parent: PRICE_ORACLE_TABLE, keys: oracleIds.map((id) => u8Key(id)) },
    ],
    atCheckpoint,
  );
  const prices = new Map<number, { price: number; at_ms: number }>();
  oracleIds.forEach((id, i) => {
    const p = rows[flat.length][i] as Json | null;
    if (p) prices.set(id, { price: fixed(uint(p.value), 10n ** BigInt(Number(p.decimal))), at_ms: Number(p.timestamp ?? 0) });
  });
  // Balance rows are in the order of `flat`, market by market; a missing row is a zero balance.
  let row = 0;
  return wanted
    .map((w) => ({ market: w.market, owners: w.owners, sui_oracle_id: suiOracleId, legs: w.legs.map((l) => ({ ...l, scaled: uint(rows[row++][0] ?? 0) })), prices }))
    .filter((w) => w.legs.length > 0);
}

async function valueAccount(account: string, objectId: string | null, ctx: ValuationContext): Promise<ValuerResult> {
  let current = false;
  let read;
  try {
    read = await readAccount(account, ctx.atCheckpoint);
  } catch (err) {
    if (ctx.atCheckpoint === undefined || !isOutOfRange(err)) throw err;
    read = await readAccount(account, undefined);
    current = true;
  }
  const atS = (await valuationTime(ctx)) ?? Math.floor(Date.now() / 1000);
  const built = read.map(({ market, legs, prices: oracle, owners, sui_oracle_id }) => {
    const lendingLegs: LendingLeg[] = legs.map(({ reserve, side, scaled }) => {
      const scale = coinScale(reserve.coin_type);
      const decimals = scale.source === "assumed" ? null : scale.decimals;
      const feedOwner = owners.get(reserve.oracle_id);
      return {
        ...(feedOwner !== undefined && feedOwner !== reserve.coin_type ? { feed_of: feedOwner } : {}),
        coin_type: reserve.coin_type,
        amount: naviAmount(scaled, side === "supply" ? reserve.supply_index : reserve.borrow_index, decimals),
        side,
        decimals: decimals ?? NAVI_DECIMALS,
        oracle_price: oracle.get(reserve.oracle_id)?.price ?? null,
        oracle_at_s: Math.floor((oracle.get(reserve.oracle_id)?.at_ms ?? 0) / 1000),
        ...(decimals === null ? { note: "Amount in NAVI's 9-decimal internal units: the coin's own decimals are not known." } : {}),
      };
    });
    const sui = sui_oracle_id === undefined ? undefined : oracle.get(sui_oracle_id);
    return { market, legs, lendingLegs, oracle, sui };
  });
  const prices = await priceLendingLegs(
    built.flatMap((b) => b.lendingLegs),
    ctx,
  );
  const positions = built.map(({ market, legs, lendingLegs, oracle, sui }) =>
    assembleLending(
      {
        protocol: "NAVI",
        kind: "lending",
        object_id: objectId,
        oracle: "navi_oracle",
        sui_oracle: sui ? { price: sui.price, at_s: Math.floor(sui.at_ms / 1000) } : null,
        at_s: atS,
        method: `NAVI market ${market.storage_id} read ${stateNote(ctx, current)} for account ${account}: scaled balances times the reserve's supply or borrow index as of its last update. NAVI stores no per-account health figure.`,
        detail: {
          account,
          storage_id: market.storage_id,
          oracle_updated_at: Object.fromEntries(
            legs.map(({ reserve }) => {
              const at = oracle.get(reserve.oracle_id)?.at_ms;
              return [reserve.coin_type, at ? new Date(at).toISOString() : null];
            }),
          ),
        },
      },
      lendingLegs,
      prices,
    ),
  );
  return { positions, unread: [] };
}

/** One `AccountCap`, valued as the NAVI account its `owner` field names. */
async function valueCap(cap: { object_id: string; json: Json | null }, ctx: ValuationContext): Promise<ValuerResult> {
  const account = cap.json?.owner;
  if (typeof account !== "string") return { positions: [], unread: [{ what: cap.object_id, reason: "The AccountCap's JSON names no account." }] };
  return valueAccount(account, cap.object_id, ctx);
}

export const naviValuer: PositionValuer = {
  name: "navi",
  value: async (ctx) => {
    const [own, caps] = await Promise.all([
      valueAccount(normalizeAddress(ctx.owner), null, ctx),
      valueOwnedObjects(ctx, "navi", ACCOUNT_CAP_TYPE, (cap) => valueCap(cap, ctx)),
    ]);
    return { positions: [...own.positions, ...caps.positions], unread: [...own.unread, ...caps.unread] };
  },
  handles: (type) => type === ACCOUNT_CAP_TYPE,
  valueObject: (obj: ObjectToValue, ctx) => valueCap(obj, ctx),
};

registerValuer(naviValuer);
