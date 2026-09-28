/**
 * Scallop lending. Borrowers hold an `ObligationKey` naming a shared
 * `Obligation` whose collaterals are coin amounts and whose debts grow by the
 * market's borrow index. Lenders hold receipts: `MarketCoin<T>` coins, sCoins
 * minted one-for-one against market coins by an `SCoinTreasury<S, T>`, or
 * market coins staked in a `SpoolAccount`. A market coin redeems for the
 * reserve's cash plus debt less revenue over its market-coin supply. Prices
 * come from Scallop's `XOracle`.
 */

import { gqlQuery } from "../../clients/graphql.js";
import { registerValuer, type ObjectToValue, type PositionValuer, type ValuationContext, type ValuerResult } from "../position-value.js";
import { readObjects, stateNote, SUI_TYPE, valuationTime } from "./common.js";
import {
  PAYLOAD_BUDGET,
  assembleLending,
  chunkByBytes,
  coinTypeOf,
  fixed,
  memo,
  mulDiv,
  normalizeAddress,
  objectsOfType,
  priceLendingLegs,
  readObjectsBatched,
  readFields,
  TABLE_IDS_TTL_MS,
  typeArgs,
  typeNameKey,
  uint,
  valueOwnedObjects,
  type FieldRead,
  type LendingLeg,
} from "./lending.js";

export const SCALLOP_PACKAGE = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
const MARKET_ID = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
/** The `prices` table of Scallop's `XOracle` (0x93d5bf09…). */
const ORACLE_PRICES_TABLE = "0xf5d0a43dcc96aa33cbe48d86155ede120377d25863389a75634364a5c8e054a7";
const OBLIGATION_KEY_TYPE = `${SCALLOP_PACKAGE}::obligation::ObligationKey`;
const MARKET_COIN_PREFIX = `${SCALLOP_PACKAGE}::reserve::MarketCoin<`;
const SCOIN_TREASURY_TYPE = "0x80ca577876dec91ae6d22090e56c39bc60dce9086ab0729930c6900bc4162b4c::s_coin_converter::SCoinTreasury";
const SPOOL_ACCOUNT_TYPE = "0xe87f1b2d498106a2c61421cec75b7b5c5e348512b0dc263949a0e7a3c256571a::spool_account::SpoolAccount";
/** XOracle prices are USD per whole coin times 1e9. */
const ORACLE_SCALE = 10n ** 9n;

type Json = Record<string, unknown>;

export interface ScallopSheet {
  cash: bigint;
  debt: bigint;
  revenue: bigint;
  market_coin_supply: bigint;
}

/** Underlying base units one amount of market coins redeems for. */
export function redeemMarketCoins(amount: bigint, sheet: ScallopSheet): bigint {
  if (sheet.market_coin_supply === 0n) return amount;
  return mulDiv(amount, sheet.cash + sheet.debt - sheet.revenue, sheet.market_coin_supply);
}

/** Market coins behind an amount of sCoin, from its treasury's balance over its supply. */
export function sCoinToMarketCoins(amount: bigint, treasury: { s_coin_supply: bigint; market_coin_balance: bigint }): bigint {
  if (treasury.s_coin_supply === 0n) return amount;
  return mulDiv(amount, treasury.market_coin_balance, treasury.s_coin_supply);
}

/** The coin type a `MarketCoin<T>` type wraps, or null for any other type. */
export function marketCoinUnderlying(type: string): string | null {
  const t = coinTypeOf(type);
  if (!t) return null;
  const prefix = `${SCALLOP_PACKAGE}::reserve::MarketCoin<`;
  return t.startsWith(prefix) && t.endsWith(">") ? t.slice(prefix.length, -1) : null;
}

interface ScallopMarket {
  sheets_table: string;
  dynamics_table: string;
  assets: string[];
}

/**
 * The market's balance-sheet and borrow-index table ids and its listed
 * assets. Table ids never change and assets are only ever added, so the
 * latest state serves any checkpoint: an asset listed later has no balance
 * or entry there.
 */
function readMarket(): Promise<ScallopMarket> {
  return memo("scallop-market", TABLE_IDS_TTL_MS, async () => {
    const m = (await readObjects([MARKET_ID])).get(MARKET_ID);
    if (!m) throw new Error("Scallop market could not be read");
    const sheets = (m.json.vault as Json).balance_sheets as Json;
    const dynamics = m.json.borrow_dynamics as Json;
    const assets = (((sheets.keys as Json | undefined)?.contents as unknown[]) ?? []).map((k) => coinTypeOf(k)).filter((t): t is string => t !== null);
    return { sheets_table: String((sheets.table as Json).id), dynamics_table: String((dynamics.table as Json).id), assets };
  });
}

