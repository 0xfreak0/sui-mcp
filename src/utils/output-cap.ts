/**
 * Output caps: a default response lists what fits a budget and states the
 * rest exactly. Rules every caller follows:
 *
 *   1. Totals, shares, counts, nets and verdicts are computed over every row
 *      before a list is capped. A cap shortens a list, never the answer.
 *   2. Rows are ranked by investigative importance, and flagged rows (`keep`)
 *      survive any budget.
 *   3. `omitted` states each capped list's count, USD value where rows carry
 *      one, and the largest omitted row, `omitted.folded` each list whose
 *      identical rows were folded first, and the response carries `truncated`.
 *   4. `omitted.next_call` either retrieves everything or advances to the next
 *      page; a list another call pages names that call instead.
 *   5. With the store on, the full result is saved and `omitted.result` is its
 *      `sui://results/{id}` resource, which pages any list of it.
 */
import { getNetwork } from "../config.js";
import { loadResult, saveResult, storeStatus } from "./store.js";
import { bindCallNetwork, bindContinuationNetwork } from "./continuation-network.js";

/**
 * The call that returns what a capped response left out: a tool with its
 * arguments, or this same call repeated with `repeat_with` changed.
 */
export type NextCall = { tool: string; args: Record<string, unknown> } | { tool: string; repeat_with: Record<string, unknown> };

/** How one list of a response is capped. */
export interface ListCap<T = never> {
  /** Characters of compact JSON the kept rows may take. Flagged rows are kept past it. */
  budget: number;
  /** Most rows to keep besides flagged ones. */
  limit?: number;
  /** Most important first. Omit when the list is already ranked. */
  rank?: (a: T, b: T) => number;
  /** Rows that survive any budget: exits, lookalikes, failures, labelled entities, authority moves. */
  keep?: (row: T) => boolean;
  /** A row's USD value: summed over the omitted rows, and what `largest` is judged by. Null means unpriced. */
  usd?: (row: T) => number | null | undefined;
  /** How many entries a row stands for, when rows were folded; omitted rows report their sum as `entries`. */
  weight?: (row: T) => number;
  /** How the omitted row named in `largest` or `first` is shown; the row itself by default. */
  brief?: (row: T) => unknown;
  /** The call that returns this list's omitted rows, when the tool's full call is not it. */
  next_call?: NextCall;
  /** List kept rows in their original order rather than rank order. */
  keepOrder?: boolean;
  /** The stored list's indices a row stands for, when the stored list is unfolded; the row's own index by default. */
  covers?: (row: T) => number[];
}

/** What a capped list left out. */
export interface OmittedRows {
  count: number;
  /** Entries the omitted rows stand for, when the list was folded. */
  entries?: number;
  /** Summed over the priced omitted rows. */
  usd?: number;
  /** Omitted rows with no USD value, which `usd` does not include. */
  unpriced?: number;
  /** The omitted row with the highest USD value, when the list carries one. */
  largest?: unknown;
  /** The first omitted row in rank (or list) order, when no USD value orders the list. */
  first?: unknown;
  /** Index in the full list of the first omitted row: every omitted row sits at or after it. */
  from: number;
  next_call?: NextCall;
}

/**
 * Keep the flagged rows, then the highest-ranked rows while they fit the
 * budget. The kept rows are a rank prefix plus the flagged rows. `shown` is
 * the kept rows' indices in the full list. At least one row is kept.
 */
