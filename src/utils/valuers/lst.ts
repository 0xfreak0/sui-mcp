/**
 * Liquid-staking coins: a wallet's balance of an LST converted to the SUI it
 * redeems for at the issuer's own exchange rate, priced at the SUI price.
 *
 * Each issuer's rate is recomputed from the fields its Move code reads, with
 * the same integer arithmetic, so a read of the issuer's objects at a
 * checkpoint gives the rate as of that checkpoint:
 *
 * - SpringSui framework, every `LiquidStakingInfo<T>`: `lst_amount_to_sui_amount`
 *   is amount x (storage.total_sui_supply - accrued_spread_fees) / total_supply
 *   of the treasury cap the info object holds. The info object owns its coin's
 *   treasury cap, so there is exactly one per coin type.
 * - Aftermath afSUI: `afsui_to_sui` is amount x rate / 1e18 with
 *   rate = total_sui_amount x 1e18 / total_supply, from the vault state and the
 *   treasury cap in its Safe.
 * - Haedal haSUI: `get_sui_by_stsui` is amount x total_sui / stsui_supply with
 *   total_sui = total_staked + total_rewards - total_protocol_fees
 *   - uncollected_protocol_fees - total_unstaked.
 * - Volo vSUI through its StakePool: `lst_amount_to_sui_amount` is
 *   amount x (validator_pool.total_sui_supply - accrued_reward_fees) / supply,
 *   where supply is the CERT supply less the constant the StakePool package's
 *   `cert::get_total_supply_value` subtracts. Before the StakePool existed the
 *   NativePool's `from_shares` rule applies to the whole CERT supply:
 *   amount x 1e18 / ratio with ratio = supply x 1e18 / total, total being the
 *   `total_staked` table entry for `staked_update_epoch` plus pending, plus
 *   total_rewards less collected_rewards, less the unstake tickets' supply.
 */

import { bcs } from "@mysten/sui/bcs";
import { deriveDynamicFieldID } from "@mysten/sui/utils";
import { gqlQuery } from "../../clients/graphql.js";
import { sui } from "../../clients/grpc.js";
import { getNetwork } from "../../config.js";
import { normalizeCoinType } from "../coin-registry.js";
import { registerValuer, type ValuationContext, type ValuedPosition, type ValuerResult } from "../position-value.js";
import { assemblePosition, bigField, priceCoinTypes, readObjects, stateNote, SUI_TYPE, type ObjectState } from "./common.js";

/** Original id of the SpringSui liquid_staking package, which names `LiquidStakingInfo` in every version. */
export const SPRINGSUI_PACKAGE = "0xb0575765166030556a6eafd3b1b970eba8183ff748860680245b9edd41c716e7";
const SPRINGSUI_INFO_TYPE = `${SPRINGSUI_PACKAGE}::liquid_staking::LiquidStakingInfo`;

export const AFSUI_TYPE = normalizeCoinType("0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI")!;
/** The vault's dynamic object field 0, `StakedSuiVaultStateV1`. */
const AFTERMATH_STATE = "0x55486449e41d89cfbdb20e005c1c5c1007858ad5b4d5d7c047d2b3b592fe8791";
/** `Safe<TreasuryCap<AFSUI>>`. */
const AFTERMATH_SAFE = "0xeb685899830dd5837b47007809c76d91a098d52aabbf61e8ac467c59e5cc4610";

export const HASUI_TYPE = normalizeCoinType("0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI")!;
const HAEDAL_STAKING = "0x47b224762220393057ebf4f70501b6e657c3e56684737568439a04f80849b2ca";

export const VSUI_TYPE = normalizeCoinType("0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT")!;
const VOLO_STAKE_POOL = "0x2d914e23d82fedef1b5f56a32d5c64bdcc3087ccfea2b4d6ea51a71f587840e5";
const VOLO_NATIVE_POOL = "0x7fa2faa111b8c65bea48a23049bfd81ca8f971a262d981dcd9a17c3825cb5baf";
/** `Metadata<CERT>`, holding the CERT supply. */
const VOLO_METADATA = "0x680cd26af32b2bde8d3361e804c53ec1d1cfe24c7f039eb7f549e8dfde389a60";
/** Subtracted from the CERT supply by `cert::get_total_supply_value` from the package version that added the StakePool. */
export const VOLO_EXCLUDED_SUPPLY = 157_564_800_000_000n;

const WAD = 1_000_000_000_000_000_000n;

