/**
 * Watching an investigation's addresses without drowning the agent.
 *
 * The constraint that shapes everything here is arithmetic. Mainnet produces
 * 4.25 checkpoints and ~74 transactions a second; subscribing to the checkpoint
 * stream is 1.1 GB/hour, which is ~323 million tokens an hour. An agent with a
 * 200k context would be full in 2.2 seconds. Streaming chain data to a model is
 * not expensive, it is impossible.
 *
 * The same measurement gives the way out: only 160 DISTINCT addresses were
 * touched in those 30 seconds. Against a watch set of twenty, the stream is
 * essentially all noise, so the useful signal is roughly one part in a million.
 * Everything here exists to do that reduction outside the model's context.
 *
 * ## Polling, not streaming
 *
 * `afterCheckpoint` on the `transactions` filter is EXCLUSIVE — verified on a
 * wallet with no activity since January: asking after its last checkpoint
 * returns nothing, after the one before returns exactly one. So remembering the
 * highest checkpoint seen per address gives a delta with no duplicates and no
 * gaps, which is all a watch needs. Polling costs about 60 requests an hour
 * against 1.1 GB, and the latency it trades away is latency nobody consumes: an
 * investigation cares that funds moved, not that they moved 900ms ago.
 *
 * Streaming becomes the better trade past roughly fifty watched addresses,
 * where polling's per-address cost overtakes the stream's flat one. Native gRPC
 * `subscribeCheckpoints` works against the public fullnode and is the way in if
 * that day comes — the gRPC-Web transport this server uses cannot do it, and
 * the archive answers UNIMPLEMENTED.
 *
 * ## Two phases, forced by the service and useful anyway
 *
 * A batched delta query carries a MINIMAL selection — digest and checkpoint.
 * Twenty aliases of that is 3,917 bytes, inside the 5,000-byte query cap;
 * adding balance changes to each alias breaks the separate 300-node limit at
 * twenty and the byte cap at thirty. So detail is a second, separate fetch,
 * made only for addresses that actually moved.
 *
 * That is also the right shape for context: the common answer is "nothing
 * happened", and it has to cost almost nothing to say.
 */

import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { findLookalikes } from "./address-lookalike.js";
import { custodyChanges, type ObjectMovement } from "./object-flow.js";

/** Addresses per delta request. The 5,000-byte query cap is what binds. */
export const WATCH_BATCH_SIZE = 20;

/**
 * Validate and pad a watched address, or return null.
 *
 * A delta query is built by interpolating twenty addresses into one aliased
 * GraphQL document, and the service answers a single bad `SuiAddress` with a
 * top-level `data: null` — not with a null for that one alias. Verified
 * against mainnet: a batch of two where one address was `not-an-address`
 * returned no data for either. So one mistyped address makes `poll_watch`
 * report nothing for every OTHER address being watched, which is the failure a
 * watch exists to prevent.
 *
 * This is the same rule `get_transactions` already follows for digests, where
 * one malformed key among fifty returned nothing at all. The reason it needs
 * its own check is that `normalizeSuiAddress` pads without validating:
 * `not-an-address` becomes a well-formed-looking 66-character string that is
 * not hex, and only `isValidSuiAddress` rejects it.
 */
export function normalizeWatchAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let padded: string;
  try {
    padded = normalizeSuiAddress(trimmed.toLowerCase());
  } catch {
    return null;
  }
  return isValidSuiAddress(padded) ? padded : null;
}

/** What a watch is looking at. Only addresses for now. */
export interface WatchEntry {
  /** Canonical padded form, compared against what the chain returns. */
  address: string;
  /**
   * The address as the store row holds it, which is what keys that row.
   * Normalizing on read fixed comparison and broke the cursor: the UPDATE is
   * keyed on the STORED string, so a legacy row spelled `0x2` matched nothing
   * and its watch silently never advanced. Absent when the two are the same.
   */
  store_key?: string;
  /** Highest checkpoint already reported. Deltas are asked strictly after it. */
  last_checkpoint: number;
  /** Only report a coin movement at or above this, in raw units of any coin. */
  min_amount?: string;
  label?: string;
  added_at: number;
}

