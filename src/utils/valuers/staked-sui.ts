/**
 * Staked SUI: a StakedSui's principal plus the rewards it has accrued, and a
 * FungibleStakedSui's pool tokens, both converted at the validator pool's
 * exchange rates the way `staking_pool` computes a withdrawal.
 *
 * A StakedSui's pool tokens are its principal at the rate of its activation
 * epoch; its SUI worth at epoch E is those tokens at E's rate. Rates are
 * entries of the pool's `exchange_rates` table keyed by epoch, written once
 * per epoch and never changed, so a past epoch's rate is read the same way
 * as the current one.
 */

import { gqlQuery } from "../../clients/graphql.js";
import { getNetwork } from "../../config.js";
import { listOwnedWithJson } from "../owned-objects.js";
import { registerValuer, type ObjectToValue, type ValuationContext, type ValuedPosition, type ValuerResult } from "../position-value.js";
import { assemblePosition, bigField, priceCoinTypes, SUI_TYPE, valuationEpoch } from "./common.js";

export const STAKED_SUI_TYPE = "0x3::staking_pool::StakedSui";
export const FUNGIBLE_STAKED_SUI_TYPE = "0x3::staking_pool::FungibleStakedSui";

/** Positions of one type read per owner before the set is reported as incomplete. */
const MAX_STAKES = 1000;

/** Epochs below the wanted one asked for in the same request, for a pool that skipped an epoch. */
const RATE_LOOKBACK = 4;

/** Validator pools are re-read after this long, so a pool that changed state is seen. */
const POOL_CACHE_MS = 10 * 60_000;

/** Table keys asked for in one multi-get. */
const KEYS_PER_REQUEST = 50;

export interface ExchangeRate {
  sui_amount: bigint;
  pool_token_amount: bigint;
}

/** SUI for pool tokens at a rate; a zero rate is 1:1, as `get_sui_amount` has it. */
export function suiForTokens(rate: ExchangeRate, tokens: bigint): bigint {
  if (rate.sui_amount === 0n || rate.pool_token_amount === 0n) return tokens;
  return (rate.sui_amount * tokens) / rate.pool_token_amount;
}

/** Pool tokens for SUI at a rate; a zero rate is 1:1, as `get_token_amount` has it. */
export function tokensForSui(rate: ExchangeRate, sui: bigint): bigint {
  if (rate.sui_amount === 0n || rate.pool_token_amount === 0n) return sui;
  return (rate.pool_token_amount * sui) / rate.sui_amount;
}

/**
 * Principal and reward of a StakedSui withdrawn at `epoch`, as
 * `staking_pool::withdraw_rewards` computes them. A stake not yet active at
 * `epoch` has no reward. The reward is never negative.
 */
export function stakeWorth(
  principal: bigint,
  activationEpoch: number,
  epoch: number,
  activationRate: ExchangeRate,
  epochRate: ExchangeRate,
): { principal: bigint; reward: bigint } {
  if (activationEpoch > epoch) return { principal, reward: 0n };
  const total = suiForTokens(epochRate, tokensForSui(activationRate, principal));
  return { principal, reward: total > principal ? total - principal : 0n };
}

export interface PoolInfo {
  pool_id: string;
  /** Id of the pool's `exchange_rates` table. */
  rates_table: string;
  activation_epoch: number | null;
  deactivation_epoch: number | null;
  /** Where the pool was found. */
  status: "active" | "inactive" | "pending";
}

interface SystemTables {
  active: Map<string, PoolInfo>;
  inactive_validators: string;
  staking_pool_mappings: string;
}

interface PoolJson {
  id?: string;
  activation_epoch?: string | null;
  deactivation_epoch?: string | null;
  exchange_rates?: { id?: string };
}

function readPool(pool: PoolJson | undefined, status: PoolInfo["status"]): PoolInfo | null {
  if (!pool?.id || !pool.exchange_rates?.id) return null;
  const epochOf = (v: string | null | undefined) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
  return {
    pool_id: pool.id,
    rates_table: pool.exchange_rates.id,
    activation_epoch: epochOf(pool.activation_epoch),
    deactivation_epoch: epochOf(pool.deactivation_epoch),
    status,
  };
}