/** The SpringSui info set is re-read after this long, so a newly issued LST is found. */
const SPRINGSUI_CACHE_MS = 60 * 60_000;
const OBJECTS_PAGE = 50;
const BALANCES_PAGE = 200;

/** An issuer's rate as its Move code computes it. */
export interface LstRate {
  /** SUI side of the ratio. */
  total_sui: bigint;
  /** LST side of the ratio. */
  total_lst: bigint;
  /** SUI for an LST amount, rounded the way the issuer rounds. */
  toSui(amount: bigint): bigint;
}

type Json = Record<string, unknown>;

function field(json: unknown, ...path: string[]): unknown {
  let v: unknown = json;
  for (const k of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Json)[k];
  }
  return v;
}

function big(json: unknown, ...path: string[]): bigint | null {
  return bigField(field(json, ...path));
}

/** A ratio rule `amount x sui / lst`; null when the issuer's code would abort on a zero supply. */
function directRate(total_sui: bigint, total_lst: bigint): LstRate | null {
  if (total_sui < 0n || total_lst <= 0n) return null;
  return { total_sui, total_lst, toSui: (amount) => (amount * total_sui) / total_lst };
}

/** SpringSui `LiquidStakingInfo<T>`; `accrued_spread_fees` absent reads as zero. */
export function springSuiRate(info: Json): LstRate | null {
  const supply = big(info, "storage", "total_sui_supply");
  const lst = big(info, "lst_treasury_cap", "total_supply", "value");
  const spread = field(info, "accrued_spread_fees") === undefined ? 0n : big(info, "accrued_spread_fees");
  if (supply === null || lst === null || spread === null) return null;
  return directRate(supply - spread, lst);
}

/** Aftermath `StakedSuiVaultStateV1` and `Safe<TreasuryCap<AFSUI>>`. */
export function aftermathRate(state: Json, safe: Json): LstRate | null {
  const total_sui = big(state, "total_sui_amount");
  const total_lst = big(safe, "obj", "total_supply", "value");
  if (total_sui === null || total_lst === null) return null;
  // A zero on either side makes `afsui_to_sui_exchange_rate` zero.
  const rate = total_sui === 0n || total_lst === 0n ? 0n : (total_sui * WAD) / total_lst;
  return { total_sui, total_lst, toSui: (amount) => (amount * rate) / WAD };
}

/** Haedal `Staking`. */
export function haedalRate(staking: Json): LstRate | null {
  const parts = ["total_staked", "total_rewards", "total_protocol_fees", "uncollected_protocol_fees", "total_unstaked", "stsui_supply"].map((k) =>
    big(staking, k),
  );
  if (parts.some((p) => p === null)) return null;
  const [staked, rewards, fees, uncollected, unstaked, supply] = parts as bigint[];
  const total_sui = staked + rewards - fees - uncollected - unstaked;
  if (total_sui < 0n) return null;
  // A zero on either side is 1:1 in `get_sui_by_stsui`.
  const toSui = total_sui === 0n || supply === 0n ? (amount: bigint) => amount : (amount: bigint) => (amount * total_sui) / supply;
  return { total_sui, total_lst: supply, toSui };
}

/** Volo `StakePool` and `Metadata<CERT>`. */
export function voloStakePoolRate(pool: Json, metadata: Json): LstRate | null {
  const supply = big(pool, "validator_pool", "total_sui_supply");
  const fees = big(pool, "accrued_reward_fees");
  const cert = big(metadata, "total_supply", "value");
  if (supply === null || fees === null || cert === null) return null;
  return directRate(supply - fees, cert - VOLO_EXCLUDED_SUPPLY);
}

/** Volo `NativePool`, its `total_staked` entry for `staked_update_epoch`, and `Metadata<CERT>`. */
export function voloNativePoolRate(pool: Json, stakedAtEpoch: bigint, metadata: Json): LstRate | null {
  const pending = big(pool, "pending", "balance");
  const rewards = big(pool, "total_rewards");
  const collected = big(pool, "collected_rewards");
  const tickets = big(pool, "ticket_metadata", "total_supply");
  const lst = big(metadata, "total_supply", "value");
  if (pending === null || rewards === null || collected === null || tickets === null || lst === null) return null;
  const total_sui = stakedAtEpoch + pending + rewards - collected - tickets;
  if (total_sui < 0n) return null;
  // `math::ratio` is 1e18 for a zero total; `from_shares` aborts on a zero ratio.
  const ratio = total_sui === 0n ? WAD : (lst * WAD) / total_sui;
  if (ratio === 0n) return null;
  return { total_sui, total_lst: lst, toSui: (amount) => (amount * WAD) / ratio };
}

