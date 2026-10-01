import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capPayload, capRows, readStoredResult } from "../src/utils/output-cap.js";
import { resetStore } from "../src/utils/store.js";

type Row = { id: number; usd: number; flagged?: boolean; pad: string };
const row = (id: number, usd: number, flagged = false): Row => ({ id, usd, ...(flagged ? { flagged } : {}), pad: "x".repeat(80) });
const size = JSON.stringify(row(10, 10)).length + 1;
const byUsd = (a: Row, b: Row) => b.usd - a.usd;

describe("capRows", () => {
  it("keeps the highest-ranked rows that fit and reports the rest", () => {
    const rows = [row(1, 5), row(2, 50), row(3, 20), row(4, 1), row(5, 30)];
    const { rows: kept, omitted } = capRows(rows, { budget: size * 2, rank: byUsd, usd: (r) => r.usd });
    expect(kept.map((r) => r.id)).toEqual([2, 5]);
    expect(omitted).toMatchObject({ count: 3, usd: 26, from: 0 });
    expect((omitted!.largest as Row).id).toBe(3);
  });

  it("keeps flagged rows past the budget, wherever they rank", () => {
    const rows = [row(1, 100), row(2, 90), row(3, 0.01, true), row(4, 0.02, true)];
    const { rows: kept, omitted } = capRows(rows, { budget: size, rank: byUsd, keep: (r) => r.flagged === true });
    expect(kept.map((r) => r.id).sort()).toEqual([3, 4]);
    expect(omitted?.count).toBe(2);
    expect(omitted!.largest).toBeUndefined();
    expect((omitted!.first as Row).id).toBe(1);
  });

  it("names the largest omitted row by USD, and counts the unpriced ones apart", () => {
    const rows = [row(1, 100), row(2, 90), { ...row(3, 0), usd: null as unknown as number }, row(4, 50)];
    const { omitted } = capRows(rows, { budget: size, rank: byUsd, usd: (r) => r.usd });
    expect(omitted).toMatchObject({ count: 3, usd: 140, unpriced: 1 });
    expect((omitted!.largest as Row).id).toBe(2);
  });

  it("stops at the first row that does not fit, so the omitted rows are a rank suffix", () => {
    const rows = [row(1, 3), { ...row(2, 2), pad: "y".repeat(400) }, row(3, 1)];
    const { rows: kept, omitted } = capRows(rows, { budget: size * 2, rank: byUsd });
    expect(kept.map((r) => r.id)).toEqual([1]);
    expect(omitted?.count).toBe(2);
  });

  it("honours a row limit and keeps the original order when asked", () => {
    const rows = [row(1, 1), row(2, 3), row(3, 2)];
    const { rows: kept, omitted } = capRows(rows, { budget: Infinity, limit: 2, rank: byUsd, keepOrder: true });
    expect(kept.map((r) => r.id)).toEqual([2, 3]);
    expect(omitted).toMatchObject({ count: 1, from: 0 });
  });

  it("names the first omitted index of the full list", () => {
    const rows = [row(1, 1), row(2, 1), row(3, 1), row(4, 1)];
    const { omitted } = capRows(rows, { budget: size * 2 });
    expect(omitted?.from).toBe(2);
  });

  it("keeps one row when even the first exceeds the budget, and nothing is omitted when all fit", () => {
    expect(capRows([row(1, 1), row(2, 1)], { budget: 0 }).rows.map((r) => r.id)).toEqual([1]);
    expect(capRows([row(1, 1)], { budget: size }).omitted).toBeNull();
  });
});

