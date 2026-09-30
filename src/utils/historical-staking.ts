import { gqlQuery } from "../clients/graphql.js";
import { getNetwork } from "../config.js";
import { checkpointBracket } from "./checkpoint-time.js";
import { BOTH_WAYS_PAGE_INFO, orderedPage, orderedPageArgs, type BothWaysPageInfo } from "./pagination.js";
import { estimateStakedSuiRewards, STAKED_SUI_TYPE } from "./valuers/staked-sui.js";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { withArchiveFallback } from "./archive-fallback.js";
import { readObjectVersions } from "./valuers/common.js";
import { loadStakingContinuation, saveStakingContinuation } from "./staking-continuation.js";

const STAKE_TYPE = /^0x0*3::staking_pool::StakedSui$/;
const MAX_POSITIONS = 10_000;
const DEADLINE_MS = 90_000;

class ScanBudgetExceeded extends Error {
  constructor(readonly budget: "time" | "transactions" | "object_changes") {
    super(`Historical replay stopped at its ${budget === "time" ? "time" : budget === "transactions" ? "transaction" : "object-change page"} budget.`);
  }
}

interface Point { sequenceNumber: number; timestamp: string }
interface Range { first: Point | null; last: Point | null }
interface Page<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
interface Ref { address: string; version: number; stake?: HistoricalStake }
interface State {
  version: number;
  owner: { __typename: string; address?: { address: string } } | null;
  asMoveObject: { contents: { type: { repr: string } } | null } | null;
}
interface Change { address: string; idCreated: boolean | null; idDeleted: boolean | null; inputState: State | null; outputState: State | null }
interface Tx { digest: string; effects: { checkpoint: { sequenceNumber: number }; objectChanges: Page<Change> } | null }
export interface HistoricalStake {
  object_id: string;
  version: number;
  pool_id: string;
  principal_mist: string;
  stake_activation_epoch: string;
  estimated_reward_mist?: string | null;
}

const STATE = `version owner { __typename ... on AddressOwner { address { address } } ... on ConsensusAddressOwner { address { address } } } asMoveObject { contents { type { repr } } }`;
// Only ownership and type ride the scan. Large shared system objects' JSON is
// unnecessary; the final held versions are hydrated once, after replay.
const CHANGES = `nodes { address idCreated idDeleted inputState { ${STATE} } outputState { ${STATE} } } pageInfo { hasNextPage endCursor }`;
const SCAN = `query($owner:SuiAddress!,$afterCp:UInt53,$beforeCp:UInt53!,$first:Int,$after:String,$last:Int,$before:String) {
  transactions(filter:{affectedAddress:$owner,afterCheckpoint:$afterCp,beforeCheckpoint:$beforeCp},first:$first,after:$after,last:$last,before:$before) {
    nodes { digest effects { checkpoint { sequenceNumber } objectChanges(first:50) { ${CHANGES} } } } ${BOTH_WAYS_PAGE_INFO}
  }
}`;
const MORE_CHANGES = `query($digest:String!,$after:String!) { transaction(digest:$digest) { effects { objectChanges(first:50,after:$after) { ${CHANGES} } } } }`;

/** Last checkpoint at or before a timestamp, including all equal-timestamp checkpoints. */
async function resolveAsOf(value: string | number): Promise<number> {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const cp = Number(text);
    if (Number.isSafeInteger(cp) && cp < Number.MAX_SAFE_INTEGER) return cp;
  } else if (typeof value === "string") {
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) {
      const bracket = await checkpointBracket(ms + 1);
      if (!bracket.before || (bracket.atOrAfter && bracket.atOrAfter.seq !== bracket.before.seq + 1)) {
        throw new Error("The requested date could not be resolved to an exact checkpoint at or before it.");
      }
      // A future date must not silently mean today's state.
      if (!bracket.atOrAfter && ms > bracket.before.ms) throw new Error("as_of is later than the indexed chain.");
      return bracket.before.seq;
    }
  }
  throw new Error("as_of must be an ISO 8601 date or a non-negative safe checkpoint number.");
}

function held(state: State | null, owner: string): boolean {
  if (!state) return false;
  if (!state.owner) throw new Error("An object owner is unavailable.");
  if (state.owner.__typename !== "AddressOwner" && state.owner.__typename !== "ConsensusAddressOwner") return false;
  if (!state.owner.address?.address) throw new Error("A direct object owner's address is unavailable.");
  if (state.owner.address.address !== owner) return false;
  if (!state.asMoveObject?.contents?.type?.repr) throw new Error("An owned object's type is unavailable.");
  return STAKE_TYPE.test(state.asMoveObject.contents.type.repr);
}

