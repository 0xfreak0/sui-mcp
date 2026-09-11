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

/** Addresses per delta request. The 5,000-byte query cap is what binds. */
export const WATCH_BATCH_SIZE = 20;

/** What a watch is looking at. Only addresses for now. */
export interface WatchEntry {
  address: string;
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
  | "appeared"
  | "sink_reached"
  | "capability_moved"
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
}

/** One address's new transactions, as the delta query returns them. */
export interface DeltaTx {
  digest: string;
  checkpoint: number;
  timestamp?: string | null;
  sender?: string | null;
  balance_changes?: Array<{ address: string; amount: string; coin_type: string }>;
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
export function evaluate(
  entry: WatchEntry,
  txs: DeltaTx[],
  opts?: {
    isSink?: (address: string) => boolean;
    labelFor?: (address: string) => string | undefined;
  },
): { hits: WatchHit[]; last_checkpoint: number } {
  let high = entry.last_checkpoint;
  const hits: WatchHit[] = [];
  const floor = bigOrZero(entry.min_amount);

  for (const tx of txs) {
    if (tx.checkpoint > high) high = tx.checkpoint;

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
    // moves without one, which is exactly what object flow is for. Saying
    // nothing here would be the same blindness in a different tool.
    if (reasons.length === 0) reasons.push("appeared");

    for (const other of counterparties) {
      if (opts?.isSink?.(other)) {
        reasons.push("sink_reached");
        break;
      }
    }

    // A floor filters VALUE movements only. Suppressing `sink_reached` or a
    // coinless transaction because it carried little money would drop the
    // findings that have nothing to do with amount.
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
    });
  }

  return { hits, last_checkpoint: high };
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
