import { beforeEach, describe, expect, it, vi } from "vitest";
import { readObjectEvents } from "../src/utils/object-events.js";
import { registerEventTools } from "../src/tools/events.js";
import type { GqlEventNode } from "../src/utils/tx-connections.js";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: query }));

const pool = `0x${"a".repeat(64)}`;
const other = `0x${"b".repeat(64)}`;
const swap = "0x2::pool::SwapEvent";
const deposit = "0x2::pool::DepositEvent";
const event = (type: string, json: unknown, module = "0x2::pool") => ({
  contents: { type: { repr: type }, json }, sender: { address: "0x1" },
  transactionModule: { fullyQualifiedName: module },
});
const tx = (cp: number, nodes: GqlEventNode[], more = false) => ({
  digest: `digest${cp}`,
  effects: {
    timestamp: `2026-10-20T00:00:${String(cp).padStart(2, "0")}Z`, checkpoint: { sequenceNumber: cp },
    events: { nodes, pageInfo: { hasNextPage: more, endCursor: "next-events" } }
  },
});
interface TestTx {
  digest: string;
  effects: {
    checkpoint: { sequenceNumber: number };
    events: { nodes: GqlEventNode[] };
  };
}
const page = (rows: TestTx[], more: boolean, cursor = "boundary") => ({
  transactions: {
    edges: rows.map((node) => ({ node, cursor: `cursor${node.effects.checkpoint.sequenceNumber}` })),
    pageInfo: { hasPreviousPage: more, hasNextPage: more, startCursor: cursor, endCursor: cursor }
  },
});
const read = (args: Partial<Parameters<typeof readObjectEvents>[0]> = {}) => readObjectEvents({
  object: pool, filter: { affectedObject: pool }, module: null, order: "newest", limit: 20, ...args,
});

beforeEach(() => query.mockReset());

describe("affected-object event listing", () => {
  it("returns complete decoded events in newest order and marks only top-level object ids", async () => {
    query.mockImplementation(async (document) => {
      if (typeof document === "string" && document.includes("transaction(digest:")) return {
        transaction: {
          effects: {
            events: {
              nodes: [event(swap, { pool })], pageInfo: { hasNextPage: false },
            }
          }
        }
      };
      return page([tx(1, [event(deposit, { nested: { id: pool } })]),
      tx(2, [event(swap, { pool: other }), event(swap, { pool })], true)], false);
    });
    const result = await read();
    expect(result.events.map((e) => [e.tx_digest, e.type, e.names_object])).toEqual([
      ["digest2", swap, true], ["digest2", swap, true], ["digest2", swap, false],
      ["digest1", deposit, false],
    ]);
    expect(result.has_next_page).toBe(false);
    expect(result.incomplete_transactions).toBeUndefined();
    const transactionRead = query.mock.calls.find(([document]) => typeof document === "string" && document.includes("transactions(filter:"));
    expect(transactionRead?.[0]).toContain("events(first: 50)");
    expect(transactionRead?.[1].last).toBe(10);
    expect(transactionRead?.[1].filter).toEqual({ affectedObject: pool });
  });

  for (const order of ["newest", "oldest"] as const) {
    it(`continues within a transaction without gaps or repeats (${order})`, async () => {
      const nodes = [event(swap, { pool, n: 1 }), event(swap, { pool, n: 2 }), event(swap, { pool, n: 3 })];
      query.mockImplementation(async (_document, vars) => {
        const before = vars?.before ?? vars?.after;
        if (before === "cursor1") return page([], false);
        return before === "cursor2" ? page([tx(1, [event(swap, { pool, n: 0 })])], false) :
          page(order === "newest" ? [tx(1, [event(swap, { pool, n: 0 })]), tx(2, nodes)]
            : [tx(2, nodes), tx(1, [event(swap, { pool, n: 0 })])], true);
      });
      const first = await read({ order, limit: 2 });
      const second = await read({ order, limit: 2, cursor: first.next_cursor! });
      const third = await read({ order, limit: 2, cursor: second.next_cursor! });
      expect([...first.events, ...second.events, ...third.events].map((e) => (e.data as { n: number }).n))
        .toEqual(order === "newest" ? [3, 2, 1, 0] : [1, 2, 3, 0]);
      expect(third.has_next_page).toBe(false);
    });
  }

  it("narrows by defining type and emitting module at the checkpoint", async () => {
    query.mockResolvedValue(page([tx(2, [event(swap, { pool }, "0x3::pool"), event(deposit, { pool }), event(swap, { pool })])], false));
    const result = await read({ eventType: swap, module: { segments: [{ filter: "0x2::pool", afterCheckpoint: 1, beforeCheckpoint: 3 }] } });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe(swap);
    expect(result.events[0].emitting_module).toBe("0x2::pool");
  });

  it("matches a generic event struct without requiring its type arguments", async () => {
    const generic = "0x2::pool::SwapEvent<0x2::sui::SUI>";
    query.mockResolvedValue(page([tx(2, [event(generic, { pool })])], false));
    const result = await read({ eventType: swap });
    expect(result.events.map((e) => e.type)).toEqual([generic]);
  });

  it("fills short and empty transaction slices and resumes after a read bound", async () => {
    query.mockImplementation(async (_document, vars) => {
      const n = Number(vars?.before ?? "0");
      return n < 20 ? page([], true, String(n + 1)) : page([tx(9, [event(swap, { pool })])], false);
    });
    const first = await read({ limit: 1 });
    expect(first.events).toEqual([]);
    expect(first.has_next_page).toBe(true);
    expect(first.scan?.reads).toBe(20);
    const second = await read({ limit: 1, cursor: first.next_cursor! });
    expect(second.events.map((e) => e.tx_digest)).toEqual(["digest9"]);
  });

  it("reports incomplete nested pages without calling their partial data complete", async () => {
    query.mockImplementation(async (document) => typeof document === "string" && document.includes("transaction(digest:")
      ? { transaction: { effects: { events: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }
      : page([tx(2, [event(swap, { pool })], true)], false));
    const result = await read();
    expect(result.incomplete_transactions).toEqual(["digest2"]);
    expect(result.incomplete_note).toContain("get_transaction");
  });
});

describe("query_events object routing", () => {
  let handler: Function | undefined;
  registerEventTools({
    tool: (name: string, _description: string, _schema: unknown, fn: Function) => {
      if (name === "query_events") handler = fn;
    }
  } as never);

  it("applies checkpoint bounds in the transaction filter", async () => {
    query.mockResolvedValue(page([tx(2, [event(swap, { pool })])], false));
    const response = await handler!({ affected_object: pool, after_checkpoint: 1, before_checkpoint: 3, limit: 1 });
    const result = JSON.parse(response.content[0].text);
    expect(result.events[0]).toMatchObject({ tx_digest: "digest2", checkpoint: 2, names_object: true });
    expect(query.mock.calls.find(([document]) => typeof document === "string" && document.includes("transactions(filter:"))?.[1].filter)
      .toEqual({ affectedObject: pool, afterCheckpoint: 1, beforeCheckpoint: 3 });
  });

  it("refuses sender with affected_object before making a network read", async () => {
    query.mockReset();
    const response = await handler!({ affected_object: pool, sender: other, after_checkpoint: "2024-10-10T00:00:00Z" });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("cannot be combined");
    expect(query).not.toHaveBeenCalled();
  });
});