/** Native effects distinguish absent state from history GraphQL cannot resolve. */
async function replayEffects(digest: string) {
  const result = await withArchiveFallback<GrpcTypes.GetTransactionResponse>(
    client => client.ledgerService.getTransaction({ digest, readMask: { paths: ["effects.changed_objects"] } }),
    response => !response.transaction?.effects,
  );
  const changes = new Map<string, GrpcTypes.ChangedObject>();
  const createdWrapped = new Set<string>();
  for (const change of result.transaction?.effects?.changedObjects ?? []) {
    if (!change.objectId) continue;
    changes.set(change.objectId, change);
    // ChangedObject: input/output DOES_NOT_EXIST = 1, id operation CREATED = 2.
    if (change.inputState === 1 && change.outputState === 1 && change.idOperation === 2) createdWrapped.add(change.objectId);
  }
  return { changes, createdWrapped };
}

/** Effects v1 omitted input holders; resolve the exact input version as moved-value does. */
async function recoverInputStates(changes: Change[], native: Map<string, GrpcTypes.ChangedObject>) {
  const missing = changes.flatMap(change => {
    const effect = native.get(change.address);
    return !change.inputState && change.idCreated !== true && effect?.inputState === 2 &&
      !effect.inputOwner && effect.inputVersion !== undefined
      ? [{ object_id: change.address, version: effect.inputVersion.toString() }] : [];
  });
  if (!missing.length) return;
  const states = await readObjectVersions(missing);
  for (const change of changes) {
    if (change.inputState) continue;
    const version = native.get(change.address)?.inputVersion?.toString();
    const state = states.get(`${change.address}@${version}`);
    if (!state || state.current || state.object_id !== change.address || state.version !== version) continue;
    const kind = state.owner?.kind;
    change.inputState = {
      version: Number(state.version),
      owner: kind && kind !== "other" ? {
        __typename: kind === "address" ? "AddressOwner" : kind === "object" ? "ObjectOwner" : kind === "shared" ? "Shared" : "Immutable",
        ...(state.owner?.address ? { address: { address: state.owner.address } } : {}),
      } : null,
      asMoveObject: { contents: { type: { repr: state.type } } },
    };
  }
}

function apply(changes: Change[], positions: Map<string, Ref>, owner: string, forward: boolean, createdWrapped?: Set<string>) {
  for (const c of changes) {
    if (!c.inputState && !c.outputState && c.idCreated === true && createdWrapped?.has(c.address)) continue;
    const known = c.outputState ?? c.inputState;
    const type = known?.asMoveObject?.contents?.type?.repr;
    // Object types cannot change. Missing opposite states of an unrelated
    // object therefore cannot alter the StakedSui set.
    if (type && !STAKE_TYPE.test(type)) continue;
    if (known?.owner?.__typename === "Immutable" && known.asMoveObject === null) continue;
    // Null states are legitimate at creation/deletion. Other absent states can
    // be wrapped objects or unavailable history; neither proves direct holdings.
    if ((!c.inputState && c.idCreated !== true) || (!c.outputState && c.idDeleted !== true)) {
      throw new Error(`Object state unavailable for ${c.address}; wrapped/unwrapped history cannot prove the held set.`);
    }
    const remove = forward ? c.inputState : c.outputState;
    const add = forward ? c.outputState : c.inputState;
    if (held(remove, owner)) {
      if (positions.get(c.address)?.version !== remove!.version) throw new Error(`Ownership history is discontinuous for ${c.address}.`);
      positions.delete(c.address);
    }
    if (held(add, owner)) {
      if (positions.has(c.address)) throw new Error(`Ownership history repeats ${c.address}.`);
      positions.set(c.address, { address: c.address, version: add!.version });
    }
  }
}