interface Reserves {
  sheets: Map<string, ScallopSheet>;
  borrowIndex: Map<string, bigint>;
  prices: Map<string, { price: number; at_s: number }>;
}

/** The three reads that give assets' balance sheets, borrow indexes and oracle prices, for batching with others. */
function reserveReads(market: ScallopMarket, assets: string[]): FieldRead[] {
  const keys = assets.map(typeNameKey);
  return [
    { parent: market.sheets_table, keys },
    { parent: market.dynamics_table, keys },
    { parent: ORACLE_PRICES_TABLE, keys },
  ];
}

function parseReserves(assets: string[], [sheetRows, dynRows, priceRows]: Array<Array<unknown | null>>): Reserves {
  const sheets = new Map<string, ScallopSheet>();
  const borrowIndex = new Map<string, bigint>();
  const prices = new Map<string, { price: number; at_s: number }>();
  assets.forEach((asset, i) => {
    const s = sheetRows[i] as Json | null;
    if (s) sheets.set(asset, { cash: uint(s.cash), debt: uint(s.debt), revenue: uint(s.revenue), market_coin_supply: uint(s.market_coin_supply) });
    const d = dynRows[i] as Json | null;
    if (d) borrowIndex.set(asset, uint(d.borrow_index));
    const p = priceRows[i] as Json | null;
    if (p) prices.set(asset, { price: fixed(uint(p.value), ORACLE_SCALE), at_s: Number(p.last_updated ?? 0) });
  });
  return { sheets, borrowIndex, prices };
}

const oracleTimes = (assets: string[], prices: Map<string, { at_s: number }>) =>
  Object.fromEntries(assets.map((a) => [a, prices.get(a)?.at_s ? new Date(prices.get(a)!.at_s * 1000).toISOString() : null]));

/* ------------------------------------------------------------------ *
 * Obligations
 * ------------------------------------------------------------------ */

function witTable(v: unknown): { table: string; keys: string[] } {
  const w = v as Json;
  const keys = (((w.keys as Json | undefined)?.contents as unknown[]) ?? []).map((k) => coinTypeOf(k)).filter((t): t is string => t !== null);
  return { table: String((w.table as Json).id), keys };
}

/**
 * One obligation in two reads: the obligation, then its collateral and debt
 * rows together with the reserves they need, with prices asked for alongside.
 */
async function valueObligation(keyId: string | null, obligationId: string, ctx: ValuationContext): Promise<ValuerResult> {
  const [obligation, market] = await Promise.all([readObjectsBatched([obligationId], ctx.atCheckpoint).then((m) => m.get(obligationId)), readMarket()]);
  if (!obligation) return { positions: [], unread: [{ what: obligationId, reason: "The Scallop obligation could not be read." }] };
  const at = obligation.current ? undefined : ctx.atCheckpoint;
  const collaterals = witTable(obligation.json.collaterals);
  const debts = witTable(obligation.json.debts);
  if (collaterals.keys.length === 0 && debts.keys.length === 0) return { positions: [], unread: [] };
  const assets = [...new Set([...collaterals.keys, ...debts.keys])];
  // SUI's oracle price values liquid-staking legs through their issuer's rate.
  const read = [...new Set([...assets, SUI_TYPE])];
  const rows = await readFields(
    [
      { parent: collaterals.table, keys: collaterals.keys.map(typeNameKey) },
      { parent: debts.table, keys: debts.keys.map(typeNameKey) },
      ...reserveReads(market, read),
    ],
    at,
  );
  const [collRows, debtRows] = rows;
  const reserves = parseReserves(read, rows.slice(2));
  const legs: LendingLeg[] = [];
  collaterals.keys.forEach((asset, i) => {
    const c = collRows[i] as Json | null;
    if (c) legs.push({ coin_type: asset, amount: uint(c.amount), side: "supply", oracle_price: reserves.prices.get(asset)?.price ?? null, oracle_at_s: reserves.prices.get(asset)?.at_s });
  });
  debts.keys.forEach((asset, i) => {
    const d = debtRows[i] as Json | null;
    if (!d) return;
    const index = reserves.borrowIndex.get(asset);
    const amount = index === undefined ? uint(d.amount) : mulDiv(uint(d.amount), index, uint(d.borrow_index));
    legs.push({ coin_type: asset, amount, side: "borrow", oracle_price: reserves.prices.get(asset)?.price ?? null, oracle_at_s: reserves.prices.get(asset)?.at_s });
  });
  const locks = obligation.json.lock_key ? { lock_key: coinTypeOf(obligation.json.lock_key) } : {};
  const prices = await priceLendingLegs(legs, ctx);
  const position = assembleLending(
    {
      protocol: "Scallop",
      kind: "lending",
      object_id: keyId ?? obligationId,
      oracle: "scallop_oracle",
      sui_oracle: reserves.prices.get(SUI_TYPE) ?? null,
      at_s: (await valuationTime(ctx)) ?? Math.floor(Date.now() / 1000),
      method: `Obligation ${obligationId} read ${stateNote(ctx, obligation.current)}: collaterals are coin amounts, debts are grown by the market's borrow index as of its last update. Scallop stores no per-obligation health figure.`,
      detail: { obligation_id: obligationId, ...locks, oracle_updated_at: oracleTimes(assets, reserves.prices) },
    },
    legs,
    prices,
  );
  return { positions: [position], unread: [] };
}