export function capRows<T>(rows: readonly T[], cap: ListCap<T>): { rows: T[]; omitted: OmittedRows | null; shown: number[] } {
  const order = rows.map((row, index) => ({ row, index }));
  if (cap.rank) {
    const rank = cap.rank;
    order.sort((a, b) => rank(a.row, b.row) || a.index - b.index);
  }
  const flagged = new Set<number>();
  let spent = 0;
  if (cap.keep) {
    for (const { row, index } of order) {
      if (!cap.keep(row)) continue;
      flagged.add(index);
      spent += JSON.stringify(row).length + 1;
    }
  }
  const kept = new Set(flagged);
  let taken = 0;
  let open = true;
  for (const { row, index } of order) {
    if (!open || flagged.has(index)) continue;
    const size = JSON.stringify(row).length + 1;
    const fits = spent + size <= cap.budget && (cap.limit === undefined || taken < cap.limit);
    if (!fits && kept.size > 0) {
      open = false;
      continue;
    }
    kept.add(index);
    spent += size;
    taken++;
  }
  const shown = [...kept].sort((a, b) => a - b);
  if (kept.size === rows.length) return { rows: [...rows], omitted: null, shown };

  const out = cap.keepOrder
    ? rows.filter((_, i) => kept.has(i))
    : order.filter(({ index }) => kept.has(index)).map(({ row }) => row);
  const dropped = order.filter(({ index }) => !kept.has(index));
  const show = (row: T) => (cap.brief ? cap.brief(row) : row);
  const summary: OmittedRows = { count: dropped.length, from: Math.min(...dropped.map((d) => d.index)) };
  if (cap.weight) summary.entries = dropped.reduce((s, d) => s + cap.weight!(d.row), 0);
  let largest: { row: T; usd: number } | null = null;
  if (cap.usd) {
    let usd = 0;
    let unpriced = 0;
    for (const d of dropped) {
      const v = cap.usd(d.row) ?? null;
      if (v === null) {
        unpriced++;
        continue;
      }
      usd += v;
      if (!largest || v > largest.usd) largest = { row: d.row, usd: v };
    }
    summary.usd = Math.round(usd * 100) / 100;
    if (unpriced) summary.unpriced = unpriced;
  }
  if (largest) summary.largest = show(largest.row);
  else summary.first = show(dropped[0].row);
  if (cap.next_call) summary.next_call = cap.next_call;
  return { rows: out, omitted: summary, shown };
}

/**
 * A path into a payload: dot-separated keys (`gas_sponsorship.sponsored`),
 * where a number indexes a list (`transactions.3.events` is the fourth
 * transaction's events).
 */
function readPath(payload: unknown, path: string): unknown {
  let node = payload;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(key)) return undefined;
      node = node[Number(key)];
    } else node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Set `path` on a copy of `payload`, copying every object and list along it and nothing else. */
function writePath<T>(payload: T, path: string, value: unknown): T {
  const [key, ...rest] = path.split(".");
  if (Array.isArray(payload)) {
    const i = /^\d+$/.test(key) ? Number(key) : payload.length;
    if (i >= payload.length) return payload;
    const copy = [...payload];
    copy[i] = rest.length === 0 ? value : writePath(payload[i], rest.join("."), value);
    return copy as T;
  }
  if (payload === null || typeof payload !== "object") return payload;
  const node = payload as Record<string, unknown>;
  return { ...node, [key]: rest.length === 0 ? value : writePath(node[key], rest.join("."), value) } as T;
}

export interface CapResult {
  payload: Record<string, unknown>;
  /** The stored full result's id, when one was stored. */
  resultId: string | null;
}

/**
 * Cap the listed paths of a payload. `full` normally returns it untouched;
 * with `maxChars`, an oversized full view pages lists, adding a next-call
 * continuation when supplied and a stored resource when available.
 * When anything is omitted the response leads with `truncated` and
 * `omitted`, and `stored` (the payload itself by default; a tool whose
 * summary rows are shorter than its full rows passes the full view) is
 * saved when the store is on.
 */