async function ownedAt(owner: string, cp: number, deadline: number, positions: Map<string, Ref>, progress: ReplayProgress) {
  const seen = new Set<string>();
  for (;;) {
    if (Date.now() >= deadline) throw new ScanBudgetExceeded("time");
    const after = progress.owned_cursor ?? null;
    const data: { address: { objects: Page<Ref> } | null } = await gqlQuery(`query($owner:SuiAddress!,$cp:UInt53!,$after:String) {
      address(address:$owner,atCheckpoint:$cp) { objects(filter:{type:"${STAKED_SUI_TYPE}"},first:50,after:$after) {
        nodes { address version } pageInfo { hasNextPage endCursor }
      } }
    }`, { owner, cp, after });
    const page = data.address?.objects;
    if (!page) throw new Error("The anchored holdings set is unavailable.");
    for (const ref of page.nodes) positions.set(ref.address, ref);
    if (positions.size > MAX_POSITIONS) throw new Error("The anchored holdings exceed the position budget.");
    if (!page.pageInfo.hasNextPage) { progress.phase = "transactions"; return; }
    const next = page.pageInfo.endCursor;
    if (!next || next === after || seen.has(next)) throw new Error("The anchored holdings continuation is unavailable.");
    seen.add(next);
    progress.owned_cursor = next;
  }
}

interface Attempt {
  direction: "forward" | "reverse";
  transactions_scanned: number;
  object_change_pages: number;
  reached_checkpoint: number | null;
  complete: boolean;
  reason?: string;
  budget_exhausted?: ScanBudgetExceeded["budget"];
}

interface ReplayProgress {
  phase: "owned" | "transactions" | "done";
  cursor?: string;
  // A time stop may occur inside a transaction page or an object-change page
  // chain. Re-read that fixed-size transaction page, skipping applied changes.
  offset: number;
  page_size?: number;
  change_cursor?: string;
  owned_cursor?: string;
}

interface SavedReplay {
  address: string;
  as_of: string;
  checkpoint: number;
  anchor: number;
  direction: Attempt["direction"];
  method: string;
  calls: number;
  transactions_scanned: number;
  object_change_pages: number;
  progress: ReplayProgress;
  positions: HistoricalStake[];
}

interface ReplayResult {
  positions: Map<string, Ref>;
  progress: ReplayProgress;
  attempt: Attempt;
}

async function replay(owner: string, cp: number, anchor: number, direction: Attempt["direction"], max: number,
  deadline: number, saved?: SavedReplay, direct = false): Promise<ReplayResult> {
  const attempt: Attempt = { direction, transactions_scanned: 0, object_change_pages: 0, reached_checkpoint: null, complete: false };
  const forward = direction === "forward";
  const positions = new Map<string, Ref>(saved?.positions.map(stake => [stake.object_id, { address: stake.object_id, version: stake.version, stake }]));
  const progress: ReplayProgress = saved?.progress ?? { phase: forward ? "transactions" : "owned", offset: 0 };
  try {
    if (progress.phase === "owned") await ownedAt(owner, anchor, deadline, positions, progress);
    if (direct) progress.phase = "done";
    const order = forward ? "oldest" : "newest";
    const cursors = new Set<string>();
    while (progress.phase !== "done") {
      if (Date.now() >= deadline) throw new ScanBudgetExceeded("time");
      if (attempt.transactions_scanned >= max) throw new ScanBudgetExceeded("transactions");
      if (attempt.object_change_pages >= max) throw new ScanBudgetExceeded("object_changes");
      progress.page_size ??= Math.min(50, max - attempt.transactions_scanned);
      const data = await gqlQuery<{ transactions: { nodes: Tx[]; pageInfo: BothWaysPageInfo } }>(SCAN, {
        owner, afterCp: forward ? null : cp, beforeCp: (forward ? cp : anchor) + 1,
        ...orderedPageArgs(order, progress.page_size, progress.cursor),
      });
      const page = orderedPage(data.transactions.nodes, data.transactions.pageInfo, order);
      for (; progress.offset < page.nodes.length; progress.offset++) {
        if (attempt.transactions_scanned >= max) throw new ScanBudgetExceeded("transactions");
        const tx = page.nodes[progress.offset];
        if (!tx.effects?.objectChanges || !tx.effects.checkpoint) throw new Error(`Transaction state unavailable for ${tx.digest}.`);
        let changes = tx.effects.objectChanges;
        let native: { changes: Map<string, GrpcTypes.ChangedObject>; createdWrapped: Set<string> } | undefined;
        const changeCursors = new Set<string>();
        for (;;) {
          if (Date.now() >= deadline) throw new ScanBudgetExceeded("time");
          if (attempt.object_change_pages >= max) throw new ScanBudgetExceeded("object_changes");
          if (progress.change_cursor) {
            const more = await gqlQuery<{ transaction: { effects: { objectChanges: Page<Change> } | null } | null }>(
              MORE_CHANGES, { digest: tx.digest, after: progress.change_cursor });
            if (!more.transaction?.effects?.objectChanges) throw new Error(`Object changes unavailable for ${tx.digest}.`);
            changes = more.transaction.effects.objectChanges;
          }
          attempt.object_change_pages++;
          if (changes.nodes.some(c => !c.inputState && (c.idCreated !== true || !c.outputState))) {
            native ??= await replayEffects(tx.digest);
            await recoverInputStates(changes.nodes, native.changes);
          }
          apply(changes.nodes, positions, owner, forward, native?.createdWrapped);
          if (positions.size > MAX_POSITIONS) throw new Error("The replay exceeds the position budget.");
          if (!changes.pageInfo.hasNextPage) { delete progress.change_cursor; break; }
          const after = changes.pageInfo.endCursor;
          if (!after || after === progress.change_cursor || changeCursors.has(after)) throw new Error("An object-change continuation is unavailable.");
          changeCursors.add(after);
          progress.change_cursor = after;
        }
        attempt.transactions_scanned++;
        attempt.reached_checkpoint = tx.effects.checkpoint.sequenceNumber;
      }
      if (!page.has_next_page) { progress.phase = "done"; break; }
      if (!page.next_cursor || page.next_cursor === progress.cursor || cursors.has(page.next_cursor)) throw new Error("The transaction continuation is unavailable.");
      cursors.add(page.next_cursor);
      progress.cursor = page.next_cursor;
      progress.offset = 0;
      delete progress.page_size;
    }
    attempt.complete = true;
  } catch (error) {
    attempt.reason = error instanceof Error ? error.message : String(error);
    if (error instanceof ScanBudgetExceeded) attempt.budget_exhausted = error.budget;
  }
  return { positions, progress, attempt };
}

