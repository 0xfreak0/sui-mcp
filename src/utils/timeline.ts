/**
 * Pure merge logic for build_timeline: combine per-address transaction lists
 * into one checkpoint-ordered, de-duplicated stream. Kept pure so the ordering /
 * dedupe / windowing is unit-testable without the chain.
 */

export interface TimelineEntry {
  digest: string;
  checkpoint: number | null;
  timestamp: string | null;
  sender: string | null;
  status: string;
  protocols: string[];
  actions: string[];
  token_flow: { coin: string; amount: string; raw_type: string }[];
  /** Tracked addresses involved in this tx. */
  involved: string[];
}

/**
 * Whether a timestamp falls inside [fromMs, toMs]. Undated entries are outside
 * any bounded window, since they cannot be placed in it.
 */
export function inWindow(timestamp: string | null, fromMs?: number, toMs?: number): boolean {
  if (fromMs == null && toMs == null) return true;
  if (!timestamp) return false;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return false;
  if (fromMs != null && ms < fromMs) return false;
  if (toMs != null && ms > toMs) return false;
  return true;
}

/**
 * Merge, de-dupe, window, and order timeline entries.
 * - A tx that touches several tracked addresses appears once, with `involved`
 *   unioned across every occurrence.
 * - Filtered to [fromMs, toMs] when those bounds are given (by timestamp).
 * - Sorted by checkpoint ascending (entries missing a checkpoint sort last),
 *   tie-broken by digest for determinism.
 * - Capped to `limit`, keeping the oldest entries or the newest. `omitted`
 *   counts what the cap dropped.
 */
export function mergeTimelineEntries(
  entries: TimelineEntry[],
  opts: { fromMs?: number; toMs?: number; limit: number; keep?: "oldest" | "newest" },
): { entries: TimelineEntry[]; omitted: number } {
  const byDigest = new Map<string, TimelineEntry>();
  for (const e of entries) {
    const existing = byDigest.get(e.digest);
    if (existing) {
      existing.involved = [...new Set([...existing.involved, ...e.involved])];
    } else {
      byDigest.set(e.digest, { ...e, involved: [...new Set(e.involved)] });
    }
  }

  const merged = [...byDigest.values()].filter((e) => inWindow(e.timestamp, opts.fromMs, opts.toMs));

  merged.sort((a, b) => {
    const ca = a.checkpoint ?? Number.POSITIVE_INFINITY;
    const cb = b.checkpoint ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    return a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0;
  });

  const omitted = Math.max(0, merged.length - opts.limit);
  const kept = opts.keep === "newest" ? merged.slice(omitted) : merged.slice(0, opts.limit);
  return { entries: kept, omitted };
}
