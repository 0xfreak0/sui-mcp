/**
 * Pure helpers for object provenance: describe an owner and detect ownership
 * transitions across an object's version history. Kept pure for unit-testing.
 */

/**
 * `consensus` is a party object (`ConsensusAddressOwner`, e.g. sent with
 * `transfer::party_transfer`): exactly one address owns it and only that
 * address can use it, while its transactions are ordered through consensus
 * the way a shared object's are. It is address-held, not shared.
 *
 * `object` is an object held BY another object: a kiosk-placed NFT's owner
 * is the kiosk's `kiosk::Item` dynamic-field wrapper, not an address at all.
 */
export type OwnerDesc =
  | { kind: "address"; address: string }
  | { kind: "consensus"; address: string }
  | { kind: "object"; address: string }
  | { kind: "shared" }
  | { kind: "immutable" }
  | { kind: "unknown" };

export interface VersionEntry {
  version: string;
  tx: string | null;
  timestamp: string | null;
  checkpoint: string | null;
  owner: OwnerDesc;
}

export interface OwnerChange {
  from: OwnerDesc;
  to: OwnerDesc;
  at_version: string;
  tx: string | null;
  timestamp: string | null;
}

/** Parse a GraphQL object owner union into an OwnerDesc. */
export function ownerDesc(o: { __typename?: string; address?: { address: string } } | null | undefined): OwnerDesc {
  switch (o?.__typename) {
    case "AddressOwner":
      return { kind: "address", address: o.address?.address ?? "" };
    case "ConsensusAddressOwner":
      return { kind: "consensus", address: o.address?.address ?? "" };
    case "ObjectOwner":
      return { kind: "object", address: o.address?.address ?? "" };
    case "Shared":
      return { kind: "shared" };
    case "Immutable":
      return { kind: "immutable" };
    default:
      return { kind: "unknown" };
  }
}

/** Stable identity key for an owner (the address distinguishes held owners). */
export function ownerKey(o: OwnerDesc): string {
  return o.kind === "address" || o.kind === "consensus" || o.kind === "object"
    ? `${o.kind}:${o.address}`
    : o.kind;
}

/**
 * Detect ownership transitions across a chronological (oldest-first) version
 * history. Each entry where the owner differs from the previous version yields
 * one change — this is the provenance signal (transfers, sharing, freezing).
 */
export function computeOwnerChanges(entries: VersionEntry[]): OwnerChange[] {
  const changes: OwnerChange[] = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1].owner;
    const cur = entries[i].owner;
    if (ownerKey(prev) !== ownerKey(cur)) {
      changes.push({
        from: prev,
        to: cur,
        at_version: entries[i].version,
        tx: entries[i].tx,
        timestamp: entries[i].timestamp,
      });
    }
  }
  return changes;
}

/** A checkpoint and the owner the object had as of it. */
export interface CheckpointState {
  checkpoint: number;
  owner: OwnerDesc;
}

/** One checkpoint where the owner changed, and what it changed to. */
export interface OwnerTransitionPoint {
  checkpoint: number;
  owner: OwnerDesc;
}

export interface TransitionSearch {
  transitions: OwnerTransitionPoint[];
  /** The budget ran out before every sub-range was resolved. */
  truncated: boolean;
  /**
   * Ranges the search stopped inside while their ends disagreed: each holds
   * at least one owner change, from `lo.owner` to `hi.owner`, not yet pinned
   * to a checkpoint. Empty unless `truncated`.
   */
  unresolved: { lo: CheckpointState; hi: CheckpointState }[];
}

