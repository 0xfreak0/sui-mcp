import { beforeEach, describe, expect, it, vi } from "vitest";
import { candidates, gqlTx, SUI, type HopSpec } from "./helpers/trace-shapes.js";
import type * as MovedValue from "../src/utils/moved-value.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/fanout.js", () => ({ measureFanout: async () => ({ classification: "narrow", counterparty_count: 1, scanned_transactions: 1, truncated: false }) }));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
vi.mock("../src/utils/recent-prices.js", () => ({ fetchRecentHistory: async () => ({ quotes: new Map(), unanswered: new Map(), outOfRange: [] }) }));
vi.mock("../src/utils/price-providers.js", () => ({
 pricesForRanking: async () => new Map(), pythApiKey: () => null,
 fetchDefiLlama: async (coins: string[]) => ({
  quotes: new Map(coins.filter((c) => c === SUI).map((c) => [c, { price: 1 }])),
  unanswered: new Set(), unsupported: new Set(),
 }),
}));

const A = `0xa1${"1".repeat(62)}`;
const B = `0xb2${"2".repeat(62)}`;
const C = `0xc3${"3".repeat(62)}`;
const D = `0xd4${"4".repeat(62)}`;
const STAKE = "0x0000000000000000000000000000000000000000000000000000000000000003::staking_pool::StakedSui";
const stakeId = (i: number) => `0x${i.toString(16).padStart(64, "0")}`;
let values: Array<{ object_id: string; usd: number | null }> = [];
const origin: HopSpec = { digest: "origin", sender: A, checkpoint: 1000, changes: [[D, "1000000000000"]] };
const redeem: HopSpec = { digest: "redeem", sender: B, checkpoint: 1001, changes: [[B, "1000000000000"]] };
const spend: HopSpec = { digest: "spend", sender: B, checkpoint: 1002, changes: [[B, "-1000000000000"], [C, "1000000000000"]] };

const rows = (digest: string) => values.map(({ object_id, usd }) => ({
 object_id, type: STAKE, from: digest === "origin" ? A : B,
 to: digest === "origin" ? B : null, protocol: null, kind: "staked-sui",
 usd, estimate: false, tier: "price-provider", method: "stake exchange rate at checkpoint",
}));
const mockReadMovedObjects = vi.fn(async (digests: string[]) => ({
 txs: digests.filter((d) => d === "origin" || d === "redeem").map((digest) => ({
  digest, checkpoint: digest === "origin" ? "1000" : "1001",
  moved: values.map(({ object_id }) => ({ object_id, type: STAKE, from: digest === "origin" ? A : B, to: digest === "origin" ? B : null })),
 })), unread: [],
}));
const mockValueMovedObjects = vi.fn(async (moved: Array<{ from: string }>) => ({ rows: rows(moved[0]?.from === A ? "origin" : "redeem"), unread: [] }));
const mockValueTransactionObjects = vi.fn(async (txs: Array<{ digest: string }>) => ({
 rows: txs.flatMap(({ digest }) => rows(digest).map((row) => ({ ...row, digest }))), unread: [], skipped: [],
}));
vi.mock("../src/utils/moved-value.js", async (original) => ({
 ...await original<typeof MovedValue>(),
 readMovedObjects: mockReadMovedObjects,
 valueMovedObjects: mockValueMovedObjects,
 valueTransactionObjects: mockValueTransactionObjects,
}));
// Imports follow the hoisted mocks so this test exercises mocked chain and valuation boundaries.
const { FlowEngine } = await import("../src/utils/flow-engine.js");
const { objectOriginWeights } = await import("../src/utils/flow-graph.js");
const options = { direction: "forward" as const, coin: null, maxDepth: 4, maxNodes: 40, minShare: 0, minUsd: null, window: {}, maxTxReads: 100 };

function changed(id: string, from: string, to: string | null) {
 const state = (address: string) => ({
  owner: { __typename: "AddressOwner", address: { address } },
  asMoveObject: { contents: { type: { repr: STAKE } } },
 });
 return {
  address: id, idCreated: false, idDeleted: to === null,
  inputState: state(from), outputState: to === null ? null : state(to),
 };
}