/** One issuer's rate with where it came from. */
export interface IssuerRead {
  rate: LstRate;
  issuer: string;
  issuer_object: string;
  /** The fields and formula, without the checkpoint note. */
  formula: string;
  current: boolean;
}

interface Issuer {
  name: string;
  /** Objects to read at the checkpoint. */
  objects(atCheckpoint?: string): string[];
  /** The rate from those objects; throws with the reason when it cannot be read. */
  read(states: Map<string, ObjectState>, atCheckpoint?: string): Promise<IssuerRead>;
}

function need(states: Map<string, ObjectState>, id: string, what: string): ObjectState {
  const s = states.get(id);
  if (!s) throw new Error(`${what} ${id} could not be read`);
  return s;
}

function springSuiIssuer(infoId: string): Issuer {
  return {
    name: "SpringSui",
    objects: () => [infoId],
    async read(states) {
      const info = need(states, infoId, "LiquidStakingInfo");
      const rate = springSuiRate(info.json);
      if (!rate) throw new Error(`LiquidStakingInfo ${infoId} has no readable SUI or LST supply`);
      return {
        rate,
        issuer: "SpringSui",
        issuer_object: infoId,
        formula: `SUI per LST is (storage.total_sui_supply - accrued_spread_fees) / lst_treasury_cap.total_supply of LiquidStakingInfo ${infoId}, the rule of liquid_staking::lst_amount_to_sui_amount`,
        current: info.current,
      };
    },
  };
}

const AFTERMATH: Issuer = {
  name: "Aftermath",
  objects: () => [AFTERMATH_STATE, AFTERMATH_SAFE],
  async read(states) {
    const state = need(states, AFTERMATH_STATE, "StakedSuiVaultStateV1");
    const safe = need(states, AFTERMATH_SAFE, "Safe<TreasuryCap<AFSUI>>");
    const rate = aftermathRate(state.json, safe.json);
    if (!rate) throw new Error("the afSUI vault state or treasury cap has no readable total");
    return {
      rate,
      issuer: "Aftermath",
      issuer_object: AFTERMATH_STATE,
      formula: `SUI per afSUI is total_sui_amount of StakedSuiVaultStateV1 ${AFTERMATH_STATE} over the AFSUI treasury cap's total_supply in Safe ${AFTERMATH_SAFE}, scaled by 1e18 as staked_sui_vault::afsui_to_sui does`,
      current: state.current || safe.current,
    };
  },
};

const HAEDAL: Issuer = {
  name: "Haedal",
  objects: () => [HAEDAL_STAKING],
  async read(states) {
    const staking = need(states, HAEDAL_STAKING, "Staking");
    const rate = haedalRate(staking.json);
    if (!rate) throw new Error(`Staking ${HAEDAL_STAKING} has no readable totals`);
    return {
      rate,
      issuer: "Haedal",
      issuer_object: HAEDAL_STAKING,
      formula: `SUI per haSUI is (total_staked + total_rewards - total_protocol_fees - uncollected_protocol_fees - total_unstaked) / stsui_supply of Staking ${HAEDAL_STAKING}, the rule of staking::get_sui_by_stsui`,
      current: staking.current,
    };
  },
};