export function capPayload(
  tool: string,
  args: Record<string, unknown>,
  full: Record<string, unknown>,
  caps: Record<string, ListCap<never>>,
  options: {
    full: boolean;
    next_call: NextCall;
    stored?: Record<string, unknown>;
    /** A full view that exceeds this wire limit pages its largest lists instead of overflowing it. */
    maxChars?: number;
    /** A capped full list whose next slice is retrievable by another tool call, even without the store. */
    fullContinuation?: { path: string; nextCall: (shown: number) => NextCall };
    /** Lists the caller folded before capping: how many entries became how many rows. */
    folded?: Record<string, { entries: number; rows: number }>;
    /**
     * Lists the caller narrowed or paged itself, by the stored list's indices
     * this response lists: saved with the stored result, so a page with
     * `omitted` reads only the rest. A capped list's own indices replace them.
     */
    paged?: Record<string, number[]>;
  },
): CapResult {
  const fullSize = options.full && options.maxChars ? JSON.stringify(full).length : 0;
  if (options.full && (!options.maxChars || fullSize <= options.maxChars)) return { payload: full, resultId: null };
  if (options.full) {
    // A full answer exceeding the transport ceiling pages its largest lists;
    // the stored copy is optional, while caller-supplied continuation is not.
    const available = Object.keys(caps).filter((path) => Array.isArray(readPath(full, path)));
    const listSizes = new Map(available.map((path) => [path, JSON.stringify(readPath(full, path)).length]));
    const continuation = options.fullContinuation;
    const all = continuation ? readPath(full, continuation.path) : null;
    const continuationChars = continuation && Array.isArray(all)
      ? JSON.stringify(continuation.nextCall(all.length)).length
      : 0;
    const selected: Record<string, ListCap<never>> = {};
    while (available.length) {
      available.sort((a, b) =>
        a === continuation?.path ? -1 : b === continuation?.path ? 1 : listSizes.get(b)! - listSizes.get(a)!);
      const path = available.shift()!;
      const budget = Math.max(0, listSizes.get(path)! - (fullSize - options.maxChars!) - 4_000 - continuationChars);
      selected[path] = { ...caps[path], budget, keep: undefined };
      const result = capPayload(tool, args, full, selected, {
        full: false, stored: options.stored ?? full, next_call: options.next_call,
      });
      const omitted = result.payload.omitted as { next_call?: NextCall } | undefined;
      if (omitted) {
        const shown = continuation ? readPath(result.payload, continuation.path) : null;
        if (continuation && Array.isArray(shown) && Array.isArray(all) && shown.length < all.length) {
          omitted.next_call = continuation.nextCall(shown.length);
        } else {
          delete omitted.next_call;
        }
      }
      if (JSON.stringify(result.payload).length <= options.maxChars!) return result;
    }
    throw new Error(`The ${tool} result cannot fit ${options.maxChars} characters even after paging its lists.`);
  }
  const folded = options.folded ?? {};
  let payload = full;
  const lists: Record<string, OmittedRows & { page?: string }> = {};
  const shown: Record<string, number[]> = {};
  for (const [path, cap] of Object.entries(caps)) {
    const rows = readPath(payload, path);
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const capped = capRows(rows as never[], cap);
    if (!capped.omitted) continue;
    payload = writePath(payload, path, capped.rows);
    lists[path] = capped.omitted;
    shown[path] = cap.covers ? capped.shown.flatMap((i) => cap.covers!(rows[i] as never)) : capped.shown;
  }
  const paged = options.paged ?? {};
  if (Object.keys(lists).length === 0 && Object.keys(folded).length === 0) {
    if (Object.keys(paged).length === 0) return { payload: full, resultId: null };
    return { payload: full, resultId: saveResult(getNetwork(), tool, args, options.stored ?? full, paged) };
  }

  const resultId = saveResult(getNetwork(), tool, args, options.stored ?? full, { ...paged, ...shown });
  if (resultId) {
    for (const path of Object.keys(lists)) lists[path].page = resultUri(resultId, { path, omitted: true });
  }
  return {
    payload: {
      truncated: true,
      omitted: {
        lists,
        ...(Object.keys(folded).length ? { folded } : {}),
        next_call: options.next_call,
        ...(resultId
          ? {
              result: {
                uri: resultUri(resultId),
                read:
                  "The full result is stored. Read each list's `page` URI as an MCP resource (Claude Code: ReadMcpResource): it pages the rows this response left out, none it listed. `path`, `offset`, `limit` and `match` (a substring every returned row contains) page any list of it; drop `omitted` for the whole list.",
              },
            }
          : {}),
      },
      ...payload,
    },
    resultId,
  };
}

/** The resource URI of a stored result, optionally one page of one list. */
export function resultUri(
  id: string,
  page?: { path?: string; omitted?: boolean; offset?: number; limit?: number; match?: string },
): string {
  const q = new URLSearchParams();
  if (page?.path) q.set("path", page.path);
  if (page?.omitted) q.set("omitted", "1");
  if (page?.offset) q.set("offset", String(page.offset));
  if (page?.limit) q.set("limit", String(page.limit));
  if (page?.match) q.set("match", page.match);
  const qs = q.toString();
  return `sui://results/${id}${qs ? `?${qs}` : ""}`;
}

/**
 * One page of a list by position: the rows from `offset` that fit `budget`
 * characters of compact JSON, at least one, and the offset the next page
 * starts at (null after the last row). Following `next` from 0 lists every
 * row exactly once, whatever the rows' sizes.
 */
