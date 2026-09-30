import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capPayload, readStoredResult, type ListCap, type OmittedRows } from "../src/utils/output-cap.js";
import { resetStore } from "../src/utils/store.js";

vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
const { selectCommands } = await import("../src/utils/ptb-resolve.js");

/**
 * For random row sets, budgets and orderings: flagged rows are always in the
 * capped view, the omitted summary is exact, and the capped view plus the
 * stored pages of what it left out hold every row exactly once. Commands:
 * following next_call's offset from a first page reaches every command.
 */

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = { id: number; usd: number | null; flagged: boolean; pad: string };
const next = { tool: "t", repeat_with: { detail: "full" } };

function randomRows(rand: () => number): Row[] {
  const n = Math.floor(rand() * 80);
  return Array.from({ length: n }, (_, id) => ({
    id,
    usd: rand() < 0.25 ? null : Math.round(rand() * 100_000) / 100,
    flagged: rand() < 0.1,
    pad: "x".repeat(Math.floor(rand() * 200)),
  }));
}

function randomCap(rand: () => number): ListCap<Row> {
  return {
    budget: Math.floor(rand() * 6_000),
    ...(rand() < 0.3 ? { limit: Math.floor(rand() * 10) } : {}),
    ...(rand() < 0.5 ? { rank: (a: Row, b: Row) => (b.usd ?? -1) - (a.usd ?? -1) } : {}),
    keep: (r: Row) => r.flagged,
    usd: (r: Row) => r.usd,
    keepOrder: rand() < 0.5,
  };
}

/** Every row of one stored list's omitted pages, walked with a random page limit. */
function walkOmitted(id: string, path: string, rand: () => number): Array<{ index: number; row: unknown }> {
  const seen: Array<{ index: number; row: unknown }> = [];
  let offset: string | null = "0";
  const limit = rand() < 0.5 ? String(1 + Math.floor(rand() * 7)) : null;
  for (let guard = 0; offset !== null && guard < 1_000; guard++) {
    const page = readStoredResult(id, { path, omitted: "1", offset, limit }) as {
      rows: Array<{ index: number; row: unknown }>;
      next_offset?: number;
    };
    seen.push(...page.rows);
    offset = page.next_offset === undefined ? null : String(page.next_offset);
  }
  return seen;
}

