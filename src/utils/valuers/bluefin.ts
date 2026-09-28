/**
 * Bluefin Pro margin accounts. The exchange's on-chain state lives in its
 * `InternalDataStore`, where each account is keyed by address and holds
 * deposited assets plus cross and isolated perpetual positions, all in
 * 9-decimal internal units. An account is worth its assets, the margin locked
 * in its isolated positions, and every position's unrealized PnL at the
 * perpetual's stored oracle price. Assets are priced at the price the
 * exchange stores for them.
 */

import { gqlQuery } from "../../clients/graphql.js";
import { registerValuer, type PositionValuer, type ValuationContext, type ValuerResult } from "../position-value.js";
import { priceCoinTypes, stateNote, valuationTime } from "./common.js";
import { addressKey, assembleLending, coinTypeOf, fixed, memo, normalizeAddress, readFields, ttlFor, uint, type FieldKey, type LendingLeg } from "./lending.js";

/** Bluefin Pro's `InternalDataStore` tables: accounts by address, perpetuals and supported assets by symbol. */
const ACCOUNTS_TABLE = "0x63f16b288f33fbe6d9374602cbbfa9948bf1cc175e9b0a91aa50085aa04980a0";
const PERPETUALS_TABLE = "0x316ab782a90ae336aba64b84c107615dd959e0b8340f506f2a5247d7cdd96e6d";
const ASSETS_TABLE = "0x9f37801fb0168407658535ed0d050b72c1465bfa76453afb9d383823ad69a0cb";
/** Bluefin Pro stores quantities and prices with this many decimals. */
const PRO_SCALE = 10n ** 9n;

type Json = Record<string, unknown>;

const stringKey = (s: string): FieldKey => {
  const bytes = Buffer.from(s, "utf8");
  return { type: "0x1::string::String", bcs: Buffer.concat([Buffer.from([bytes.length]), bytes]).toString("base64") };
};

export interface ProAsset {
  symbol: string;
  coin_type: string;
  decimals: number;
  price: number;
}

/** An internal 9-decimal quantity as base units of a coin with `decimals`. */
export function fromProUnits(quantity: bigint, decimals: number): bigint {
  return decimals >= 9 ? quantity * 10n ** BigInt(decimals - 9) : quantity / 10n ** BigInt(9 - decimals);
}

/**
 * Unrealized PnL of one position in 9-decimal USD units: size times the move
 * from the entry price to the oracle price, negated for a short.
 */
export function proPnl(position: Json, oraclePrice: bigint): bigint {
  const size = uint(position.size);
  const entry = uint(position.average_entry_price);
  const move = (oraclePrice - entry) * size / PRO_SCALE;
  return position.is_long === true ? move : -move;
}

const ASSETS_QUERY = `query($t: SuiAddress!, $cp: UInt53) {
  address(address: $t, atCheckpoint: $cp) { dynamicFields(first: 50) { pageInfo { hasNextPage } nodes { value { ... on MoveValue { json } } } } }
}`;

/** Every asset the exchange supports, by symbol. */
function supportedAssets(atCheckpoint: string | undefined): Promise<Map<string, ProAsset>> {
  return memo(`bluefin-assets:${atCheckpoint ?? "latest"}`, ttlFor(atCheckpoint), async () => {
    const d = await gqlQuery<{ address: { dynamicFields: { pageInfo: { hasNextPage: boolean }; nodes: Array<{ value: { json?: Json } | null }> } } | null }>(ASSETS_QUERY, {
      t: ASSETS_TABLE,
      cp: atCheckpoint === undefined ? null : Number(atCheckpoint),
    });
    const conn = d.address?.dynamicFields;
    if (!conn || conn.pageInfo.hasNextPage) throw new Error("Bluefin Pro's supported-asset table could not be read whole");
    const out = new Map<string, ProAsset>();
    for (const n of conn.nodes) {
      const a = n.value?.json;
      const coinType = a ? coinTypeOf(String(a.type)) : null;
      if (a && coinType) out.set(String(a.symbol), { symbol: String(a.symbol), coin_type: coinType, decimals: Number(a.decimals), price: fixed(uint(a.price), PRO_SCALE) });
    }
    return out;
  });
}

