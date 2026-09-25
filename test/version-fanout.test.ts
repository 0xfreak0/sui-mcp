import { describe, it, expect } from "vitest";
import {
  decodeFanoutCursor,
  encodeFanoutCursor,
  mergeVersionPages,
  type VersionPage,
  type VersionStream,
} from "../src/utils/version-fanout.js";
import type { ListOrder } from "../src/utils/pagination.js";

/**
 * A function filter matches one package version, so `all_versions` reads each
 * version's calls as a separate list and merges them. The merge must read
 * every call exactly once across pages, which is checked here by walking a
 * whole synthetic lineage page by page.
 */

type Tx = { digest: string; cp: number };

/** A version's full call list, ascending, served a page at a time like the connection does. */
function serve(all: Tx[], order: ListOrder, cursor: string | undefined, size: number): VersionPage<Tx> {
  const at = cursor === undefined ? (order === "newest" ? all.length : -1) : all.findIndex((t) => t.digest === cursor);
  const slice =
    order === "newest" ? all.slice(Math.max(0, at - size), at) : all.slice(at + 1, at + 1 + size);
  const hasMore = order === "newest" ? at - size > 0 : at + 1 + size < all.length;
  return { edges: slice.map((t) => ({ cursor: t.digest, node: t })), hasMore };
}

function walk(lineage: Tx[][], order: ListOrder, limit: number): Tx[][] {
  let streams: VersionStream[] = lineage.map((_, i) => ({ address: `0x${i}`, done: false }));
  const pages: Tx[][] = [];
  for (let guard = 0; guard < 100; guard++) {
    const read = streams.map((s, i) => (s.done ? null : serve(lineage[i], order, s.cursor, limit)));
    const r = mergeVersionPages(streams, read, order, limit, (t) => t.digest, (t) => t.cp);
    pages.push(r.nodes);
    // Round-trip the cursor as a caller would.
    const cursor = encodeFanoutCursor(order, r.streams);
    streams = decodeFanoutCursor(cursor, order)!;
    if (!r.has_next_page) break;
  }
  return pages;
}

const v1: Tx[] = [
  { digest: "a1", cp: 10 },
  { digest: "a2", cp: 20 },
  { digest: "a3", cp: 30 },
  { digest: "a4", cp: 31 },
  { digest: "a5", cp: 50 },
];
const v2: Tx[] = [
  { digest: "b1", cp: 15 },
  { digest: "b2", cp: 30 },
  { digest: "b3", cp: 40 },
];
const v3: Tx[] = [
  { digest: "c1", cp: 45 },
  { digest: "c2", cp: 60 },
];

describe("mergeVersionPages", () => {
  it("reads every call of every version once, newest first", () => {
    const pages = walk([v1, v2, v3], "newest", 3);
    const flat = pages.flat().map((t) => t.digest);
    expect(flat).toEqual(["c2", "a5", "c1", "b3", "a4", "a3", "b2", "a2", "b1", "a1"]);
    expect(pages.every((p) => p.length <= 3)).toBe(true);
  });

  it("reads every call of every version once, oldest first", () => {
    const flat = walk([v1, v2, v3], "oldest", 4).flat().map((t) => t.digest);
    expect(flat).toEqual(["a1", "b1", "a2", "a3", "b2", "a4", "b3", "c1", "a5", "c2"]);
  });

  it("shows a transaction that called two versions once and advances both past it", () => {
    const shared = { digest: "both", cp: 35 };
    const flat = walk([[...v1.slice(0, 3), shared, v1[4]], [v2[0], shared, v2[2]]], "newest", 2)
      .flat()
      .map((t) => t.digest);
    expect(flat.filter((d) => d === "both")).toHaveLength(1);
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat).toHaveLength(7);
  });
});

describe("fan-out cursor", () => {
  it("refuses a cursor written for the other order, or not written by it", () => {
    const c = encodeFanoutCursor("newest", [{ address: "0x1", cursor: "x", done: false }]);
    expect(decodeFanoutCursor(c, "oldest")).toBeNull();
    expect(decodeFanoutCursor("KAE6Cwivua9ZELCw9Z0P", "newest")).toBeNull();
  });
});
