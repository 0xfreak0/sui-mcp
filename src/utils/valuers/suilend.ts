/**
 * Suilend obligations. A wallet holds an `ObligationOwnerCap<P>` naming its
 * obligation, which lives inside the lending market `P`. Deposits are cTokens
 * of a reserve and borrows are amounts at the reserve's cumulative borrow
 * rate when they last compounded; both are read against the market's
 * reserves, which carry the price Suilend's oracle last pushed.
 */

import { registerValuer, type ObjectToValue, type PositionValuer, type ValuationContext, type ValuerResult } from "../position-value.js";
import { SUI_TYPE, stateNote, valuationTime } from "./common.js";
import {
  WAD,
  assembleLending,
  coinTypeOf,
  fixed,
  memo,
  mulDiv,
  priceLendingLegs,
  readObjectsBatched,
  ttlFor,
  uint,
  valueOwnedObjects,
  withHealthRatios,
  type HealthRatios,
  type LendingLeg,
} from "./lending.js";

export const SUILEND_PACKAGE = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const CAP_TYPE = `${SUILEND_PACKAGE}::lending_market::ObligationOwnerCap`;

type Json = Record<string, unknown>;

export interface SuilendReserve {
  coin_type: string;
  decimals: number;
  price: number;
  price_updated_s: number;
  /** Underlying per cToken, as a WAD-scaled numerator and denominator. */
  total_supply_wad: bigint;
  ctoken_supply: bigint;
  cumulative_borrow_rate: bigint;
  /** The Pyth price identifier the reserve is priced by. */
  feed: string | null;
  /** Loan-to-value for new borrows; 0 marks a reserve being wound down. */
  open_ltv_pct: number | null;
}

/** One reserve of a lending market's `reserves` vector, reduced to what valuing needs. */
export function parseSuilendReserve(r: Json): SuilendReserve {
  const coinType = coinTypeOf(r.coin_type);
  if (!coinType) throw new Error("Suilend reserve without a coin type");
  return {
    coin_type: coinType,
    decimals: Number(r.mint_decimals),
    price: fixed(uint(r.price), WAD),
    price_updated_s: Number(r.price_last_update_timestamp_s ?? 0),
    total_supply_wad: uint(r.available_amount) * WAD + uint(r.borrowed_amount) - uint(r.unclaimed_spread_fees),
    ctoken_supply: uint(r.ctoken_supply),
    cumulative_borrow_rate: uint(r.cumulative_borrow_rate),
    feed: typeof (r.price_identifier as Json | undefined)?.bytes === "string" ? String((r.price_identifier as Json).bytes) : null,
    open_ltv_pct: typeof ((r.config as Json | undefined)?.element as Json | undefined)?.open_ltv_pct === "number" ? Number(((r.config as Json).element as Json).open_ltv_pct) : null,
  };
}

/**
 * For each reserve priced by a feed an earlier reserve of another coin
 * already uses, that coin: the reserve is priced as that asset. A feed
 * belongs to the first reserve listed with it, since a market lists a coin
 * with its own feed before any later reserve reuses it.
 */
export function borrowedFeeds(reserves: SuilendReserve[]): Map<number, string> {
  const owner = new Map<string, string>();
  const out = new Map<number, string>();
  reserves.forEach((r, i) => {
    if (!r.feed) return;
    const first = owner.get(r.feed);
    if (first === undefined) owner.set(r.feed, r.coin_type);
    else if (first !== r.coin_type) out.set(i, first);
  });
  return out;
}

/**
 * Deposits and borrows of one obligation in underlying base units. A cToken
 * redeems for the reserve's total supply over its cToken supply; a borrow
 * grows by the reserve's cumulative borrow rate over the rate it last
 * compounded at.
 */
export function suilendLegs(obligation: Json, reserves: SuilendReserve[]): LendingLeg[] {
  const legs: LendingLeg[] = [];
  const borrowed = borrowedFeeds(reserves);
  const reserveAt = (d: Json): SuilendReserve => {
    const r = reserves[Number(d.reserve_array_index)];
    if (!r) throw new Error(`Suilend obligation names reserve ${String(d.reserve_array_index)}, which the market does not have`);
    return r;
  };
  const pricing = (d: Json, r: SuilendReserve): Partial<LendingLeg> => {
    const feedOf = borrowed.get(Number(d.reserve_array_index));
    return {
      oracle_price: r.price,
      oracle_at_s: r.price_updated_s,
      ...(feedOf ? { feed_of: feedOf } : {}),
      ...(r.open_ltv_pct === 0 ? { note: "Suilend lends nothing against this reserve (open LTV 0)." } : {}),
    };
  };
  for (const d of (obligation.deposits as Json[] | undefined) ?? []) {
    const r = reserveAt(d);
    const ctokens = uint(d.deposited_ctoken_amount);
    const amount = r.ctoken_supply === 0n ? ctokens : mulDiv(ctokens, r.total_supply_wad, r.ctoken_supply * WAD);
    legs.push({ coin_type: r.coin_type, amount, side: "supply", decimals: r.decimals, ...pricing(d, r) });
  }
  for (const b of (obligation.borrows as Json[] | undefined) ?? []) {
    const r = reserveAt(b);
    const amountWad = mulDiv(uint(b.borrowed_amount), r.cumulative_borrow_rate, uint(b.cumulative_borrow_rate));
    legs.push({ coin_type: r.coin_type, amount: (amountWad + WAD - 1n) / WAD, side: "borrow", decimals: r.decimals, ...pricing(b, r) });
  }
  return legs;
}

