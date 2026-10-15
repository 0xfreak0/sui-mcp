import { z } from "zod";
import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { sui } from "../clients/grpc.js";
import { scanTokenTopHolders, sampledHolders } from "../tools/holders.js";
import { fetchKinds } from "./identity.js";
import { isUnspendableAddress } from "./upgrade-cap.js";
import { resolvePublisher } from "./publisher.js";
import { capPayload } from "./output-cap.js";
import type { ListCap, NextCall } from "./output-cap.js";
import { aftermathReserves, flowxReserves, kriyaReserves, KRIYA_LP_TOKEN_TYPE } from "./valuers/amm-lp.js";
import { amountsForLiquidity, i32FromBits, parsePoolFields, parsePositionFields, VERIFIED_POSITION_TYPES } from "./valuers/clmm.js";
import type { ClmmPoolFields } from "./valuers/clmm.js";
import { bigField } from "./valuers/common.js";
import type { PoolCandidate } from "../tools/pools.js";
import { readLiquidityOrigin } from "./liquidity-origin.js";

/** Each pool is independently bounded. An incomplete walk is a sample, never a ranking. */
export const LIQUIDITY_POOL_LIMIT = 3;
export const LIQUIDITY_POSITION_SCAN_LIMIT = 1000;
export const LIQUIDITY_LP_SCAN_LIMIT = 1000;
export const LIQUIDITY_HOLDER_DISPLAY_LIMIT = 100;
/** Characters of holder rows per pool: three pools' rows and the rest of analyze_token fit its 50k budget. */
export const LIQUIDITY_HOLDER_BUDGET = 9_000;

/** `object` names an object holder, never a protocol or a lock; `package` is a package address, which no key signs for. */
export type LiquidityHolderKind = "publisher" | "burned" | "wallet" | "object" | "package" | "kiosk" | "unknown";

export function liquidityHolderKind(address: string, publisher: string | null, objectType?: string, identity?: string): LiquidityHolderKind {
  if (isUnspendableAddress(address)) return "burned";
  if (publisher && normalizeSuiAddress(address) === normalizeSuiAddress(publisher)) return "publisher";
  if (objectType && normalizeStructTag(objectType).split("<")[0] === `${normalizeSuiAddress("0x2")}::kiosk::Kiosk`) return "kiosk";
  if (identity === "package") return "package";
  if (identity === "object") return "object";
  return identity === "wallet" ? "wallet" : "unknown";
}

export function fractionOfLiquidity(amount: bigint, total: bigint): number | null {
  if (total <= 0n) return null;
  return Number((amount * 1_000_000n) / total) / 1_000_000;
}
interface LiquidityDisplayRow { address: string; kind: LiquidityHolderKind; amount_raw: string }

/** Budgeted list cap with a complete per-pool store copy and an advancing page. */
export function capLiquidityHolders<T extends LiquidityDisplayRow>(
  holders: T[], offset: number, coinType: string, poolOffset: number, poolId: string, budget = LIQUIDITY_HOLDER_BUDGET
) {
  const page = holders.slice(offset);
  const indices = new Map(page.map((row, index) => [row, offset + index]));
  const nextCall = (nextOffset: number): NextCall => ({
    tool: "analyze_token", args: {
      query: coinType, include_holders: false, liquidity_pool_offset: poolOffset, liquidity_holder_pool: poolId, liquidity_offset: nextOffset
    }
  });
  const { payload } = capPayload(
    "analyze_token",
    { query: coinType, include_holders: false, liquidity_pool_offset: poolOffset, liquidity_holder_pool: poolId, liquidity_offset: offset },
    { holders: page },
    {
      holders: {
        budget, limit: LIQUIDITY_HOLDER_DISPLAY_LIMIT, keepOrder: true,
        keep: (row: T) => row.kind !== "wallet",
        brief: (row: T) => ({ address: row.address, kind: row.kind, amount_raw: row.amount_raw }),
        covers: (row: T) => [indices.get(row)!],
        next_call: nextCall(offset + 1),
      } satisfies ListCap<T>
    },
    { full: false, stored: { holders }, next_call: nextCall(offset + 1) }
  );
  const omitted = payload.omitted as {
    next_call: NextCall;
    lists: { holders: { from: number; next_call?: NextCall } };
  } | undefined;
  const shown = payload.holders as T[];
  if (omitted) {
    const next = nextCall(offset + shown.length);
    omitted.next_call = next;
    omitted.lists.holders.next_call = next;
    omitted.lists.holders.from += offset;
  }
  return { holders: shown, ...(omitted ? { truncated: true, omitted } : {}) };
}

interface CustodyHolding { address: string; amount: bigint; counterpart?: bigint; position_id?: string; position_ids?: string[]; object_type?: string; via_field?: boolean }
/** Positions whose liquidity counts toward the total while their holder could not be read. */
interface OwnerUnread { positions: number; amount: bigint; counterpart: bigint; position_ids: string[] }
const OWNER_UNREAD_IDS = 10;
interface ScanResult { rows: CustodyHolding[]; total: bigint | null; counterpart_total?: bigint; counterpart_type?: string; scanned: number; incomplete: boolean; reason?: string; unit: string; owner_unread?: OwnerUnread; locked_in_pool?: bigint; fee_in_pool?: bigint }

