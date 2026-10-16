import { beforeEach, describe, expect, it, vi } from "vitest";
import { gqlTx, searchPage, SUI, type HopSpec } from "./helpers/trace-shapes.js";
import type * as MovedValue from "../src/utils/moved-value.js";

/**
 * A small simulated chain of coin and object movements, read through the
 * same GraphQL, version-read and valuation boundaries the engine uses, for
 * scenarios that combine objects with coins: positions added to in place and
 * then handed over, objects returning to the start, objects redeemed at a
 * hub, and random worlds checked against the ledger invariants.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
const hubs = new Set<string>();
vi.mock("../src/utils/fanout.js", () => ({
 measureFanout: async (address: string) =>
  hubs.has(address)
   ? { classification: "hub", counterparty_count: 500, sender_count: 500, scanned_transactions: 200, truncated: false }
   : { classification: "narrow", counterparty_count: 1, sender_count: 1, scanned_transactions: 1, truncated: false },
}));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
vi.mock("../src/utils/recent-prices.js", () => ({ fetchRecentHistory: async () => ({ quotes: new Map(), unanswered: new Map(), outOfRange: [] }) }));
vi.mock("../src/utils/price-providers.js", () => ({
 pricesForRanking: async () => new Map(),
 pythApiKey: () => null,
 fetchDefiLlama: async (coins: string[]) => ({
  quotes: new Map(coins.filter((c) => c === SUI).map((c) => [c, { price: 1 }])),
  unanswered: new Set(),
  unsupported: new Set(),
 }),
}));
vi.mock("../src/utils/identity.js", () => ({ describeAddresses: async () => new Map(), identityNote: () => null }));

type Owner = string | { object: string };
interface Obj {
 id: string;
 /** Transferred, created (from null), deleted (to null); `kept` is a change in place at `from`. */
 from: Owner | null;
 to: Owner | null;
 kept?: true;
 /** Value moved, or for a kept object the signed change. Undefined: no price. */
 usd?: number;
 usd_after?: number;
}
interface WorldTx extends HopSpec {
 objs?: Obj[];
}

let world: WorldTx[] = [];
const TYPE = "0x0000000000000000000000000000000000000000000000000000000000000003::staking_pool::StakedSui";
const addr = (o: Owner | null) => (typeof o === "string" ? o : null);

function objectChanges(tx: WorldTx) {
 const state = (o: Owner | null) =>
  o === null
   ? null
   : {
    owner: typeof o === "string" ? { __typename: "AddressOwner", address: { address: o } } : { __typename: "ObjectOwner", address: { address: o.object } },
    asMoveObject: { contents: { type: { repr: TYPE } } },
   };
 return (tx.objs ?? []).map((o) => ({
  address: o.id,
  idCreated: !o.kept && o.from === null,
  idDeleted: !o.kept && o.to === null,
  inputState: state(o.from),
  outputState: state(o.kept ? o.from : o.to),
 }));
}

function movementsOf(tx: WorldTx) {
 const ref = (o: Owner | null) => (o === null ? null : typeof o === "string" ? { kind: "address", address: o } : { kind: "object", address: o.object });
 return (tx.objs ?? [])
  .filter((o) => !o.kept)
  .map((o) => ({
   object_id: o.id,
   type: TYPE,
   type_short: "staking_pool::StakedSui",
   kind: o.from === null ? "created" : o.to === null ? "deleted" : "transferred",
   category: "other",
   high_consequence: false,
   from: ref(o.from),
   to: ref(o.to),
  }));
}

function movedOf(tx: WorldTx) {
 return (tx.objs ?? []).map((o) =>
  o.kept
   ? { object_id: o.id, type: TYPE, from: addr(o.from), to: addr(o.from), version: "2", before_version: "1" }
   : { object_id: o.id, type: TYPE, from: addr(o.from), to: addr(o.to), version: "1" },
 );
}

function rowOf(tx: WorldTx, o: Obj) {
 return {
  object_id: o.id,
  type: TYPE,
  from: addr(o.from),
  to: addr(o.kept ? o.from : o.to),
  protocol: null,
  kind: "staked-sui",
  usd: o.usd ?? null,
  ...(o.usd === undefined ? { unpriced_reason: "no price" } : {}),
  ...(o.kept ? { changed_in_place: true as const, usd_after: o.usd_after ?? null } : {}),
  estimate: false,
  tier: "price-provider",
  method: "test",
 };
}

