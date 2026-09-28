/**
 * Bucket CDPs. Both versions key positions by debtor address in a linked
 * table per collateral type, so a wallet's positions are found by looking up
 * its own address, and in v2 also the ids of the `Account` objects it holds.
 *
 * v2 (`Vault<T>`, debt in USDB): a position's debt grows by the vault's
 * interest unit, which rises linearly at the vault's rate from its last
 * update, over the unit the position last settled at. v2 stores no price.
 *
 * v1 (`Bucket<T>`, debt in BUCK): a bottle adds its share of redistributed
 * collateral and debt (stake times the per-stake totals since its snapshot,
 * over 2^64), and its debt grows by the bucket's interest index over the
 * index the bottle last settled at. Collateral prices come from Bucket's
 * `SingleOracle<T>` objects. A bottle's surplus left after liquidation or
 * redemption is claimable collateral.
 */

import { registerValuer, type ObjectToValue, type PositionValuer, type ValuationContext, type ValuedPosition, type ValuerResult } from "../position-value.js";
import { checkpointMeta, stateNote, SUI_TYPE, valuationTime } from "./common.js";
import {
  addressKey,
  assembleLending,
  coinTypeOf,
  fixed,
  listOwned,
  mulDiv,
  normalizeAddress,
  objectsOfType,
  priceLendingLegs,
  readFields,
  typeArgs,
  uint,
  withHealthRatios,
  type FieldKey,
  type HealthRatios,
  type LendingLeg,
} from "./lending.js";

const V2_PACKAGE = "0x9f835c21d21f8ce519fec17d679cd38243ef2643ad879e7048ba77374be4036e";
const V2_VAULT_TYPE = `${V2_PACKAGE}::vault::Vault`;
const V2_ACCOUNT_TYPE = "0x665188033384920a5bb5dcfb2ef21f54b4568d08b431718b97e02e5c184b92cc::account::Account";
const USDB = "0xe14726c336e81b32328e92afc37345d159f5b550b09fa92bd43640cfdd0a0cfd::usdb::USDB";
const V1_PACKAGE = "0xce7ff77a83ea0cb6fd39bd8748e2ec89a3f41e8efdc3f4eb123e0ca37b184db2";
const V1_BUCKET_TYPE = `${V1_PACKAGE}::bucket::Bucket`;
const BUCK = `${V1_PACKAGE}::buck::BUCK`;
const V1_ORACLE_TYPE = "0xf145ee6d09aae034924f80672bc76db2415dfd1b1bed863ac289af9d94e2c4fc::single_oracle::SingleOracle";

/** v2's `Double` and `Float` fixed points. */
const DOUBLE = 10n ** 18n;
const FLOAT = 10n ** 9n;
const ONE_YEAR_MS = 31_536_000_000n;
/** v1's scale for per-stake redistribution totals, and for its interest index. */
const DISTRIBUTION_PRECISION = 2n ** 64n;
const INTEREST_PRECISION = 10n ** 27n;

type Json = Record<string, unknown>;

const vectorU8Key = (s: string): FieldKey => ({ type: "vector<u8>", bcs: Buffer.concat([Buffer.from([s.length]), Buffer.from(s, "ascii")]).toString("base64") });

/* ------------------------------------------------------------------ *
 * v2
 * ------------------------------------------------------------------ */

export interface V2Vault {
  vault_id: string;
  coin_type: string;
  decimals: number;
  interest_rate: bigint;
  interest_unit: bigint;
  updated_ms: bigint;
  total_debt: bigint;
  min_collateral_ratio: number;
  table: string;
}

export function parseV2Vault(id: string, type: string, j: Json): V2Vault | null {
  const coinType = coinTypeOf(typeArgs(type)[0]);
  if (!coinType) return null;
  return {
    vault_id: id,
    coin_type: coinType,
    decimals: Number(j.decimal),
    interest_rate: uint(j.interest_rate),
    interest_unit: uint(j.interest_unit),
    updated_ms: uint(j.timestamp),
    total_debt: uint(j.total_debt_amount),
    min_collateral_ratio: fixed(uint(j.min_collateral_ratio), FLOAT),
    table: String((j.position_table as Json).id),
  };
}

/** A v2 position's debt at `atMs`: the stored debt plus interest at the vault's unit then over the position's own. */
export function v2Debt(position: { debt_amount: bigint; interest_unit: bigint }, vault: V2Vault, atMs: bigint): bigint {
  const elapsed = atMs > vault.updated_ms ? atMs - vault.updated_ms : 0n;
  const unit = vault.total_debt > 0n ? vault.interest_unit + (vault.interest_rate * elapsed) / ONE_YEAR_MS : vault.interest_unit;
  const grown = unit > position.interest_unit ? (unit - position.interest_unit) * position.debt_amount : 0n;
  return position.debt_amount + (grown + DOUBLE - 1n) / DOUBLE;
}