/** All positions of one owner contribute to that owner's pool share. */
export function aggregateCustodyRows(rows: CustodyHolding[]): CustodyHolding[] {
  const byOwner = new Map<string, CustodyHolding>();
  for (const row of rows) {
    const address = normalizeSuiAddress(row.address);
    const existing = byOwner.get(address);
    // Rows already grouped carry position_ids; a raw row carries one position_id.
    const ids = row.position_ids ?? (row.position_id ? [row.position_id] : []);
    if (!existing) {
      byOwner.set(address, { ...row, address, position_id: undefined, position_ids: [...ids] });
    } else {
      existing.amount += row.amount;
      if (row.counterpart !== undefined) existing.counterpart = (existing.counterpart ?? 0n) + row.counterpart;
      existing.position_ids!.push(...ids);
    }
  }
  return [...byOwner.values()];
}

const StateJson = z.record(z.string(), z.unknown());
const LpSupply = z.object({ value: z.string() });
const KriyaLpBalance = z.object({ balance: z.string() });
const CetusPositionManager = z.object({ positions: z.object({ id: z.string(), size: z.string() }) });

function coinParams(type: string): string[] {
  try {
    return parseStructTag(type).typeParams.map((t) => normalizeStructTag(t));
  } catch { return []; }
}

const CLMM_POSITION: Record<string, string> = {
  cetus: VERIFIED_POSITION_TYPES[0]!, bluefin: VERIFIED_POSITION_TYPES[1]!,
  momentum: VERIFIED_POSITION_TYPES[2]!, flowx_clmm: VERIFIED_POSITION_TYPES[3]!,
  magma: VERIFIED_POSITION_TYPES[4]!, turbos: VERIFIED_POSITION_TYPES[5]!,
};

function lpCoinOf(pool: PoolCandidate): string | null {
  if (pool.lp_type) return normalizeStructTag(pool.lp_type);
  const [a, b] = coinParams(pool.object_type);
  if (pool.protocol === "bluemove" && a && b) return `${normalizeSuiAddress(pool.object_type.split("::")[0]!)}::swap::LSP<${a},${b}>`;
  if (pool.protocol === "flowx_v2" && a && b) return `${normalizeSuiAddress("0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0")}::pair::LP<${a},${b}>`;
  if (pool.protocol === "aftermath" && coinParams(pool.object_type)[0]) return coinParams(pool.object_type)[0]!;
  return null;
}

/** Objects per batched read: a coin can have over a thousand pools, and one read each takes minutes under a rate limit. */
const STATE_BATCH = 50;

