import { beforeEach, describe, expect, it, vi } from "vitest";
import { readObjectEvents, typeMatches } from "../src/utils/object-events.js";
import { registerEventTools } from "../src/tools/events.js";
import type { GqlEventNode } from "../src/utils/tx-connections.js";

const { query, resolveType } = vi.hoisted(() => ({ query: vi.fn(), resolveType: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: query }));
vi.mock("../src/utils/package-versions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveEventTypeFilter: resolveType,
}));

const pool = `0x${"a".repeat(64)}`;
const other = `0x${"b".repeat(64)}`;
const swap = "0x2::pool::SwapEvent";
const deposit = "0x2::pool::DepositEvent";
const event = (type: string, json: unknown, module = "0x2::pool"): GqlEventNode => ({
  contents: { type: { repr: type }, json }, sender: { address: "0x1" },
  transactionModule: { fullyQualifiedName: module },
});

interface SimTx { digest: string; cp: number; events: GqlEventNode[]; more?: GqlEventNode[] }
const tx = (digest: string, cp: number, events: GqlEventNode[], more?: GqlEventNode[]): SimTx => ({ digest, cp, events, more });

/**
 * A transactions service over per-object lists in chain order. Edge cursors
 * are `object:index`; `cap` limits rows per read the way the service's
 * bounded reads do, and `hollow` makes every page claim another, so a read
 * after the last row answers with no rows and the cursor passed in.
 */