describe("capPayload", () => {
  let dir: string;
  let backup: string | undefined;
  beforeEach(() => {
    backup = process.env.SUI_STORE_PATH;
    dir = mkdtempSync(join(tmpdir(), "sui-cap-"));
    delete process.env.SUI_STORE_PATH;
    resetStore();
  });
  afterEach(() => {
    resetStore();
    if (backup === undefined) delete process.env.SUI_STORE_PATH;
    else process.env.SUI_STORE_PATH = backup;
    rmSync(dir, { recursive: true, force: true });
  });

  const full = { total: 7, nested: { rows: [row(1, 1), row(2, 2), row(3, 3)] }, rows: [row(4, 9), row(5, 8)] };
  const next = { tool: "t", args: { a: 1, detail: "full" } };

  it("leaves totals alone, caps nested lists and names the next call, without a handle when the store is off", () => {
    const { payload, resultId } = capPayload("t", { a: 1 }, full, { "nested.rows": { budget: size, rank: byUsd } }, { full: false, next_call: next });
    expect(resultId).toBeNull();
    expect(payload.total).toBe(7);
    expect(payload.truncated).toBe(true);
    expect((payload.nested as { rows: Row[] }).rows.map((r) => r.id)).toEqual([3]);
    expect((payload.rows as Row[]).length).toBe(2);
    const omitted = payload.omitted as { lists: Record<string, { count: number; page?: string }>; next_call: unknown; result?: unknown };
    expect(omitted.lists["nested.rows"].count).toBe(2);
    expect(omitted.next_call).toEqual(next);
    expect(omitted.result).toBeUndefined();
    expect(omitted.lists["nested.rows"].page).toBeUndefined();
    expect(full.nested.rows).toHaveLength(3);
  });

  it("returns the payload untouched when nothing is cut or detail is full", () => {
    expect(capPayload("t", {}, full, { rows: { budget: Infinity } }, { full: false, next_call: next }).payload).toBe(full);
    expect(capPayload("t", {}, full, { rows: { budget: 0 } }, { full: true, next_call: next }).payload).toBe(full);
  });

  it("pages an oversized full incident without losing totals or unreachable rows", () => {
    process.env.SUI_STORE_PATH = join(dir, "store.db");
    resetStore();
    const groups = Array.from({ length: 300 }, (_, id) => ({ id, usd: id, pad: "g".repeat(1_100) }));
    const samples = Array.from({ length: 140 }, (_, id) => ({ id, pad: "p".repeat(1_000) }));
    const unread = Array.from({ length: 70 }, (_, id) => ({ id, pad: "u".repeat(1_000) }));
    const incident = { totals: { usd_net: 321_000 }, groups, usd_basis: { price_samples: samples }, objects_unread: unread };
    const { payload, resultId } = capPayload("summarize_incident_losses", {}, incident, {
      groups: { budget: 14_000 }, "usd_basis.price_samples": { budget: 12_000 }, objects_unread: { budget: 2_000 },
    }, { full: true, maxChars: 498_000, next_call: next });
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(498_000);
    expect(payload.totals).toEqual(incident.totals);
    expect(payload.omitted).not.toHaveProperty("next_call");
    if (!Array.isArray(payload.groups)) throw new Error("Missing incident groups");
    const displayed = payload.groups.map((g: { id: number }) => g.id);
    const seen = [...displayed];
    let offset: string | null = "0";
    while (offset !== null) {
      const page = readStoredResult(resultId!, { path: "groups", omitted: "1", offset }) as {
        rows: Array<{ row: { id: number } }>; next_offset?: number;
      };
      seen.push(...page.rows.map(({ row }) => row.id));
      offset = page.next_offset === undefined ? null : String(page.next_offset);
    }
    expect(seen.sort((a, b) => a - b)).toEqual(groups.map((g) => g.id));
  });

  it("stores the full result with the store on, and its resource pages every omitted row", () => {
    process.env.SUI_STORE_PATH = join(dir, "store.db");
    resetStore();
    const rows = Array.from({ length: 30 }, (_, i) => row(i, 30 - i));
    const { payload, resultId } = capPayload("t", { a: 1 }, { rows }, { rows: { budget: size * 3 } }, { full: false, next_call: next });
    expect(resultId).toMatch(/^[0-9a-f]{12}$/);
    const list = (payload.omitted as { lists: Record<string, { page: string }> }).lists.rows;
    const page = new URL(list.page);
    expect(page.searchParams.get("omitted")).toBe("1");

    const seen: number[] = [];
    let offset: string | null = "0";
    while (offset !== null) {
      const read = readStoredResult(resultId!, { path: "rows", omitted: "1", offset, limit: "10" }) as { rows: Array<{ row: Row }>; next_offset?: number };
      seen.push(...read.rows.map((r) => r.row.id));
      offset = read.next_offset === undefined ? null : String(read.next_offset);
    }
    expect(seen).toEqual(rows.slice(3).map((r) => r.id));

    const matched = readStoredResult(resultId!, { path: "rows", match: '"id":17,' }) as { matched: number; rows: Array<{ index: number }> };
    expect(matched.matched).toBe(1);
    expect(matched.rows[0].index).toBe(17);
    expect((readStoredResult(resultId!, {}) as { lists: Record<string, number> }).lists).toEqual({ rows: 30 });
  });

  it("stores the full view a tool passes, not the summary rows it caps", () => {
    process.env.SUI_STORE_PATH = join(dir, "store.db");
    resetStore();
    const summary = { rows: [row(1, 1), row(2, 1)] };
    const stored = { rows: [{ ...row(1, 1), chain: [1, 2] }, { ...row(2, 1), chain: [3] }] };
    const { resultId } = capPayload("t", {}, summary, { rows: { budget: 0 } }, { full: false, next_call: next, stored });
    const read = readStoredResult(resultId!, { path: "rows" }) as { rows: Array<{ row: { chain: number[] } }> };
    expect(read.rows.map((r) => r.row.chain)).toEqual([[1, 2], [3]]);
  });

  it("caps a list inside each row of another list, and pages each one's omitted rows", () => {
    process.env.SUI_STORE_PATH = join(dir, "store.db");
    resetStore();
    const txs = [{ id: "a", events: Array.from({ length: 6 }, (_, i) => row(i, 1)) }, { id: "b", events: [row(9, 1)] }];
    const { payload, resultId } = capPayload("t", {}, { txs }, { "txs.0.events": { budget: size * 2 }, "txs.1.events": { budget: size * 2 } }, { full: false, next_call: next });
    const shown = payload.txs as Array<{ id: string; events: Row[] }>;
    expect(shown.map((t) => t.events.map((e) => e.id))).toEqual([[0, 1], [9]]);
    expect(shown[0].id).toBe("a");
    const lists = (payload.omitted as { lists: Record<string, { count: number }> }).lists;
    expect(Object.keys(lists)).toEqual(["txs.0.events"]);
    expect(lists["txs.0.events"].count).toBe(4);
    const read = readStoredResult(resultId!, { path: "txs.0.events", omitted: "1" }) as { rows: Array<{ index: number }> };
    expect(read.rows.map((r) => r.index)).toEqual([2, 3, 4, 5]);
    expect(txs[0].events).toHaveLength(6);
  });

  it("stores a list the caller narrowed, so its omitted page skips what the response listed", () => {
    process.env.SUI_STORE_PATH = join(dir, "store.db");
    resetStore();
    const stored = { rows: [row(1, 1), row(2, 1), row(3, 1)] };
    const { payload, resultId } = capPayload("t", {}, { rows: [row(2, 1)] }, {}, { full: false, next_call: next, stored, paged: { rows: [1] } });
    expect(payload.omitted).toBeUndefined();
    const read = readStoredResult(resultId!, { path: "rows", omitted: "1" }) as { rows: Array<{ index: number }> };
    expect(read.rows.map((r) => r.index)).toEqual([0, 2]);
  });

  it("refuses to read a stored result with the store off", () => {
    expect(() => readStoredResult("abc", {})).toThrow(/SUI_STORE_PATH/);
  });
});
