import { gqlQuery } from "../clients/graphql.js";

/**
 * Translate wall-clock time into a checkpoint number.
 *
 * Sui's event and transaction filters bound by checkpoint, not time, so any
 * "what happened today" question starts with a conversion the caller has to do
 * by hand — probing checkpoints until one lands near midnight. This does it in
 * a handful of queries instead.
 *
 * Interpolate-then-refine rather than plain binary search: checkpoints are
 * produced at a fairly steady rate (~4.5/sec on mainnet as of writing), so a
 * linear guess lands close and the search only has to correct for drift. A pure
 * binary search over ~300M checkpoints would cost ~28 round trips; this
 * typically costs under 10.
 */

export interface CheckpointPoint {
  seq: number;
  ms: number;
}

const LATEST_QUERY = `query { checkpoints(last: 1) { nodes { sequenceNumber timestamp } } }`;
const AT_QUERY = `query ($seq: UInt53!) { checkpoint(sequenceNumber: $seq) { sequenceNumber timestamp } }`;

/** Close enough: one minute of wall clock is far finer than any day-scale query. */
const TOLERANCE_MS = 60_000;
const MAX_PROBES = 20;

export async function latestCheckpoint(): Promise<CheckpointPoint> {
  const d = await gqlQuery<{
    checkpoints: { nodes: Array<{ sequenceNumber: number; timestamp: string }> };
  }>(LATEST_QUERY, {});
  const n = d.checkpoints.nodes[0];
  return { seq: n.sequenceNumber, ms: Date.parse(n.timestamp) };
}

export async function checkpointAt(seq: number): Promise<CheckpointPoint | null> {
  const d = await gqlQuery<{
    checkpoint: { sequenceNumber: number; timestamp: string } | null;
  }>(AT_QUERY, { seq: Math.max(0, Math.floor(seq)) });
  if (!d.checkpoint) return null;
  return { seq: d.checkpoint.sequenceNumber, ms: Date.parse(d.checkpoint.timestamp) };
}

/**
 * The checkpoint closest to `targetMs`.
 *
 * Returns the latest checkpoint for a future time, and never returns below
 * zero. `probes` reports the round trips spent so callers can see the cost.
 */
export async function resolveCheckpointAtTime(
  targetMs: number,
  latest?: CheckpointPoint,
): Promise<{ checkpoint: number; actual_time: string; probes: number }> {
  let probes = 0;
  const hi0 = latest ?? (await latestCheckpoint());
  if (!latest) probes++;

  if (targetMs >= hi0.ms) {
    return { checkpoint: hi0.seq, actual_time: new Date(hi0.ms).toISOString(), probes };
  }

  // Seed a lower bound by stepping back at the observed rate, doubling until we
  // land before the target. Doubling matters: a naive single guess based on the
  // current rate drifts badly over long spans, when the chain was slower.
  let lo: CheckpointPoint | null = null;
  let back = Math.max(1, Math.round(((hi0.ms - targetMs) / 1000) * 4.5));
  for (let i = 0; i < 8 && probes < MAX_PROBES; i++) {
    const candidate = await checkpointAt(hi0.seq - back);
    probes++;
    if (candidate && candidate.ms <= targetMs) {
      lo = candidate;
      break;
    }
    back *= 2;
    if (hi0.seq - back <= 0) {
      lo = (await checkpointAt(0)) ?? { seq: 0, ms: 0 };
      probes++;
      break;
    }
  }
  if (!lo) lo = { seq: 0, ms: 0 };

  let hi = hi0;
  let best = lo;

  while (probes < MAX_PROBES && hi.seq - lo.seq > 1) {
    // Interpolate within the bracket; fall back to the midpoint when the two
    // anchors share a timestamp, which would otherwise divide by zero.
    const span = hi.ms - lo.ms;
    const frac = span > 0 ? (targetMs - lo.ms) / span : 0.5;
    let guess = Math.round(lo.seq + (hi.seq - lo.seq) * Math.min(0.95, Math.max(0.05, frac)));
    if (guess <= lo.seq) guess = lo.seq + 1;
    if (guess >= hi.seq) guess = hi.seq - 1;

    const point = await checkpointAt(guess);
    probes++;
    // A pruned or missing checkpoint can't anchor the search; nudge the upper
    // bound down and try again rather than aborting.
    if (!point) {
      hi = { ...hi, seq: guess };
      continue;
    }

    if (Math.abs(point.ms - targetMs) < Math.abs(best.ms - targetMs)) best = point;
    if (Math.abs(point.ms - targetMs) <= TOLERANCE_MS) break;

    if (point.ms < targetMs) lo = point;
    else hi = point;
  }

  return {
    checkpoint: best.seq,
    actual_time: new Date(best.ms).toISOString(),
    probes,
  };
}

