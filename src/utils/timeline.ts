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

/** Parse a from/to bound: a bare integer is a checkpoint, otherwise an ISO date. */
export function parseTimeBound(s: string | undefined): { checkpoint?: number; ms?: number } {
  if (!s) return {};
  const t = s.trim();
  if (/^\d+$/.test(t)) return { checkpoint: parseInt(t, 10) };
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? {} : { ms };
}

/**
 * Merge, de-dupe, window, and order timeline entries.
 * - A tx that touches several tracked addresses appears once, with `involved`
 *   unioned across every occurrence.
 * - Filtered to [fromMs, toMs] when those bounds are given (by timestamp).
 * - Sorted by checkpoint ascending (entries missing a checkpoint sort last),
 *   tie-broken by digest for determinism.
 * - Capped to `limit`.
 */
export function mergeTimelineEntries(
  entries: TimelineEntry[],
  opts: { fromMs?: number; toMs?: number; limit: number },
): TimelineEntry[] {
  const byDigest = new Map<string, TimelineEntry>();
  for (const e of entries) {
    const existing = byDigest.get(e.digest);
    if (existing) {
      existing.involved = [...new Set([...existing.involved, ...e.involved])];
    } else {
      byDigest.set(e.digest, { ...e, involved: [...new Set(e.involved)] });
    }
  }

  let merged = [...byDigest.values()];

  if (opts.fromMs != null || opts.toMs != null) {
    merged = merged.filter((e) => {
      if (!e.timestamp) return false; // can't window an undated entry
      const ms = Date.parse(e.timestamp);
      if (Number.isNaN(ms)) return false;
      if (opts.fromMs != null && ms < opts.fromMs) return false;
      if (opts.toMs != null && ms > opts.toMs) return false;
      return true;
    });
  }

  merged.sort((a, b) => {
    const ca = a.checkpoint ?? Number.POSITIVE_INFINITY;
    const cb = b.checkpoint ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    return a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0;
  });

  return merged.slice(0, opts.limit);
}