async function hydrate(refs: Map<string, Ref>): Promise<HistoricalStake[]> {
  const keys = [...refs.values()].filter(ref => !ref.stake);
  for (let i = 0; i < keys.length; i += 40) {
    const batch = keys.slice(i, i + 40);
    const data = await gqlQuery<{ multiGetObjects: Array<{ address: string; version: number; asMoveObject: { contents: { json: Record<string, unknown> } | null } | null } | null> }>(
      `query($keys:[ObjectKey!]!) { multiGetObjects(keys:$keys) { address version asMoveObject { contents { json } } } }`, { keys: batch });
    for (let j = 0; j < batch.length; j++) {
      const object = data.multiGetObjects[j];
      const json = object?.asMoveObject?.contents?.json;
      if (!object || object.address !== batch[j].address || object.version !== batch[j].version || !json ||
          typeof json.pool_id !== "string" || typeof json.principal !== "string" || !/^\d+$/.test(json.principal) ||
          typeof json.stake_activation_epoch !== "string" || !/^\d+$/.test(json.stake_activation_epoch)) {
        throw new Error(`Historical stake contents unavailable for ${batch[j].address}.`);
      }
      refs.get(object.address)!.stake = { object_id: object.address, version: object.version, pool_id: json.pool_id,
        principal_mist: json.principal, stake_activation_epoch: json.stake_activation_epoch };
    }
  }
  return [...refs.values()].map(ref => ref.stake!).sort((a, b) => a.object_id.localeCompare(b.object_id));
}