/**
 * Suilend's own health checks: borrowing and withdrawing stop once the weighted
 * borrows at the upper bound of each price exceed `allowed_borrow_value_usd`,
 * and the obligation can be liquidated once the weighted borrows exceed
 * `unhealthy_borrow_value_usd`. An obligation that stores no upper bound is
 * measured by its weighted borrows alone.
 */
export function suilendHealthRatios(obligation: Json): HealthRatios {
  const limited = obligation.weighted_borrowed_value_upper_bound_usd === undefined ? "weighted_borrowed_value_usd" : "weighted_borrowed_value_upper_bound_usd";
  return {
    borrow_limit_used: [limited, "allowed_borrow_value_usd"],
    liquidation_threshold_used: ["weighted_borrowed_value_usd", "unhealthy_borrow_value_usd"],
  };
}

/** The obligation's own USD figures, which Suilend writes each time the obligation is refreshed, and the ratios derived from them. */
export function suilendHealth(obligation: Json): Record<string, number | boolean | null> {
  const usd = (k: string): number | null => (obligation[k] === undefined ? null : fixed(uint(obligation[k]), WAD));
  const stored: Record<string, number | boolean | null> = {
    deposited_value_usd: usd("deposited_value_usd"),
    unweighted_borrowed_value_usd: usd("unweighted_borrowed_value_usd"),
    weighted_borrowed_value_usd: usd("weighted_borrowed_value_usd"),
    weighted_borrowed_value_upper_bound_usd: usd("weighted_borrowed_value_upper_bound_usd"),
    allowed_borrow_value_usd: usd("allowed_borrow_value_usd"),
    unhealthy_borrow_value_usd: usd("unhealthy_borrow_value_usd"),
    super_unhealthy_borrow_value_usd: usd("super_unhealthy_borrow_value_usd"),
    bad_debt_usd: usd("bad_debt_usd"),
    borrowing_isolated_asset: typeof obligation.borrowing_isolated_asset === "boolean" ? obligation.borrowing_isolated_asset : null,
  };
  return withHealthRatios(stored, suilendHealthRatios(obligation));
}

async function marketReserves(marketId: string, atCheckpoint: string | undefined): Promise<{ reserves: SuilendReserve[]; current: boolean }> {
  return memo(`suilend-market:${marketId}:${atCheckpoint ?? "latest"}`, ttlFor(atCheckpoint), async () => {
    const market = (await readObjectsBatched([marketId], atCheckpoint)).get(marketId);
    if (!market) throw new Error(`Suilend lending market ${marketId} could not be read`);
    return { reserves: ((market.json.reserves as Json[] | undefined) ?? []).map(parseSuilendReserve), current: market.current };
  });
}

async function valueObligation(capId: string | null, obligationId: string, ctx: ValuationContext): Promise<ValuerResult> {
  const obligation = (await readObjectsBatched([obligationId], ctx.atCheckpoint)).get(obligationId);
  if (!obligation) return { positions: [], unread: [{ what: obligationId, reason: "The Suilend obligation could not be read." }] };
  const marketId = String(obligation.json.lending_market_id ?? "");
  // The market is read at the state the obligation was read at, so a
  // fallback to the latest state applies to both.
  const { reserves } = await marketReserves(marketId, obligation.current ? undefined : ctx.atCheckpoint);
  const legs = suilendLegs(obligation.json, reserves);
  if (legs.length === 0) return { positions: [], unread: [] };
  const prices = await priceLendingLegs(legs, ctx);
  const sui = reserves.find((r) => r.coin_type === SUI_TYPE);
  const health = suilendHealth(obligation.json);
  const position = assembleLending(
    {
      protocol: "Suilend",
      kind: "lending",
      object_id: capId ?? obligationId,
      oracle: "suilend_oracle",
      sui_oracle: sui ? { price: sui.price, at_s: sui.price_updated_s } : null,
      at_s: (await valuationTime(ctx)) ?? Math.floor(Date.now() / 1000),
      method: `Obligation ${obligationId} read ${stateNote(ctx, obligation.current)}: deposits are cTokens redeemed at the reserve's supply over its cToken supply, borrows are grown by the reserve's cumulative borrow rate since they last compounded. The health figures are the obligation's own, as of its last refresh; \`detail.health_ratios\` names what each ratio divides.`,
      health,
      stored_totals: { deposits_usd: health.deposited_value_usd as number | null, borrows_usd: health.unweighted_borrowed_value_usd as number | null },
      detail: {
        obligation_id: obligationId,
        lending_market_id: marketId,
        health_ratios: suilendHealthRatios(obligation.json),
        oracle_updated_at: Object.fromEntries(
          legs.map((l) => {
            const r = reserves.find((x) => x.coin_type === l.coin_type);
            return [l.coin_type, r?.price_updated_s ? new Date(r.price_updated_s * 1000).toISOString() : null];
          }),
        ),
      },
    },
    legs,
    prices,
  );
  return { positions: [position], unread: [] };
}

/** One `ObligationOwnerCap<P>`, valued as the obligation it names. */
async function valueCap(cap: { object_id: string; json: Record<string, unknown> | null }, ctx: ValuationContext): Promise<ValuerResult> {
  const obligationId = cap.json?.obligation_id;
  if (typeof obligationId !== "string") return { positions: [], unread: [{ what: cap.object_id, reason: "The cap's JSON names no obligation." }] };
  return valueObligation(cap.object_id, obligationId, ctx);
}

export const suilendValuer: PositionValuer = {
  name: "suilend",
  value: (ctx) => valueOwnedObjects(ctx, "suilend", CAP_TYPE, (cap) => valueCap(cap, ctx)),
  handles: (type) => type.startsWith(`${CAP_TYPE}<`),
  valueObject: (obj: ObjectToValue, ctx) => valueCap(obj, ctx),
};

registerValuer(suilendValuer);
