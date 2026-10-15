import { normalizeSuiAddress, normalizeStructTag } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { parsePositionFields, VERIFIED_POSITION_TYPES } from "./valuers/clmm.js";
import { isUnspendableAddress } from "./upgrade-cap.js";
import type { PoolCandidate } from "../tools/pools.js";

interface Owner { address?: { address: string } }
interface CreatedObject {
  address: string;
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

/** Recent removals are leads, not evidence that this was every removal. */
async function recentRemovals(pool: PoolCandidate, lpType: string | null) {
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
    const evidence = (tx.effects?.events?.nodes ?? []).filter((event) => {
      if (!/Remove[_]?Li(?:quidity|qidity)/i.test(event.contents?.type?.repr ?? "")) return false;
      const named = event.contents?.json?.pool ?? event.contents?.json?.pool_id;
      return typeof named !== "string" || normalizeSuiAddress(named) === normalizeSuiAddress(pool.pool_id);
    });
    const burnedLp = (tx.effects?.balanceChanges?.nodes ?? []).filter((change) =>
      lpType && change.coinType?.repr && normalizeStructTag(change.coinType.repr) === normalizeStructTag(lpType) && BigInt(change.amount) < 0n
    ).map((change) => ({ owner: change.owner?.address ?? null, amount: change.amount }));
    if (evidence.length === 0 && burnedLp.length === 0) return [];
    return [{
      digest: tx.digest, sender: tx.sender?.address ?? null,
      events: evidence.map((e) => ({ type: e.contents?.type?.repr ?? null, after_liquidity: e.contents?.json?.after_liquidity ?? null })),
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

/** Position minted alongside a pool and the recipient of its initial LP coin. */
export async function readLiquidityOrigin(pool: PoolCandidate, lpType: string | null) {
  const result = await gqlQuery<CreationRead>(`query($id: SuiAddress!) {
    objectVersions(address: $id, first: 1) { nodes { previousTransaction { digest } } }
  }`, { id: pool.pool_id });
  const digest = result.objectVersions?.nodes[0]?.previousTransaction?.digest;
  if (!digest) return { incomplete: true, reason: "Pool creation transaction unavailable." };
  const positions: Array<{ position_id: string; minted_to: string | null; current_owner: string | null; last_touch: string | null; current_liquidity: string | null }> = [];
  const initialLp: Array<{ address: string; amount: string }> = [];
  let cursor: string | null = null;
  let incomplete = false;
  for (let i = 0; i < MAX_CREATION_PAGES; i++) {
    const created: CreationTx = await gqlQuery<CreationTx>(`query($digest: String!, $after: String) {
      transaction(digest: $digest) { effects {
        objectChanges(first: 50, after: $after) { nodes { address outputState {
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
      const type = node.outputState?.asMoveObject?.contents?.type?.repr;
      const json = node.outputState?.asMoveObject?.contents?.json;
      if (!type || !json || !ORIGIN_POSITION_TYPES.has(normalizeStructTag(type).split("<")[0])) continue;
      const poolId = typeof json.pool === "string" ? json.pool : typeof json.pool_id === "string" ? json.pool_id : null;
      if (!poolId || normalizeSuiAddress(poolId) !== normalizeSuiAddress(pool.pool_id)) continue;
      const initialOwner = node.outputState?.owner?.address?.address ?? null;
      // A position can be deleted or wrapped. objectVersions still lists its
      // latest write; a null current object is never mistaken for burned.
      const latest = await gqlQuery<{
        current?: { owner?: Owner; asMoveObject?: { contents?: { json?: Record<string, unknown> } } } | null;
        versions?: { nodes: Array<{ previousTransaction?: { digest?: string } }> } | null;
      }>(`query($id: SuiAddress!) {
        current: object(address: $id) {
          owner { ... on AddressOwner { address { address } } ... on ConsensusAddressOwner { address { address } } ... on ObjectOwner { address { address } } }
          asMoveObject { contents { json } }
        }
        versions: objectVersions(address: $id, last: 1) { nodes { previousTransaction { digest } } }
      }`, { id: node.address });
      const currentJson = latest.current?.asMoveObject?.contents?.json;
      const currentLiquidity = currentJson ? parsePositionFields(currentJson)?.liquidity.toString() ?? null : null;
      positions.push({
        position_id: node.address, minted_to: initialOwner,
        current_owner: latest.current?.owner?.address?.address ?? null,
        last_touch: latest.versions?.nodes[0]?.previousTransaction?.digest ?? null,
        current_liquidity: currentLiquidity
      });
    }
    if (!effects.objectChanges.pageInfo.hasNextPage) break;
    cursor = effects.objectChanges.pageInfo.endCursor ?? null;
    if (!cursor || i === MAX_CREATION_PAGES - 1) { incomplete = true; break; }
  }
  const removals = await recentRemovals(pool, lpType).catch((err: unknown) => ({
    unavailable: err instanceof Error ? err.message : String(err),
  }));
  return {
    creation_tx: digest, incomplete, positions,
    initial_lp_recipients: initialLp, recent_removals: removals,
    burned_positions: positions.filter((p) => p.current_owner && isUnspendableAddress(p.current_owner)).length,
    note: "Creation recipients, current owners and removal-event senders are chain-derived. Only the ten newest pool transactions were inspected for removals. A last-touch transaction alone does not prove a withdrawal; a null current owner includes deleted or wrapped positions."
  };
}