/**
 * Why a watch fired.
 *
 * A reason, not a payload. The agent decides from this whether to spend a
 * `get_transaction` call, and that decision is the whole point — returning the
 * transaction inline would put the thing we are avoiding back in the context.
 */
export type HitReason =
  | "value_in"
  | "value_out"
  /** Something happened that moved no coin and no object we could name. */
  | "appeared"
  | "sink_reached"
  /** A framework capability changed hands: mint, upgrade, freeze or publish. */
  | "capability_moved"
  /** A non-coin object changed hands — an NFT, a kiosk item, a position. */
  | "object_moved"
  /** A new counterparty renders like an address already in the watch set. */
  | "lookalike_appeared";

export interface WatchHit {
  address: string;
  label?: string;
  digest: string;
  checkpoint: number;
  timestamp?: string | null;
  reasons: HitReason[];
  /** Net raw units for the watched address, summed per coin type. */
  net?: Record<string, string>;
  counterparties?: string[];
  /** Short type names of non-coin objects that changed hands, if any. */
  objects?: string[];
  /** What a moved capability grants, when the type is one whose powers we know. */
  capability_note?: string;
}

/** One address's new transactions, as the delta query returns them. */
export interface DeltaTx {
  digest: string;
  checkpoint: number;
  timestamp?: string | null;
  sender?: string | null;
  balance_changes?: Array<{ address: string; amount: string; coin_type: string }>;
  /**
   * Non-coin objects that moved, from the phase-two fetch.
   *
   * A capability or an NFT changes hands WITHOUT producing a balance change, so
   * a watch reading only balances is blind to exactly the transfers worth
   * waking someone for: mint authority, upgrade rights, a stolen NFT.
   */
  object_movements?: ObjectMovement[];
}

/**
 * Split a watch set into requests.
 *
 * Exported so the batching is testable without a network: getting this wrong
 * means a silently dropped address, which is a watch that reports nothing and
 * looks calm.
 */
export function planBatches<T>(entries: T[], size = WATCH_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < entries.length; i += size) out.push(entries.slice(i, i + size));
  return out;
}