const systemCache = new Map<string, { at: number; tables: Promise<SystemTables> }>();

/** The active validators' pools and the ids of the tables holding the rest. */
function systemTables(): Promise<SystemTables> {
  const network = getNetwork();
  const hit = systemCache.get(network);
  if (hit && Date.now() - hit.at < POOL_CACHE_MS) return hit.tables;
  const tables = gqlQuery<{
    epoch: {
      validatorSet: {
        contents: {
          json: {
            active_validators: Array<{ staking_pool?: PoolJson }>;
            inactive_validators: { id: string };
            staking_pool_mappings: { id: string };
          };
        } | null;
      } | null;
    } | null;
  }>(`{ epoch { validatorSet { contents { json } } } }`).then((d) => {
    const json = d.epoch?.validatorSet?.contents?.json;
    if (!json) throw new Error("the validator set could not be read");
    const active = new Map<string, PoolInfo>();
    for (const v of json.active_validators) {
      const pool = readPool(v.staking_pool, "active");
      if (pool) active.set(pool.pool_id, pool);
    }
    return { active, inactive_validators: json.inactive_validators.id, staking_pool_mappings: json.staking_pool_mappings.id };
  });
  tables.catch(() => systemCache.delete(network));
  systemCache.set(network, { at: Date.now(), tables });
  return tables;
}

const idKey = (id: string) => ({ type: "0x2::object::ID", bcs: Buffer.from(id.replace(/^0x/, "").padStart(64, "0"), "hex").toString("base64") });

function u64Key(n: number): { type: string; bcs: string } {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return { type: "u64", bcs: b.toString("base64") };
}

const FIELD_QUERY = `query($id: SuiAddress!, $k: DynamicFieldName!) {
  address(address: $id) { dynamicField(name: $k) { value { ... on MoveValue { json } } } }
}`;

async function tableEntry<T>(table: string, key: { type: string; bcs: string }): Promise<T | null> {
  const d = await gqlQuery<{ address: { dynamicField: { value: { json: T } | null } | null } | null }>(FIELD_QUERY, { id: table, k: key });
  return d.address?.dynamicField?.value?.json ?? null;
}

/** A pool found for a stake: active or inactive with its rates, or pending with none. */
type FoundPool = PoolInfo | { pool_id: string; status: "pending" } | null;

/**
 * The pool a StakedSui names: an active validator's, an inactive one's
 * (the wrapper's versioned inner validator), or a pending validator's,
 * which has no exchange rate yet. Null when the system knows no such pool.
 */
async function findPool(poolId: string, tables: SystemTables): Promise<FoundPool> {
  const active = tables.active.get(poolId);
  if (active) return active;
  const wrapper = await tableEntry<{ inner?: { id?: string; version?: string } }>(tables.inactive_validators, idKey(poolId));
  if (wrapper?.inner?.id && wrapper.inner.version) {
    const validator = await tableEntry<{ staking_pool?: PoolJson }>(wrapper.inner.id, u64Key(Number(wrapper.inner.version)));
    const pool = readPool(validator?.staking_pool, "inactive");
    if (pool) return pool;
  }
  const mapped = await tableEntry<string>(tables.staking_pool_mappings, idKey(poolId));
  return mapped ? { pool_id: poolId, status: "pending" } : null;
}

const INITIAL_RATE: ExchangeRate = { sui_amount: 0n, pool_token_amount: 0n };

/**
 * Rates of one pool at each wanted epoch, resolved as
 * `pool_token_exchange_rate_at_epoch` does: 1:1 before the pool's
 * activation, clamped to its deactivation, else the latest entry at or
 * below the epoch.
 */
