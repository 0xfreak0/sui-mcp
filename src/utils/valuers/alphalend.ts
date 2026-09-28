/**
 * AlphaLend positions. A wallet holds a `PositionCap` naming a position in
 * the protocol's `positions` table. Collaterals are xTokens per market,
 * worth the market's `xtoken_ratio` (a 1e18 fixed point) each; loans grow by
 * the market's compounded interest over the value it had when the loan last
 * compounded. Prices come from AlphaLend's oracle, and the position stores
 * its own USD totals and health flags as of its last refresh.
 */

import { registerValuer, valueObjects, type ObjectToValue, type PositionValuer, type ValuationContext, type ValuerResult } from "../position-value.js";
import { readObjects, stateNote, SUI_TYPE, valuationTime } from "./common.js";
import {
  WAD,
  assembleLending,
  coinTypeOf,
  fixed,
  idKey,
  memo,
  mulDiv,
  priceLendingLegs,
  readObjectsBatched,
  readFields,
  TABLE_IDS_TTL_MS,
  typeNameKey,
  u64Key,
  uint,
  valueOwnedObjects,
  withHealthRatios,
  type HealthRatios,
  type LendingLeg,
} from "./lending.js";

export const ALPHALEND_PACKAGE = "0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4";
const PROTOCOL_ID = "0x01d9cf05d65fa3a9bb7163095139120e3c4e414dfbab153a49779a7d14010b93";
const CAP_TYPE = `${ALPHALEND_PACKAGE}::position::PositionCap`;
/** Key under the oracle's UID that names the table its prices live in. */
const ORACLE_IDENTITY_KEY = { type: "0x58fb555e394c7c67537292963c0916023d1b9530896e9f1d2cea734d7208ce93::oracle::OracleIdentityKey", bcs: "AA==" };

type Json = Record<string, unknown>;

export interface AlphaMarket {
  market_id: string;
  coin_type: string;
  xtoken_ratio: bigint;
  compounded_interest: bigint;
}

export function parseAlphaMarket(m: Json): AlphaMarket {
  const coinType = coinTypeOf(m.coin_type);
  if (!coinType) throw new Error("AlphaLend market without a coin type");
  return {
    market_id: String(m.market_id),
    coin_type: coinType,
    xtoken_ratio: uint(m.xtoken_ratio),
    compounded_interest: uint(m.compounded_interest),
  };
}

/** The `(market id, xToken amount)` pairs of a position's `VecMap<u64, u64>` of collaterals. */
function collateralEntries(position: Json): Array<{ market_id: string; xtokens: bigint }> {
  const contents = ((position.collaterals as Json | undefined)?.contents as Json[] | undefined) ?? [];
  return contents.map((e) => ({ market_id: String(e.key), xtokens: uint(e.value) }));
}

/** Collateral and loan legs of one position in underlying base units. */
export function alphaLegs(position: Json, markets: Map<string, AlphaMarket>): LendingLeg[] {
  const legs: LendingLeg[] = [];
  const market = (id: string) => {
    const m = markets.get(id);
    if (!m) throw new Error(`AlphaLend position names market ${id}, which could not be read`);
    return m;
  };
  for (const { market_id, xtokens } of collateralEntries(position)) {
    const m = market(market_id);
    legs.push({ coin_type: m.coin_type, amount: mulDiv(xtokens, m.xtoken_ratio, WAD), side: "supply" });
  }
  for (const loan of (position.loans as Json[] | undefined) ?? []) {
    const m = market(String(loan.market_id));
    legs.push({ coin_type: m.coin_type, amount: mulDiv(uint(loan.amount), m.compounded_interest, uint(loan.borrow_compounded_interest)), side: "borrow" });
  }
  return legs;
}

/**
 * AlphaLend's borrow limit is `safe_collateral_usd` (each collateral times
 * its market's safe collateral ratio) and its liquidation line is
 * `liquidation_value` (each collateral times its liquidation threshold),
 * both against the loans weighted by each market's borrow weight.
 */
export const ALPHA_HEALTH_RATIOS: HealthRatios = {
  borrow_limit_used: ["weighted_total_loan_usd", "safe_collateral_usd"],
  liquidation_threshold_used: ["weighted_total_loan_usd", "liquidation_value_usd"],
};