async function valueAccount(owner: string, ctx: ValuationContext): Promise<ValuerResult> {
  const [[account]] = await readFields([{ parent: ACCOUNTS_TABLE, keys: [addressKey(owner)] }], ctx.atCheckpoint);
  if (!account) return { positions: [], unread: [] };
  const acct = account as Json;
  const assets = ((acct.assets as Json[] | undefined) ?? []).filter((a) => uint(a.quantity) > 0n);
  const positions = [...((acct.cross_positions as Json[] | undefined) ?? []), ...((acct.isolated_positions as Json[] | undefined) ?? [])].filter(
    (p) => uint(p.size) > 0n || uint(p.margin) > 0n,
  );
  if (assets.length === 0 && positions.length === 0) return { positions: [], unread: [] };
  const perpNames = [...new Set(positions.map((p) => String(p.perpetual)))];
  const [supported, [perpRows]] = await Promise.all([
    supportedAssets(ctx.atCheckpoint),
    readFields([{ parent: PERPETUALS_TABLE, keys: perpNames.map(stringKey) }], ctx.atCheckpoint),
  ]);
  const unread: ValuerResult["unread"] = [];
  const legs: LendingLeg[] = [];
  for (const a of assets) {
    const asset = supported.get(String(a.name));
    if (!asset) {
      unread.push({ what: `bluefin_pro: ${owner} ${String(a.name)}`, reason: "The account holds an asset the exchange's supported-asset table does not describe." });
      continue;
    }
    legs.push({ coin_type: asset.coin_type, amount: fromProUnits(uint(a.quantity), asset.decimals), side: "supply", decimals: asset.decimals, oracle_price: asset.price });
  }
  // Margin and PnL settle in the exchange's settlement asset, the only
  // collateral asset it supports; with more than one, which one is not stated.
  const settlement = supported.size === 1 ? [...supported.values()][0] : null;
  const perps = new Map<string, Json>();
  perpRows.forEach((row, i) => {
    if (row) perps.set(perpNames[i], row as Json);
  });
  const pending: Record<string, string> = {};
  for (const p of positions) {
    const name = String(p.perpetual);
    const perp = perps.get(name);
    if (!settlement || !perp) {
      unread.push({ what: `bluefin_pro: ${owner} ${name}`, reason: settlement ? "The perpetual could not be read." : "The exchange's settlement asset could not be told apart." });
      continue;
    }
    const side = p.is_long === true ? "long" : "short";
    const margin = uint(p.margin);
    if (p.is_isolated === true && margin > 0n) {
      legs.push({ coin_type: settlement.coin_type, amount: fromProUnits(margin, settlement.decimals), side: "supply", decimals: settlement.decimals, oracle_price: settlement.price, note: `${name} ${side} isolated margin` });
    }
    const pnl = proPnl(p, uint(perp.oracle_price));
    if (pnl !== 0n) {
      legs.push({
        coin_type: settlement.coin_type,
        amount: fromProUnits(pnl < 0n ? -pnl : pnl, settlement.decimals),
        side: pnl < 0n ? "borrow" : "supply",
        decimals: settlement.decimals,
        oracle_price: settlement.price,
        note: `${name} ${side} unrealized ${pnl < 0n ? "loss" : "profit"} at the perpetual's oracle price ${fixed(uint(perp.oracle_price), PRO_SCALE)}`,
      });
    }
    if (uint(p.pending_funding_payment) > 0n) pending[name] = p.pending_funding_payment as string;
  }
  if (legs.length === 0) return { positions: [], unread };
  const [prices, atS] = await Promise.all([priceCoinTypes(legs.map((l) => l.coin_type), ctx), valuationTime(ctx)]);
  const position = assembleLending(
    {
      protocol: "Bluefin",
      kind: "vault",
      object_id: null,
      oracle: "bluefin_pro",
      at_s: atS ?? Math.floor(Date.now() / 1000),
      method: `Bluefin Pro account ${owner} read from the exchange's on-chain data store ${stateNote(ctx, false)}: deposited assets, isolated margin, and each position's unrealized PnL at the perpetual's stored oracle price. Pending funding payments are listed in detail and not netted. Bluefin Pro stores no per-account health figure.`,
      detail: {
        account: owner,
        positions: positions.map((p) => ({
          perpetual: p.perpetual,
          side: p.is_long === true ? "long" : "short",
          size: p.size,
          average_entry_price: p.average_entry_price,
          isolated: p.is_isolated === true,
        })),
        ...(Object.keys(pending).length > 0 ? { pending_funding_payment: pending } : {}),
      },
    },
    legs,
    prices,
  );
  return { positions: [position], unread };
}

export const bluefinProValuer: PositionValuer = {
  name: "bluefin_pro",
  value: (ctx) => valueAccount(normalizeAddress(ctx.owner), ctx),
};

registerValuer(bluefinProValuer);