/** Pool states in request order; a failed read is an Error, an absent or unparsable object null. */
async function readStates(ids: string[]): Promise<Array<{ type: string; json: Record<string, unknown> } | null | Error>> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += STATE_BATCH) chunks.push(ids.slice(i, i + STATE_BATCH));
  const results = await Promise.all(chunks.map(async (chunk) => {
    try {
      const { objects } = await sui.getObjects({ objectIds: chunk, include: { json: true } });
      return chunk.map((_, i) => {
        const object = objects[i];
        if (object instanceof Error) return object;
        const parsed = StateJson.safeParse(object?.json);
        return object?.type && parsed.success ? { type: object.type, json: parsed.data } : null;
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return chunk.map(() => error);
    }
  }));
  return results.flat();
}

async function readLp(pool: PoolCandidate, state: { type: string; json: Record<string, unknown> }): Promise<ScanResult> {
  const lpType = lpCoinOf(pool);
  if (!lpType) return { rows: [], total: null, scanned: 0, incomplete: true, unit: "LP", reason: "The pool's fungible LP coin type is not known." };
  // Minted supply; FlowX v2's pending protocol fee mint is not held by anyone until the next burn mints it.
  let supply = bigField(LpSupply.safeParse(state.json.lsp_supply).data?.value);
  if (pool.protocol === "aftermath") supply = aftermathReserves(state.json)?.supply ?? null;
  if (pool.protocol === "kriya_v2") supply = kriyaReserves(state.type, state.json)?.supply ?? null;
  if (pool.protocol === "flowx_v2") {
    const [a, b] = coinParams(lpType);
    supply = a && b ? flowxReserves(state.json, a, b, false)?.supply ?? null : null;
  }
  // LP the pool keeps for itself and no holder can withdraw: BlueMove's minimum_liq balance, Aftermath's illiquid_lp_supply.
  const locked = pool.protocol === "bluemove" ? bigField(state.json.minimum_liq)
    : pool.protocol === "aftermath" ? bigField(state.json.illiquid_lp_supply) : 0n;
  // BlueMove's protocol-fee LP, a Balance<LSP> inside the pool that its fee mechanism, not a coin holder, controls.
  const poolFee = pool.protocol === "bluemove" ? bigField(state.json.fee_amount) : 0n;
  const scan = await scanTokenTopHolders(lpType, 100, LIQUIDITY_LP_SCAN_LIMIT);
  const holders = scan.truncated ? await sampledHolders(scan.holders, lpType) : scan.holders;
  const unread = holders.some((h) => h.balance === null);
  const rows = holders.filter((h) => h.balance !== null && BigInt(h.balance) > 0n)
    .map((h) => ({ address: h.address, amount: BigInt(h.balance!), object_type: h.object_type }));
  const accounted = rows.reduce((n, row) => n + row.amount, 0n);
  const walkStopped = scan.truncated || !!scan.unresolved_owners || scan.unique_holders > scan.holders.length || unread;
  const unreconciled = supply !== null && locked !== null && poolFee !== null && accounted + locked + poolFee !== supply;
  const incomplete = supply === null || locked === null || poolFee === null || walkStopped || unreconciled;
  return {
    rows, total: supply, scanned: scan.total_scanned, incomplete, unit: lpType,
    ...(locked ? { locked_in_pool: locked } : {}),
    ...(poolFee ? { fee_in_pool: poolFee } : {}),
    ...(incomplete ? {
      reason: supply === null || locked === null || poolFee === null ? "Pool LP supply could not be read; holder shares are unknown."
        : walkStopped ? `The LP holder walk stopped at its bound (${LIQUIDITY_LP_SCAN_LIMIT} objects, 100 holders) or left holders unread; other LP holders may be larger.`
          : `Live LP balances sum to ${accounted}${locked || poolFee ? ` plus ${locked! + poolFee!} the pool keeps` : ""} against a minted supply of ${supply}; the rest may be held inside other objects.`
    } : {}),
  };
}

interface PositionPage {
  objects: {
    nodes: Array<{
      address: string;
      owner?: { address?: { address: string } };
      asMoveObject?: { contents?: { json?: Record<string, unknown> } };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
}

async function readKriya(pool: PoolCandidate, state: { type: string; json: Record<string, unknown> }): Promise<ScanResult> {
  const supply = kriyaReserves(state.type, state.json)?.supply ?? null;
  const rows: CustodyHolding[] = [];
  let cursor: string | null = null;
  let scanned = 0;
  let incomplete = supply === null;
  for (; ;) {
    const page: PositionPage = await gqlQuery(`query($type: String!, $after: String) {
      objects(filter: { type: $type }, first: 50, after: $after) {
        nodes { address owner { ... on AddressOwner { address { address } } ... on ConsensusAddressOwner { address { address } } ... on ObjectOwner { address { address } } } asMoveObject { contents { json } } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { type: KRIYA_LP_TOKEN_TYPE, after: cursor });
    const remaining = LIQUIDITY_POSITION_SCAN_LIMIT - scanned;
    for (let index = 0; index < page.objects.nodes.length && index < remaining; index++) {
      const node = page.objects.nodes[index]!;
      scanned++;
      const json = node.asMoveObject?.contents?.json;
      const id = json?.pool_id;
      if (typeof id !== "string" || normalizeSuiAddress(id) !== normalizeSuiAddress(pool.pool_id)) continue;
      const amount = bigField(KriyaLpBalance.safeParse(json?.lsp).data?.balance);
      const owner = node.owner?.address?.address;
      if (amount !== null && amount > 0n && owner) rows.push({ address: owner, amount, position_id: node.address });
      else incomplete = true;
    }
    if (page.objects.nodes.length > remaining) { incomplete = true; break; }
    if (!page.objects.pageInfo.hasNextPage) break;
    cursor = page.objects.pageInfo.endCursor ?? null;
    if (!cursor || scanned >= LIQUIDITY_POSITION_SCAN_LIMIT) { incomplete = true; break; }
  }
  // Kriya keeps the minimum liquidity as an lsp_locked balance inside the pool.
  const locked = bigField(state.json.lsp_locked);
  if (supply === null || locked === null || rows.reduce((total, row) => total + row.amount, 0n) + locked !== supply) incomplete = true;
  return {
    rows, total: supply, scanned, incomplete, unit: KRIYA_LP_TOKEN_TYPE, ...(locked ? { locked_in_pool: locked } : {}),
    ...(incomplete ? { reason: "Kriya LP-token scan or pool supply is incomplete; other holders or their shares may be unknown." } : {})
  };
}

interface CetusPositionPage {
  address?: {
    dynamicFields?: {
      nodes: Array<{ name?: { json?: unknown }; value?: { json?: { value?: { position_id?: unknown; liquidity?: unknown; tick_lower_index?: unknown; tick_upper_index?: unknown } } } }>;
      pageInfo: { hasNextPage: boolean; endCursor?: string | null };
    } | null;
  } | null;
}

/** Cetus links every active position to its pool; global NFT ID scans miss most pools. */
async function readCetusPositions(state: { json: Record<string, unknown> }, positionType: string, poolFields: ClmmPoolFields, coinType: string): Promise<ScanResult> {
  const positions = CetusPositionManager.safeParse(state.json.position_manager).data?.positions;
  const table = positions?.id;
  const expected = bigField(positions?.size);
  if (typeof table !== "string" || expected === null) {
    return { rows: [], total: null, scanned: 0, incomplete: true, unit: coinType, reason: "Cetus pool position table unavailable." };
  }
  const entries: Array<{ id: string; amount: bigint; counterpart: bigint }> = [];
  let cursor: string | null = null;
  let incomplete = false;
  let scanned = 0;
  for (; ;) {
    const data: CetusPositionPage = await gqlQuery<CetusPositionPage>(`query($id: SuiAddress!, $after: String) {
      address(address: $id) { dynamicFields(first: 50, after: $after) {
        nodes { name { json } value { ... on MoveValue { json } } }
        pageInfo { hasNextPage endCursor }
      } }
    }`, { id: table, after: cursor });
    const page: NonNullable<NonNullable<CetusPositionPage["address"]>["dynamicFields"]> | null | undefined = data.address?.dynamicFields;
    if (!page) { incomplete = true; break; }
    const remaining = LIQUIDITY_POSITION_SCAN_LIMIT - scanned;
    for (let index = 0; index < page.nodes.length && index < remaining; index++) {
      const node = page.nodes[index]!;
      scanned++;
      const id = node.name?.json;
      const value = node.value?.json?.value;
      const liquidity = bigField(value?.liquidity);
      const lower = i32FromBits(value?.tick_lower_index);
      const upper = i32FromBits(value?.tick_upper_index);
      if (typeof id !== "string" || typeof value?.position_id !== "string"
        || normalizeSuiAddress(id) !== normalizeSuiAddress(value.position_id)
        || liquidity === null || lower === null || upper === null) {
        incomplete = true;
      } else if (liquidity > 0n) {
        try {
          const coins = amountsForLiquidity(lower, upper, poolFields.currentTick, poolFields.sqrtPrice, liquidity);
          entries.push({ id, amount: poolFields.coinA === coinType ? coins.a : coins.b, counterpart: poolFields.coinA === coinType ? coins.b : coins.a });
        } catch { incomplete = true; }
      }
    }
    if (page.nodes.length > remaining) { incomplete = true; break; }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor ?? null;
    if (!cursor || scanned >= LIQUIDITY_POSITION_SCAN_LIMIT) { incomplete = true; break; }
  }
  const rows: CustodyHolding[] = [];
  const unowned: OwnerUnread = { positions: 0, amount: 0n, counterpart: 0n, position_ids: [] };
  for (let i = 0; i < entries.length; i += 40) {
    const batch = entries.slice(i, i + 40);
    const data = await gqlQuery<{
      multiGetObjects: Array<{
        address?: string; owner?: { address?: { address?: string } };
        asMoveObject?: { contents?: { type?: { repr?: string } } };
      } | null>;
    }>(`query($keys: [ObjectKey!]!) {
      multiGetObjects(keys: $keys) {
        address owner { ... on AddressOwner { address { address } } ... on ConsensusAddressOwner { address { address } } ... on ObjectOwner { address { address } } }
        asMoveObject { contents { type { repr } } }
      }
    }`, { keys: batch.map(({ id }) => ({ address: id })) });
    for (let j = 0; j < batch.length; j++) {
      const position = data.multiGetObjects[j];
      const type = position?.asMoveObject?.contents?.type?.repr;
      const owner = position?.owner?.address?.address;
      if (!owner || !type || normalizeStructTag(type).split("<")[0] !== normalizeStructTag(positionType).split("<")[0]) {
        // Counted apart, as get_top_holders counts unresolved owners: the table was read to its end.
        unowned.positions++;
        unowned.amount += batch[j]!.amount;
        unowned.counterpart += batch[j]!.counterpart;
        if (unowned.position_ids.length < OWNER_UNREAD_IDS) unowned.position_ids.push(batch[j]!.id);
        continue;
      }
      rows.push({ address: owner, amount: batch[j]!.amount, counterpart: batch[j]!.counterpart, position_id: batch[j]!.id });
    }
  }
  const total = entries.reduce((n, entry) => n + entry.amount, 0n);
  const counterpartTotal = entries.reduce((n, entry) => n + entry.counterpart, 0n);
  const tableIncomplete = BigInt(scanned) !== expected;
  if (tableIncomplete) incomplete = true;
  // A table read short of its end sums only the positions read; that is no pool total.
  return {
    rows, total: tableIncomplete ? null : total, counterpart_total: tableIncomplete ? undefined : counterpartTotal,
    counterpart_type: poolFields.coinA === coinType ? poolFields.coinB : poolFields.coinA,
    scanned, incomplete, unit: coinType,
    ...(unowned.positions ? { owner_unread: unowned } : {}),
    ...(incomplete ? {
      reason: tableIncomplete
        ? `The pool's position table lists ${expected} positions and ${scanned} were read (bound ${LIQUIDITY_POSITION_SCAN_LIMIT}).`
        : "A position record in the pool's table could not be read."
    } : {})
  };
}

async function readClmm(pool: PoolCandidate, state: { type: string; json: Record<string, unknown> }, coinType: string): Promise<ScanResult> {
  const positionType = CLMM_POSITION[pool.protocol];
  if (!positionType) return { rows: [], total: null, scanned: 0, incomplete: true, unit: coinType, reason: "No verified position type for this pool." };
  const poolFields = parsePoolFields(state.type, state.json);
  if (!poolFields || (poolFields.coinA !== coinType && poolFields.coinB !== coinType)) return { rows: [], total: null, scanned: 0, incomplete: true, unit: coinType, reason: "Pool tick, price or coin type could not be read." };
  // Magma is a Cetus fork with the same linked position table (PositionInfo nodes keyed by position id).
  if (pool.protocol === "cetus" || pool.protocol === "magma") return readCetusPositions(state, positionType, poolFields, coinType);
  const rows: CustodyHolding[] = [];
  let cursor: string | null = null;
  let scanned = 0;
  let incomplete = false;
  let inRange = 0n;
  for (; ;) {
    const page: PositionPage = await gqlQuery(`query($type: String!, $after: String) {
      objects(filter: { type: $type }, first: 50, after: $after) {
        nodes { address owner { ... on AddressOwner { address { address } } ... on ConsensusAddressOwner { address { address } } ... on ObjectOwner { address { address } } } asMoveObject { contents { json } } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { type: positionType, after: cursor });
    const remaining = LIQUIDITY_POSITION_SCAN_LIMIT - scanned;
    const nodes = page.objects.nodes.slice(0, remaining);
    scanned += nodes.length;
    // A Turbos NFT names its pool and the object holding the liquidity; read those objects in one batch.
    const turbosIds = pool.protocol === "turbos" ? nodes.map((node) => {
      const json = node.asMoveObject?.contents?.json;
      return typeof json?.pool_id === "string" && normalizeSuiAddress(json.pool_id) === normalizeSuiAddress(pool.pool_id) && typeof json.position_id === "string" ? json.position_id : null;
    }) : [];
    const wanted = turbosIds.filter((id): id is string => id !== null);
    const innerStates = new Map((wanted.length ? await readStates(wanted) : []).map((state, i) => [wanted[i]!, state]));
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      const json = node.asMoveObject?.contents?.json;
      if (!json) { incomplete = true; continue; }
      let parsed = parsePositionFields(json);
      const innerId = turbosIds[index];
      if (innerId) {
        const inner = innerStates.get(innerId);
        parsed = inner && !(inner instanceof Error) ? parsePositionFields(inner.json, pool.pool_id) : null;
        if (!parsed) incomplete = true;
      }
      if (parsed?.pool !== normalizeSuiAddress(pool.pool_id) || parsed.liquidity <= 0n) continue;
      if (parsed.tickLower <= poolFields.currentTick && poolFields.currentTick < parsed.tickUpper) inRange += parsed.liquidity;
      const address = node.owner?.address?.address;
      if (address) {
        try {
          const amounts = amountsForLiquidity(parsed.tickLower, parsed.tickUpper, poolFields.currentTick, poolFields.sqrtPrice, parsed.liquidity);
          rows.push({
            address, amount: poolFields.coinA === coinType ? amounts.a : amounts.b,
            counterpart: poolFields.coinA === coinType ? amounts.b : amounts.a, position_id: node.address
          });
        } catch { incomplete = true; }
      } else incomplete = true;
    }
    if (page.objects.nodes.length > remaining) { incomplete = true; break; }
    if (!page.objects.pageInfo.hasNextPage) break;
    cursor = page.objects.pageInfo.endCursor ?? null;
    if (!cursor || scanned >= LIQUIDITY_POSITION_SCAN_LIMIT) { incomplete = true; break; }
  }
  // A type-wide list holds top-level positions only; one wrapped in another object is missing from it.
  // The in-range positions' liquidity sums to the pool's active liquidity exactly when none is missing.
  const active = bigField(state.json.liquidity);
  const unreconciled = !incomplete && (active === null || inRange !== active);
  return {
    rows, total: incomplete || unreconciled ? null : rows.reduce((n, row) => n + row.amount, 0n),
    counterpart_total: incomplete || unreconciled ? undefined : rows.reduce((n, row) => n + (row.counterpart ?? 0n), 0n),
    counterpart_type: poolFields.coinA === coinType ? poolFields.coinB : poolFields.coinA,
    scanned, incomplete: incomplete || unreconciled, unit: coinType,
    ...(incomplete ? { reason: "Position scan stopped before reaching every position; pool-wide withdrawable coin shares are unknown." }
      : unreconciled ? { reason: `The listed in-range positions hold ${inRange} liquidity and the pool's active liquidity is ${active ?? "unread"}; positions wrapped in other objects are not listed, so shares are unknown.` } : {})
  };
}

async function readPool(pool: PoolCandidate, state: { type: string; json: Record<string, unknown> } | null, reserve: bigint | null, coinType: string): Promise<{ pool: PoolCandidate; reserve: bigint | null; scan: ScanResult }> {
  if (!state) return { pool, reserve: null, scan: { rows: [], total: null, scanned: 0, incomplete: true, unit: "unknown", reason: "Pool state unavailable." } };
  const scan = CLMM_POSITION[pool.protocol] ? await readClmm(pool, state, coinType)
    : pool.protocol === "kriya_v2" ? await readKriya(pool, state) : await readLp(pool, state);
  scan.rows = aggregateCustodyRows(scan.rows);
  return { pool, reserve, scan };
}

/**
 * The publisher's or burned holders' summed liquidity, with the paired coin for CLMM positions:
 * an out-of-range position can hold none of the queried coin and all of the other.
 * On an incomplete scan a zero sum is null, since an unobserved holder is not a zero holding.
 */
function kindSums(holders: Array<{ kind: LiquidityHolderKind; amount_raw: string; counterpart_raw?: string }>, kind: "publisher" | "burned", incomplete: boolean, paired: boolean) {
  const rows = holders.filter((h) => h.kind === kind);
  const unseen = incomplete && rows.length === 0;
  const amount = rows.reduce((n, h) => n + BigInt(h.amount_raw), 0n);
  const counterpart = rows.reduce((n, h) => n + BigInt(h.counterpart_raw ?? "0"), 0n);
  return {
    [`${kind}_liquidity_raw`]: unseen ? null : amount.toString(),
    ...(paired ? { [`${kind}_counterpart_raw`]: unseen ? null : counterpart.toString() } : {}),
  };
}

const DOF_FIELD = `${normalizeSuiAddress("0x2")}::dynamic_field::Field<${normalizeSuiAddress("0x2")}::dynamic_object_field::Wrapper<`;

/** The object owning each dynamic-object-field Field. A Field whose parent cannot be read stays the holder, typed as a Field. */
async function dynamicFieldParents(fields: string[]): Promise<Map<string, string>> {
  const parents = new Map<string, string>();
  for (let i = 0; i < fields.length; i += 40) {
    const chunk = fields.slice(i, i + 40);
    try {
      const data = await gqlQuery<{ multiGetObjects: Array<{ owner?: { address?: { address?: string } } } | null> }>(
        `query($keys: [ObjectKey!]!) { multiGetObjects(keys: $keys) { owner { ... on ObjectOwner { address { address } } } } }`,
        { keys: chunk.map((address) => ({ address })) },
      );
      chunk.forEach((field, j) => {
        const parent = data.multiGetObjects[j]?.owner?.address?.address;
        if (parent) parents.set(field, normalizeSuiAddress(parent));
      });
    } catch {
      // Unread parents leave those Fields as the holders.
    }
  }
  return parents;
}

/** What the pool holds of `coinType`, read from its own layout; null when unread, never zero. */
function reserveOf(pool: PoolCandidate, state: { type: string; json: Record<string, unknown> }, coinType: string): bigint | null {
  const clmm = parsePoolFields(state.type, state.json);
  if (clmm) return clmm.coinA === coinType ? clmm.reserveA : clmm.coinB === coinType ? clmm.reserveB : null;
  if (pool.protocol === "aftermath") {
    const parsed = aftermathReserves(state.json);
    const index = parsed?.coins.indexOf(coinType) ?? -1;
    return index >= 0 ? parsed!.reserves[index]! : null;
  }
  if (pool.protocol === "flowx_v2" && pool.token_a && pool.token_b) {
    const parsed = flowxReserves(state.json, pool.token_a, pool.token_b, false);
    const index = parsed?.coins.indexOf(coinType) ?? -1;
    return index >= 0 ? parsed!.reserves[index]! : null;
  }
  const params = coinParams(state.type);
  // BlueMove keeps its reserves in reserve_x/reserve_y; its token_x/token_y balances read zero.
  if (pool.protocol === "bluemove") {
    return params.indexOf(coinType) === 0 ? bigField(state.json.reserve_x) : params.indexOf(coinType) === 1 ? bigField(state.json.reserve_y) : null;
  }
  return params.indexOf(coinType) === 0 ? bigField(state.json.coin_a ?? state.json.token_x ?? state.json.reserve_x)
    : params.indexOf(coinType) === 1 ? bigField(state.json.coin_b ?? state.json.token_y ?? state.json.reserve_y) : null;
}

/** Chain-derived, current holdings only. Never treat missing positions as a claim about past liquidity. */
export async function analyzeLiquidityCustody(coinType: string, pools: PoolCandidate[], holderOffset = 0, poolOffset = 0, holderPool?: string) {
  coinType = normalizeStructTag(coinType);
  const publisher = await resolvePublisher(coinType.split("::")[0]!);
  const candidates = pools.filter((p) => p.protocol !== "deepbook");
  // Reserve values of this same coin are comparable across pools. An unread reserve
  // is not zero; read it after known reserves so it never changes the ranking.
  const states = await readStates(candidates.map((pool) => pool.pool_id));
  const ranked = candidates.map((pool, i) => {
    const state = states[i];
    if (!state || state instanceof Error) {
      return { pool, state: null, reserve: null as bigint | null, state_unavailable: state instanceof Error ? state.message : "The pool object was absent from the gRPC response." };
    }
    return { pool, state, reserve: reserveOf(pool, state, coinType), state_unavailable: undefined };
  });
  ranked.sort((a, b) => a.reserve === null ? b.reserve === null ? 0 : 1 : b.reserve === null ? -1 : a.reserve > b.reserve ? -1 : a.reserve < b.reserve ? 1 : 0);
  const poolPage = ranked.slice(poolOffset, poolOffset + LIQUIDITY_POOL_LIMIT);
  const chosen = holderPool ? poolPage.filter((row) => normalizeSuiAddress(row.pool.pool_id) === holderPool) : poolPage;
  if (holderPool && !chosen.length) throw new Error("The requested holder pool is not on this page of discovered pools.");
  const reads = await Promise.allSettled(chosen.map((r) => readPool(r.pool, r.state, r.reserve, coinType)));
  const origins = await Promise.allSettled(chosen.map((r) => readLiquidityOrigin(r.pool, lpCoinOf(r.pool))));
  const allAddresses = [...new Set(reads.flatMap((r) => r.status === "fulfilled"
    ? r.value.scan.rows.map((h) => h.address)
    : []))];
  const ownerKinds = await fetchKinds(allAddresses);
  // A position kept as a dynamic object field is owned by its Field; the object holding the field
  // (a kiosk, a vault) is the holder. Re-key rows by it, merging positions it holds through several fields.
  const parents = await dynamicFieldParents(allAddresses.filter((address) => ownerKinds.get(address)?.type?.startsWith(DOF_FIELD)));
  for (const read of reads) {
    if (read.status !== "fulfilled" || !parents.size) continue;
    read.value.scan.rows = aggregateCustodyRows(read.value.scan.rows.map((row) => {
      const parent = parents.get(row.address);
      return parent ? { ...row, address: parent, via_field: true } : row;
    }));
  }
  const unclassified = [...new Set(parents.values())].filter((parent) => !ownerKinds.has(parent));
  const kinds = new Map([...ownerKinds, ...(unclassified.length ? await fetchKinds(unclassified) : [])]);
  const entries = reads.map((read, i) => {
    const candidate = chosen[i]!;
    const origin = origins[i]!;
    if (read.status === "rejected") return {
      pool_id: candidate.pool.pool_id, protocol: candidate.pool.protocol, reserve_coin_raw: candidate.reserve?.toString() ?? null,
      custody_unavailable: read.reason instanceof Error ? read.reason.message : String(read.reason),
      ...(candidate.state_unavailable ? { state_unavailable: candidate.state_unavailable } : {}),
      ...(origin.status === "fulfilled" ? { creation: origin.value } : { creation_unavailable: String(origin.reason) }),
    };
    const { pool, scan } = read.value;
    const otherCoin = (pool.coin_types ?? [pool.token_a, pool.token_b]).find((type) => type && type !== coinType) ?? null;
    const holders = scan.rows.map((h) => {
      const identity = kinds.get(h.address);
      const objectType = identity?.type ?? h.object_type;
      const kind = liquidityHolderKind(h.address, publisher.publisher, objectType, identity?.kind ?? (h.object_type ? "object" : undefined));
      return {
        address: h.address, kind, amount_raw: h.amount.toString(), share: scan.incomplete ? null : fractionOfLiquidity(h.amount, scan.total ?? 0n),
        ...(h.counterpart !== undefined ? { counterpart_raw: h.counterpart.toString(), counterpart_share: scan.incomplete ? null : fractionOfLiquidity(h.counterpart, scan.counterpart_total ?? 0n) } : {}),
        ...(h.position_ids?.length ? { position_count: h.position_ids.length, position_ids: h.position_ids } : {}),
        ...(h.via_field ? { held_as_dynamic_object_field: true } : {}),
        ...(objectType ? { object_type: objectType } : {}),
        ...(kind === "unknown" && !identity ? { classification_unavailable: "Owner-kind lookup unavailable." } : {}),
        ...(kind === "publisher" && publisher.publish_tx ? { publisher_tx: publisher.publish_tx } : {})
      };
    }).sort((a, b) => {
      if ((a.kind === "wallet") !== (b.kind === "wallet")) return a.kind === "wallet" ? 1 : -1;
      const shareA = Math.max(a.share ?? 0, "counterpart_share" in a ? a.counterpart_share ?? 0 : 0);
      const shareB = Math.max(b.share ?? 0, "counterpart_share" in b ? b.counterpart_share ?? 0 : 0);
      return shareB - shareA || (BigInt(b.amount_raw) > BigInt(a.amount_raw) ? 1 : BigInt(b.amount_raw) < BigInt(a.amount_raw) ? -1 : 0);
    });
    const display = capLiquidityHolders(holders, holderOffset, coinType, poolOffset, pool.pool_id);
    return {
      pool_id: pool.pool_id, protocol: pool.protocol, reserve_coin_raw: read.value.reserve?.toString() ?? null,
      // The other side shows a drained pool: a pool full of the queried coin can hold almost nothing to sell it for.
      ...(otherCoin && candidate.state ? { counterpart_reserve: { coin_type: otherCoin, raw: reserveOf(pool, candidate.state, otherCoin)?.toString() ?? null } } : {}),
      ...(candidate.state_unavailable ? { state_unavailable: candidate.state_unavailable } : {}),
      ...(CLMM_POSITION[pool.protocol] ? { position_type: CLMM_POSITION[pool.protocol], amount_basis: "withdrawable coin amounts at the current pool price, excluding fees and rewards" }
        : pool.protocol === "kriya_v2" ? { position_type: KRIYA_LP_TOKEN_TYPE, amount_basis: "LP units" }
          : { lp_type: scan.unit, amount_basis: "LP units" }),
      liquidity_unit: scan.unit,
      ...(scan.counterpart_type ? { counterpart_type: scan.counterpart_type, counterpart_total_raw: scan.counterpart_total?.toString() ?? null } : {}),
      scan: { scanned: scan.scanned, incomplete: scan.incomplete, ...(scan.reason ? { reason: scan.reason } : {}) },
      ...(scan.owner_unread ? {
        owner_unread: {
          positions: scan.owner_unread.positions, amount_raw: scan.owner_unread.amount.toString(),
          counterpart_raw: scan.owner_unread.counterpart.toString(), position_ids: scan.owner_unread.position_ids,
          share: scan.incomplete ? null : fractionOfLiquidity(scan.owner_unread.amount, scan.total ?? 0n),
          counterpart_share: scan.incomplete ? null : fractionOfLiquidity(scan.owner_unread.counterpart, scan.counterpart_total ?? 0n),
          note: "Positions in the pool's table that are not top-level objects (wrapped inside another object, such as a farm or a burn certificate) or did not read as its position type. They count in the totals and no holder row includes them, so a holder controlling one through its wrapper holds more than its row's share. Whether they can be withdrawn depends on the wrapper's code; trace_object_history on a position id shows where it went.",
        }
      } : {}),
      holder_count_observed: holders.length,
      ...(holders.some((h) => h.kind === "kiosk") ? { kiosk_note: "A kiosk is controlled by whoever holds its KioskOwnerCap, not by its declared owner field; get_object on the kiosk id names the cap holder." } : {}),
      ...kindSums(holders, "publisher", scan.incomplete, scan.counterpart_type !== undefined),
      ...kindSums(holders, "burned", scan.incomplete, scan.counterpart_type !== undefined),
      ...(scan.incomplete ? { observed_sums_note: "The scan is incomplete, so publisher and burned sums cover the observed holders only; null means none was observed, not none held." } : {}),
      total_liquidity_raw: scan.total?.toString() ?? null,
      ...(scan.locked_in_pool ? { lp_locked_in_pool_raw: scan.locked_in_pool.toString() } : {}),
      ...(scan.fee_in_pool ? {
        lp_protocol_fee_in_pool_raw: scan.fee_in_pool.toString(),
        lp_protocol_fee_share: scan.incomplete ? null : fractionOfLiquidity(scan.fee_in_pool, scan.total ?? 0n),
      } : {}),
      ...display,
      ...(origin.status === "fulfilled" ? { creation: origin.value } : { creation_unavailable: String(origin.reason) }),
    };
  });
  return {
    as_of: "current", coin_type: coinType, publisher: publisher.publisher, ...(publisher.unresolved ? { publisher_unavailable: publisher.unresolved } : {}),
    pools_found: pools.length, pool_limit: LIQUIDITY_POOL_LIMIT, pools_inspected: chosen.length, omitted_pools: Math.max(0, candidates.length - poolOffset - poolPage.length),
    ...(poolOffset + LIQUIDITY_POOL_LIMIT < candidates.length ? {
      next_call: {
        tool: "analyze_token", args: {
          query: coinType, include_holders: false, liquidity_pool_offset: poolOffset + LIQUIDITY_POOL_LIMIT
        }
      }
    } : {}),
    selection: "Largest current reserve of this coin where readable, among the discovered SUI/USDC pairs; unread reserves sort last.",
    locker_note: "No liquidity-locker package is verified in this registry; an object-held LP or position is not called locked without checking its code and authority.",
    caveat: "Current state does not show LP coins burned or positions closed during a past withdrawal. An incomplete scan cannot establish a wallet's share or the absence of a position.",
    pools: entries
  };
}