/**
 * Accept either an ISO 8601 timestamp or a raw checkpoint number.
 *
 * Callers pass user input straight through — a numeric string is a checkpoint,
 * anything else is parsed as a date. Returns null for empty input so "no bound"
 * stays distinct from "bound at zero".
 */
export async function toCheckpoint(
  value: string | number | undefined,
  latest?: CheckpointPoint,
): Promise<{ checkpoint: number; resolved_from: string; actual_time?: string } | null> {
  if (value === undefined || value === null || value === "") return null;

  if (typeof value === "number") {
    return { checkpoint: value, resolved_from: "checkpoint" };
  }
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) {
    return { checkpoint: Number(trimmed), resolved_from: "checkpoint" };
  }

  const ms = trimmed.toLowerCase() === "now" ? Date.now() : Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(
      `Could not parse '${value}' as a time or checkpoint. Use an ISO 8601 timestamp (2026-08-07T00:00:00Z), 'now', or a checkpoint number.`,
    );
  }
  const r = await resolveCheckpointAtTime(ms, latest);
  return { checkpoint: r.checkpoint, resolved_from: "time", actual_time: r.actual_time };
}

export interface CheckpointBracket {
  /** The last checkpoint stamped before the target. */
  before: CheckpointPoint | null;
  /** The first checkpoint stamped at or after the target. */
  atOrAfter: CheckpointPoint | null;
  probes: number;
}

/**
 * The checkpoints either side of a moment: the last one stamped before
 * `targetMs`, and the first stamped at or after it.
 *
 * `resolveCheckpointAtTime` stops within a minute of the target, which is fine
 * for a point and wrong for a window edge: an incident window of three minutes
 * loses a third of itself to a one-minute error. This refines the bracket until
 * the two checkpoints are adjacent. Interpolation lands within a few
 * checkpoints, and a step that fails to halve the bracket is followed by a
 * bisection, so a stretch of uneven timestamps cannot stall it.
 *
 * `before` is null when the target precedes genesis; `atOrAfter` is null when
 * it is later than the latest checkpoint. When a probe finds a checkpoint
 * missing, refinement stops and the bracket is returned wider than one step;
 * both ends still hold, so a window built from it contains every checkpoint it
 * should, plus a few it should not.
 */
export async function checkpointBracket(targetMs: number, latest?: CheckpointPoint): Promise<CheckpointBracket> {
  let probes = 0;
  const top = latest ?? (await latestCheckpoint());
  if (!latest) probes++;
  if (targetMs > top.ms) return { before: top, atOrAfter: null, probes };

  // Seed the lower end by stepping back at the observed rate, doubling until a
  // checkpoint stamped strictly before the target turns up.
  let lo: CheckpointPoint | null = null;
  let back = Math.max(1, Math.round(((top.ms - targetMs) / 1000) * 4.5));
  while (probes < MAX_BRACKET_PROBES) {
    const seq = Math.max(0, top.seq - back);
    const candidate = await checkpointAt(seq);
    probes++;
    if (candidate && candidate.ms < targetMs) {
      lo = candidate;
      break;
    }
    if (seq === 0) {
      // Genesis is at or after the target: nothing precedes it.
      return { before: null, atOrAfter: candidate ?? top, probes };
    }
    back *= 2;
  }
  if (!lo) return { before: null, atOrAfter: top, probes };

  let hi = top;
  let lastWidth = hi.seq - lo.seq;
  let bisect = false;
  while (probes < MAX_BRACKET_PROBES && hi.seq - lo.seq > 1) {
    let guess: number;
    if (bisect || hi.ms <= lo.ms) {
      guess = lo.seq + Math.floor((hi.seq - lo.seq) / 2);
    } else {
      const frac = (targetMs - lo.ms) / (hi.ms - lo.ms);
      guess = Math.round(lo.seq + (hi.seq - lo.seq) * frac);
    }
    guess = Math.min(hi.seq - 1, Math.max(lo.seq + 1, guess));
    const point = await checkpointAt(guess);
    probes++;
    if (!point) break;
    if (point.ms < targetMs) lo = point;
    else hi = point;
    const width = hi.seq - lo.seq;
    bisect = width * 2 > lastWidth;
    lastWidth = width;
  }
  return { before: lo, atOrAfter: hi, probes };
}