describe("capPayload properties", () => {
  let dir: string;
  let backup: string | undefined;
  beforeAll(() => {
    backup = process.env.SUI_STORE_PATH;
    dir = mkdtempSync(join(tmpdir(), "sui-cap-prop-"));
  });
  afterAll(() => {
    resetStore();
    if (backup === undefined) delete process.env.SUI_STORE_PATH;
    else process.env.SUI_STORE_PATH = backup;
    rmSync(dir, { recursive: true, force: true });
  });

  for (const store of [false, true]) {
    it(`keeps flagged rows, states the omitted rows exactly, and reaches every row once (store ${store ? "on" : "off"})`, () => {
      if (store) process.env.SUI_STORE_PATH = join(dir, "store.db");
      else delete process.env.SUI_STORE_PATH;
      resetStore();
      for (let seed = 1; seed <= 300; seed++) {
        const rand = prng(seed * (store ? 7 : 1));
        const rows = randomRows(rand);
        const cap = randomCap(rand);
        const { payload, resultId } = capPayload("t", { seed }, { total: rows.length, rows }, { rows: cap as ListCap<never> }, { full: false, next_call: next });
        const kept = payload.rows as Row[];
        const keptIds = kept.map((r) => r.id);
        const context = `seed ${seed}`;

        expect(new Set(keptIds).size, context).toBe(keptIds.length);
        for (const r of rows) if (r.flagged) expect(keptIds, context).toContain(r.id);
        if (rows.length) expect(kept.length, context).toBeGreaterThan(0);
        expect(payload.total, context).toBe(rows.length);

        const omitted = (payload.omitted as { lists?: Record<string, OmittedRows> } | undefined)?.lists?.rows;
        const dropped = rows.filter((r) => !keptIds.includes(r.id));
        if (dropped.length === 0) {
          expect(omitted, context).toBeUndefined();
          expect(payload.truncated, context).toBeUndefined();
          continue;
        }
        expect(payload.truncated, context).toBe(true);
        expect(omitted!.count, context).toBe(dropped.length);
        expect(omitted!.from, context).toBe(Math.min(...dropped.map((r) => r.id)));
        const priced = dropped.filter((r) => r.usd !== null);
        expect(omitted!.usd, context).toBeCloseTo(priced.reduce((s, r) => s + r.usd!, 0), 1);
        expect(omitted!.unpriced ?? 0, context).toBe(dropped.length - priced.length);
        if (priced.length) expect((omitted!.largest as Row).usd, context).toBe(Math.max(...priced.map((r) => r.usd!)));
        else expect(dropped.map((r) => r.id), context).toContain((omitted!.first as Row).id);
        expect((payload.omitted as { next_call: unknown }).next_call, context).toEqual(next);

        // Store off: the full call returns every row.
        const full = capPayload("t", { seed }, { rows }, { rows: cap as ListCap<never> }, { full: true, next_call: next }).payload;
        expect((full.rows as Row[]).map((r) => r.id), context).toEqual(rows.map((r) => r.id));

        if (store) {
          expect(resultId, context).toMatch(/^[0-9a-f]{12}$/);
          const paged = walkOmitted(resultId!, "rows", rand).map((p) => (p.row as Row).id);
          expect([...keptIds, ...paged].sort((a, b) => a - b), context).toEqual(rows.map((r) => r.id));
        } else {
          expect(resultId, context).toBeNull();
        }
      }
    }, 60_000);
  }

  it("reaches every entry of a folded list once, and counts the omitted entries", () => {
    process.env.SUI_STORE_PATH = join(dir, "store.db");
    resetStore();
    for (let seed = 1; seed <= 150; seed++) {
      const rand = prng(seed + 10_000);
      const entries = Array.from({ length: 1 + Math.floor(rand() * 120) }, (_, i) => ({ i, pad: "y".repeat(Math.floor(rand() * 120)) }));
      // Contiguous runs folded into one row each.
      const folded: Array<{ index: number; indices: number[]; count: number; flagged: boolean }> = [];
      for (let i = 0; i < entries.length; ) {
        const len = 1 + Math.floor(rand() * 6);
        const indices = entries.slice(i, i + len).map((e) => e.i);
        folded.push({ index: indices[0], indices, count: indices.length, flagged: rand() < 0.1 });
        i += len;
      }
      const cap: ListCap<(typeof folded)[number]> = {
        budget: Math.floor(rand() * 1_500),
        keepOrder: true,
        keep: (r) => r.flagged,
        weight: (r) => r.count,
        covers: (r) => r.indices,
      };
      const { payload, resultId } = capPayload(
        "t",
        { seed, folded: true },
        { events: folded },
        { events: cap as ListCap<never> },
        { full: false, next_call: next, stored: { events: entries }, folded: { events: { entries: entries.length, rows: folded.length } } },
      );
      const kept = payload.events as typeof folded;
      const context = `seed ${seed}`;
      for (const r of folded) if (r.flagged) expect(kept.map((k) => k.index), context).toContain(r.index);
      const omitted = (payload.omitted as { lists: Record<string, OmittedRows> }).lists.events;
      const keptEntries = kept.flatMap((k) => k.indices);
      if (!omitted) {
        expect(keptEntries.length, context).toBe(entries.length);
        continue;
      }
      expect(omitted.entries, context).toBe(entries.length - keptEntries.length);
      const paged = walkOmitted(resultId!, "events", rand).map((p) => p.index);
      expect([...keptEntries, ...paged].sort((a, b) => a - b), context).toEqual(entries.map((e) => e.i));
    }
  }, 60_000);
});

describe("selectCommands properties", () => {
  const PKG = `0x${"ab".repeat(32)}`;
  it("a first page plus its next_call continuations reach every command, each continuation contiguous and advancing", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = prng(seed + 20_000);
      const n = Math.floor(rand() * 60);
      const commands = Array.from({ length: n }, (_, index) => {
        const kind = rand();
        const pad = "z".repeat(Math.floor(rand() * 400));
        if (kind < 0.4) return { index, type: "MoveCall", target: `${PKG}::m::f`, pad };
        if (kind < 0.6) return { index, type: "MoveCall", target: "0x0000000000000000000000000000000000000000000000000000000000000002::coin::split", pad };
        return { index, type: "SplitCoins", pad };
      });
      const budget = Math.floor(rand() * 4_000);
      const context = `seed ${seed}`;
      const first = selectCommands(commands, { budget });
      const reached = new Set(first.page.map((c) => c.index as number));
      if (first.omitted) {
        const inRanges = first.omitted.ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k));
        expect(inRanges.length, context).toBe(first.omitted.count);
        expect([...reached, ...inRanges].sort((a, b) => a - b), context).toEqual(commands.map((c) => c.index));
      } else {
        expect(reached.size, context).toBe(n);
      }
      let offset = first.omitted?.from ?? null;
      let previousEnd = -1;
      for (let guard = 0; offset !== null && guard < 1_000; guard++) {
        const page = selectCommands(commands, { offset, budget });
        const ids = page.page.map((c) => c.index as number);
        expect(ids.length, context).toBeGreaterThan(0);
        expect(ids, context).toEqual(Array.from({ length: ids.length }, (_, k) => offset! + k));
        expect(ids[0], context).toBeGreaterThan(previousEnd);
        previousEnd = ids[ids.length - 1];
        for (const i of ids) reached.add(i);
        offset = page.omitted?.from ?? null;
      }
      expect(reached.size, context).toBe(n);
    }
  });
});
