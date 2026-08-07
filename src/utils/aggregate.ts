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
  groups.sort((a, b) =>
    opts.valueField
      ? (b.value_sum ?? 0) - (a.value_sum ?? 0) || b.event_count - a.event_count
      : b.event_count - a.event_count,
  );

  return {
    groups: groups.slice(0, opts.top ?? 20),
    distinct_keys: acc.size,
    events_aggregated: events.length - ungrouped,
    ungrouped_count: ungrouped,
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