/**
 * When a valuation is for: `price_s` for prices and oracle age, and
 * `state_ms`, the time of the state read, to which debt accrues. They differ
 * when a caller prices a past state at another time; interest accrues only up
 * to the checkpoint read, never to the pricing time.
 */
interface Times {
  price_s: number;
  state_ms: bigint;
}

async function valuationTimes(ctx: ValuationContext): Promise<Times> {
  const now = Math.floor(Date.now() / 1000);
  const stateS = ctx.atCheckpoint === undefined ? now : ((await checkpointMeta(ctx.atCheckpoint))?.timestampSec ?? now);
  return { price_s: (await valuationTime(ctx)) ?? now, state_ms: BigInt(stateS) * 1000n };
}

async function valueV2(debtors: Array<{ address: string; object_id: string | null }>, ctx: ValuationContext, times: Times): Promise<ValuedPosition[]> {
  const vaults = (await objectsOfType(V2_VAULT_TYPE, ctx.atCheckpoint)).flatMap((v) => (v.json ? [parseV2Vault(v.object_id, v.type, v.json)] : [])).filter((v): v is V2Vault => v !== null);
  const rows = await readFields(
    vaults.map((v) => ({ parent: v.table, keys: debtors.map((d) => addressKey(d.address)) })),
    ctx.atCheckpoint,
  );
  const found: Array<{ vault: V2Vault; debtor: (typeof debtors)[number]; pos: Json }> = [];
  vaults.forEach((vault, i) =>
    rows[i].forEach((node, k) => {
      const pos = (node as Json | null)?.value as Json | undefined;
      if (pos) found.push({ vault, debtor: debtors[k], pos });
    }),
  );
  if (found.length === 0) return [];
  const legsOf = found.map(({ vault, pos }): LendingLeg[] => [
    { coin_type: vault.coin_type, amount: uint(pos.coll_amount), side: "supply", decimals: vault.decimals },
    { coin_type: USDB, amount: v2Debt({ debt_amount: uint(pos.debt_amount), interest_unit: uint(pos.interest_unit) }, vault, times.state_ms), side: "borrow" },
  ]);
  const prices = await priceLendingLegs(legsOf.flat(), ctx);
  return found.map(({ vault, debtor }, i) => {
    const legs = legsOf[i];
    return withCollateralRatio(
      assembleLending(
        {
          protocol: "Bucket",
          kind: "lending",
          object_id: debtor.object_id,
          oracle: "bucket_v2",
          at_s: times.price_s,
          method: `Bucket v2 vault ${vault.vault_id} read ${stateNote(ctx, false)} for debtor ${debtor.address}: debt is the stored amount plus interest at the vault's rate since the position last settled. Bucket v2 stores no price. ${BUCKET_RATIOS_NOTE}`,
          health: { min_collateral_ratio: vault.min_collateral_ratio },
          detail: { version: 2, vault_id: vault.vault_id, debtor: debtor.address },
        },
        legs,
        prices,
      ),
    );
  });
}

/* ------------------------------------------------------------------ *
 * v1
 * ------------------------------------------------------------------ */

export interface V1Bucket {
  bucket_id: string;
  coin_type: string;
  decimals: number;
  min_collateral_ratio: number;
  /** The ratio below which a bottle can be liquidated while the bucket's own collateral ratio is below it (recovery mode). */
  recovery_mode_threshold?: number | null;
  bottles: string;
  surplus: string;
  reward_per_unit_stake: bigint;
  debt_per_unit_stake: bigint;
}

export function parseV1Bucket(id: string, type: string, j: Json): V1Bucket | null {
  const coinType = coinTypeOf(typeArgs(type)[0]);
  const table = j.bottle_table as Json | undefined;
  if (!coinType || !table) return null;
  return {
    bucket_id: id,
    coin_type: coinType,
    decimals: Number(j.collateral_decimal),
    min_collateral_ratio: Number(j.min_collateral_ratio) / 100,
    recovery_mode_threshold: j.recovery_mode_threshold === undefined ? null : Number(j.recovery_mode_threshold) / 100,
    bottles: String((table.table as Json).id),
    surplus: String((j.surplus_bottle_table as Json).id),
    reward_per_unit_stake: uint(table.reward_per_unit_stake),
    debt_per_unit_stake: uint(table.debt_per_unit_stake),
  };
}