/** The position's own USD figures and health flags, as of its last refresh, and the ratios derived from them. */
export function alphaHealth(position: Json): Record<string, number | boolean | null> {
  const usd = (k: string): number | null => (position[k] === undefined ? null : fixed(uint(position[k]), WAD));
  const flag = (k: string): boolean | null => (typeof position[k] === "boolean" ? (position[k] as boolean) : null);
  return withHealthRatios(
    {
      total_collateral_usd: usd("total_collateral_usd"),
      safe_collateral_usd: usd("safe_collateral_usd"),
      liquidation_value_usd: usd("liquidation_value"),
      total_loan_usd: usd("total_loan_usd"),
      weighted_total_loan_usd: usd("weighted_total_loan_usd"),
      is_position_healthy: flag("is_position_healthy"),
      is_position_liquidatable: flag("is_position_liquidatable"),
    },
    ALPHA_HEALTH_RATIOS,
  );
}

interface ProtocolTables {
  positions: string;
  markets: string;
  prices: string;
}

/**
 * The protocol's positions, markets and oracle-price table ids. Table ids
 * never change, so they are read at the latest state and serve any
 * checkpoint. Were the oracle's price table ever replaced, a checkpoint from
 * before would find no oracle price and fall back to a provider's.
 */
function protocolTables(): Promise<ProtocolTables> {
  return memo("alphalend-protocol", TABLE_IDS_TTL_MS, async () => {
    const p = (await readObjects([PROTOCOL_ID])).get(PROTOCOL_ID);
    if (!p) throw new Error("AlphaLend's lending protocol object could not be read");
    const oracleId = String((p.json.oracle as Json).id);
    const [[identity]] = await readFields([{ parent: oracleId, keys: [ORACLE_IDENTITY_KEY] }]);
    const pricesAt = (identity as Json | null)?.id;
    if (typeof pricesAt !== "string") throw new Error("AlphaLend's oracle names no price table");
    return { positions: String((p.json.positions as Json).id), markets: String((p.json.markets as Json).id), prices: pricesAt };
  });
}