export function pageAt<T>(rows: readonly T[], offset: number, budget: number): { rows: T[]; next: number | null } {
  const out: T[] = [];
  let spent = 0;
  for (let i = offset; i < rows.length; i++) {
    const size = JSON.stringify(rows[i]).length + 1;
    if (out.length > 0 && spent + size > budget) return { rows: out, next: i };
    out.push(rows[i]);
    spent += size;
  }
  return { rows: out, next: null };
}

/** Characters one page of a stored list may take. */
export const RESULT_PAGE_BUDGET = 20_000;

/**
 * One read of a stored result. Without `path`: the call that produced it and
 * every list in it with its length. With `path`: the rows from `offset`
 * (after `omitted` drops the rows the capped response listed and `match`
 * keeps the rows containing a substring) that fit {@link RESULT_PAGE_BUDGET},
 * or `limit` rows, and `next_offset` when rows remain. Each row carries its
 * index in the full list. A path to a non-list returns the value.
 */
export function readStoredResult(
  id: string,
  query: { path?: string | null; omitted?: string | null; offset?: string | null; limit?: string | null; match?: string | null },
): Record<string, unknown> {
  const status = storeStatus();
  if (!status.enabled) {
    throw new Error(`Stored results need the local store, which is off (${status.reason}). Set SUI_STORE_PATH and restart.`);
  }
  const stored = loadResult(id);
  if (!stored) throw new Error(`No stored result '${id}'. Its id comes from a capped response's omitted.result.uri.`);
  // Resource reads have no originating tool context. Use the stored chain,
  // including when the process default has changed since the result was saved.
  bindCallNetwork(stored, stored.network);
  bindContinuationNetwork(stored.payload, stored.network);
  if (!query.path) {
    const lists: Record<string, number> = {};
    const walk = (node: unknown, prefix: string, depth: number) => {
      if (node === null || typeof node !== "object" || Array.isArray(node) || depth > 2) return;
      for (const [k, v] of Object.entries(node)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (Array.isArray(v)) lists[p] = v.length;
        else walk(v, p, depth + 1);
      }
    };
    walk(stored.payload, "", 0);
    return {
      id,
      tool: stored.tool,
      network: stored.network,
      args: stored.args,
      stored_at: new Date(stored.created_at).toISOString(),
      characters: JSON.stringify(stored.payload).length,
      lists,
      read: `Add ?path=<list> (and offset, limit, match) to page one list, e.g. ${resultUri(id, { path: Object.keys(lists)[0] ?? "" })}.`,
    };
  }
  const value = readPath(stored.payload, query.path);
  if (value === undefined) throw new Error(`Stored result '${id}' has nothing at path '${query.path}'. Read ${resultUri(id)} for its lists.`);
  if (!Array.isArray(value)) return { id, path: query.path, value };

  const offset = Math.max(0, Number.parseInt(query.offset ?? "0", 10) || 0);
  const limit = query.limit ? Math.max(1, Number.parseInt(query.limit, 10) || 1) : Infinity;
  const needle = query.match?.toLowerCase();
  const onlyOmitted = query.omitted === "1" || query.omitted === "true";
  const listed = new Set(onlyOmitted ? (stored.shown[query.path] ?? []) : []);
  const indexed = value.map((row, index) => ({ row, index })).filter(({ index }) => !listed.has(index));
  const matched = needle ? indexed.filter(({ row }) => JSON.stringify(row).toLowerCase().includes(needle)) : indexed;
  const rows: Array<{ index: number; row: unknown }> = [];
  let spent = 0;
  let next: number | null = null;
  for (let i = offset; i < matched.length; i++) {
    const size = JSON.stringify(matched[i]).length + 1;
    if (rows.length > 0 && (rows.length >= limit || spent + size > RESULT_PAGE_BUDGET)) {
      next = i;
      break;
    }
    rows.push(matched[i]);
    spent += size;
  }
  return {
    id,
    path: query.path,
    total: value.length,
    ...(onlyOmitted ? { omitted: indexed.length } : {}),
    ...(needle ? { match: query.match, matched: matched.length } : {}),
    offset,
    rows,
    ...(next !== null
      ? {
          next_offset: next,
          next_page: resultUri(id, {
            path: query.path,
            omitted: onlyOmitted,
            offset: next,
            match: query.match ?? undefined,
            limit: query.limit ? limit : undefined,
          }),
        }
      : {}),
  };
}