const VOLO: Issuer = {
  name: "Volo",
  objects: (atCheckpoint) => (atCheckpoint === undefined ? [VOLO_STAKE_POOL, VOLO_METADATA] : [VOLO_STAKE_POOL, VOLO_METADATA, VOLO_NATIVE_POOL]),
  async read(states, atCheckpoint) {
    const metadata = need(states, VOLO_METADATA, "Metadata<CERT>");
    const pool = states.get(VOLO_STAKE_POOL);
    const native = states.get(VOLO_NATIVE_POOL);
    // The NativePool ran vSUI until the StakePool replaced it and it was paused.
    if (atCheckpoint !== undefined && (!pool || pool.current) && native && !native.current && native.json.paused !== true) {
      const epoch = big(native.json, "staked_update_epoch");
      const table = field(native.json, "total_staked", "id");
      if (epoch === null || typeof table !== "string") throw new Error(`NativePool ${VOLO_NATIVE_POOL} has no readable total_staked table`);
      // The Field object holding `total_staked[epoch]`, read at the checkpoint like its parent.
      const entryId = deriveDynamicFieldID(table, "u64", bcs.u64().serialize(epoch).toBytes());
      const entry = (await readObjects([entryId], atCheckpoint)).get(entryId);
      const staked = entry && !entry.current ? big(entry.json, "value") : null;
      if (staked === null) throw new Error(`the NativePool total_staked entry for epoch ${epoch} could not be read at checkpoint ${atCheckpoint}`);
      const rate = voloNativePoolRate(native.json, staked, metadata.json);
      if (!rate) throw new Error(`NativePool ${VOLO_NATIVE_POOL} has no readable totals`);
      return {
        rate,
        issuer: "Volo",
        issuer_object: VOLO_NATIVE_POOL,
        formula:
          `SUI per vSUI is (total_staked[staked_update_epoch] + pending + total_rewards - collected_rewards - ticket_metadata.total_supply) of NativePool ${VOLO_NATIVE_POOL} ` +
          `over the CERT supply of Metadata ${VOLO_METADATA}, as native_pool::from_shares computes it`,
        current: metadata.current,
      };
    }
    if (!pool) throw new Error(`StakePool ${VOLO_STAKE_POOL} could not be read`);
    const rate = voloStakePoolRate(pool.json, metadata.json);
    if (!rate) throw new Error(`StakePool ${VOLO_STAKE_POOL} has no readable totals`);
    return {
      rate,
      issuer: "Volo",
      issuer_object: VOLO_STAKE_POOL,
      formula:
        `SUI per vSUI is (validator_pool.total_sui_supply - accrued_reward_fees) of StakePool ${VOLO_STAKE_POOL} ` +
        `over the CERT supply of Metadata ${VOLO_METADATA} less ${VOLO_EXCLUDED_SUPPLY}, the rule of stake_pool::lst_amount_to_sui_amount`,
      current: pool.current || metadata.current,
    };
  },
};

const FIXED_ISSUERS: Record<string, Issuer> = {
  [AFSUI_TYPE]: AFTERMATH,
  [HASUI_TYPE]: HAEDAL,
  [VSUI_TYPE]: VOLO,
};

interface InfoPage {
  objects: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ address: string; asMoveObject: { contents: { type: { repr: string } } | null } | null }>;
  };
}

const INFO_QUERY = `query($t: String!, $after: String) {
  objects(filter: { type: $t }, first: ${OBJECTS_PAGE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { address asMoveObject { contents { type { repr } } } }
  }
}`;

/** Every SpringSui `LiquidStakingInfo<T>`, keyed by T. */
async function readSpringSuiInfos(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let after: string | null = null;
  for (;;) {
    const d: InfoPage = await gqlQuery<InfoPage>(INFO_QUERY, { t: SPRINGSUI_INFO_TYPE, after });
    for (const n of d.objects.nodes) {
      const repr = n.asMoveObject?.contents?.type.repr;
      const inner = repr?.match(/^[^<]+<(.+)>$/)?.[1];
      const coin = inner ? normalizeCoinType(inner) : null;
      if (coin) out.set(coin, n.address);
    }
    if (!d.objects.pageInfo.hasNextPage || !d.objects.pageInfo.endCursor) return out;
    after = d.objects.pageInfo.endCursor;
  }
}

const springSuiCache = new Map<string, { at: number; infos: Promise<Map<string, string>> }>();

function springSuiInfos(): Promise<Map<string, string>> {
  const key = getNetwork();
  const hit = springSuiCache.get(key);
  if (hit && Date.now() - hit.at < SPRINGSUI_CACHE_MS) return hit.infos;
  const infos = readSpringSuiInfos();
  const entry = { at: Date.now(), infos };
  infos.catch(() => {
    if (springSuiCache.get(key) === entry) springSuiCache.delete(key);
  });
  springSuiCache.set(key, entry);
  return infos;
}

/** Forget the SpringSui info set, so the next lookup reads it again. */
export function resetLstIssuers(): void {
  springSuiCache.clear();
}

/** The issuers are mainnet objects; other networks have none. */
function issuersApply(): boolean {
  return getNetwork() === "mainnet";
}

function issuerFor(coinType: string, springSui: Map<string, string>): Issuer | null {
  const fixed = FIXED_ISSUERS[coinType];
  if (fixed) return fixed;
  const info = springSui.get(coinType);
  return info ? springSuiIssuer(info) : null;
}