beforeEach(() => {
 values = [{ object_id: stakeId(1), usd: 1000 }];
 mockGqlQuery.mockReset();
 mockReadMovedObjects.mockClear();
 mockValueMovedObjects.mockClear();
 mockValueTransactionObjects.mockClear();
 mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
  if (query.includes("transactions(")) {
   if (query.includes("affectedObject:")) return {
    transactions: { nodes: [origin, redeem].map(({ digest }) => ({ digest })), pageInfo: { hasNextPage: false, endCursor: null } },
   };
   // The address-start object scan: `sentAddress` forward, `affectedAddress` backward.
   if (query.includes("affectedAddress: $id") || query.includes("sentAddress: $id")) return {
    transactions: { nodes: [{ digest: origin.digest }], pageInfo: { hasNextPage: false, endCursor: null } },
   };
   if (query.includes("sentAddress")) return candidates(
    vars.address === B ? [redeem, spend] : vars.address === A && origin.changes.some(([a, v]) => a === A && v.startsWith("-")) ? [origin] : [],
    query.includes("last:") ? "backward" : "forward",
   );
   return candidates([], query.includes("last:") ? "backward" : "forward");
  }
  const hop = [origin, redeem, spend].find((t) => t.digest === vars.digest);
  if (!hop) return { transaction: null };
  if (query.includes("json")) return { transaction: { effects: { events: { nodes: [], pageInfo: { hasNextPage: false } } } } };
  const data = gqlTx(hop);
  data.transaction.effects.objectChanges.nodes = (hop === origin || hop === redeem)
   ? values.map(({ object_id }) => changed(object_id, hop === origin ? A : B, hop === origin ? B : null))
   : [];
  return data;
 });
});

