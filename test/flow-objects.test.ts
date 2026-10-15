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
   if (query.includes("affectedAddress: $id")) return {
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
});