function chain(lists: Record<string, SimTx[]>, opts: { cap?: Record<string, number>; hollow?: boolean } = {}) {
  const continuation: Record<string, GqlEventNode[]> = {};
  for (const list of Object.values(lists)) for (const t of list) if (t.more) continuation[t.digest] = t.more;
  query.mockImplementation(async (document: string, vars: Record<string, unknown>) => {
    if (document.includes("transaction(digest:")) {
      const nodes = continuation[vars.digest as string];
      return { transaction: { effects: { events: nodes ? { nodes, pageInfo: { hasNextPage: false } } : { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } };
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(vars).filter((k) => /^f\d+$/.test(k))) {
      const k = key.slice(1);
      const filter = vars[key] as { affectedObject: string; afterCheckpoint?: number; beforeCheckpoint?: number };
      const rows = (lists[filter.affectedObject] ?? [])
        .map((t, index) => ({ t, index }))
        .filter(({ t }) => (filter.afterCheckpoint == null || t.cp > filter.afterCheckpoint) && (filter.beforeCheckpoint == null || t.cp < filter.beforeCheckpoint));
      const cursor = vars[`c${k}`] as string | undefined;
      const at = cursor ? Number(cursor.split(":")[1]) : undefined;
      const size = Math.min(vars.n as number, opts.cap?.[filter.affectedObject] ?? Infinity);
      const newest = document.includes("last: $n");
      const candidates = newest ? rows.filter((r) => at === undefined || r.index < at) : rows.filter((r) => at === undefined || r.index > at);
      const picked = newest ? candidates.slice(-size) : candidates.slice(0, size);
      const more = candidates.length > picked.length || !!opts.hollow;
      const edges = picked.map(({ t, index }) => ({
        cursor: `${filter.affectedObject}:${index}`,
        node: {
          digest: t.digest,
          effects: { timestamp: `2026-10-20T00:00:${String(t.cp).padStart(2, "0")}Z`, checkpoint: { sequenceNumber: t.cp }, events: { nodes: t.events, pageInfo: { hasNextPage: !!t.more, endCursor: t.more ? "e1" : null } } },
        },
      }));
      out[`o${k}`] = {
        edges,
        pageInfo: {
          hasPreviousPage: newest && more, hasNextPage: !newest && more,
          startCursor: edges[0]?.cursor ?? cursor ?? null, endCursor: edges.at(-1)?.cursor ?? cursor ?? null,
        },
      };
    }
    return out;
  });
}

const read = (args: Partial<Parameters<typeof readObjectEvents>[0]> = {}) => readObjectEvents({
  objects: [pool], filter: {}, module: null, order: "newest", limit: 20, ...args,
});
const n = (e: { data: unknown }) => (e.data && typeof e.data === "object" && "n" in e.data ? e.data.n : undefined);
async function walkAll(args: Partial<Parameters<typeof readObjectEvents>[0]>) {
  const out: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await read({ ...args, cursor });
    out.push(...r.events);
    if (!r.has_next_page) return out;
    cursor = r.next_cursor!;
  }
  throw new Error("walk did not end");
}

beforeEach(() => {
  query.mockReset();
  resolveType.mockReset();
});

describe("affected-object event listing", () => {
  it("returns complete decoded events newest first and marks nested object ids", async () => {
    chain({ [pool]: [tx("d1", 1, [event(deposit, { nested: { id: pool } })]), tx("d2", 2, [event(swap, { pool: other })], [event(swap, { pool })])] });
    const result = await read();
    expect(result.events.map((e) => [e.tx_digest, e.names_object, e.names_object_at])).toEqual([["d2", true, "pool"], ["d2", false, undefined], ["d1", true, "nested.id"]]);
    expect(result.has_next_page).toBe(false);
    const listing = query.mock.calls.find(([document]) => document.includes("o0: transactions("));
    expect(listing?.[0]).toContain("events(first: 50)");
    expect(listing?.[1].f0).toEqual({ affectedObject: pool });
  });

  for (const order of ["newest", "oldest"] as const) {
    it(`continues within a transaction without gaps or repeats (${order})`, async () => {
      chain({ [pool]: [tx("d1", 1, [event(swap, { pool, n: 0 })]), tx("d2", 2, [1, 2, 3].map((k) => event(swap, { pool, n: k })))] });
      const events = await walkAll({ order, limit: 2 });
      expect(events.map(n)).toEqual(order === "newest" ? [3, 2, 1, 0] : [0, 1, 2, 3]);
    });
  }

  it("pins a newest-first walk below the first page, so a transaction landing later cannot shift a split", async () => {
    const lists = { [pool]: [tx("d1", 1, [event(swap, { pool, n: 0 })]), tx("d2", 2, [1, 2, 3].map((k) => event(swap, { pool, n: k })))] };
    chain(lists);
    const first = await read({ limit: 2 });
    lists[pool].push(tx("d3", 3, [event(swap, { pool, n: 9 })]));
    const second = await read({ limit: 2, cursor: first.next_cursor! });
    expect([...first.events, ...second.events].map(n)).toEqual([3, 2, 1, 0]);
    expect(second.has_next_page).toBe(false);
    expect(query.mock.calls.at(-1)?.[1].f0.beforeCheckpoint).toBe(3);
  });

  it("ends the list on an empty read that hands back its own cursor, keeping what it read", async () => {
    chain({ [pool]: [tx("d1", 1, [event(swap, { pool })]), tx("d2", 2, [event(swap, { pool })])] }, { hollow: true, cap: { [pool]: 1 } });
    const result = await read({ order: "oldest", limit: 5 });
    expect(result.events.map((e) => e.tx_digest)).toEqual(["d1", "d2"]);
    expect(result.has_next_page).toBe(false);
  });

  it("leaves a transaction whose events cannot be completed for the next call unless it is the first read", async () => {
    // Twenty one-row reads spend the budget; the transaction after them needs
    // a continuation read the call can no longer make.
    const rows = Array.from({ length: 19 }, (_, i) => tx(`e${i}`, i + 1, []));
    rows.push(tx("big", 30, [event(swap, { pool, n: 1 })], [event(swap, { pool, n: 2 })]));
    chain({ [pool]: rows }, { cap: { [pool]: 1 } });
    const first = await read({ order: "oldest" });
    expect(first.events).toEqual([]);
    expect(first.incomplete_transactions).toBeUndefined();
    expect(first.has_next_page).toBe(true);
    const second = await read({ order: "oldest", cursor: first.next_cursor! });
    expect(second.events.map(n)).toEqual([1, 2]);
    expect(second.incomplete_transactions).toBeUndefined();
  });

  it("reports a first transaction whose event pages cannot be completed", async () => {
    chain({ [pool]: [tx("d2", 2, [event(swap, { pool })], undefined)] });
    query.mockImplementationOnce(async () => ({
      o0: {
        edges: [{ cursor: `${pool}:0`, node: { digest: "d2", effects: { checkpoint: { sequenceNumber: 2 }, events: { nodes: [event(swap, { pool })], pageInfo: { hasNextPage: true, endCursor: "e1" } } } } }],
        pageInfo: { hasPreviousPage: false, hasNextPage: false, startCursor: `${pool}:0`, endCursor: `${pool}:0` },
      },
    }));
    const result = await read();
    expect(result.incomplete_transactions).toEqual(["d2"]);
    expect(result.incomplete_note).toContain("get_transaction");
  });

  it("narrows by type, emitting module at the checkpoint, and names_object", async () => {
    chain({ [pool]: [tx("d2", 2, [event(swap, { pool }, "0x3::pool"), event(deposit, { pool }), event(swap, { pool }), event(swap, { pool: other })])] });
    const result = await read({ eventTypes: [swap], module: { segments: [{ filter: "0x2::pool", afterCheckpoint: 1, beforeCheckpoint: 3 }] } as never, namesObjectOnly: true });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: swap, emitting_module: "0x2::pool", names_object: true });
  });

  it("finds the real memez wrapper's nested pool field, including through names_object filtering", async () => {
    const memez = "0x779829966a2e8642c310bed79e6ba603e5acd3c31b25d7d4511e2c9303d6e3ef";
    const pump = `${memez}::memez_events_wrapper::Event<${memez}::memez_events::Pump>`;
    chain({
      [pool]: [tx("pump", 2, [
        event(pump, { pos0: { memez_fun: pool, meme: "ee13f7e784dea867688a0a29fc176b2279e645532af8ea4e812b89f374d7c12e::job::JOB", quote: "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI", quote_amount_in: "7952040000", meme_amount_out: "12139534316505221" } }),
        event(swap, { pool: other }),
      ])]
    });
    const result = await read({ namesObjectOnly: true });
    expect(result.events).toMatchObject([{ tx_digest: "pump", names_object: true, names_object_at: "pos0.memez_fun" }]);
    expect(result.has_next_page).toBe(false);
    const unfiltered = await read();
    expect(unfiltered.events).toHaveLength(2);
  });

  it("counts read and dropped events when none names the requested object", async () => {
    chain({ [pool]: [tx("d2", 2, [event(swap, { pool: other }), event(deposit, { id: other })])] });
    const result = await read({ namesObjectOnly: true });
    expect(result.events).toEqual([]);
    expect(result.no_results_hint).toMatch(/Read 2 events.*dropped 2/);
    expect(result.has_next_page).toBe(false);
  });

  it("matches ids inside arrays but does not search past the depth bound", async () => {
    chain({
      [pool]: [tx("d2", 2, [
        event(swap, { pools: [{ id: pool }] }),
        event(swap, { a: { b: { c: { d: { e: { f: { g: { h: { id: pool } } } } } } } } }),
      ])]
    });
    const result = await read({ namesObjectOnly: true });
    expect(result.events.map((e) => e.names_object_at)).toEqual(["pools.0.id"]);
  });

  it("does not treat a wide but shallow decoded event as an absent pool", async () => {
    chain({ [pool]: [tx("wide", 2, [event(swap, { values: [...Array(2_100).fill("other"), pool] })])] });
    const result = await read({ namesObjectOnly: true });
    expect(result.events.map((e) => e.names_object_at)).toEqual(["values.2100"]);
  });

  it("matches type arguments however their addresses are written, and any listed defining package", () => {
    const padded = `0x2::pool::SwapEvent<0x${"0".repeat(63)}2::sui::SUI>`;
    expect(typeMatches(padded, ["0x2::pool::SwapEvent<0x2::sui::SUI>"])).toBe(true);
    expect(typeMatches(padded, ["0x2::pool::SwapEvent<0x2::coin::COIN>"])).toBe(false);
    expect(typeMatches(padded, ["0x2::pool::SwapEvent"])).toBe(true);
    expect(typeMatches("0x9::pool::Other", ["0x2::pool", "0x9::pool"])).toBe(true);
    expect(typeMatches("0x9::vault::Other", ["0x2::pool", "0x9::pool"])).toBe(false);
  });

  it("refuses a cursor written for another object list", async () => {
    chain({ [pool]: [tx("d1", 1, [event(swap, { pool, n: 1 }), event(swap, { pool, n: 2 })])] });
    const first = await read({ limit: 1 });
    await expect(read({ objects: [other], limit: 1, cursor: first.next_cursor! })).rejects.toThrow("Invalid object-event cursor");
  });
});