/** Exact directly held StakedSui principal; an incomplete reconstruction returns no positions or total. */
export async function historicalStaking(address: string, asOf: string | number, maxTransactions = 1000, continuation?: string): Promise<Record<string, unknown>> {
  const saved = continuation ? loadStakingContinuation<SavedReplay>(continuation) : undefined;
  if (saved && (saved.address !== address || saved.as_of !== String(asOf))) {
    throw new Error("Staking continuation belongs to a different address or as_of. Use the original arguments.");
  }
  const cp = saved?.checkpoint ?? await resolveAsOf(asOf);
  const data = await gqlQuery<{
    serviceConfig: { owned: Range; transactions: Range; objects: Range };
    checkpoint: (Point & { epoch: { epochId: number } }) | null;
  }>(`query($cp:UInt53!) {
    serviceConfig {
      owned: availableRange(type:"Address",field:"objects") { first { sequenceNumber timestamp } last { sequenceNumber timestamp } }
      transactions: availableRange(type:"Query",field:"transactions") { first { sequenceNumber timestamp } last { sequenceNumber timestamp } }
      objects: availableRange(type:"Query",field:"object") { first { sequenceNumber timestamp } last { sequenceNumber timestamp } }
    }
    checkpoint(sequenceNumber:$cp) { sequenceNumber timestamp epoch { epochId } }
  }`, { cp });
  if (!data.checkpoint) throw new Error("The requested checkpoint is unavailable.");
  const ranges = data.serviceConfig;
  const base = {
    address, as_of: asOf, at_checkpoint: cp, timestamp: data.checkpoint.timestamp, epoch: data.checkpoint.epoch.epochId,
    scope: "Directly address-owned StakedSui objects at the end of the checkpoint, including transferred and split/joined positions. Excludes wrapped/object-owned stakes, FungibleStakedSui and liquid-staking tokens. Principal excludes rewards; an empty set makes no claim about those excluded holdings.",
    max_transactions: maxTransactions, available_ranges: ranges, replay_calls: (saved?.calls ?? 0) + 1,
  };
  const attempts: Attempt[] = [];
  let refs: Map<string, Ref> | undefined;
  let method = saved?.method ?? "reconstructed_object_changes";
  let reason: string | undefined;
  let direction: Attempt["direction"] | undefined;
  let stopped: ReplayResult | undefined;
  let selected: ReplayResult | undefined;
  const start = ranges.owned?.first?.sequenceNumber;
  const end = ranges.owned?.last?.sequenceNumber;
  const anchor = saved?.anchor ?? (end === undefined || start === undefined ? null : Math.max(start, end - 10));
  const txFirst = ranges.transactions?.first?.sequenceNumber;
  const txLast = ranges.transactions?.last?.sequenceNumber;
  const objectFirst = ranges.objects?.first?.sequenceNumber;
  const forwardAllowed = txFirst === 0 && objectFirst === 0 && txLast !== undefined && txLast >= cp;
  const reverseAllowed = anchor !== null && anchor >= cp && txFirst !== undefined && txFirst <= cp && txLast !== undefined && txLast >= anchor && objectFirst !== undefined && objectFirst <= cp;
  const take = (result: ReplayResult) => {
    attempts.push(result.attempt);
    if (result.attempt.complete) {
      refs = result.positions;
      direction = result.attempt.direction;
      selected = result;
    } else if (result.attempt.budget_exhausted && !stopped) {
      stopped = result;
    }
  };
  if (saved) {
    const ownedRetained = start !== undefined && end !== undefined && saved.anchor >= start && saved.anchor <= end;
    if ((saved.progress.phase === "owned" && !ownedRetained) ||
        (method !== "checkpoint_objects" && !(saved.direction === "forward" ? forwardAllowed : reverseAllowed))) {
      throw new Error("Stale staking continuation: the provider no longer retains the anchored holdings or replay range. Start again without continuation.");
    }
    const result = await replay(address, cp, saved.anchor, saved.direction, maxTransactions,
      Date.now() + DEADLINE_MS / 2, saved, method === "checkpoint_objects");
    if (!result.attempt.complete && !result.attempt.budget_exhausted) {
      throw new Error(`Staking continuation replay is stale or unavailable: ${result.attempt.reason}`);
    }
    take(result);
  } else if (start !== undefined && end !== undefined && cp >= start && cp <= end) {
    method = "checkpoint_objects";
    take(await replay(address, cp, cp, "reverse", maxTransactions, Date.now() + DEADLINE_MS, undefined, true));
  } else {
    const bounds = await gqlQuery<{ first: { nodes: Array<{ effects: { checkpoint: { sequenceNumber: number } } }> }; last: { nodes: Array<{ effects: { checkpoint: { sequenceNumber: number } } }> } }>(
      `query($owner:SuiAddress!,$before:UInt53!) {
        first: transactions(filter:{affectedAddress:$owner,beforeCheckpoint:$before},first:1) { nodes { effects { checkpoint { sequenceNumber } } } }
        last: transactions(filter:{affectedAddress:$owner,beforeCheckpoint:$before},last:1) { nodes { effects { checkpoint { sequenceNumber } } } }
      }`, { owner: address, before: (anchor ?? cp) + 1 });
    const first = bounds.first.nodes[0]?.effects.checkpoint.sequenceNumber ?? cp;
    const last = bounds.last.nodes[0]?.effects.checkpoint.sequenceNumber ?? cp;
    const order: Attempt["direction"][] = cp - first < last - cp ? ["forward", "reverse"] : ["reverse", "forward"];
    for (const side of order) {
      if (side === "forward" ? !forwardAllowed : !reverseAllowed) continue;
      // Try both on the initial call, but resume only the selected saved walk.
      take(await replay(address, cp, anchor ?? cp, side, maxTransactions, Date.now() + DEADLINE_MS / 2));
      if (refs) break;
    }
  }
  if (!refs) reason = stopped?.attempt.reason ?? attempts.at(-1)?.reason ?? "The retained transaction/object ranges cannot cover either complete reconstruction.";
  let positions: HistoricalStake[] = [];
  if (refs) {
    try { positions = await hydrate(refs); } catch (e) { refs = undefined; reason = String(e); }
  }
  const timeStopped = attempts.some(attempt => attempt.budget_exhausted === "time");
  if (!refs) {
    let next: Record<string, unknown> = {};
    if (stopped) {
      try {
        const state: SavedReplay = {
          address, as_of: String(asOf), checkpoint: cp, anchor: method === "checkpoint_objects" ? cp : anchor ?? cp,
          direction: stopped.attempt.direction, method, calls: base.replay_calls,
          transactions_scanned: (saved?.transactions_scanned ?? 0) + stopped.attempt.transactions_scanned,
          object_change_pages: (saved?.object_change_pages ?? 0) + stopped.attempt.object_change_pages,
          progress: stopped.progress, positions: await hydrate(stopped.positions),
        };
        const stored = saveStakingContinuation(state);
        next = {
          direction: state.direction, anchor_checkpoint: state.direction === "reverse" ? state.anchor : null,
          replay_transactions_scanned: state.transactions_scanned, replay_object_change_pages: state.object_change_pages,
          continue_with: { tool: "get_staking_summary", args: { address, network: getNetwork(), as_of: asOf, max_transactions: maxTransactions, continuation: stored.token } },
          continuation_storage: stored.storage,
          continuation_note: stored.storage === "argument"
            ? "Resume this same replay with continue_with. The authenticated state fits in the argument (at most 8 KiB); it expires after 24 hours or a server restart."
            : "Resume this same replay with continue_with. The state exceeds 8 KiB and is saved in SUI_STORE_PATH; this handle needs the same store and expires after 24 hours.",
        };
      } catch (e) {
        next = { continuation_unavailable: e instanceof Error ? e.message : String(e) };
      }
    }
    return { ...base, method, complete: false, total_staked_mist: null, position_count: null, positions: [],
      estimated_reward_mist: null, total_unavailable: reason, attempts, ...next,
      ...(timeStopped ? { time_budget_reached: true } : {}),
    };
  }
  let rewardsUnavailable: string | undefined;
  try {
    const rewards = await estimateStakedSuiRewards(positions, data.checkpoint.epoch.epochId);
    for (const p of positions) p.estimated_reward_mist = rewards.get(p.object_id) ?? null;
    if (positions.some(p => p.estimated_reward_mist === null)) rewardsUnavailable = "One or more activation/target-epoch exchange rates are unavailable; no total reward is given.";
  } catch (e) { rewardsUnavailable = `Historical rewards unavailable: ${String(e)}`; }
  return { ...base, method, ...(direction && method !== "checkpoint_objects" ? { direction, anchor_checkpoint: direction === "reverse" ? anchor : null } : {}),
    replay_transactions_scanned: (saved?.transactions_scanned ?? 0) + (selected?.attempt.transactions_scanned ?? 0),
    replay_object_change_pages: (saved?.object_change_pages ?? 0) + (selected?.attempt.object_change_pages ?? 0),
    complete: true, total_staked_mist: positions.reduce((n, p) => n + BigInt(p.principal_mist), 0n).toString(),
    position_count: positions.length, positions, attempts,
    estimated_reward_mist: rewardsUnavailable ? null : positions.reduce((n, p) => n + BigInt(p.estimated_reward_mist ?? "0"), 0n).toString(),
    reward_method: "Principal converted to pool tokens at its activation-epoch rate, then to SUI at the checkpoint epoch's rate, floored and clamped at zero. Estimate excludes any withdrawal-time reward-pool balance cap; no current-epoch rate is substituted.",
    ...(rewardsUnavailable ? { rewards_unavailable: rewardsUnavailable } : {}),
  };
}