/** Probe budget for one exact bracket. Interpolation usually needs under 15. */
const MAX_BRACKET_PROBES = 40;

/** One edge of a window, as the exclusive checkpoint a GraphQL filter takes. */
export interface FilterBound {
  /**
   * The filter's `afterCheckpoint` or `beforeCheckpoint`, both exclusive.
   * Null when a time bound lies outside the chain's range and bounds nothing.
   */
  checkpoint: number | null;
  resolved_from: "checkpoint" | "time";
  /** The time asked for, when the bound was a time. Exact, for filtering by timestamp. */
  ms?: number;
}

/** Milliseconds for a time bound ('now' or ISO 8601). Throws on anything else. */
function parseTimeBound(value: string | number): number {
  const trimmed = String(value).trim();
  const ms = trimmed.toLowerCase() === "now" ? Date.now() : Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(
      `Could not parse '${value}' as a time or checkpoint. Use an ISO 8601 timestamp (2026-08-07T00:00:00Z), 'now', or a checkpoint number.`,
    );
  }
  return ms;
}

function isTimeBound(value: string | number | undefined): boolean {
  if (value === undefined || value === null || typeof value === "number") return false;
  const t = String(value).trim();
  return t !== "" && !/^\d+$/.test(t);
}

/**
 * Turn one edge of a window into the exclusive checkpoint a transaction or
 * event filter takes.
 *
 * A checkpoint number passes through unchanged. A time is resolved with
 * `checkpointBracket` so the window holds exactly the checkpoints stamped
 * inside it: `after` a time T is the last checkpoint stamped before T, and
 * `before` a time T is the first checkpoint stamped after T, so both ends of
 * the window are inclusive in time. Throws on input that is neither.
 */
export async function toFilterBound(
  value: string | number | undefined,
  side: "after" | "before",
  latest?: CheckpointPoint,
): Promise<FilterBound | null> {
  if (value === undefined || value === null || value === "") return null;
  if (!isTimeBound(value)) {
    return { checkpoint: Number(String(value).trim()), resolved_from: "checkpoint" };
  }
  const ms = parseTimeBound(value);
  if (side === "after") {
    const { before } = await checkpointBracket(ms, latest);
    return { checkpoint: before?.seq ?? null, resolved_from: "time", ms };
  }
  const { atOrAfter } = await checkpointBracket(ms + 1, latest);
  return { checkpoint: atOrAfter?.seq ?? null, resolved_from: "time", ms };
}

export interface ResolvedWindow {
  after: FilterBound | null;
  before: FilterBound | null;
}

/**
 * Resolve both edges of a `from`/`to` window, sharing one latest-checkpoint
 * probe between them and spending none when neither edge is a time.
 */
export async function resolveWindow(
  from: string | number | undefined,
  to: string | number | undefined,
): Promise<ResolvedWindow> {
  // Both edges are parsed before any request, so a typo costs nothing.
  for (const v of [from, to]) if (v !== undefined && isTimeBound(v)) parseTimeBound(v);
  const latest = isTimeBound(from) || isTimeBound(to) ? await latestCheckpoint() : undefined;
  return {
    after: await toFilterBound(from, "after", latest),
    before: await toFilterBound(to, "before", latest),
  };
}

/** A window as reported back: the input, and the exclusive checkpoints it resolved to. */
export function describeWindow(
  from: string | number | undefined,
  to: string | number | undefined,
  w: ResolvedWindow,
) {
  return {
    from: from ?? null,
    to: to ?? null,
    after_checkpoint: w.after?.checkpoint ?? null,
    before_checkpoint: w.before?.checkpoint ?? null,
  };
}