function bigOrZero(v: string | undefined): bigint {
  if (!v) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

/**
 * Turn one address's new transactions into hits, applying its triggers.
 *
 * Returns the hits and the new high-water checkpoint. The checkpoint ADVANCES
 * EVEN WHEN A TRIGGER SUPPRESSES THE HIT — a filtered transaction has still
 * been seen, and leaving the cursor behind would re-read it forever and report
 * it the moment the threshold changed.
 */
/**
 * Where the cursor may safely advance to, given a page that may be a prefix.
 *
 * `afterCheckpoint` is exclusive at CHECKPOINT granularity, but the page cap
 * cuts at TRANSACTION granularity. So when a page comes back full, its last
 * transaction is usually not the last one in its checkpoint, and advancing to
 * that checkpoint excludes the rest of it from every future poll. Measured on
 * one mainnet address: 30 transactions spanning 13 checkpoints, 8 of which held
 * more than one — a boundary landing mid-checkpoint most of the time, and only
 * on the busy addresses this feature exists for.
 *
 * So a saturated page stops one checkpoint SHORT of its own maximum. The
 * boundary checkpoint is read again next poll and its transactions may be
 * reported twice; re-reporting is recoverable and silent loss is not.
 *
 * When a full page sits entirely inside ONE checkpoint there is no safe
 * advance: stopping short cannot make progress and advancing drops the
 * remainder. That is reported rather than decided — `stalled` means the cap is
 * below the address's per-checkpoint rate and only a larger `max_per_address`
 * can move it.
 */
export function safeAdvance(
  txs: DeltaTx[],
  saturated: boolean,
  current: number,
): { checkpoint: number; stalled: boolean } {
  const cps = txs.map((t) => t.checkpoint).filter((c) => c > 0);
  if (cps.length === 0) return { checkpoint: current, stalled: false };
  const high = Math.max(...cps);
  if (!saturated) return { checkpoint: high, stalled: false };
  const low = Math.min(...cps);
  if (low === high) return { checkpoint: current, stalled: true };
  return { checkpoint: Math.max(high - 1, current), stalled: false };
}

export function evaluate(
  entry: WatchEntry,
  txs: DeltaTx[],
  opts?: {
    isSink?: (address: string) => boolean;
    labelFor?: (address: string) => string | undefined;
    /** This address's delta filled the per-poll cap, so the page is a prefix. */
    saturated?: boolean;
  },
): { hits: WatchHit[]; last_checkpoint: number; stalled: boolean } {
  const hits: WatchHit[] = [];
  // A stored floor is validated here too, not only where it was written: a row
  // from an earlier build can hold "0.5", which threw inside BigInt and became
  // a floor of zero, so the caller saw everything and was told nothing. An
  // unusable value is no floor, which is what it already was — but now the
  // read side agrees with the write side about what is acceptable.
  const floor = /^\d+$/.test((entry.min_amount ?? "").trim()) ? bigOrZero(entry.min_amount) : 0n;

  for (const tx of txs) {
    const net = new Map<string, bigint>();
    const counterparties = new Set<string>();
    for (const bc of tx.balance_changes ?? []) {
      if (bc.address === entry.address) {
        net.set(bc.coin_type, (net.get(bc.coin_type) ?? 0n) + bigOrZero(bc.amount));
      } else if (bc.address) {
        counterparties.add(bc.address);
      }
    }

    const reasons: HitReason[] = [];
    let largest = 0n;
    for (const amount of net.values()) {
      const size = amount < 0n ? -amount : amount;
      if (size > largest) largest = size;
      if (amount > 0n && !reasons.includes("value_in")) reasons.push("value_in");
      if (amount < 0n && !reasons.includes("value_out")) reasons.push("value_out");
    }

    // A transaction that moved no coin still matters — an NFT or a capability
    // moves without one, which is exactly what object flow is for.
    const moved = custodyChanges(tx.object_movements ?? []).filter(
      (m) => m.from?.address === entry.address || m.to?.address === entry.address,
    );
    const capabilities = moved.filter((m) => m.high_consequence && !m.renounced);
    if (capabilities.length) reasons.push("capability_moved");
    else if (moved.length) reasons.push("object_moved");

    if (reasons.length === 0) reasons.push("appeared");

    for (const other of counterparties) {
      if (opts?.isSink?.(other)) {
        reasons.push("sink_reached");
        break;
      }
    }

    // A floor filters VALUE movements only. Suppressing `sink_reached`, or a
    // coinless transaction such as a capability changing hands, because it
    // carried little money would drop the findings that have nothing to do
    // with amount — including the loudest one the watch has.
    const onlyValue = reasons.every((r) => r === "value_in" || r === "value_out");
    if (floor > 0n && onlyValue && largest < floor) continue;

    hits.push({
      address: entry.address,
      ...(entry.label ? { label: entry.label } : {}),
      digest: tx.digest,
      checkpoint: tx.checkpoint,
      timestamp: tx.timestamp ?? null,
      reasons,
      ...(net.size
        ? { net: Object.fromEntries([...net].map(([coin, amount]) => [coin, amount.toString()])) }
        : {}),
      ...(counterparties.size ? { counterparties: [...counterparties] } : {}),
      ...(moved.length ? { objects: moved.map((m) => m.type_short ?? "unknown") } : {}),
      ...(capabilities[0]?.note ? { capability_note: capabilities[0].note } : {}),
    });
  }

  const advance = safeAdvance(txs, opts?.saturated ?? false, entry.last_checkpoint);
  return { hits, last_checkpoint: advance.checkpoint, stalled: advance.stalled };
}

/**
 * Flag hits whose counterparty renders like an address already being watched.
 *
 * Run over the whole poll rather than per transaction, because the pair is the
 * finding and one half of it is the watch set. This is the case the detector
 * exists for: someone grinds a lookalike of an address under investigation and
 * sends dust, so it turns up as a NEW counterparty of the very wallet being
 * watched. Pure, and it costs no request — the addresses are already in hand.
 */
export function flagLookalikes(watched: string[], hits: WatchHit[]): WatchHit[] {
  const counterparties = new Set<string>();
  for (const h of hits) for (const c of h.counterparties ?? []) counterparties.add(c);
  if (counterparties.size === 0) return hits;

  const pairs = findLookalikes([...new Set([...watched, ...counterparties])]);
  if (pairs.length === 0) return hits;

  // Only pairs that bring in something NEW, and only against a WATCHED address.
  // Two watched addresses resembling each other is a fact about the watch set,
  // not an event. Two COUNTERPARTIES resembling each other is not about the
  // subject at all: accepting either side independently flagged such a pair and
  // reported it as something impersonating the address under investigation,
  // which is a false claim about the strongest finding this check makes.
  const watchedSet = new Set(watched);
  const suspects = new Set<string>();
  for (const p of pairs) {
    const sides = [p.established, p.suspect] as const;
    for (const [i, side] of sides.entries()) {
      const other = sides[i === 0 ? 1 : 0];
      if (counterparties.has(side) && !watchedSet.has(side) && watchedSet.has(other)) {
        suspects.add(side);
      }
    }
  }
  if (suspects.size === 0) return hits;

  return hits.map((h) =>
    (h.counterparties ?? []).some((c) => suspects.has(c)) && !h.reasons.includes("lookalike_appeared")
      ? { ...h, reasons: [...h.reasons, "lookalike_appeared" as const] }
      : h,
  );
}

export interface PollSummary {
  watched: number;
  /** Addresses whose delta came back non-empty. */
  active: number;
  hits: WatchHit[];
  /** Requests spent. Stated so the cost of a quiet poll is visible. */
  requests: number;
  /**
   * Addresses that filled the per-poll cap, so more happened than was returned.
   * The watch advances past what it saw and will catch up on the next poll —
   * but an address busier than the cap never catches up, and saying nothing
   * would make a permanently lagging watch look complete.
   */
  more_pending?: string[];
  note?: string;
}

/**
 * Shape a poll result.
 *
 * The empty case is deliberately tiny and carries no note: a quiet poll is the
 * common one, and it is what makes watching affordable at all. Prose explaining
 * that nothing happened, repeated every minute, is the cost this design exists
 * to avoid.
 */
export function summarizePoll(
  watched: number,
  hits: WatchHit[],
  requests: number,
  saturated: string[] = [],
): PollSummary {
  const active = new Set(hits.map((h) => h.address)).size;
  if (hits.length === 0 && saturated.length === 0) {
    return { watched, active: 0, hits: [], requests };
  }

  const parts = [
    `${hits.length} new transaction${hits.length === 1 ? "" : "s"} across ${active} watched address${active === 1 ? "" : "es"}. Each entry names a digest and why it fired; read one with get_transaction rather than assuming from the reasons.`,
  ];
  if (saturated.length) {
    parts.push(
      `${saturated.length} address${saturated.length === 1 ? "" : "es"} hit the per-poll cap, so more happened than is listed. Poll again to continue, or set min_amount on those addresses — one busy enough to fill the cap every time will never be fully reported.`,
    );
  }

  return {
    watched,
    active,
    hits,
    requests,
    ...(saturated.length ? { more_pending: saturated } : {}),
    note: parts.join(" "),
  };
}