/** Rates for many LST coin types with one read of their issuers' objects. Errors are per coin type. */
async function readRates(issuers: Map<string, Issuer>, atCheckpoint?: string): Promise<Map<string, IssuerRead | Error>> {
  const ids = [...issuers.values()].flatMap((i) => i.objects(atCheckpoint));
  const states = await readObjects(ids, atCheckpoint);
  const out = new Map<string, IssuerRead | Error>();
  for (const [coin, issuer] of issuers) {
    try {
      out.set(coin, await issuer.read(states, atCheckpoint));
    } catch (err) {
      out.set(coin, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return out;
}

/**
 * SUI per unit of an LST from its issuer's state at `atCheckpoint`, or the
 * latest state without one. Null for a coin type no known issuer mints;
 * throws when the issuer's state cannot be read.
 */
export async function suiPerLst(
  coinType: string,
  atCheckpoint?: string,
): Promise<{ sui_per_lst: number; issuer: string; issuer_object: string; method: string; current: boolean } | null> {
  if (!issuersApply()) return null;
  const coin = normalizeCoinType(coinType);
  if (!coin) return null;
  const issuer = issuerFor(coin, coin in FIXED_ISSUERS ? new Map() : await springSuiInfos());
  if (!issuer) return null;
  const r = (await readRates(new Map([[coin, issuer]]), atCheckpoint)).get(coin)!;
  if (r instanceof Error) throw r;
  return {
    sui_per_lst: Number(r.rate.total_sui) / Number(r.rate.total_lst),
    issuer: r.issuer,
    issuer_object: r.issuer_object,
    method: `${r.formula}, ${stateNote({ owner: "", atCheckpoint }, r.current)}.`,
    current: r.current,
  };
}

/** Every coin type the owner holds a nonzero balance of, with its total balance. */
async function heldBalances(owner: string): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  let cursor: string | null = null;
  for (;;) {
    const res = await sui.listBalances({ owner, limit: BALANCES_PAGE, cursor });
    for (const b of res.balances) {
      const coin = normalizeCoinType(b.coinType);
      const amount = bigField(b.balance);
      if (coin && amount !== null && amount > 0n) out.set(coin, amount);
    }
    if (!res.hasNextPage || !res.cursor) return out;
    cursor = res.cursor;
  }
}

export async function valueLsts(ctx: ValuationContext): Promise<ValuerResult> {
  if (!issuersApply()) return { positions: [], unread: [] };
  const unread: ValuerResult["unread"] = [];
  const balances = await heldBalances(ctx.owner);
  let springSui = new Map<string, string>();
  if ([...balances.keys()].some((c) => !(c in FIXED_ISSUERS) && c !== SUI_TYPE)) {
    try {
      springSui = await springSuiInfos();
    } catch (err) {
      unread.push({ what: "SpringSui LiquidStakingInfo set", reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const issuers = new Map<string, Issuer>();
  for (const coin of balances.keys()) {
    const issuer = issuerFor(coin, springSui);
    if (issuer) issuers.set(coin, issuer);
  }
  if (issuers.size === 0) return { positions: [], unread };

  const rates = await readRates(issuers, ctx.atCheckpoint);
  const prices = await priceCoinTypes([SUI_TYPE], ctx);
  const balanceNote = ctx.atCheckpoint === undefined ? "" : " The LST balance is the owner's latest, not the one at that checkpoint.";
  const positions: ValuedPosition[] = [];
  for (const [coin, r] of rates) {
    const amount = balances.get(coin)!;
    if (r instanceof Error) {
      unread.push({ what: coin, reason: `${issuers.get(coin)!.name} state: ${r.message}` });
      continue;
    }
    const suiAmount = r.rate.toSui(amount);
    positions.push(
      assemblePosition(
        {
          protocol: r.issuer,
          kind: "lst",
          object_id: null,
          method: `The SUI is the LST balance converted by the issuer's integer rule, where ${r.formula}, ${stateNote(ctx, r.current)}.${balanceNote}`,
          detail: {
            lst_coin_type: coin,
            lst_amount: amount.toString(),
            sui_per_lst: Number(r.rate.total_sui) / Number(r.rate.total_lst),
            issuer_object: r.issuer_object,
            receipt_coin_types: [coin],
          },
        },
        [{ coin_type: SUI_TYPE, amount: suiAmount, side: "stake" }],
        prices,
      ),
    );
  }
  return { positions, unread };
}

registerValuer({ name: "lst", value: valueLsts });