/**
 * Find every checkpoint where an object's owner changed, between `lo` and
 * `hi`, without reading every version in between.
 *
 * A capability mutated on every privileged call can accumulate thousands of
 * versions between two real ownership changes. Paging through that history,
 * forward or backward, needs an unbounded number of pages to reach such a
 * transition.
 *
 * Owner is piecewise-constant between transitions (`GraphQL
 * object(atCheckpoint:)` interpolates to the state as of the last write at or
 * before the checkpoint asked for), so this is a `git bisect`: wherever the
 * two ends of a range agree, the search drops the range and does not probe
 * inside it. That leaves a blind spot: an object whose owner went
 * A -> B -> A between the two probed ends (a capability handed out and
 * returned, a kiosk item taken out and placed back) reports zero
 * transitions there, indistinguishable from an object that never moved.
 * Wherever the ends disagree, the search keeps splitting until adjacent
 * checkpoints disagree, which pins the transition exactly to the checkpoint
 * whose write changed it. Total reads are O(transitions x log(range))
 * rather than O(versions), cheap regardless of how hot the object is,
 * because what is being searched for is rare even when the object is busy.
 * The two halves of a range are searched at once, so wall time grows with
 * the depth of the search, about log(range) reads, rather than with the
 * number of reads. A range the budget stops inside is returned in
 * `unresolved`: it holds an owner change the search did not pin.
 * Callers must not report a bisected span as covering an object's full life:
 * only that no DISAGREEMENT was found at the checkpoints this search chose.
 *
 * Two owner changes landing in the SAME checkpoint are indistinguishable
 * from one: checkpoint granularity is the finest this can resolve.
 */
export interface TransitionBudget {
  /** Reads remaining, shared by every branch; each read halves a checkpoint range. */
  remaining: number;
  /** Wall-clock deadline (`Date.now()`-comparable); once passed, the search
   *  stops splitting and reports truncated, the same as running out of
   *  `remaining`. These are network calls with no per-call timeout of their
   *  own, so `remaining` alone bounds call COUNT, not time spent, and a slow
   *  endpoint can blow a client's deadline before the reads run out.
   *  Optional so the many pure-logic tests that construct a budget need not
   *  set it. */
  deadlineMs?: number;
}
export async function findOwnerTransitions(
  lo: CheckpointState,
  hi: CheckpointState,
  fetchOwnerAt: (checkpoint: number) => Promise<OwnerDesc>,
  budget: TransitionBudget,
): Promise<TransitionSearch> {
  if (ownerKey(lo.owner) === ownerKey(hi.owner)) return { transitions: [], truncated: false, unresolved: [] };
  if (hi.checkpoint - lo.checkpoint <= 1) {
    return { transitions: [{ checkpoint: hi.checkpoint, owner: hi.owner }], truncated: false, unresolved: [] };
  }
  if (budget.remaining <= 0 || (budget.deadlineMs !== undefined && Date.now() >= budget.deadlineMs)) {
    return { transitions: [], truncated: true, unresolved: [{ lo, hi }] };
  }
  budget.remaining -= 1;
  const mid = Math.floor((lo.checkpoint + hi.checkpoint) / 2);
  const midState: CheckpointState = { checkpoint: mid, owner: await fetchOwnerAt(mid) };
  const [left, right] = await Promise.all([
    findOwnerTransitions(lo, midState, fetchOwnerAt, budget),
    findOwnerTransitions(midState, hi, fetchOwnerAt, budget),
  ]);
  return {
    transitions: [...left.transitions, ...right.transitions],
    truncated: left.truncated || right.truncated,
    unresolved: [...left.unresolved, ...right.unresolved],
  };
}

/**
 * {@link findOwnerTransitions} with one read first at the checkpoint before
 * `hi`. The span's upper end is a write of the object (its latest version,
 * or the version before a page), and a change made by that write would
 * otherwise cost bisection about log2(range) reads to pin; this read
 * settles it and leaves the rest of the span to bisection.
 */
export async function findOwnerTransitionsFromEnd(
  lo: CheckpointState,
  hi: CheckpointState,
  fetchOwnerAt: (checkpoint: number) => Promise<OwnerDesc>,
  budget: TransitionBudget,
): Promise<TransitionSearch> {
  if (ownerKey(lo.owner) === ownerKey(hi.owner) || hi.checkpoint - lo.checkpoint <= 2 || budget.remaining <= 0) {
    return findOwnerTransitions(lo, hi, fetchOwnerAt, budget);
  }
  budget.remaining -= 1;
  const before: CheckpointState = { checkpoint: hi.checkpoint - 1, owner: await fetchOwnerAt(hi.checkpoint - 1) };
  const rest = await findOwnerTransitions(lo, before, fetchOwnerAt, budget);
  const atEnd = ownerKey(before.owner) === ownerKey(hi.owner) ? [] : [{ checkpoint: hi.checkpoint, owner: hi.owner }];
  return { ...rest, transitions: [...rest.transitions, ...atEnd] };
}
