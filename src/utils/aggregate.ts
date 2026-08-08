/**
 * Group-by over a stream of events.
 *
 * Ranking wallets by protocol flow is the question that pushed one
 * investigation out of this server entirely: it meant paginating ~900 GraphQL
 * pages and aggregating in Python. The aggregation itself is trivial — it is
 * the paging and the value extraction that make it tedious — so this keeps the
 * arithmetic pure and testable and leaves the fetching to the caller.
 *
 * Deliberately field-agnostic. Protocols carry their amounts under different
 * names and scales (AlphaLend emits `*_value` in USD cents), and encoding that
 * per protocol would mean a second hand-maintained registry alongside one that
 * already drifts. The caller names the field instead.
 */

export interface AggregatableEvent {
  sender?: string | null;
  type?: string | null;
  data?: unknown;
}

export interface AggregateGroup {
  key: string;
  event_count: number;
  /** Sum of `value_field`, scaled. Null when no field was requested. */
  value_sum: number | null;
  /** Events in this group that had no readable value. */
  missing_value_count: number;
}

export interface AggregateResult {
  groups: AggregateGroup[];
  distinct_keys: number;
  events_aggregated: number;
  /** Events whose group key was absent — counted, never silently dropped. */
  ungrouped_count: number;
  /**
   * Distribution across ALL groups, not just the returned page.
   *
   * A `top: 20` view says nothing about the shape of the other 900, and the
   * interesting population is often the small end: a swarm of wallets each
   * doing one tiny action is invisible in a descending top-N, which is exactly
   * how a 900-wallet dust cluster hides behind twenty large depositors.
   */
  distribution: Distribution | null;
}

export interface Distribution {
  /** Metric described: the summed value if one was requested, else counts. */
  metric: "value" | "event_count";
  min: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
  max: number;
  total: number;
}

/** Nearest-rank percentile over a sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function describe(values: number[], metric: Distribution["metric"]): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const round6 = (n: number) => Number(n.toFixed(6));
  return {
    metric,
    min: round6(sorted[0]),
    p25: round6(percentile(sorted, 25)),
    median: round6(percentile(sorted, 50)),
    p75: round6(percentile(sorted, 75)),
    p95: round6(percentile(sorted, 95)),
    max: round6(sorted[sorted.length - 1]),
    total: round6(sorted.reduce((a, b) => a + b, 0)),
  };
}

/**
 * Read a dotted path out of an event's JSON payload.
 *
 * Values arrive as strings more often than numbers (Move u64s do not survive
 * JSON as numbers), so strings that parse cleanly are accepted and anything
 * else is reported as missing rather than coerced to zero — a silent zero would
 * quietly deflate a total.
 */
export function readNumericPath(data: unknown, path: string): number | null {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur === "number") return Number.isFinite(cur) ? cur : null;
  if (typeof cur === "string" && cur.trim() !== "") {
    const n = Number(cur);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface AggregateOptions {
  groupBy: "sender" | "event_type";
  valueField?: string;
  /** Divisor applied to the summed value, e.g. 100 for USD cents. */
  valueScale?: number;
  top?: number;
  /**
   * Which end of the ranking to return. Descending finds whales; ascending
   * finds swarms, and the small end is where coordinated dust activity lives.
   */
  sortOrder?: "desc" | "asc";
}

export function aggregateEvents(
  events: AggregatableEvent[],
  opts: AggregateOptions,
): AggregateResult {
  const acc = new Map<string, { count: number; sum: number; missing: number }>();
  let ungrouped = 0;

  for (const e of events) {
    const key = opts.groupBy === "sender" ? e.sender : e.type;
    if (!key) {
      ungrouped++;
      continue;
    }

    const entry = acc.get(key) ?? { count: 0, sum: 0, missing: 0 };
    entry.count++;

    if (opts.valueField) {
      const v = readNumericPath(e.data, opts.valueField);
      if (v === null) entry.missing++;
      else entry.sum += v;
    }
    acc.set(key, entry);
  }

  const scale = opts.valueScale && opts.valueScale !== 0 ? opts.valueScale : 1;
  const groups: AggregateGroup[] = [...acc.entries()].map(([key, v]) => ({
    key,
    event_count: v.count,
    value_sum: opts.valueField ? Number((v.sum / scale).toFixed(6)) : null,
    missing_value_count: v.missing,
  }));

  // Rank by value when there is one, otherwise by activity. Sorting by count
  // when a value was requested would bury a single large mover under a bot
  // making thousands of dust calls.
  const metricOf = (g: AggregateGroup) => (opts.valueField ? (g.value_sum ?? 0) : g.event_count);
  const dir = opts.sortOrder === "asc" ? -1 : 1;
  groups.sort((a, b) => dir * (metricOf(b) - metricOf(a) || b.event_count - a.event_count));

  // Percentiles come from every group, before the page is cut — otherwise they
  // would only describe the slice the caller already has.
  const distribution = describe(
    groups.map(metricOf),
    opts.valueField ? "value" : "event_count",
  );

  return {
    groups: groups.slice(0, opts.top ?? 20),
    distinct_keys: acc.size,
    events_aggregated: events.length - ungrouped,
    ungrouped_count: ungrouped,
    distribution,
  };
}

/**
 * Numeric fields visible in a sample event, as candidate `value_field` paths.
 *
 * This is the discovery step that replaces a per-protocol schema registry: call
 * once without a value field, read what the protocol actually emits, call again
 * naming it.
 */
export function suggestValueFields(data: unknown, prefix = ""): string[] {
  if (data === null || typeof data !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))) {
      out.push(path);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...suggestValueFields(v, path));
    }
  }
  return out;
}