async function valuePosition(capId: string | null, positionId: string, ctx: ValuationContext): Promise<ValuerResult> {
  const tables = await protocolTables();
  const at = ctx.atCheckpoint;
  const [[position]] = await readFields([{ parent: tables.positions, keys: [idKey(positionId)] }], at);
  if (!position) return { positions: [], unread: [{ what: positionId, reason: "AlphaLend has no position with this id at that state." }] };
  const pos = position as Json;
  const marketIds = [
    ...new Set([...collateralEntries(pos).map((c) => c.market_id), ...((pos.loans as Json[] | undefined) ?? []).map((l) => String(l.market_id))]),
  ];
  const [marketRows] = await readFields([{ parent: tables.markets, keys: marketIds.map((id) => u64Key(id)) }], at);
  const markets = new Map<string, AlphaMarket>();
  marketRows.forEach((m) => {
    if (m) {
      const parsed = parseAlphaMarket(m as Json);
      markets.set(parsed.market_id, parsed);
    }
  });
  const legs = alphaLegs(pos, markets);
  const coinTypes = [...new Set(legs.map((l) => l.coin_type))];
  // SUI's oracle price values liquid-staking legs through their issuer's rate.
  const oracleCoins = [...new Set([...coinTypes, SUI_TYPE])];
  const [priceRows, atS] = await Promise.all([
    readFields([{ parent: tables.prices, keys: oracleCoins.map(typeNameKey) }], at).then((r) => r[0]),
    valuationTime(ctx),
  ]);
  const oracle = new Map<string, { price: number; at_s: number }>();
  oracleCoins.forEach((t, i) => {
    const p = priceRows[i] as Json | null;
    if (p) oracle.set(t, { price: fixed(uint(p.price), WAD), at_s: Number(p.last_updated ?? 0) });
  });
  for (const leg of legs) {
    leg.oracle_price = oracle.get(leg.coin_type)?.price ?? null;
    leg.oracle_at_s = oracle.get(leg.coin_type)?.at_s;
  }
  const prices = await priceLendingLegs(legs, ctx);
  const out: ValuerResult = { positions: [], unread: [] };
  // LP-position collateral is a CLMM position held by the protocol; its
  // reader values it, and the row is attributed to the cap (or position), so
  // whoever holds the cap is credited with it wherever the cap is valued.
  const lp = pos.lp_collaterals as Json | null | undefined;
  const lpId = typeof lp?.lp_position_id === "string" ? lp.lp_position_id : null;
  if (lpId) {
    const lpObj = (await readObjectsBatched([lpId], at)).get(lpId);
    // A latest-state fallback for the LP object is valued at the latest state throughout, so its method says so.
    const lpCtx: ValuationContext = lpObj?.current ? { ...ctx, atCheckpoint: undefined } : ctx;
    const lpValued = lpObj ? await valueObjects([{ object_id: lpId, type: lpObj.type, json: lpObj.json, version: lpObj.version }], lpCtx) : null;
    if (lpValued && lpValued.positions.length > 0) {
      for (const p of lpValued.positions) {
        out.positions.push({ ...p, object_id: capId ?? positionId, detail: { ...p.detail, lp_position_id: lpId, collateral_for: positionId, protocol_holding: "AlphaLend" } });
      }
      out.unread.push(...lpValued.unread);
    } else {
      out.unread.push({ what: capId ?? positionId, reason: `AlphaLend position ${positionId} holds LP position ${lpId} as collateral, and no reader could value it.` });
    }
  }
  if (legs.length > 0) {
    const health = alphaHealth(pos);
    const refreshedMs = pos.last_refreshed ? Number(pos.last_refreshed) : null;
    // The stored collateral total includes LP-position collateral, which is
    // its own row: the legs are compared with it plus that row's value, and
    // not at all when that row has no value.
    const lpUsd = !lpId ? 0 : out.positions.length === 0 ? null : out.positions.reduce<number | null>((n, p) => (n === null || p.usd_net === null ? null : n + p.usd_net), 0);
    out.positions.push(
      assembleLending(
        {
          protocol: "AlphaLend",
          kind: "lending",
          object_id: capId ?? positionId,
          oracle: "alphalend_oracle",
          sui_oracle: oracle.get(SUI_TYPE) ?? null,
          at_s: atS ?? Math.floor(Date.now() / 1000),
          method: `Position ${positionId} read ${stateNote(ctx, false)}: collaterals are xTokens at the market's xToken ratio, loans are grown by the market's compounded interest since they last compounded.${lpId ? " Its LP-position collateral is reported as its own row under the same object." : ""} The health figures are the position's own, as of its last refresh; \`detail.health_ratios\` names what each ratio divides.`,
          health,
          ...(lpUsd === null
            ? {}
            : {
                stored_totals: {
                  deposits_usd: health.total_collateral_usd as number | null,
                  borrows_usd: health.total_loan_usd as number | null,
                  supply_elsewhere_usd: lpUsd,
                  as_of_s: refreshedMs === null ? null : Math.floor(refreshedMs / 1000),
                },
              }),
          detail: {
            position_id: positionId,
            last_refreshed: refreshedMs === null ? null : new Date(refreshedMs).toISOString(),
            health_ratios: ALPHA_HEALTH_RATIOS,
            oracle_updated_at: Object.fromEntries(coinTypes.map((t) => [t, oracle.get(t)?.at_s ? new Date(oracle.get(t)!.at_s * 1000).toISOString() : null])),
          },
        },
        legs,
        prices,
      ),
    );
  }
  return out;
}

async function valueCap(cap: { object_id: string; json: Json | null }, ctx: ValuationContext): Promise<ValuerResult> {
  const positionId = cap.json?.position_id;
  if (typeof positionId !== "string") return { positions: [], unread: [{ what: cap.object_id, reason: "The PositionCap's JSON names no position." }] };
  return valuePosition(cap.object_id, positionId, ctx);
}

export const alphalendValuer: PositionValuer = {
  name: "alphalend",
  value: (ctx) => valueOwnedObjects(ctx, "alphalend", CAP_TYPE, (cap) => valueCap(cap, ctx)),
  handles: (type) => type === CAP_TYPE,
  valueObject: (obj: ObjectToValue, ctx) => valueCap(obj, ctx),
};

registerValuer(alphalendValuer);