async function valueKey(key: { object_id: string; json: Json | null }, ctx: ValuationContext): Promise<ValuerResult> {
  const obligationId = (key.json?.ownership as Json | undefined)?.of;
  if (typeof obligationId !== "string") return { positions: [], unread: [{ what: key.object_id, reason: "The ObligationKey's JSON names no obligation." }] };
  return valueObligation(key.object_id, obligationId, ctx);
}

/* ------------------------------------------------------------------ *
 * Supply receipts
 * ------------------------------------------------------------------ */

interface Treasury {
  s_coin: string;
  underlying: string;
  s_coin_supply: bigint;
  market_coin_balance: bigint;
}

/** Every sCoin treasury, keyed by sCoin type, as of the checkpoint. */
async function sCoinTreasuries(atCheckpoint: string | undefined): Promise<Map<string, Treasury>> {
  const out = new Map<string, Treasury>();
  for (const t of await objectsOfType(SCOIN_TREASURY_TYPE, atCheckpoint)) {
    const [sCoin, underlying] = typeArgs(t.type).map((a) => coinTypeOf(a));
    if (!sCoin || !underlying || !t.json) continue;
    out.set(sCoin, { s_coin: sCoin, underlying, s_coin_supply: uint(t.json.s_coin_supply), market_coin_balance: uint(t.json.market_coin_balance) });
  }
  return out;
}

interface Receipt {
  object_id: string | null;
  receipt_type: string;
  receipt_amount: bigint;
  underlying: string;
  market_coins: bigint;
  via: string;
}

const BALANCES_QUERY = `query($owner: SuiAddress!, $cp: UInt53, $keys: [String!]!) {
  address(address: $owner, atCheckpoint: $cp) { multiGetBalances(keys: $keys) { coinType { repr } totalBalance } }
}`;

async function readReceipts(ctx: ValuationContext): Promise<{ receipts: Receipt[]; unread: ValuerResult["unread"] }> {
  const [market, treasuries] = await Promise.all([readMarket(), sCoinTreasuries(ctx.atCheckpoint)]);
  const marketCoinTypes = market.assets.map((a) => `${MARKET_COIN_PREFIX}${a}>`);
  const keys = [...marketCoinTypes, ...treasuries.keys()];
  const receipts: Receipt[] = [];
  const unread: ValuerResult["unread"] = [];
  try {
    for (const chunk of chunkByBytes(keys, (k) => k.length + 3, PAYLOAD_BUDGET - 400, 50)) {
      const d = await gqlQuery<{ address: { multiGetBalances: Array<{ coinType: { repr: string }; totalBalance: string } | null> } | null }>(BALANCES_QUERY, {
        owner: normalizeAddress(ctx.owner),
        cp: ctx.atCheckpoint === undefined ? null : Number(ctx.atCheckpoint),
        keys: chunk,
      });
      for (const b of d.address?.multiGetBalances ?? []) {
        const amount = b ? BigInt(b.totalBalance) : 0n;
        if (!b || amount === 0n) continue;
        const type = coinTypeOf(b.coinType.repr) ?? b.coinType.repr;
        const treasury = treasuries.get(type);
        const underlying = treasury?.underlying ?? marketCoinUnderlying(type);
        if (!underlying) continue;
        receipts.push({
          object_id: null,
          receipt_type: type,
          receipt_amount: amount,
          underlying,
          market_coins: treasury ? sCoinToMarketCoins(amount, treasury) : amount,
          via: treasury ? "sCoins, converted to market coins at the treasury's market-coin balance over its sCoin supply" : "market coins",
        });
      }
    }
  } catch (err) {
    unread.push({ what: "scallop: receipt coins", reason: `The owner's receipt-coin balances could not be read${ctx.atCheckpoint ? ` at checkpoint ${ctx.atCheckpoint}` : ""}: ${err instanceof Error ? err.message : String(err)}` });
  }
  return { receipts, unread };
}