export interface V1Interest {
  rate: bigint;
  active_index: bigint;
  updated_ms: bigint;
}

/** A bottle's collateral and debt at `atMs`, with its redistribution share and interest. */
export function v1Bottle(bottle: Json, bucket: V1Bucket, interest: V1Interest | null, bottleIndex: bigint | null, atMs: bigint): { collateral: bigint; debt: bigint } {
  const stake = uint(bottle.stake_amount);
  const pendingColl = (stake * (bucket.reward_per_unit_stake - uint(bottle.reward_coll_snapshot))) / DISTRIBUTION_PRECISION;
  const pendingDebt = (stake * (bucket.debt_per_unit_stake - uint(bottle.reward_debt_snapshot))) / DISTRIBUTION_PRECISION;
  let debt = uint(bottle.buck_amount);
  if (interest && bottleIndex !== null && bottleIndex > 0n) {
    const elapsed = atMs > interest.updated_ms ? atMs - interest.updated_ms : 0n;
    const index = interest.active_index + mulDiv(interest.active_index, interest.rate * elapsed, INTEREST_PRECISION);
    debt = mulDiv(debt, index, bottleIndex);
  }
  return { collateral: uint(bottle.collateral_amount) + pendingColl, debt: debt + pendingDebt };
}

async function valueV1(owner: string, ctx: ValuationContext, times: Times): Promise<ValuedPosition[]> {
  const buckets = (await objectsOfType(V1_BUCKET_TYPE, ctx.atCheckpoint)).flatMap((b) => (b.json ? [parseV1Bucket(b.object_id, b.type, b.json)] : [])).filter((b): b is V1Bucket => b !== null);
  const key = addressKey(owner);
  const rows = await readFields(
    buckets.flatMap((b) => [
      { parent: b.bottles, keys: [key] },
      { parent: b.surplus, keys: [key] },
    ]),
    ctx.atCheckpoint,
  );
  const held = buckets
    .map((bucket, i) => ({ bucket, bottle: ((rows[2 * i][0] as Json | null)?.value as Json | undefined) ?? null, surplus: rows[2 * i + 1][0] as Json | null }))
    .filter((h) => h.bottle !== null || h.surplus !== null);
  if (held.length === 0) return [];
  const withBottle = held.filter((h) => h.bottle !== null);
  const interestKey = vectorU8Key("interest_table");
  const indexKey = vectorU8Key("interest_index");
  const [interestRows, indexRows, oracles] = await Promise.all([
    readFields(withBottle.map((h) => ({ parent: h.bucket.bucket_id, keys: [interestKey], objects: true })), ctx.atCheckpoint),
    readFields(withBottle.map((h) => ({ parent: String(h.bottle!.id), keys: [indexKey], objects: true })), ctx.atCheckpoint),
    objectsOfType(V1_ORACLE_TYPE, ctx.atCheckpoint),
  ]);
  const oracleByCoin = new Map<string, { price: number; at_s: number }>();
  for (const o of oracles) {
    const coin = coinTypeOf(typeArgs(o.type)[0]);
    if (coin && o.json) oracleByCoin.set(coin, { price: fixed(uint(o.json.price), uint(o.json.precision)), at_s: Math.floor(Number(o.json.latest_update_ms ?? 0) / 1000) });
  }
  const built = held.map(({ bucket, bottle, surplus }) => {
    const oracle = oracleByCoin.get(bucket.coin_type);
    const collLeg = (amount: bigint, note?: string): LendingLeg => ({
      coin_type: bucket.coin_type,
      amount,
      side: "supply",
      decimals: bucket.decimals,
      oracle_price: oracle?.price ?? null,
      oracle_at_s: oracle?.at_s,
      ...(note ? { note } : {}),
    });
    const legs: LendingLeg[] = [];
    if (bottle) {
      const j = withBottle.findIndex((h) => h.bucket === bucket);
      const t = interestRows[j][0] as Json | null;
      const interest = t ? { rate: uint(t.interest_rate), active_index: uint(t.active_interest_index), updated_ms: uint(t.last_active_index_update) } : null;
      const idx = indexRows[j][0] as Json | null;
      const { collateral, debt } = v1Bottle(bottle, bucket, interest, idx ? uint(idx.active_interest_index) : null, times.state_ms);
      legs.push(collLeg(collateral), { coin_type: BUCK, amount: debt, side: "borrow" });
    }
    if (surplus) legs.push(collLeg(uint(surplus.collateral_amount), "Surplus collateral left after liquidation or redemption, claimable by the debtor."));
    return { bucket, legs };
  });
  const prices = await priceLendingLegs(
    built.flatMap((b) => b.legs),
    ctx,
  );
  const sui = oracleByCoin.get(SUI_TYPE) ?? null;
  return built.map(({ bucket, legs }) =>
    withCollateralRatio(
      assembleLending(
        {
          protocol: "Bucket",
          kind: "lending",
          object_id: null,
          oracle: "bucket_oracle",
          sui_oracle: sui,
          at_s: times.price_s,
          method: `Bucket v1 bucket ${bucket.bucket_id} read ${stateNote(ctx, false)} for debtor ${owner}: collateral and debt include the bottle's share of redistributions, and debt grows by the bucket's interest index since the bottle last settled. ${BUCKET_RATIOS_NOTE} While the bucket's own collateral ratio is below its recovery-mode threshold, it mints nothing and a bottle below that threshold can be liquidated, which these ratios do not measure.`,
          health: { min_collateral_ratio: bucket.min_collateral_ratio, ...(bucket.recovery_mode_threshold == null ? {} : { recovery_mode_threshold: bucket.recovery_mode_threshold }) },
          detail: { version: 1, bucket_id: bucket.bucket_id, debtor: owner },
        },
        legs,
        prices,
      ),
    ),
  );
}