describe("several objects", () => {
  const objects = [pool, other];

  it("lists a transaction affecting two objects once, with both refs and the named object", async () => {
    const shared = tx("s", 2, [event(swap, { pool: other })]);
    chain({ [pool]: [tx("a", 1, [event(swap, { pool })]), shared], [other]: [shared, tx("b", 3, [event(deposit, {})])] });
    const result = await read({ objects, order: "oldest" });
    expect(result.objects).toEqual(objects);
    expect(result.events.map((e) => [e.tx_digest, e.object_refs, e.named_object_ref])).toEqual([
      ["a", [0], 0], ["s", [0, 1], 1], ["b", [1], undefined],
    ]);
    expect(query.mock.calls.filter(([document]) => document.includes("o1: transactions(")).length).toBe(1);
  });

  for (const order of ["newest", "oldest"] as const) {
    it(`never repeats a shared transaction another object's position has not passed (${order})`, async () => {
      // In one checkpoint the second object lists x before the shared
      // transaction, while the merge places the first object's copy first.
      const shared = tx("s", 5, [event(swap, { pool, n: 1 })]);
      const x = tx("x", 5, [event(swap, { pool: other, n: 2 })]);
      chain({ [pool]: [tx("a", 4, [event(swap, { pool, n: 0 })]), shared], [other]: order === "oldest" ? [x, shared] : [shared, x] });
      for (const limit of [1, 2, 3]) {
        const events = await walkAll({ objects, order, limit });
        expect(events.map((e) => e.tx_digest).filter((d) => d === "s")).toHaveLength(1);
        expect(new Set(events.map((e) => e.tx_digest))).toEqual(new Set(["a", "s", "x"]));
      }
    });
  }

  it("reads on another object's page until it passes the checkpoint before listing a transaction", async () => {
    const shared = tx("s", 5, [event(swap, { pool })]);
    chain({ [pool]: [shared], [other]: [tx("y", 5, []), shared, tx("z", 6, [])] }, { cap: { [other]: 1 } });
    const events = await walkAll({ objects, order: "oldest" });
    expect(events.map((e) => [e.tx_digest, e.object_refs])).toEqual([["s", [0, 1]]]);
  });
});