async function ratesAt(pool: PoolInfo, epochs: number[]): Promise<Map<number, ExchangeRate>> {
  const out = new Map<number, ExchangeRate>();
  const table = new Map<number, ExchangeRate | null>();
  const pending = new Map<number, number>();
  for (const e of new Set(epochs)) {
    if (pool.activation_epoch === null || e < pool.activation_epoch) {
      out.set(e, INITIAL_RATE);
      continue;
    }
    pending.set(e, pool.deactivation_epoch === null ? e : Math.min(e, pool.deactivation_epoch));
  }
  const floor = pool.activation_epoch ?? 0;
  while (pending.size > 0) {
    const wanted = new Set<number>();
    for (const clamped of pending.values()) {
      for (let k = clamped; k >= Math.max(floor, clamped - RATE_LOOKBACK); k--) if (!table.has(k)) wanted.add(k);
    }
    const keys = [...wanted].slice(0, KEYS_PER_REQUEST);
    if (keys.length > 0) {
      const d = await gqlQuery<{
        address: { multiGetDynamicFields: Array<{ value: { json: { sui_amount: string; pool_token_amount: string } } | null } | null> } | null;
      }>(
        `query($id: SuiAddress!, $keys: [DynamicFieldName!]!) { address(address: $id) { multiGetDynamicFields(keys: $keys) { value { ... on MoveValue { json } } } } }`,
        { id: pool.rates_table, keys: keys.map(u64Key) },
      );
      const rows = d.address?.multiGetDynamicFields ?? [];
      keys.forEach((k, i) => {
        const json = rows[i]?.value?.json;
        table.set(k, json ? { sui_amount: BigInt(json.sui_amount), pool_token_amount: BigInt(json.pool_token_amount) } : null);
      });
    }
    let progressed = keys.length > 0;
    for (const [e, clamped] of [...pending]) {
      let k = clamped;
      while (k >= floor && table.has(k) && table.get(k) === null) k--;
      if (k < floor) {
        // No entry from activation up: the pool's code falls back to 1:1.
        out.set(e, INITIAL_RATE);
        pending.delete(e);
      } else if (table.get(k)) {
        out.set(e, table.get(k)!);
        pending.delete(e);
      } else {
        pending.set(e, k);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * `ratesAt` through the call's memo: a rate is written once per epoch and
 * never changes, so one read serves every stake of that pool and epoch.
 */
async function memoRatesAt(pool: PoolInfo, epochs: number[], memo: ValuationContext["memo"]): Promise<Map<number, ExchangeRate>> {
  if (!memo) return ratesAt(pool, epochs);
  const keyOf = (e: number) => `stake-rate:${getNetwork()}:${pool.rates_table}:${e}`;
  const unique = [...new Set(epochs)];
  const missing = unique.filter((e) => !memo.has(keyOf(e)));
  if (missing.length > 0) {
    const read = ratesAt(pool, missing);
    for (const e of missing) memo.set(keyOf(e), read.then((m) => m.get(e) ?? null));
    read.catch(() => {
      for (const e of missing) memo.delete(keyOf(e));
    });
  }
  const answers = unique.map((e) => [e, memo.get(keyOf(e)) as Promise<ExchangeRate | null>] as const);
  const out = new Map<number, ExchangeRate>();
  for (const [e, answer] of answers) {
    const rate = await answer;
    if (rate) out.set(e, rate);
  }
  return out;
}

interface Stake {
  object_id: string;
  pool_id: string;
  /** StakedSui: principal and activation epoch. FungibleStakedSui: pool tokens. */
  principal?: bigint;
  activation_epoch?: number;
  pool_tokens?: bigint;
}

function readStake(obj: ObjectToValue): Stake | null {
  const json = obj.json;
  if (!json || typeof json.pool_id !== "string") return null;
  if (/::staking_pool::FungibleStakedSui$/.test(obj.type)) {
    const tokens = bigField(json.value);
    return tokens === null ? null : { object_id: obj.object_id, pool_id: json.pool_id, pool_tokens: tokens };
  }
  const principal = bigField(json.principal) ?? bigField((json.principal as { value?: unknown } | null)?.value);
  const activation = bigField(json.stake_activation_epoch);
  if (principal === null || activation === null) return null;
  return { object_id: obj.object_id, pool_id: json.pool_id, principal, activation_epoch: Number(activation) };
}

/** Value stakes at the context's epoch, pricing the SUI at its time. */
async function valueStakes(stakes: Stake[], ctx: ValuationContext): Promise<ValuerResult> {
  const unread: ValuerResult["unread"] = [];
  if (stakes.length === 0) return { positions: [], unread };
  const [epoch, tables, prices] = await Promise.all([valuationEpoch(ctx), systemTables(), priceCoinTypes([SUI_TYPE], ctx)]);
  const byPool = new Map<string, Stake[]>();
  for (const s of stakes) byPool.set(s.pool_id, [...(byPool.get(s.pool_id) ?? []), s]);

  const positions: ValuedPosition[] = [];
  for (const [poolId, group] of byPool) {
    const poolKey = `stake-pool:${getNetwork()}:${poolId}`;
    if (ctx.memo && !ctx.memo.has(poolKey)) ctx.memo.set(poolKey, findPool(poolId, tables));
    const pool = await ((ctx.memo?.get(poolKey) as Promise<FoundPool> | undefined) ?? findPool(poolId, tables));
    if (!pool) {
      for (const s of group) unread.push({ what: s.object_id, reason: `validator pool ${poolId} is not in the active, inactive or pending validator set` });
      continue;
    }
    if (pool.status === "pending") {
      // A pool with no activation epoch converts at 1:1 and has earned nothing.
      for (const s of group) {
        const amount = s.principal ?? s.pool_tokens!;
        positions.push(
          assemblePosition(
            {
              protocol: "Sui staking",
              kind: "staked_sui",
              object_id: s.object_id,
              method: `Stake with pending validator pool ${poolId}, which has not been active and so converts 1:1 with no reward, at epoch ${epoch}.`,
              detail: { pool_id: poolId, epoch, principal: amount.toString(), reward: "0" },
            },
            [{ coin_type: SUI_TYPE, amount, side: "stake" }],
            prices,
          ),
        );
      }
      continue;
    }
    const wanted = [epoch, ...group.flatMap((s) => (s.activation_epoch === undefined ? [] : [s.activation_epoch]))];
    const rates = await memoRatesAt(pool, wanted, ctx.memo);
    const epochRate = rates.get(epoch);
    for (const s of group) {
      if (!epochRate) {
        unread.push({ what: s.object_id, reason: `no exchange rate of pool ${poolId} at or below epoch ${epoch}` });
        continue;
      }
      const clamp = pool.deactivation_epoch !== null && pool.deactivation_epoch < epoch ? ` (the pool stopped at epoch ${pool.deactivation_epoch})` : "";
      if (s.pool_tokens !== undefined) {
        const sui = suiForTokens(epochRate, s.pool_tokens);
        positions.push(
          assemblePosition(
            {
              protocol: "Sui staking",
              kind: "staked_sui",
              object_id: s.object_id,
              method: `Fungible staked SUI: ${s.pool_tokens} pool tokens of validator pool ${poolId} at its epoch ${epoch} exchange rate${clamp}.`,
              detail: { pool_id: poolId, epoch, pool_tokens: s.pool_tokens.toString() },
            },
            [{ coin_type: SUI_TYPE, amount: sui, side: "stake" }],
            prices,
          ),
        );
        continue;
      }
      const activationRate = rates.get(s.activation_epoch!);
      if (!activationRate) {
        unread.push({ what: s.object_id, reason: `no exchange rate of pool ${poolId} at activation epoch ${s.activation_epoch}` });
        continue;
      }
      const { principal, reward } = stakeWorth(s.principal!, s.activation_epoch!, epoch, activationRate, epochRate);
      positions.push(
        assemblePosition(
          {
            protocol: "Sui staking",
            kind: "staked_sui",
            object_id: s.object_id,
            method:
              s.activation_epoch! > epoch
                ? `Stake with validator pool ${poolId} activating at epoch ${s.activation_epoch}, after epoch ${epoch}, so it is worth its principal with no reward.`
                : `Principal plus rewards as withdraw_stake computes them: the principal in pool tokens at validator pool ${poolId}'s ` +
                  `activation-epoch ${s.activation_epoch} rate, converted back at its epoch ${epoch} rate${clamp}.`,
            detail: { pool_id: poolId, epoch, activation_epoch: s.activation_epoch, principal: principal.toString(), reward: reward.toString() },
          },
          [
            { coin_type: SUI_TYPE, amount: principal, side: "stake" },
            { coin_type: SUI_TYPE, amount: reward, side: "reward" },
          ],
          prices,
        ),
      );
    }
  }
  return { positions, unread };
}

/** Rewards for already-proven historical holdings, without price lookups. */
export async function estimateStakedSuiRewards(
  stakes: Array<{ object_id: string; pool_id: string; principal_mist: string; stake_activation_epoch: string }>,
  epoch: number,
): Promise<Map<string, string | null>> {
  const rewards = new Map<string, string | null>();
  if (stakes.length === 0) return rewards;
  const tables = await systemTables();
  const groups = new Map<string, typeof stakes>();
  for (const stake of stakes) {
    const group = groups.get(stake.pool_id);
    if (group) group.push(stake);
    else groups.set(stake.pool_id, [stake]);
  }
  for (const [id, group] of groups) {
    try {
      const pool = await findPool(id, tables);
      if (!pool) throw new Error("Pool unavailable");
      if (pool.status === "pending") {
        for (const stake of group) rewards.set(stake.object_id, "0");
        continue;
      }
      const wanted = [...new Set([epoch, ...group.map(s => Number(s.stake_activation_epoch))])];
      const rates = new Map<number, ExchangeRate>();
      for (let i = 0; i < wanted.length; i += KEYS_PER_REQUEST) {
        const batch = wanted.slice(i, i + KEYS_PER_REQUEST);
        const keys = batch.map(e => u64Key(pool.deactivation_epoch === null ? e : Math.min(e, pool.deactivation_epoch)));
        const d = await gqlQuery<{
          address: { multiGetDynamicFields: Array<{ value: { json: { sui_amount: string; pool_token_amount: string } } | null } | null> } | null;
        }>(`query($id:SuiAddress!,$keys:[DynamicFieldName!]!) { address(address:$id) { multiGetDynamicFields(keys:$keys) { value { ... on MoveValue { json } } } } }`,
          { id: pool.rates_table, keys });
        batch.forEach((e, j) => {
          const json = d.address?.multiGetDynamicFields[j]?.value?.json;
          if (json) rates.set(e, { sui_amount: BigInt(json.sui_amount), pool_token_amount: BigInt(json.pool_token_amount) });
        });
      }
      for (const stake of group) {
        const activation = Number(stake.stake_activation_epoch);
        const atStart = rates.get(activation);
        const atEnd = rates.get(epoch);
        rewards.set(stake.object_id, activation > epoch ? "0" : atStart && atEnd
          ? stakeWorth(BigInt(stake.principal_mist), activation, epoch, atStart, atEnd).reward.toString()
          : null);
      }
    } catch {
      for (const stake of group) rewards.set(stake.object_id, null);
    }
  }
  return rewards;
}

const STAKE_TYPE = /^0x0*3::staking_pool::(StakedSui|FungibleStakedSui)$/;

registerValuer({
  name: "staked_sui",
  async value(ctx) {
    const unread: ValuerResult["unread"] = [];
    const stakes: Stake[] = [];
    for (const type of [STAKED_SUI_TYPE, FUNGIBLE_STAKED_SUI_TYPE]) {
      const { objects, complete } = await listOwnedWithJson(ctx.owner, type, MAX_STAKES);
      if (!complete) unread.push({ what: type, reason: `more than ${MAX_STAKES} held; only the first ${objects.length} are valued` });
      for (const o of objects) {
        const stake = readStake({ object_id: o.objectId, type: o.type, json: o.json });
        if (stake) stakes.push(stake);
        else unread.push({ what: o.objectId, reason: "its pool, principal or activation epoch could not be read" });
      }
    }
    if (ctx.atCheckpoint !== undefined && stakes.length > 0) {
      unread.push({ what: "staked_sui holdings", reason: `the stakes listed are those held now; the set held at checkpoint ${ctx.atCheckpoint} is not listed` });
    }
    const valued = await valueStakes(stakes, ctx);
    return { positions: valued.positions, unread: [...unread, ...valued.unread] };
  },
  handles: (type) => STAKE_TYPE.test(type),
  async valueObject(obj, ctx) {
    const stake = readStake(obj);
    if (!stake) return { positions: [], unread: [{ what: obj.object_id, reason: "its pool, principal or activation epoch could not be read" }] };
    return valueStakes([stake], ctx);
  },
});