function spoolReceipt(obj: { object_id: string; json: Json | null }, treasuries: Map<string, Treasury>): Receipt | null {
  const stakeType = coinTypeOf(obj.json?.stake_type);
  if (!stakeType) return null;
  const stakes = uint(obj.json?.stakes ?? 0);
  const treasury = treasuries.get(stakeType);
  const underlying = treasury?.underlying ?? marketCoinUnderlying(stakeType);
  if (!underlying) return null;
  return {
    object_id: obj.object_id,
    receipt_type: stakeType,
    receipt_amount: stakes,
    underlying,
    market_coins: treasury ? sCoinToMarketCoins(stakes, treasury) : stakes,
    via: "market coins staked in a spool account",
  };
}

/** Receipts valued at the reserve state of the valuation point. */
async function valueReceipts(receipts: Receipt[], ctx: ValuationContext): Promise<ValuerResult> {
  const nonZero = receipts.filter((r) => r.receipt_amount > 0n);
  if (nonZero.length === 0) return { positions: [], unread: [] };
  const market = await readMarket();
  const assets = [...new Set([...nonZero.map((r) => r.underlying), SUI_TYPE])];
  const [rows, atS] = await Promise.all([readFields(reserveReads(market, assets), ctx.atCheckpoint), valuationTime(ctx)]);
  const reserves = parseReserves(assets, rows);
  const out: ValuerResult = { positions: [], unread: [] };
  for (const r of nonZero) {
    const sheet = reserves.sheets.get(r.underlying);
    if (!sheet) {
      out.unread.push({ what: r.object_id ?? r.receipt_type, reason: `Scallop's market has no balance sheet for ${r.underlying}, so what the receipt redeems for is not known.` });
      continue;
    }
    const price = reserves.prices.get(r.underlying);
    const legs: LendingLeg[] = [{ coin_type: r.underlying, amount: redeemMarketCoins(r.market_coins, sheet), side: "supply", oracle_price: price?.price ?? null, oracle_at_s: price?.at_s }];
    const prices = await priceLendingLegs(legs, ctx);
    out.positions.push(
      assembleLending(
        {
          protocol: "Scallop",
          kind: "lending",
          object_id: r.object_id,
          oracle: "scallop_oracle",
          sui_oracle: reserves.prices.get(SUI_TYPE) ?? null,
          at_s: atS ?? Math.floor(Date.now() / 1000),
          method: `${r.receipt_type} held as ${r.via}, redeemed at the reserve's cash plus debt less revenue over its market-coin supply ${stateNote(ctx, false)}.`,
          detail: {
            receipt_coin_type: r.receipt_type,
            receipt_amount: r.receipt_amount.toString(),
            ...(r.object_id === null ? { receipt_coin_types: [r.receipt_type] } : {}),
            oracle_updated_at: oracleTimes([r.underlying], reserves.prices),
          },
        },
        legs,
        prices,
      ),
    );
  }
  return out;
}

async function valueSpool(obj: { object_id: string; json: Json | null }, ctx: ValuationContext): Promise<ValuerResult> {
  const receipt = spoolReceipt(obj, await sCoinTreasuries(ctx.atCheckpoint));
  if (!receipt) return { positions: [], unread: [{ what: obj.object_id, reason: "The spool account stakes a type that is not a Scallop market coin or sCoin." }] };
  return valueReceipts([receipt], ctx);
}

async function valueOwner(ctx: ValuationContext): Promise<ValuerResult> {
  const [o, s, coins] = await Promise.all([
    valueOwnedObjects(ctx, "scallop", OBLIGATION_KEY_TYPE, (key) => valueKey(key, ctx)),
    valueOwnedObjects(ctx, "scallop", SPOOL_ACCOUNT_TYPE, (sp) => valueSpool(sp, ctx)),
    readReceipts(ctx),
  ]);
  const c = await valueReceipts(coins.receipts, ctx);
  return {
    positions: [...o.positions, ...s.positions, ...c.positions],
    unread: [...o.unread, ...s.unread, ...coins.unread, ...c.unread],
  };
}

export const scallopValuer: PositionValuer = {
  name: "scallop",
  value: valueOwner,
  handles: (type) => type === OBLIGATION_KEY_TYPE || type.startsWith(`${SPOOL_ACCOUNT_TYPE}<`),
  valueObject: (obj: ObjectToValue, ctx) => (obj.type === OBLIGATION_KEY_TYPE ? valueKey(obj, ctx) : valueSpool(obj, ctx)),
};

registerValuer(scallopValuer);