describe("query_events object routing", () => {
  let handler: Function | undefined;
  registerEventTools({
    tool: (name: string, _description: string, _schema: unknown, fn: Function) => {
      if (name === "query_events") handler = fn;
    },
  } as never);

  it("applies checkpoint bounds in the transaction filter", async () => {
    chain({ [pool]: [tx("d2", 2, [event(swap, { pool })])] });
    const response = await handler!({ affected_object: [pool], after_checkpoint: 1, before_checkpoint: 3, limit: 1 });
    const result = JSON.parse(response.content[0].text);
    expect(result.events[0]).toMatchObject({ tx_digest: "d2", checkpoint: 2, names_object: true });
    expect(query.mock.calls.find(([document]) => document.includes("o0: transactions("))?.[1].f0)
      .toEqual({ affectedObject: pool, afterCheckpoint: 1, beforeCheckpoint: 3 });
  });

  it("selects the object's transactions a sender sent in the transaction filter", async () => {
    chain({ [pool]: [tx("d2", 2, [event(swap, { pool })])] });
    await handler!({ affected_object: [pool], sender: other, limit: 1 });
    expect(query.mock.calls.find(([document]) => document.includes("o0: transactions("))?.[1].f0)
      .toEqual({ affectedObject: pool, sentAddress: other });
  });

  it("refuses names_object without affected_object before any read", async () => {
    const alone = await handler!({ names_object: true });
    expect(alone.isError).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it("matches every package version defining the requested module's event types", async () => {
    resolveType.mockResolvedValue({
      filter: "0x2::pool",
      resolution: { requested: "0x2::pool", queried: "0x2::pool", note: "query the others", other_defining_packages: [`0x${"9".repeat(64)}`] },
    });
    chain({ [pool]: [tx("d1", 1, [event(swap, { pool }), event(`0x${"9".repeat(64)}::pool::Late`, { pool }), event("0x5::vault::Other", { pool })])] });
    const response = await handler!({ affected_object: [pool], event_type: "0x2::pool", order: "oldest" });
    const result = JSON.parse(response.content[0].text);
    expect(result.events.map((e: { type: string }) => e.type)).toEqual([swap, `0x${"9".repeat(64)}::pool::Late`]);
    expect(result.event_type_resolution.note).toContain("every one of them");
  });

  it("refuses an event_type that is not a Move type rather than matching nothing", async () => {
    resolveType.mockResolvedValue({ filter: "pool" });
    const response = await handler!({ affected_object: [pool], event_type: "pool" });
    expect(response.isError).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });
});