const txAt = (checkpoint: string | null) => world.find((t) => String(t.checkpoint) === checkpoint);

vi.mock("../src/utils/moved-value.js", async (original) => ({
 ...(await original<typeof MovedValue>()),
 readMovedObjects: async (digests: string[]) => ({
  txs: digests
   .map((d) => world.find((t) => t.digest === d))
   .filter((t): t is WorldTx => t !== undefined)
   .map((t) => ({ digest: t.digest, checkpoint: String(t.checkpoint), moved: movedOf(t), movements: movementsOf(t) })),
  unread: [],
 }),
 valueMovedObjects: async (moved: Array<{ object_id: string; from: string | null; to: string | null }>, checkpoint: string | null) => {
  const tx = txAt(checkpoint)!;
  return { rows: moved.map((m) => rowOf(tx, tx.objs!.find((o) => o.id === m.object_id)!)), unread: [] };
 },
 valueTransactionObjects: async (txs: Array<{ digest: string }>) => ({
  rows: txs.flatMap(({ digest }) => {
   const tx = world.find((t) => t.digest === digest)!;
   return (tx.objs ?? []).map((o) => ({ ...rowOf(tx, o), digest }));
  }),
  unread: [],
  skipped: [],
 }),
}));

const { FlowEngine } = await import("../src/utils/flow-engine.js");
const { registerFlowGraphTools } = await import("../src/tools/flow-graph.js");
const options = { direction: "forward" as const, coin: null, maxDepth: 6, maxNodes: 60, minShare: 0, minUsd: null, window: {}, maxTxReads: 200 };

const A = `0xa1${"1".repeat(62)}`;
const B = `0xb2${"2".repeat(62)}`;
const C = `0xc3${"3".repeat(62)}`;
const D = `0xd4${"4".repeat(62)}`;
const P = `0x${"9".repeat(63)}1`;
const Q = `0x${"9".repeat(63)}2`;
const KIOSK = `0xe5${"5".repeat(62)}`;
const sui = (n: number) => `${Math.round(n * 1e9)}`;

const touches = (t: WorldTx, id: string) => (t.objs ?? []).some((o) => o.id === id);
const inBounds = (t: WorldTx, vars: Record<string, unknown>) =>
 (typeof vars.afterCheckpoint !== "number" || (t.checkpoint ?? 100) > vars.afterCheckpoint) &&
 (typeof vars.beforeCheckpoint !== "number" || (t.checkpoint ?? 100) < vars.beforeCheckpoint);

function digestPage(list: WorldTx[], query: string) {
 const sorted = [...list].sort((a, b) => (a.checkpoint ?? 0) - (b.checkpoint ?? 0));
 return {
  transactions: {
   nodes: sorted.map((t) => ({ digest: t.digest })),
   pageInfo: query.includes("last:") ? { hasPreviousPage: false, startCursor: null } : { hasNextPage: false, endCursor: null },
  },
 };
}

beforeEach(() => {
 hubs.clear();
 mockGqlQuery.mockReset();
 mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
  if (query.includes("transactions(")) {
   if (query.includes("affectedObject: $id")) return digestPage(world.filter((t) => touches(t, String(vars.id)) && inBounds(t, vars)), query);
   if (query.includes("sentAddress: $id")) return digestPage(world.filter((t) => t.sender === vars.id && inBounds(t, vars)), query);
   if (query.includes("affectedAddress: $id")) {
    const id = String(vars.id);
    return digestPage(
     world.filter((t) => inBounds(t, vars) && (t.sender === id || t.changes.some(([a]) => a === id) || (t.objs ?? []).some((o) => o.from === id || o.to === id))),
     query,
    );
   }
   return searchPage(world, query, vars);
  }
  const tx = world.find((t) => t.digest === vars.digest);
  if (!tx) return { transaction: null };
  if (query.includes("json")) return { transaction: { effects: { events: { nodes: [], pageInfo: { hasNextPage: false } } } } };
  const data = gqlTx(tx);
  data.transaction.effects.objectChanges.nodes = objectChanges(tx) as never;
  return data;
 });
});

function ledger(graph: InstanceType<typeof FlowEngine>) {
 const out: Record<string, number> = {};
 for (const g of graph.ledger.summary()) out[g.code] = (out[g.code] ?? 0) + g.share;
 return out;
}

