import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFanoutCursor } from "../../src/utils/version-fanout.js";
import { registerTransactionTools } from "../../src/tools/transactions.js";

const { query, versions } = vi.hoisted(() => ({ query: vi.fn(), versions: vi.fn() }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: query }));
vi.mock("../../src/utils/package-versions.js", () => ({
  fetchPackageVersions: versions,
  versionScopeNote: vi.fn().mockResolvedValue(null),
}));
const handlers = new Map<string, Function>();
registerTransactionTools({ tool: (name: string, _d: string, _s: unknown, handler: Function) => handlers.set(name, handler) } as never);
const call = async (args: Record<string, unknown>) => {
  const result = await handlers.get("query_transactions")!(args);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
};
const tx = (cp: number) => ({ digest: `tx${cp}`, effects: { checkpoint: { sequenceNumber: cp } } });
const connection = (cps: number[], more: boolean, boundary: string) => ({
  nodes: cps.map(tx),
  edges: cps.map((cp) => ({ node: tx(cp), cursor: `row${cp}` })),
  pageInfo: { hasPreviousPage: more, hasNextPage: more, startCursor: boundary, endCursor: boundary },
});
const fn = "0x1::trade";

beforeEach(() => {
  query.mockReset();
  versions.mockResolvedValue([{ address: "0x1", version: 1 }, { address: "0x2", version: 2 }]);
});

for (const order of ["newest", "oldest"] as const) {
  const cursorKey = order === "newest" ? "before" : "after";
  const sizeKey = order === "newest" ? "last" : "first";
  describe(`${order} transaction page filling`, () => {
    it("fills through empty and short reads and continues at the scanned boundary", async () => {
      const first = order === "newest" ? 30 : 10;
      const last = order === "newest" ? 10 : 30;
      query.mockImplementation(async (_q, v) => {
        if (!v[cursorKey]) return { transactions: connection([first], true, "short") };
        if (v[cursorKey] === "short") return { transactions: connection([], true, "empty") };
        if (v[cursorKey] === "empty") return { transactions: connection([20], true, "middle") };
        return { transactions: connection([last], false, "end") };
      });
      const r = await call({ sender: "0x3", order, limit: 3 });
      expect(r.transactions.map((t: { checkpoint: number }) => t.checkpoint)).toEqual([first, 20, last]);
      expect(r.has_next_page).toBe(false);
      expect(query.mock.calls.map(([, v]) => v[sizeKey])).toEqual([3, 2, 2, 1]);
    });

    it("bounds empty reads and resumes after their boundary without declaring exhaustion", async () => {
      query.mockImplementation(async (_q, v) => {
        const n = Number(v[cursorKey] ?? 0);
        return { transactions: connection(n >= 10 ? [50] : [], n < 10, String(n + 1)) };
      });
      const r = await call({ sender: "0x3", order, limit: 1 });
      expect(r.transactions).toEqual([]);
      expect(r.has_next_page).toBe(true);
      expect(r.scan.reads).toBe(10);
      const resumed = await call({ sender: "0x3", limit: 1, ...r.scan.next_call.repeat_with });
      expect(resumed.transactions.map((t: { digest: string }) => t.digest)).toEqual(["tx50"]);
      expect(resumed.has_next_page).toBe(false);
    });

    it("finds the leading rows of every version before merging short streams", async () => {
      const leading = order === "newest" ? [90, 100] : [1, 2];
      const trailing = order === "newest" ? [10, 20] : [90, 100];
      query.mockImplementation(async (_q, v) => {
        const out: Record<string, unknown> = {};
        for (let k = 0; v[`f${k}`]; k++) {
          const address = v[`f${k}`].function.split("::")[0];
          const cursor = v[`c${k}`];
          out[`v${k}`] = address === "0x1"
            ? connection(trailing, false, "older-end")
            : !cursor ? connection([], true, "gap") : connection(leading, false, "leading-end");
        }
        return out;
      });
      const r = await call({ function: fn, all_versions: true, order, limit: 2 });
      expect(r.transactions.map((t: { checkpoint: number }) => t.checkpoint)).toEqual(order === "newest" ? [...leading].reverse() : leading);
      const resumed = await call({ function: fn, all_versions: true, order, limit: 2, cursor: r.next_cursor });
      expect(resumed.transactions.map((t: { checkpoint: number }) => t.checkpoint)).toEqual(order === "newest" ? [...trailing].reverse() : trailing);
      expect(resumed.has_next_page).toBe(false);
    });

    it("returns only the ordered prefix at a read stop and resumes beyond its scanned range", async () => {
      const first = order === "newest" ? 100 : 1;
      const second = order === "newest" ? 80 : 20;
      query.mockImplementation(async (_q, v) => {
        const out: Record<string, unknown> = {};
        for (let k = 0; v[`f${k}`]; k++) {
          const address = v[`f${k}`].function.split("::")[0];
          const n = Number(v[`c${k}`] ?? 0);
          out[`v${k}`] = address === "0x2" ? connection([50], false, "end")
            : n === 0 ? connection([first], true, "1")
            : n >= 10 ? connection([second], false, "done")
            : connection([], true, String(n + 1));
        }
        return out;
      });
      const r = await call({ function: fn, all_versions: true, order, limit: 2 });
      expect(r.transactions.map((t: { checkpoint: number }) => t.checkpoint)).toEqual([first]);
      expect(decodeFanoutCursor(r.next_cursor, order)?.[0].cursor).toBe("10");
      const resumed = await call({ function: fn, all_versions: true, limit: 2, ...r.scan.next_call.repeat_with });
      expect(resumed.transactions.map((t: { checkpoint: number }) => t.checkpoint)).toEqual([second, 50]);
      expect(resumed.has_next_page).toBe(false);
    });

    it("withholds unordered rows at a read stop and keeps the empty stream's progress", async () => {
      query.mockImplementation(async (_q, v) => {
        const out: Record<string, unknown> = {};
        for (let k = 0; v[`f${k}`]; k++) {
          const address = v[`f${k}`].function.split("::")[0];
          const n = Number(v[`c${k}`] ?? 0);
          out[`v${k}`] = address === "0x1"
            ? connection([50], false, "end")
            : connection(n >= 10 ? [order === "newest" ? 100 : 1] : [], n < 10, String(n + 1));
        }
        return out;
      });
      const r = await call({ function: fn, all_versions: true, order, limit: 2 });
      expect(r.transactions).toEqual([]);
      expect(r.scan.reads).toBe(10);
      expect(decodeFanoutCursor(r.next_cursor, order)).toEqual([
        { address: "0x1", done: false, cursor: undefined },
        { address: "0x2", done: false, cursor: "10" },
      ]);
      const resumed = await call({ function: fn, all_versions: true, limit: 2, ...r.scan.next_call.repeat_with });
      expect(resumed.transactions.map((t: { checkpoint: number }) => t.checkpoint)).toEqual(order === "newest" ? [100, 50] : [1, 50]);
      expect(resumed.has_next_page).toBe(false);
    });
  });
}