describe("valued object flow", () => {
 it("follows transferred StakedSui through unstaking and a coin payment", async () => {
  const graph = new FlowEngine(options);
  await graph.startFromDigest(origin.digest);
  await graph.run();
  const transfers = [...graph.edges.values()].filter((e) => e.object_id);
  expect(transfers).toHaveLength(1);
  expect(transfers[0]).toMatchObject({ object_id: stakeId(1), object_type: STAKE, amount: 1n, traced: 1n, usd: 1000, share: 0.5 });
  expect([...graph.edges.values()].some((e) => e.basis === "conversion" && e.to.includes(SUI))).toBe(true);
  expect([...graph.edges.values()].some((e) => e.to.startsWith(C))).toBe(true);
  expect(graph.ledger.total()).toBeCloseTo(1);
  for (const e of graph.edges.values()) expect(e.traced <= e.amount).toBe(true);
 });

 it("starts from an object-only address history without requiring a coin spend", async () => {
  origin.changes = [];
  const graph = new FlowEngine(options);
  graph.startFromAddress(A);
  await graph.run();
  expect([...graph.edges.values()].some((e) => e.object_id === stakeId(1) && e.from.startsWith(A) && e.to.startsWith(B))).toBe(true);
  expect(graph.ledger.total()).toBeCloseTo(1);
  origin.changes = [[D, "1000000000000"]];
 });

 it("allocates an address root between object handovers and coin payouts", async () => {
  origin.changes = [[A, "-1000000000000"], [D, "1000000000000"]];
  const graph = new FlowEngine(options);
  graph.startFromAddress(A);
  await graph.run();
  expect([...graph.edges.values()].find((e) => e.object_id === stakeId(1))?.share).toBeCloseTo(0.5);
  expect([...graph.edges.values()].find((e) => e.to.startsWith(D) && e.coin_type === SUI)?.share).toBeCloseTo(0.5);
  expect(graph.ledger.total()).toBeCloseTo(1);
  for (const e of graph.edges.values()) expect(e.traced <= e.amount).toBe(true);
  origin.changes = [[D, "1000000000000"]];
 });

 it("lists an object without a price without allocating it a zero-valued share", async () => {
  values = [{ object_id: stakeId(1), usd: 1000 }, { object_id: stakeId(2), usd: null }];
  const graph = new FlowEngine(options);
  await graph.startFromDigest(origin.digest);
  await graph.run();
  expect(graph.unvaluedObjects).toEqual(expect.arrayContaining([expect.objectContaining({ object_id: stakeId(2) })]));
  expect([...graph.edges.values()].some((e) => e.object_id === stakeId(2))).toBe(false);
  expect([...graph.edges.values()].find((e) => e.object_id === stakeId(1))?.share).toBeCloseTo(0.5);
  expect(graph.ledger.total()).toBeCloseTo(1);
 });

 it("allocates mixed object and coin starts without losing or multiplying a share", async () => {
  for (let size = 1; size <= 8; size++) {
   values = Array.from({ length: size }, (_, i) => ({ object_id: stakeId(i + 1), usd: (i + 1) * 125 }));
   const weights = objectOriginWeights([{ amount: 1000000000000n, coin_type: SUI }], values, () => 1000);
   expect(weights.coins.reduce((sum, v) => sum + v, 0) + weights.objects.reduce((sum, v) => sum + v, 0)).toBeCloseTo(1);
   const graph = new FlowEngine(options);
   await graph.startFromDigest(origin.digest);
   await graph.run();
   expect([...graph.edges.values()].filter((e) => e.object_id)).toHaveLength(size);
   expect(graph.ledger.total()).toBeCloseTo(1);
   for (const e of graph.edges.values()) expect(e.traced <= e.amount).toBe(true);
  }
 });

 it("keeps shares whole and conserved at object nodes over random stakes, prices and proceeds", async () => {
  let seed = 7;
  const rand = (n: number) => {
   seed = (seed * 1103515245 + 12345) % 2 ** 31;
   return seed % n;
  };
  const sui = (n: number) => `${n}000000000`;
  for (let run = 0; run < 150; run++) {
   const size = 1 + rand(6);
   values = Array.from({ length: size }, (_, i) => ({ object_id: stakeId(i + 1), usd: [null, 0][rand(4)] ?? 1 + rand(2000) }));
   const coin = rand(3) === 0 ? 0 : 1 + rand(2000);
   const proceeds = rand(4) === 0 ? 0 : 1 + rand(3000);
   origin.changes = coin ? [[D, sui(coin)]] : [];
   redeem.changes = proceeds ? [[B, sui(proceeds)]] : [];
   const graph = new FlowEngine(options);
   await graph.startFromDigest(origin.digest);
   await graph.run();
   const edges = [...graph.edges.values()];
   const priced = values.filter((v) => v.usd !== null && v.usd > 0);
   const label = JSON.stringify({ run, values, coin, proceeds });
   expect(graph.unvaluedObjects.map((u) => u.object_id).sort(), label).toEqual(values.filter((v) => v.usd === null).map((v) => v.object_id).sort());
   const handovers = edges.filter((e) => e.object_id && e.from === "tx:origin");
   expect(handovers.map((e) => e.object_id).sort(), label).toEqual(priced.map((v) => v.object_id).sort());
   const total = priced.reduce((s, v) => s + v.usd!, 0) + coin;
   for (const e of handovers) expect(e.share, label).toBeCloseTo(values.find((v) => v.object_id === e.object_id)!.usd! / total);
   for (const e of edges) {
    expect(e.traced <= e.amount, label).toBe(true);
    if (e.object_id) expect(e.amount, label).toBe(BigInt(e.digests.length));
   }
   // What arrives at an object node leaves it as coin edges or ends there.
   for (const h of handovers) {
    const out = edges.filter((e) => e.from === h.to).reduce((s, e) => s + e.share, 0);
    const ended = graph.ledger.summary().flatMap((g) => g.entries).filter((x) => x.node === h.to).reduce((s, x) => s + x.share, 0);
    expect(out + ended, label).toBeCloseTo(h.share);
   }
   if (priced.length > 0 || coin > 0 || values.some((v) => v.usd === null)) expect(graph.ledger.total(), label).toBeCloseTo(1);
  }
  origin.changes = [[D, "1000000000000"]];
  redeem.changes = [[B, "1000000000000"]];
 });

 it("passes a value drawn from a held position in place to the coins it paid, and keeps the rest on the object", async () => {
  const draw: HopSpec = { digest: "draw", sender: B, checkpoint: 1001, changes: [[B, "600000000000"]] };
  const base = mockGqlQuery.getMockImplementation()!;
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
   if (query.includes("affectedObject:")) return { transactions: { nodes: [{ digest: "origin" }, { digest: "draw" }], pageInfo: { hasNextPage: false, endCursor: null } } };
   if (!query.includes("transactions(") && vars.digest === "draw") return gqlTx(draw);
   return base(query, vars);
  });
  mockReadMovedObjects.mockImplementationOnce(async (digests: string[]) => ({
   txs: digests.map((digest) => ({ digest, checkpoint: "1000", moved: [{ object_id: stakeId(1), type: STAKE, from: A, to: B }] })), unread: [],
  })).mockImplementationOnce(async () => ({
   txs: [{ digest: "draw", checkpoint: "1001", moved: [{ object_id: stakeId(1), type: STAKE, from: B, to: B }] }], unread: [],
  }));
  mockValueMovedObjects.mockImplementationOnce(async () => ({ rows: rows("origin"), unread: [] })).mockImplementationOnce(async () => ({
   rows: [{ ...rows("redeem")[0], to: B, changed_in_place: true, usd: -600, usd_after: 400 }], unread: [],
  }));
  const graph = new FlowEngine(options);
  await graph.startFromDigest(origin.digest);
  await graph.run();
  const drawn = [...graph.edges.values()].find((e) => e.basis === "conversion" && e.digests.includes("draw"));
  expect(drawn?.share).toBeCloseTo(0.3);
  expect(drawn!.traced).toBe(600000000000n);
  const held = graph.ledger.summary().find((g) => g.code === "unspent")?.entries.find((e) => e.node.includes("|object:"));
  expect(held?.share).toBeCloseTo(0.2);
  expect(graph.ledger.total()).toBeCloseTo(1);
  for (const e of graph.edges.values()) expect(e.traced <= e.amount).toBe(true);
 });

 it("starts an object branch at a stake created for another address, and none at one created for the sender", async () => {
  for (const [to, followed] of [[B, true], [A, false]] as const) {
   mockValueMovedObjects.mockImplementationOnce(async () => ({ rows: [{ ...rows("origin")[0], from: null, to }], unread: [] }));
   const graph = new FlowEngine(options);
   await graph.startFromDigest(origin.digest);
   await graph.run();
   expect([...graph.edges.values()].some((e) => e.object_id === stakeId(1) && e.from === "tx:origin"), to).toBe(followed);
   expect(graph.ledger.total()).toBeCloseTo(1);
  }
 });

 it("ends an object branch that moves into a kiosk as unread rather than as a redemption", async () => {
  const kiosk = `0xe5${"5".repeat(62)}`;
  mockReadMovedObjects.mockImplementationOnce(async (digests: string[]) => ({
   txs: digests.map((digest) => ({ digest, checkpoint: "1000", moved: [{ object_id: stakeId(1), type: STAKE, from: A, to: B }] })), unread: [],
  })).mockImplementationOnce(async () => ({
   txs: [{
    digest: "redeem", checkpoint: "1001", moved: [{ object_id: stakeId(1), type: STAKE, from: B, to: null }],
    movements: [{ object_id: stakeId(1), type: STAKE, kind: "transferred", category: "other", from: { kind: "address", address: B }, to: { kind: "object", address: kiosk } }],
   }], unread: [],
  }));
  const graph = new FlowEngine(options);
  await graph.startFromDigest(origin.digest);
  await graph.run();
  expect([...graph.edges.values()].some((e) => e.basis === "conversion")).toBe(false);
  const unread = graph.ledger.summary().find((g) => g.code === "read_failed")?.entries ?? [];
  expect(unread.some((e) => e.detail?.includes(`object ${kiosk}`))).toBe(true);
  expect(graph.truncated).toBe(true);
  expect(graph.ledger.total()).toBeCloseTo(1);
 });

 it("counts a stake the address created from its coins and then handed over once, on the object", async () => {
  const stake: HopSpec = {
   digest: "stake", sender: A, checkpoint: 999, changes: [[A, "-1000000000000"]],
   objects: [{ id: stakeId(1), type: STAKE, owner: A }],
  };
  origin.changes = [];
  const base = mockGqlQuery.getMockImplementation()!;
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
   if (query.includes("transactions(") && query.includes("sentAddress") && !query.includes("sentAddress: $id") && vars.address === A) return candidates([stake]);
   if (!query.includes("transactions(") && vars.digest === "stake") return gqlTx(stake);
   return base(query, vars);
  });
  const graph = new FlowEngine(options);
  graph.startFromAddress(A);
  await graph.run();
  expect([...graph.edges.values()].find((e) => e.object_id === stakeId(1))?.share).toBeCloseTo(1);
  expect(graph.ledger.summary().find((g) => g.code === "consumed")?.share ?? 0).toBeCloseTo(0);
  expect(graph.ledger.total()).toBeCloseTo(1);
  origin.changes = [[D, "1000000000000"]];
 });

 it("lists an address start's unvalued objects only in the traced direction", async () => {
  origin.changes = [];
  const movement = (id: string, from: string, to: string) => ({
   object_id: id, type: "0x9::spam::NFT", type_short: "spam::NFT", kind: "transferred", category: "other", high_consequence: false,
   from: { kind: "address", address: from }, to: { kind: "address", address: to },
  });
  mockReadMovedObjects.mockImplementationOnce(async () => ({
   txs: [{ digest: "origin", checkpoint: "1000", moved: [], movements: [movement(stakeId(7), D, A), movement(stakeId(8), A, D)] }], unread: [],
  }));
  const graph = new FlowEngine(options);
  graph.startFromAddress(A);
  await graph.run();
  expect(graph.unvaluedObjects.map((u) => u.object_id)).toEqual([stakeId(8)]);
  origin.changes = [[D, "1000000000000"]];
 });
});