describe("objects in a simulated world", () => {
 it("counts a position the start address added to in place and then handed over once, on the object", async () => {
  world = [
   { digest: "open", sender: A, checkpoint: 10, changes: [[A, sui(-100)]], objs: [{ id: P, from: null, to: A, usd: 100 }] },
   { digest: "add", sender: A, checkpoint: 11, changes: [[A, sui(-50)]], objs: [{ id: P, from: A, to: A, kept: true, usd: 50, usd_after: 150 }] },
   { digest: "give", sender: A, checkpoint: 12, changes: [], objs: [{ id: P, from: A, to: B, usd: 150 }] },
  ];
  const graph = new FlowEngine(options);
  graph.startFromAddress(A);
  await graph.run();
  const l = ledger(graph);
  expect(graph.ledger.total()).toBeCloseTo(1);
  expect([...graph.edges.values()].find((e) => e.object_id === P)?.share).toBeCloseTo(1);
  expect(l.consumed ?? 0).toBeCloseTo(0);
 });

 it("never carves more from the legs that fed an object than it was worth when handed over", async () => {
  world = [
   { digest: "open", sender: A, checkpoint: 10, changes: [[A, sui(-100)]], objs: [{ id: P, from: null, to: A, usd: 100 }] },
   { digest: "add", sender: A, checkpoint: 11, changes: [[A, sui(-50)]], objs: [{ id: P, from: A, to: A, kept: true, usd: 50, usd_after: 150 }] },
   { digest: "give", sender: A, checkpoint: 12, changes: [], objs: [{ id: P, from: A, to: B, usd: 120 }] },
  ];
  const graph = new FlowEngine(options);
  graph.startFromAddress(A);
  await graph.run();
  expect(graph.ledger.total()).toBeCloseTo(1);
  expect([...graph.edges.values()].find((e) => e.object_id === P)?.share).toBeCloseTo(0.8);
  expect(ledger(graph).consumed ?? 0).toBeCloseTo(0.2);
 });

 it("follows a stake an address start created for another address in one transaction, counted once", async () => {
  world = [
   { digest: "gift", sender: A, checkpoint: 10, changes: [[A, sui(-100)]], objs: [{ id: P, from: null, to: B, usd: 100 }] },
   { digest: "pay", sender: A, checkpoint: 11, changes: [[A, sui(-50)], [C, sui(50)]] },
  ];
  const graph = new FlowEngine(options);
  graph.startFromAddress(A);
  await graph.run();
  expect(graph.ledger.total()).toBeCloseTo(1);
  const edges = [...graph.edges.values()];
  expect(edges.find((e) => e.object_id === P && e.to.startsWith(B))?.share).toBeCloseTo(2 / 3);
  expect(edges.find((e) => e.to.startsWith(C))?.share).toBeCloseTo(1 / 3);
  expect(ledger(graph).consumed ?? 0).toBeCloseTo(0);
 });

 it("names the object of a branch pruned below min_share", async () => {
  world = [{ digest: "give", sender: A, checkpoint: 10, changes: [[A, sui(-10)], [C, sui(10)]], objs: [{ id: P, from: A, to: B, usd: 5 }] }];
  const graph = new FlowEngine({ ...options, minShare: 0.5 });
  await graph.startFromDigest("give");
  await graph.run();
  expect(graph.pruned.find((p) => p.address === B)).toMatchObject({ object_id: P, object_type: TYPE });
  expect(graph.ledger.total()).toBeCloseTo(1);
 });

 it("checks a hub before following an object's redemption proceeds", async () => {
  hubs.add(B);
  world = [
   { digest: "give", sender: A, checkpoint: 10, changes: [], objs: [{ id: P, from: A, to: B, usd: 100 }] },
   { digest: "redeem", sender: B, checkpoint: 11, changes: [[B, sui(100)]], objs: [{ id: P, from: B, to: null, usd: 100 }] },
   { digest: "pay", sender: B, checkpoint: 12, changes: [[B, sui(-100)], [C, sui(100)]] },
  ];
  const graph = new FlowEngine(options);
  await graph.startFromDigest("give");
  await graph.run();
  expect(graph.ledger.total()).toBeCloseTo(1);
  // B pools other people's coins: the proceeds stop there, never reach C by FIFO.
  expect([...graph.edges.values()].some((e) => e.to.startsWith(C))).toBe(false);
  expect(ledger(graph).hub ?? 0).toBeCloseTo(1);
 });

 it("ends an object returning to the start address as a cycle, with whole shares", async () => {
  world = [
   { digest: "give", sender: A, checkpoint: 10, changes: [], objs: [{ id: P, from: A, to: B, usd: 100 }] },
   { digest: "back", sender: B, checkpoint: 11, changes: [], objs: [{ id: P, from: B, to: A, usd: 100 }] },
   { digest: "again", sender: A, checkpoint: 12, changes: [], objs: [{ id: P, from: A, to: C, usd: 100 }] },
  ];
  const graph = new FlowEngine(options);
  graph.startFromAddress(A);
  await graph.run();
  expect(graph.ledger.total()).toBeCloseTo(1);
  expect(ledger(graph).cycle ?? 0).toBeCloseTo(0.5);
  for (const e of graph.edges.values()) expect(e.traced <= e.amount).toBe(true);
 });

 it("splits a backward start between an object given up and the coins paid in", async () => {
  world = [
   { digest: "open", sender: A, checkpoint: 10, changes: [[A, sui(-100)]], objs: [{ id: P, from: null, to: A, usd: 100 }] },
   { digest: "add", sender: A, checkpoint: 11, changes: [[A, sui(-50)]], objs: [{ id: P, from: A, to: A, kept: true, usd: 50, usd_after: 150 }] },
   { digest: "give", sender: A, checkpoint: 12, changes: [], objs: [{ id: P, from: A, to: B, usd: 150 }] },
   { digest: "sell", sender: B, checkpoint: 13, changes: [[B, sui(-50)], [D, sui(50)]], objs: [{ id: P, from: B, to: D, usd: 150 }] },
  ];
  const graph = new FlowEngine({ ...options, direction: "backward" });
  await graph.startFromDigest("sell");
  await graph.run();
  expect(graph.ledger.total()).toBeCloseTo(1);
  const l = ledger(graph);
  // 150 of object and 50 of coin paid in; the object came from A's 100 + 50.
  expect(l.source ?? 0).toBeCloseTo(1);
  for (const e of graph.edges.values()) expect(e.traced <= e.amount).toBe(true);
 });

 it("keeps whole, conserved shares over random worlds of coins and objects", async () => {
  let seed = 11;
  const rand = (n: number) => {
   seed = (seed * 1103515245 + 12345) % 2 ** 31;
   // The low bits of this generator cycle with a short period.
   return Math.floor(seed / 65536) % n;
  };
  const parties = [A, B, C, D];
  let objectEdges = 0;
  for (let run = 0; run < 120; run++) {
   // Each object: created by a party from its coins, then moved about, sometimes redeemed or put in a kiosk.
   world = [];
   let cp = 10;
   const holder = new Map<string, Owner | null>();
   const value = new Map<string, number>();
   for (const id of [P, Q].slice(0, 1 + rand(2))) {
    const owner = parties[rand(4)];
    const v = 1 + rand(500);
    world.push({ digest: `open-${id.slice(-1)}-${run}`, sender: owner, checkpoint: cp++, changes: [[owner, sui(-v)]], objs: [{ id, from: null, to: owner, usd: v }] });
    holder.set(id, owner);
    value.set(id, v);
   }
   for (let step = 0; step < 6; step++) {
    const ids = [...holder.keys()].filter((id) => typeof holder.get(id) === "string");
    const id = ids[rand(Math.max(1, ids.length))];
    const h = id ? (holder.get(id) as string) : parties[rand(4)];
    const action = id ? rand(7) : 5;
    const v = id ? value.get(id)! : 0;
    const digest = `s${step}-${run}`;
    if (action <= 1) {
     const to = parties[rand(4)];
     if (to === h) continue;
     world.push({ digest, sender: h, checkpoint: cp++, changes: rand(2) ? [[h, sui(-5)], [to, sui(5)]] : [], objs: [{ id, from: h, to, usd: v }] });
     holder.set(id, to);
    } else if (action === 2) {
     const pay = parties[rand(4)];
     world.push({ digest, sender: h, checkpoint: cp++, changes: pay === h ? [[h, sui(v)]] : [[h, sui(v / 2)], [pay, sui(v / 2)]], objs: [{ id, from: h, to: null, usd: v }] });
     holder.delete(id);
    } else if (action === 3) {
     const drawn = Math.max(1, Math.floor(v / 3));
     world.push({ digest, sender: h, checkpoint: cp++, changes: [[h, sui(drawn)]], objs: [{ id, from: h, to: h, kept: true, usd: -drawn, usd_after: v - drawn }] });
     value.set(id, v - drawn);
    } else if (action === 4) {
     world.push({ digest, sender: h, checkpoint: cp++, changes: [], objs: [{ id, from: h, to: { object: KIOSK }, usd: v }] });
     holder.set(id, { object: KIOSK });
    } else if (action === 6) {
     const added = 1 + rand(200);
     world.push({ digest, sender: h, checkpoint: cp++, changes: [[h, sui(-added)]], objs: [{ id, from: h, to: h, kept: true, usd: added, usd_after: v + added }] });
     value.set(id, v + added);
    } else {
     const to = parties[rand(4)];
     if (to === h) continue;
     world.push({ digest, sender: h, checkpoint: cp++, changes: [[h, sui(-(1 + rand(50)))], [to, sui(1 + rand(50))]] });
    }
   }
   const start = world[rand(world.length)];
   const subject = parties[rand(4)];
   for (const [direction, from] of [["forward", "tx"], ["backward", "tx"], ["forward", "address"], ["backward", "address"]] as const) {
    const label = JSON.stringify({ run, direction, from, subject: subject.slice(0, 4), start: start.digest, world: world.map((t) => [t.digest, t.sender.slice(0, 4), t.changes.map(([a, v]) => [a.slice(0, 4), v]), t.objs?.map((o) => [o.id.slice(-1), typeof o.from === "string" ? o.from.slice(0, 4) : o.from, typeof o.to === "string" ? o.to.slice(0, 4) : o.to, o.usd])]) });
    const graph = new FlowEngine({ ...options, direction });
    if (from === "tx") await graph.startFromDigest(start.digest);
    else graph.startFromAddress(subject);
    await graph.run();
    const edges = [...graph.edges.values()];
    objectEdges += edges.filter((e) => e.object_id).length;
    if (graph.ledger.summary().length > 0) expect(graph.ledger.total(), label).toBeCloseTo(1, 6);
    for (const e of edges) {
     expect(e.traced <= e.amount, label).toBe(true);
     expect(e.share, label).toBeLessThanOrEqual(1 + 1e-9);
    }
    // Conservation at every expanded node: what arrives leaves as edges or ends there.
    const terminals = graph.ledger.summary().flatMap((g) => g.entries);
    for (const n of graph.nodes.values()) {
     if (n.kind !== "address" || !n.expanded) continue;
     // A root has no edge in: what arrives is its share.
     const into = edges.filter((e) => (direction === "forward" ? e.to : e.from) === n.id).reduce((s, e) => s + e.share, 0) || n.share;
     const out = edges.filter((e) => (direction === "forward" ? e.from : e.to) === n.id).reduce((s, e) => s + e.share, 0);
     const ended = terminals.filter((x) => x.node === n.id).reduce((s, x) => s + x.share, 0);
     expect(out + ended, `${label} node ${n.id}`).toBeCloseTo(into, 6);
    }
   }
  }
  expect(objectEdges).toBeGreaterThan(100);
 });

 it("finds a path through an object handover and its redemption", async () => {
  world = [
   { digest: "give", sender: A, checkpoint: 10, changes: [], objs: [{ id: P, from: A, to: B, usd: 100 }] },
   { digest: "redeem", sender: B, checkpoint: 11, changes: [[B, sui(100)]], objs: [{ id: P, from: B, to: null, usd: 100 }] },
   { digest: "pay", sender: B, checkpoint: 12, changes: [[B, sui(-100)], [C, sui(100)]] },
  ];
  type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  let findFlowPath!: Handler;
  registerFlowGraphTools({
   tool: (name: string, _d: string, _s: unknown, h: Handler) => {
    if (name === "find_flow_path") findFlowPath = h;
   },
  } as never);
  const r = await findFlowPath({ from: A, to: C });
  const json = JSON.parse(r.content.map((c) => c.text).find((t) => t.trim().startsWith("{"))!);
  expect(json.paths?.length, JSON.stringify(json).slice(0, 2000)).toBeGreaterThan(0);
  const steps = json.paths[0].steps;
  expect(steps[0]).toMatchObject({ object_id: P, digests: ["give"] });
  expect(steps.at(-1).to).toBe(C);
 });
});
