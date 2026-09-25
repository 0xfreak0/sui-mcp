import type { ListOrder } from "./pagination.js";

/**
 * One list read across every version of a package lineage, as one ordered
 * page with one cursor.
 *
 * A `function` filter matches calls made through one package version, so a
 * protocol's calls are split across its versions. Each version is read as its
 * own connection; the pages are merged by checkpoint and the cursor records
 * where each version's walk stands. Each version is consumed as a prefix of its
 * own order, so a page never skips or repeats a row of any version. Rows from
 * different versions in the same checkpoint are ordered by version, since the
 * connection does not expose their order within a checkpoint.
 */

export interface VersionStream {
  /** Package address of this version. */
  address: string;
  /** Cursor to continue from; undefined starts at the list's end in `order`. */
  cursor?: string;
  /** Nothing further to read. */
  done: boolean;
}

export interface VersionPage<T> {
  /** Rows in connection order (ascending), with their own cursors. */
  edges: Array<{ cursor: string; node: T }>;
  /** More rows exist beyond this page in the walk's direction. */
  hasMore: boolean;
}

interface CursorState {
  o: ListOrder;
  v: Array<[string, string | null, 0 | 1]>;
}

export function encodeFanoutCursor(order: ListOrder, streams: VersionStream[]): string {
  const state: CursorState = { o: order, v: streams.map((s) => [s.address, s.cursor ?? null, s.done ? 1 : 0]) };
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

/** Null when `cursor` is not one this module wrote for `order`. */
export function decodeFanoutCursor(cursor: string, order: ListOrder): VersionStream[] | null {
  let state: unknown;
  try {
    state = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!state || typeof state !== "object" || !("o" in state) || !("v" in state)) return null;
  if (state.o !== order || !Array.isArray(state.v)) return null;
  const streams: VersionStream[] = [];
  for (const entry of state.v) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return null;
    streams.push({
      address: entry[0],
      cursor: typeof entry[1] === "string" ? entry[1] : undefined,
      done: entry[2] === 1,
    });
  }
  return streams;
}

/**
 * Merge one page per stream into `limit` rows in display order, and advance
 * each stream past exactly the rows it contributed.
 *
 * `pages[i]` belongs to `streams[i]`; a done stream's page is ignored. A
 * transaction that called two versions appears in both pages and is shown
 * once, with both streams advanced past it.
 */
export function mergeVersionPages<T>(
  streams: VersionStream[],
  pages: Array<VersionPage<T> | null>,
  order: ListOrder,
  limit: number,
  keyOf: (node: T) => string,
  checkpointOf: (node: T) => number | null | undefined,
): { nodes: T[]; streams: VersionStream[]; has_next_page: boolean } {
  type Item = { stream: number; pos: number; cursor: string; node: T; cp: number };
  const items: Item[] = [];
  streams.forEach((s, i) => {
    const page = pages[i];
    if (s.done || !page) return;
    // Walk order for this stream: newest-first reverses the ascending edges.
    const edges = order === "newest" ? [...page.edges].reverse() : page.edges;
    edges.forEach((e, pos) => items.push({ stream: i, pos, cursor: e.cursor, node: e.node, cp: checkpointOf(e.node) ?? 0 }));
  });
  items.sort((a, b) => {
    if (a.cp !== b.cp) return order === "newest" ? b.cp - a.cp : a.cp - b.cp;
    if (a.stream !== b.stream) return a.stream - b.stream;
    return a.pos - b.pos;
  });

  const taken: T[] = [];
  const shown = new Set<string>();
  const consumed = streams.map(() => 0);
  const lastCursor: Array<string | undefined> = streams.map(() => undefined);
  const blocked = new Set<number>();
  for (const item of items) {
    if (blocked.has(item.stream)) continue;
    const key = keyOf(item.node);
    if (shown.has(key)) {
      consumed[item.stream]++;
      lastCursor[item.stream] = item.cursor;
      continue;
    }
    if (taken.length >= limit) {
      // Past the page: this stream stops here so its later rows are not
      // consumed out of order. Duplicates of shown rows still advance others.
      blocked.add(item.stream);
      continue;
    }
    taken.push(item.node);
    shown.add(key);
    consumed[item.stream]++;
    lastCursor[item.stream] = item.cursor;
  }

  const next = streams.map((s, i) => {
    const page = pages[i];
    if (s.done || !page) return s;
    const all = consumed[i] === page.edges.length;
    return {
      address: s.address,
      cursor: lastCursor[i] ?? s.cursor,
      done: all && !page.hasMore,
    };
  });
  return { nodes: taken, streams: next, has_next_page: next.some((s) => !s.done) };
}
