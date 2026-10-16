import { normalizeSuiAddress, normalizeStructTag } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { parsePositionFields, VERIFIED_POSITION_TYPES } from "./valuers/clmm.js";
import { isUnspendableAddress } from "./upgrade-cap.js";
import { objectEndKind } from "./object-end.js";
import type { PoolCandidate } from "../tools/pools.js";

interface Owner { address?: { address: string } }
interface CreatedObject {
  address: string;
  idCreated?: boolean | null;
  outputState?: {
    owner?: Owner | null;
    asMoveObject?: { contents?: { type?: { repr?: string }; json?: Record<string, unknown> } };
  } | null;
}
interface CreationRead {
  objectVersions?: { nodes: Array<{ previousTransaction?: { digest?: string } }> } | null;
}
interface CreationTx {
  transaction?: {
    sender?: { address?: string } | null;
    effects?: {
      objectChanges?: { nodes: CreatedObject[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } };
      balanceChanges?: { nodes: Array<{ owner?: { address?: string }; amount: string; coinType?: { repr?: string } }>; pageInfo: { hasNextPage: boolean } };
    };
  } | null;
}

const ORIGIN_POSITION_TYPES = new Set(VERIFIED_POSITION_TYPES.map((t) => t.split("<")[0]));
const MAX_CREATION_PAGES = 5;

interface RemovalRead {
  transactions?: {
    nodes: Array<{
      digest: string;
      sender?: { address?: string };
      effects?: {
        events?: { nodes: Array<{ contents?: { type?: { repr?: string }; json?: Record<string, unknown> } }>; pageInfo: { hasNextPage: boolean } };
        balanceChanges?: { nodes: Array<{ owner?: { address?: string }; amount: string; coinType?: { repr?: string } }>; pageInfo: { hasNextPage: boolean } };
      };
    }>;
    pageInfo: { hasPreviousPage: boolean };
  };
}

export function removalScanIncomplete(transactions: RemovalRead["transactions"]): boolean {
  return (transactions?.pageInfo.hasPreviousPage ?? true)
    || (transactions?.nodes ?? []).some((tx) => !!tx.effects?.events?.pageInfo.hasNextPage || !!tx.effects?.balanceChanges?.pageInfo.hasNextPage);
}

/**
 * Liquidity-removal events of each searched venue, by `module::Name`, with the field holding
 * the amount removed ("" when the event states only coin amounts). Each was read off a mainnet
 * event. An event counts only when it names this pool; FlowX v2's names its two coins instead.
 */
const REMOVAL_EVENTS: Record<string, string> = {
  "pool::RemoveLiquidityEvent": "liquidity", // Cetus, Magma
  "pool::RemoveLiquidityV2Event": "liquidity", // Cetus
  "pool::BurnEvent": "liquidity_delta", // Turbos
  "position_manager::DecreaseLiquidityEvent": "liquidity", // Turbos
  "events::LiquidityRemoved": "liquidity", // Bluefin
  "liquidity::RemoveLiquidityEvent": "liquidity", // Momentum
  "position_manager::DecreaseLiquidity": "liquidity", // FlowX CLMM
  "swap::Remove_Liqidity_Pool": "", // BlueMove
  "stable_swap::Remove_Liqidity_Stable_Pool_Event": "", // BlueMove
  "events::WithdrawEvent": "lp_coins_burned", // Aftermath
  "pair::LiquidityRemoved": "liquidity", // FlowX v2
  "spot_dex::LiquidityRemovedEvent": "lsp_burned", // Kriya v2
};

type RemovalEvent = { contents?: { type?: { repr?: string }; json?: Record<string, unknown> } };

/** The events in one transaction that remove liquidity from `pool`; a removal of zero is a fee collection, not a withdrawal. */
export function removalEvidence(events: RemovalEvent[], pool: Pick<PoolCandidate, "pool_id" | "token_a" | "token_b">) {
  return events.flatMap((event) => {
    const type = event.contents?.type?.repr ?? "";
    const json = event.contents?.json ?? {};
    const name = type.split("<")[0]!.split("::").slice(1).join("::");
    const field = REMOVAL_EVENTS[name];
    if (field === undefined) return [];
    const named = json.pool ?? json.pool_id;
    if (typeof named === "string") {
      if (normalizeSuiAddress(named) !== normalizeSuiAddress(pool.pool_id)) return [];
    } else {
      const coins = [json.coin_x, json.coin_y].map((v) => {
        if (typeof v !== "string") return null;
        try { return normalizeStructTag(v.startsWith("0x") ? v : `0x${v}`); } catch { return null; }
      });
      if (name !== "pair::LiquidityRemoved" || !pool.token_a || !pool.token_b
        || !coins.includes(pool.token_a) || !coins.includes(pool.token_b)) return [];
    }
    const removed = field ? json[field] : undefined;
    if (typeof removed === "string" && /^0+$/.test(removed)) return [];
    return [{ type, ...(field ? { liquidity_removed: removed ?? null } : {}), ...(json.after_liquidity !== undefined ? { after_liquidity: json.after_liquidity } : {}) }];
  });
}

