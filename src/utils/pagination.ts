import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../config.js";

export function clampPageSize(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}

/**
 * Which end of a transaction or event list a page starts from.
 *
 * GraphQL's `first` returns the OLDEST rows, so a list tool that pages with
 * `first`/`after` shows a long-lived address as it was years ago. `newest`
 * pages with `last`/`before` and reverses each page, so the first row is the
 * most recent.
 */
export type ListOrder = "newest" | "oldest";

/** Select alongside a connection read by `orderedPageArgs`. */
export const BOTH_WAYS_PAGE_INFO = "pageInfo { hasNextPage endCursor hasPreviousPage startCursor }";

export interface BothWaysPageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
  hasPreviousPage: boolean;
  startCursor?: string | null;
}

/**
 * Connection arguments for one page. Pass them as `$first $after $last
 * $before`; the two left undefined are omitted from the request.
 */
export function orderedPageArgs(
  order: ListOrder,
  size: number,
  cursor?: string,
): { first?: number; after?: string; last?: number; before?: string } {
  return order === "newest" ? { last: size, before: cursor } : { first: size, after: cursor };
}

/**
 * A page in display order, and the cursor that continues in the same order.
 * `next_cursor` goes back as the next call's cursor with the same `order`.
 * Walking oldest-first, the cursor is returned at the end of the list too: it
 * marks the newest row read, so a later call with it returns only what came
 * after.
 */
export function orderedPage<T>(
  nodes: T[],
  pageInfo: BothWaysPageInfo,
  order: ListOrder,
): { nodes: T[]; has_next_page: boolean; next_cursor: string | null } {
  if (order === "newest") {
    return {
      nodes: [...nodes].reverse(),
      has_next_page: pageInfo.hasPreviousPage,
      next_cursor: pageInfo.hasPreviousPage ? (pageInfo.startCursor ?? null) : null,
    };
  }
  return {
    nodes,
    has_next_page: pageInfo.hasNextPage,
    next_cursor: pageInfo.endCursor ?? null,
  };
}

/** The earliest and latest timestamps on a page, so a reader sees the span without scanning rows. */
export function shownRange(timestamps: Array<string | null | undefined>): {
  oldest_shown: string | null;
  newest_shown: string | null;
} {
  let oldest: { t: string; ms: number } | null = null;
  let newest: { t: string; ms: number } | null = null;
  for (const t of timestamps) {
    if (!t) continue;
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) continue;
    if (!oldest || ms < oldest.ms) oldest = { t, ms };
    if (!newest || ms > newest.ms) newest = { t, ms };
  }
  return { oldest_shown: oldest?.t ?? null, newest_shown: newest?.t ?? null };
}