/**
 * A CDP may borrow down to its minimum collateral ratio and is liquidated
 * below it, so its borrow limit and its liquidation line are both its
 * collateral over that ratio, and both health ratios are the minimum over
 * the position's collateral ratio.
 */
const BUCKET_HEALTH_RATIOS: HealthRatios = {
  borrow_limit_used: ["min_collateral_ratio", "collateral_ratio"],
  liquidation_threshold_used: ["min_collateral_ratio", "collateral_ratio"],
};
const BUCKET_RATIOS_NOTE =
  "Bucket stores no USD figure, so with debt and both sides priced the collateral ratio is taken at the prices the legs are valued at, and both health ratios are the minimum collateral ratio over it: the position may borrow down to that ratio and is liquidated below it.";

/** Adds the collateral ratio at the prices used, and the health ratios from it, when both sides are priced and there is debt. */
function withCollateralRatio(p: ValuedPosition): ValuedPosition {
  const supply = p.assets.filter((a) => a.side === "supply").reduce((n, a) => (n === null || a.usd === null ? null : n + a.usd), 0 as number | null);
  const debt = p.assets.filter((a) => a.side === "borrow").reduce((n, a) => (n === null || a.usd === null ? null : n + a.usd), 0 as number | null);
  if (supply !== null && debt !== null && debt > 0) {
    p.health = withHealthRatios({ ...p.health, collateral_ratio: Math.round((supply / debt) * 10_000) / 10_000 }, BUCKET_HEALTH_RATIOS);
    p.detail = { ...p.detail, health_ratios: BUCKET_HEALTH_RATIOS };
  }
  return p;
}

/* ------------------------------------------------------------------ *
 * Valuer
 * ------------------------------------------------------------------ */

async function valueOwner(ctx: ValuationContext): Promise<ValuerResult> {
  const owner = normalizeAddress(ctx.owner);
  const times = await valuationTimes(ctx);
  const unread: ValuerResult["unread"] = [];
  let accounts: Array<{ address: string; object_id: string | null }> = [];
  try {
    const listing = await listOwned(owner, V2_ACCOUNT_TYPE, ctx.atCheckpoint);
    accounts = listing.objects.map((a) => ({ address: a.object_id, object_id: a.object_id }));
    if (!listing.complete) unread.push({ what: `bucket: ${V2_ACCOUNT_TYPE}`, reason: `Only the first ${accounts.length} of the owner's Bucket accounts were read.` });
  } catch (err) {
    unread.push({ what: `bucket: ${V2_ACCOUNT_TYPE}`, reason: `The owner's Bucket accounts could not be listed: ${err instanceof Error ? err.message : String(err)}` });
  }
  const [v2, v1] = await Promise.all([valueV2([{ address: owner, object_id: null }, ...accounts], ctx, times), valueV1(owner, ctx, times)]);
  return { positions: [...v2, ...v1], unread };
}

export const bucketValuer: PositionValuer = {
  name: "bucket",
  value: valueOwner,
  handles: (type) => type === V2_ACCOUNT_TYPE,
  valueObject: async (obj: ObjectToValue, ctx) => {
    return { positions: await valueV2([{ address: obj.object_id, object_id: obj.object_id }], ctx, await valuationTimes(ctx)), unread: [] };
  },
};

registerValuer(bucketValuer);