/** Recent removals are leads, not evidence that this was every removal. */
async function recentRemovals(pool: PoolCandidate, lpType: string | null, publisher: string | null) {
  const data = await gqlQuery<RemovalRead>(`query($pool: SuiAddress!) {
    transactions(filter: { affectedObject: $pool }, last: 10) {
      nodes { digest sender { address } effects {
        events(first: 50) { nodes { contents { type { repr } json } } pageInfo { hasNextPage } }
        balanceChanges(first: 50) { nodes { owner { address } coinType { repr } amount } pageInfo { hasNextPage } }
      }
      }
      pageInfo { hasPreviousPage }
    }
  }`, { pool: pool.pool_id });
  const matches = (data.transactions?.nodes ?? []).flatMap((tx) => {
    const evidence = removalEvidence(tx.effects?.events?.nodes ?? [], pool);
    const burnedLp = (tx.effects?.balanceChanges?.nodes ?? []).filter((change) =>
      lpType && change.coinType?.repr && normalizeStructTag(change.coinType.repr) === normalizeStructTag(lpType) && BigInt(change.amount) < 0n
    ).map((change) => ({ owner: change.owner?.address ?? null, amount: change.amount }));
    if (evidence.length === 0 && burnedLp.length === 0) return [];
    return [{
      digest: tx.digest, sender: tx.sender?.address ?? null,
      ...(publisher && tx.sender?.address ? { sender_is_publisher: normalizeSuiAddress(tx.sender.address) === normalizeSuiAddress(publisher) } : {}),
      events: evidence,
      lp_spent: burnedLp,
      incomplete: !!tx.effects?.events?.pageInfo.hasNextPage || !!tx.effects?.balanceChanges?.pageInfo.hasNextPage
    }];
  });
  return {
    scan_limit: 10,
    incomplete: removalScanIncomplete(data.transactions),
    matches
  };
}

/** Position minted alongside a pool and the recipient of its initial LP coin. `publisher` marks the coin publisher's own removals and closes. */
export async function readLiquidityOrigin(pool: PoolCandidate, lpType: string | null, publisher: string | null = null) {
  const result = await gqlQuery<CreationRead>(`query($id: SuiAddress!) {
    objectVersions(address: $id, first: 1) { nodes { previousTransaction { digest } } }
  }`, { id: pool.pool_id });
  const digest = result.objectVersions?.nodes[0]?.previousTransaction?.digest;
  if (!digest) return { incomplete: true, reason: "Pool creation transaction unavailable." };
  const positions: Array<{
    position_id: string; minted_to: string | null; current_owner: string | null; last_touch: string | null; current_liquidity: string | null;
    ended?: "deleted" | "wrapped"; ended_by?: string | null; ended_by_publisher?: boolean; end_unavailable?: string;
  }> = [];
  const initialLp: Array<{ address: string; amount: string }> = [];
  let cursor: string | null = null;
  let incomplete = false;
  let poolCreated = false;
  let changesRead = false;
  for (let i = 0; i < MAX_CREATION_PAGES; i++) {
    const created: CreationTx = await gqlQuery<CreationTx>(`query($digest: String!, $after: String) {
      transaction(digest: $digest) { effects {
        objectChanges(first: 50, after: $after) { nodes { address idCreated outputState {
          owner { ... on AddressOwner { address { address } } ... on ConsensusAddressOwner { address { address } } ... on ObjectOwner { address { address } } }
          asMoveObject { contents { type { repr } json } }
        } } pageInfo { hasNextPage endCursor } }
        balanceChanges(first: 50) { nodes { amount owner { address } coinType { repr } } pageInfo { hasNextPage } }
      } }
    }`, { digest, after: cursor });
    const effects: NonNullable<CreationTx["transaction"]>["effects"] = created.transaction?.effects;
    if (!effects?.objectChanges) return { creation_tx: digest, incomplete: true, reason: "Pool creation effects could not be read." };
    if (i === 0 && lpType) {
      for (const change of effects.balanceChanges?.nodes ?? []) {
        if (change.owner?.address && change.coinType?.repr && normalizeStructTag(change.coinType.repr) === normalizeStructTag(lpType) && BigInt(change.amount) > 0n) {
          initialLp.push({ address: change.owner.address, amount: change.amount });
        }
      }
      if (effects.balanceChanges?.pageInfo.hasNextPage) incomplete = true;
    }
    for (const node of effects.objectChanges.nodes) {
      if (node.idCreated && normalizeSuiAddress(node.address) === normalizeSuiAddress(pool.pool_id)) poolCreated = true;
      const type = node.outputState?.asMoveObject?.contents?.type?.repr;
      const json = node.outputState?.asMoveObject?.contents?.json;
      if (!type || !json || !ORIGIN_POSITION_TYPES.has(normalizeStructTag(type).split("<")[0])) continue;
      const poolId = typeof json.pool === "string" ? json.pool : typeof json.pool_id === "string" ? json.pool_id : null;
      if (!poolId || normalizeSuiAddress(poolId) !== normalizeSuiAddress(pool.pool_id)) continue;
      const initialOwner = node.outputState?.owner?.address?.address ?? null;
      // A position can be deleted or wrapped. Its last affecting transaction is
      // the one that did so, and its effects say which; a null current object is never mistaken for burned.
      const latest = await gqlQuery<{
        current?: { owner?: Owner; asMoveObject?: { contents?: { json?: Record<string, unknown> } } } | null;
        touches?: { nodes: Array<{ digest?: string; sender?: { address?: string } | null }> } | null;
      }>(`query($id: SuiAddress!) {
        current: object(address: $id) {
          owner { ... on AddressOwner { address { address } } ... on ConsensusAddressOwner { address { address } } ... on ObjectOwner { address { address } } }
          asMoveObject { contents { json } }
        }
        touches: transactions(filter: { affectedObject: $id }, last: 1) { nodes { digest sender { address } } }
      }`, { id: node.address });
      let currentJson = latest.current?.asMoveObject?.contents?.json;
      // A Turbos NFT holds no liquidity itself; the position object it names does.
      if (currentJson && typeof currentJson.position_id === "string" && currentJson.liquidity === undefined) {
        const inner = await gqlQuery<{ object?: { asMoveObject?: { contents?: { json?: Record<string, unknown> } } } | null }>(
          `query($id: SuiAddress!) { object(address: $id) { asMoveObject { contents { json } } } }`, { id: currentJson.position_id });
        const innerJson = inner.object?.asMoveObject?.contents?.json;
        currentJson = innerJson ? { ...innerJson, pool_id: pool.pool_id } : undefined;
      }
      const currentLiquidity = currentJson ? parsePositionFields(currentJson)?.liquidity.toString() ?? null : null;
      const lastTouch = latest.touches?.nodes[0];
      // Deleting a position requires its liquidity removed first; a wrapped one may still hold it (a farm, a burn certificate).
      let end: { ended?: "deleted" | "wrapped"; ended_by?: string | null; ended_by_publisher?: boolean; end_unavailable?: string } = {};
      if (!latest.current && lastTouch?.digest) {
        const endedBy = lastTouch.sender?.address ?? null;
        end = await objectEndKind(node.address, lastTouch.digest).then(
          (kind) => ({
            ended: kind, ended_by: endedBy,
            ...(publisher && endedBy ? { ended_by_publisher: normalizeSuiAddress(endedBy) === normalizeSuiAddress(publisher) } : {}),
          }),
          (err: unknown) => ({ end_unavailable: err instanceof Error ? err.message : String(err) }),
        );
      }
      positions.push({
        position_id: node.address, minted_to: initialOwner,
        current_owner: latest.current?.owner?.address?.address ?? null,
        last_touch: lastTouch?.digest ?? null,
        current_liquidity: currentLiquidity,
        ...end,
      });
    }
    if (!effects.objectChanges.pageInfo.hasNextPage) { changesRead = true; break; }
    cursor = effects.objectChanges.pageInfo.endCursor ?? null;
    if (!cursor || i === MAX_CREATION_PAGES - 1) { incomplete = true; break; }
  }
  const removals = await recentRemovals(pool, lpType, publisher).catch((err: unknown) => ({
    unavailable: err instanceof Error ? err.message : String(err),
  }));
  // objectVersions starts at the earliest version the service retains, which is the creation only when it created the pool.
  const unverified = changesRead && !poolCreated;
  const burned = positions.filter((p) => p.current_owner && isUnspendableAddress(p.current_owner));
  return {
    creation_tx: digest, incomplete: incomplete || unverified, positions,
    ...(unverified ? { reason: "The earliest retained pool version's transaction did not create the pool, so it is not the creation; its recipients are not the initial ones." } : {}),
    initial_lp_recipients: initialLp, recent_removals: removals,
    // An emptied position sent to 0x0 locks nothing, so a burn counts only with liquidity still in it.
    burned_positions: burned.filter((p) => p.current_liquidity !== null && BigInt(p.current_liquidity) > 0n).length,
    ...(burned.some((p) => p.current_liquidity === "0") ? { burned_empty_positions: burned.filter((p) => p.current_liquidity === "0").length } : {}),
    ...(burned.some((p) => p.current_liquidity === null) ? { burned_positions_liquidity_unread: burned.filter((p) => p.current_liquidity === null).length } : {}),
    note: "Creation recipients, current owners and removal-event senders are chain-derived. Only the ten newest pool transactions were inspected for removals. A position with no current object carries `ended` from its last touch's effects: `deleted` (closed, so its liquidity had been removed) or `wrapped` (inside another object, such as a farm or a burn certificate, whose code decides whether it can be withdrawn)."
  };
}
