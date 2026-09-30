import { beforeEach, describe, expect, it, vi } from "vitest";
import { historicalStaking } from "../src/utils/historical-staking.js";
import { runWithNetwork } from "../src/config.js";
import { loadStakingContinuation } from "../src/utils/staking-continuation.js";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ gql: vi.fn(), bracket: vi.fn(), rewards: vi.fn(), effects: vi.fn(), versions: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mocks.gql }));
vi.mock("../src/utils/checkpoint-time.js", () => ({ checkpointBracket: mocks.bracket }));
vi.mock("../src/utils/valuers/staked-sui.js", () => ({ STAKED_SUI_TYPE: "0x3::staking_pool::StakedSui", estimateStakedSuiRewards: mocks.rewards }));
vi.mock("../src/utils/archive-fallback.js", () => ({ withArchiveFallback: mocks.effects }));
vi.mock("../src/utils/valuers/common.js", () => ({ readObjectVersions: mocks.versions }));
const owner = "0x" + "a".repeat(64);
const other = "0x" + "b".repeat(64);
const type = "0x3::staking_pool::StakedSui";
interface StateFixture { version: number; owner: { __typename: string; address: { address: string } }; asMoveObject: { contents: { type: { repr: string } } } }
interface RangeFixture { first: { sequenceNumber: number; timestamp: string }; last: { sequenceNumber: number; timestamp: string } }
const state = (version: number, who = owner, kind = "AddressOwner") => ({ version, owner: { __typename: kind, address: { address: who } }, asMoveObject: { contents: { type: { repr: type } } } });
const change = (id: string, input: StateFixture | null, output: StateFixture | null) => ({ address: id, inputState: input, outputState: output, idCreated: input === null, idDeleted: output === null });
const page = (nodes: unknown[], more = false, cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: cursor, hasPreviousPage: more, startCursor: cursor } });
const tx = (cp: number, changes: unknown[], more = false, cursor: string | null = null) => ({ digest: `tx${cp}`, effects: { checkpoint: { sequenceNumber: cp }, objectChanges: page(changes, more, cursor) } });
const range = (first: number, last: number) => ({ first: { sequenceNumber: first, timestamp: "2025-01-01T00:00:00Z" }, last: { sequenceNumber: last, timestamp: "2025-01-02T00:00:00Z" } });
function continuationArgs(result: Record<string, unknown>) {
  expect(result.continuation_unavailable).toBeUndefined();
  return z.object({ args: z.object({ continuation: z.string(), max_transactions: z.number() }) }).parse(result.continue_with).args;
}

let owned: Array<{ address: string; version: number }>;
let scanned: unknown[];
let first: number;
let last: number;
let txRange: RangeFixture;
let scanMore: boolean;
let continuation: unknown[];
let hydrationMissing: boolean;
let amounts: Record<string, string>;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.effects.mockResolvedValue({ transaction: { effects: { changedObjects: [] } } });
  mocks.versions.mockResolvedValue(new Map());
  owned = [];
  scanned = [];
  first = 0;
  last = 900;
  txRange = range(0, 1000);
  scanMore = false;
  continuation = [];
  hydrationMissing = false;
  amounts = {};
  mocks.rewards.mockImplementation(async (stakes: Array<{ object_id: string }>) => new Map(stakes.map(s => [s.object_id, "7"])));
  mocks.gql.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
    if (query.includes("serviceConfig")) return { serviceConfig: { owned: range(990, 1000), transactions: txRange, objects: range(0, 1000) }, checkpoint: { sequenceNumber: vars.cp, timestamp: "2025-01-01T00:00:00Z", epoch: { epochId: 50 } } };
    if (query.includes("first: transactions")) return { first: { nodes: [tx(first, [])] }, last: { nodes: [tx(last, [])] } };
    if (query.includes("address(address:$owner")) return { address: { objects: page(owned) } };
    if (query.includes("transaction(digest:")) return { transaction: { effects: { objectChanges: page(continuation) } } };
    if (query.includes("transactions(filter:")) return { transactions: page(scanned, scanMore, scanMore ? "next" : null) };
    if (query.includes("multiGetObjects")) return { multiGetObjects: (vars.keys as Array<{ address: string; version: number }>).map(ref => hydrationMissing ? null : ({ ...ref, asMoveObject: { contents: { json: { pool_id: "0xpool", principal: amounts[`${ref.address}@${ref.version}`] ?? amounts[ref.address] ?? "100", stake_activation_epoch: "10" } } } })) };
    throw new Error("Unexpected query");
  });
});

describe("historical staking holdings", () => {
  it("reads the checkpoint set, sums all positions, and keeps epoch rewards separate", async () => {
    owned = [{ address: "0xs1", version: 1 }, { address: "0xs2", version: 2 }];
    amounts = { "0xs1": "9007199254740993", "0xs2": "5" };
    const result = await historicalStaking(owner, 995);
    expect(result).toMatchObject({ method: "checkpoint_objects", complete: true, total_staked_mist: "9007199254740998", estimated_reward_mist: "14", position_count: 2 });
    expect(mocks.rewards.mock.calls[0][1]).toBe(50);
  });

  it("replays inbound transfers, split, join and outgoing transfer without staking events", async () => {
    // 100 arrives, splits into 60+40, joins again, then leaves; only a separate 25 remains.
    scanned = [
      tx(10, [change("0xs", state(1, other), state(2))]),
      tx(20, [change("0xs", state(2), state(3)), change("0xsplit", null, state(3))]),
      tx(30, [change("0xs", state(3), state(4)), change("0xsplit", state(3), null)]),
      tx(40, [change("0xs", state(4), state(5, other)), change("0xkept", null, state(1))]),
    ];
    amounts = { "0xkept": "25" };
    const result = await historicalStaking(owner, 100);
    expect(result).toMatchObject({ complete: true, direction: "forward", total_staked_mist: "25", positions: [{ object_id: "0xkept", version: 1 }] });
  });

  it("reverses split and transferred-away positions using historical versions", async () => {
    owned = [{ address: "0xs", version: 3 }];
    // Connection is chronological; newest replay reverses it.
    scanned = [tx(850, [change("0xs", state(1), state(2)), change("0xsplit", null, state(2))]),
      tx(900, [change("0xs", state(2), state(3)), change("0xsplit", state(2), state(3, other))])];
    const result = await historicalStaking(owner, 800);
    expect(result).toMatchObject({ complete: true, direction: "reverse", total_staked_mist: "100", positions: [{ object_id: "0xs", version: 1 }] });
  });

  it("tracks incoming, mutated and outgoing single-owner consensus stakes", async () => {
    scanned = [
      tx(10, [change("0xsent", state(1, other), state(2, owner, "ConsensusAddressOwner"))]),
      tx(20, [change("0xsent", state(2, owner, "ConsensusAddressOwner"), state(3, owner, "ConsensusAddressOwner"))]),
      tx(30, [change("0xsent", state(3, owner, "ConsensusAddressOwner"), state(4, other, "ConsensusAddressOwner"))]),
      tx(40, [change("0xkept", null, state(1, owner, "ConsensusAddressOwner"))]),
    ];
    amounts = { "0xkept": "75" };
    expect(await historicalStaking(owner, 100)).toMatchObject({
      complete: true, total_staked_mist: "75", positions: [{ object_id: "0xkept", version: 1 }],
    });
  });

  it("restores the previous version of a consensus-owned stake in reverse replay", async () => {
    owned = [{ address: "0xs", version: 2 }];
    scanned = [tx(850, [change("0xs", state(1, owner, "ConsensusAddressOwner"), state(2, owner, "ConsensusAddressOwner"))])];
    expect(await historicalStaking(owner, 800)).toMatchObject({
      complete: true, direction: "reverse", positions: [{ object_id: "0xs", version: 1 }],
    });
  });

  it.each(["forward", "reverse"])("ignores proven created-and-wrapped objects during %s replay", async direction => {
    const wrapped = { address: "0xwrapped", inputState: null, outputState: null, idCreated: true, idDeleted: false };
    mocks.effects.mockResolvedValue({ transaction: { effects: { changedObjects: [
      { objectId: "0xwrapped", inputState: 1, outputState: 1, idOperation: 2 },
    ] } } });
    owned = [{ address: "0xvisible", version: 1 }];
    scanned = [tx(850, direction === "forward" ? [change("0xvisible", null, state(1)), wrapped] : [wrapped])];
    expect(await historicalStaking(owner, direction === "forward" ? 100 : 800)).toMatchObject({
      complete: true, direction, total_staked_mist: "100", positions: [{ object_id: "0xvisible" }],
    });
  });

  it("refuses absent GraphQL states when native effects say a created object was written", async () => {
    scanned = [tx(10, [{ address: "0xmissing", inputState: null, outputState: null, idCreated: true, idDeleted: false }])];
    mocks.effects.mockResolvedValue({ transaction: { effects: { changedObjects: [
      { objectId: "0xmissing", inputState: 1, outputState: 2, idOperation: 2 },
    ] } } });
    expect(await historicalStaking(owner, 100)).toMatchObject({ complete: false, total_staked_mist: null });
  });

  it("recovers the input holder of an effects-v1 deleted stake at its exact version", async () => {
    scanned = [tx(850, [{ address: "0xs", inputState: null, outputState: null, idCreated: false, idDeleted: true }])];
    mocks.effects.mockResolvedValue({ transaction: { effects: { changedObjects: [
      { objectId: "0xs", inputState: 2, inputVersion: 7n, outputState: 1, idOperation: 3 },
    ] } } });
    mocks.versions.mockResolvedValue(new Map([["0xs@7", {
      object_id: "0xs", version: "7", type, json: {}, current: false, owner: { kind: "address", address: owner },
    }]]));
    expect(await historicalStaking(owner, 800)).toMatchObject({
      complete: true, direction: "reverse", total_staked_mist: "100", positions: [{ object_id: "0xs", version: 7 }],
    });
  });

  it("keeps effects-v1 history incomplete if the input version cannot be read", async () => {
    scanned = [tx(850, [{ address: "0xs", inputState: null, outputState: null, idCreated: false, idDeleted: true }])];
    mocks.effects.mockResolvedValue({ transaction: { effects: { changedObjects: [
      { objectId: "0xs", inputState: 2, inputVersion: 7n, outputState: 1, idOperation: 3 },
    ] } } });
    expect(await historicalStaking(owner, 800)).toMatchObject({ complete: false, total_staked_mist: null });
  });

  it("resumes after a time stop without increasing the transaction budget", async () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const original = mocks.gql.getMockImplementation()!;
    let slow = true;
    mocks.gql.mockImplementation((query, vars) => {
      if (slow && query.includes("transactions(filter:") && !query.includes("first: transactions")) now += 60_000;
      return original(query, vars);
    });
    scanned = [tx(10, [change("0xs", null, state(1))])];
    try {
      const result = await historicalStaking(owner, 100);
      expect(result).toMatchObject({ complete: false, total_staked_mist: null, time_budget_reached: true, replay_calls: 1 });
      const args = continuationArgs(result);
      expect(args.max_transactions).toBe(1000);
      slow = false;
      expect(await historicalStaking(owner, 100, args.max_transactions, args.continuation)).toMatchObject({
        complete: true, total_staked_mist: "100", replay_calls: 2, positions: [{ object_id: "0xs", version: 1 }],
      });
    } finally {
      clock.mockRestore();
    }
  });

  it("finishes every object-change page before treating a transaction as complete", async () => {
    scanned = [tx(10, [change("0xs", null, state(1))], true, "changes")];
    continuation = [change("0xsecond", null, state(1))];
    const result = await historicalStaking(owner, 100);
    expect(result).toMatchObject({ complete: true, total_staked_mist: "200", position_count: 2 });
  });

  it("resumes inside a transaction's object-change pages without reapplying the first page", async () => {
    scanned = [tx(10, [change("0xs", null, state(1))], true, "changes")];
    continuation = [change("0xsecond", null, state(1))];
    owned = [{ address: "0xs", version: 1 }];
    const result = await historicalStaking(owner, 100, 1);
    expect(result).toMatchObject({ complete: false, total_staked_mist: null, attempts: [
      { object_change_pages: 1, complete: false }, { object_change_pages: 1, complete: false },
    ] });
    expect(mocks.gql.mock.calls.filter(([query]) => query.includes("transaction(digest:"))).toEqual([]);
    const token = continuationArgs(result).continuation;
    expect(loadStakingContinuation<{ positions: unknown[] }>(token).positions).toEqual([
      { object_id: "0xs", version: 1, pool_id: "0xpool", principal_mist: "100", stake_activation_epoch: "10" },
    ]);
    expect(await historicalStaking(owner, 100, 1, token)).toMatchObject({
      complete: true, total_staked_mist: "200", position_count: 2, replay_calls: 2,
      replay_transactions_scanned: 1, replay_object_change_pages: 2,
    });
  });

  it("tries the other direction after a budget stop instead of returning a partial sum", async () => {
    owned = [{ address: "0xold", version: 1 }];
    const original = mocks.gql.getMockImplementation()!;
    mocks.gql.mockImplementation((query, vars) => query.includes("transactions(filter:") && !query.includes("first: transactions")
      ? Promise.resolve({ transactions: vars.first ? page([tx(10, [change("0xwrong", null, state(1))])], true, "next") : page([]) })
      : original(query, vars));
    const result = await historicalStaking(owner, 100, 1);
    expect(result).toMatchObject({ complete: true, direction: "reverse", total_staked_mist: "100", positions: [{ object_id: "0xold" }] });
    expect(result.attempts).toMatchObject([{ direction: "forward", complete: false }, { direction: "reverse", complete: true }]);
  });

  it("gives no holdings on an exhausted scan and supplies the same-budget continuation", async () => {
    scanned = [tx(10, [change("0xs", null, state(1))])];
    scanMore = true;
    const result = await historicalStaking(owner, 100, 1);
    continuationArgs(result);
    expect(result).toMatchObject({ complete: false, total_staked_mist: null, position_count: null, positions: [], continue_with: { args: { max_transactions: 1, continuation: expect.any(String) } } });
  });

  it("refuses missing object state and missing final contents", async () => {
    owned = [{ address: "0xs", version: 1 }];
    hydrationMissing = true;
    expect(await historicalStaking(owner, 995)).toMatchObject({ complete: false, total_staked_mist: null, positions: [] });
    hydrationMissing = false;
    scanned = [tx(10, [{ ...change("0xs", null, state(1)), idCreated: false }])];
    expect(await historicalStaking(owner, 100)).toMatchObject({ complete: false, total_staked_mist: null });
  });

  it("does not reconstruct an empty history across pruned transaction coverage", async () => {
    txRange = range(200, 1000);
    const result = await historicalStaking(owner, 100);
    expect(result).toMatchObject({ complete: false, total_staked_mist: null });
  });

  it("keeps exact principal when historical reward rates are unavailable", async () => {
    owned = [{ address: "0xs", version: 1 }];
    mocks.rewards.mockResolvedValue(new Map([["0xs", null]]));
    expect(await historicalStaking(owner, 995)).toMatchObject({ complete: true, total_staked_mist: "100", estimated_reward_mist: null });
  });

  it("uses the last checkpoint at or before a date, never a nearby future checkpoint", async () => {
    const ms = Date.parse("2025-01-01T00:00:00Z");
    mocks.bracket.mockResolvedValue({ before: { seq: 995, ms }, atOrAfter: { seq: 996, ms: ms + 10 } });
    expect(await historicalStaking(owner, "2025-01-01T00:00:00Z")).toMatchObject({ at_checkpoint: 995, complete: true });
    expect(mocks.bracket).toHaveBeenCalledWith(ms + 1);
    mocks.bracket.mockResolvedValue({ before: { seq: 990, ms: ms - 10 }, atOrAfter: { seq: 996, ms: ms + 10 } });
    await expect(historicalStaking(owner, "2025-01-01T00:00:00Z")).rejects.toThrow();
  });

  it.each(["bad-date", -1, Number.MAX_SAFE_INTEGER, "9007199254740992"])("rejects invalid as_of %s before a data query", async value => {
    await expect(historicalStaking(owner, value)).rejects.toThrow();
    expect(mocks.gql).not.toHaveBeenCalled();
  });

  it.each(["forward", "reverse"] as const)("matches uninterrupted %s replay split at several transaction and time boundaries", async direction => {
    const forward = direction === "forward";
    const cp = forward ? 100 : 800;
    txRange = range(forward ? 0 : 800, forward ? 100 : 1000);
    owned = [{ address: "0xs", version: 4 }, { address: "0xkept", version: 2 }];
    amounts = { "0xs@3": "60", "0xsplit@3": "40", "0xkept@1": "25", "0xkept@2": "35" };
    const offset = forward ? 0 : 800;
    const rows = [
      ...(forward ? [tx(1, [change("0xs", null, state(1))])] : []),
      tx(offset + 10, [change("0xs", state(1), state(2)), change("0xin", state(1, other), state(2))]),
      tx(offset + 20, [change("0xs", state(2), state(3)), change("0xsplit", null, state(3))]),
      tx(offset + 30, [change("0xs", state(3), state(4)), change("0xsplit", state(3), null)]),
      tx(offset + 40, [change("0xin", state(2), state(3, other)), change("0xkept", null, state(1))]),
      tx(offset + 50, [change("0xkept", state(1), state(2))]),
    ];
    const original = mocks.gql.getMockImplementation()!;
    let now = 0;
    let readCost = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.gql.mockImplementation((query: string, vars: Record<string, unknown>) => {
      if (query.includes("transactions(filter:") && !query.includes("first: transactions")) {
        const start = vars.first ? Number(String(vars.after ?? "p0").slice(1)) : Math.max(0, Number(String(vars.before ?? `p${rows.length}`).slice(1)) - Number(vars.last));
        const end = vars.first ? Math.min(rows.length, start + Number(vars.first)) : Number(String(vars.before ?? `p${rows.length}`).slice(1));
        return { transactions: { nodes: rows.slice(start, end).map(row => ({
          ...row, effects: { ...row.effects, objectChanges: {
            ...row.effects.objectChanges,
            get nodes() { now += readCost; return row.effects.objectChanges.nodes; },
          } },
        })), pageInfo: { hasNextPage: end < rows.length, endCursor: `p${end}`, hasPreviousPage: start > 0, startCursor: `p${start}` } } };
      }
      return original(query, vars);
    });
    try {
      const whole = await historicalStaking(owner, cp, 100);
      expect(whole).toMatchObject({ complete: true, direction, total_staked_mist: forward ? "135" : "100" });
      for (const budget of [1, 2, 3, 100]) {
        // The 100-transaction run stops inside a single fetched transaction page.
        readCost = budget === 100 ? 10_000 : 0;
        let result = await historicalStaking(owner, cp, budget);
        let calls = 1;
        while (!result.complete && calls <= rows.length + 1) {
          expect(result).toMatchObject({ total_staked_mist: null, position_count: null, positions: [] });
          const token = continuationArgs(result).continuation;
          result = await historicalStaking(owner, cp, budget, token);
          calls++;
        }
        expect(calls).toBeGreaterThan(1);
        expect(result).toMatchObject({
          complete: true, replay_calls: calls, positions: whole.positions,
          total_staked_mist: whole.total_staked_mist, estimated_reward_mist: whole.estimated_reward_mist,
          replay_transactions_scanned: rows.length,
        });
      }
    } finally { clock.mockRestore(); }
  });

  it("keeps the saved reverse anchor after the recent owned-object range advances", async () => {
    txRange = range(800, 2000);
    owned = [{ address: "0xs", version: 3 }];
    const original = mocks.gql.getMockImplementation()!;
    let resumed = false;
    mocks.gql.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("serviceConfig")) {
        const data = await original(query, vars);
        if (resumed) data.serviceConfig.owned = range(1100, 2000);
        return data;
      }
      if (query.includes("address(address:$owner") && resumed) throw new Error("Must not re-enumerate the anchor");
      if (query.includes("transactions(filter:") && !query.includes("first: transactions")) {
        return { transactions: vars.before
          ? page([tx(850, [change("0xs", state(1), state(2))])])
          : page([tx(900, [change("0xs", state(2), state(3))])], true, "next") };
      }
      return original(query, vars);
    });
    const firstResult = await historicalStaking(owner, 800, 1);
    const token = continuationArgs(firstResult).continuation;
    resumed = true;
    expect(await historicalStaking(owner, 800, 1, token)).toMatchObject({
      complete: true, direction: "reverse", anchor_checkpoint: 990, replay_calls: 2,
      total_staked_mist: "100", positions: [{ object_id: "0xs", version: 1 }],
    });
  });

  it.each(["forward", "reverse"] as const)("resumes each nested change page in %s order", async direction => {
    const forward = direction === "forward";
    txRange = range(forward ? 0 : 800, forward ? 100 : 1000);
    owned = [1, 2, 3].map(i => ({ address: `0xs${i}`, version: 2 }));
    scanned = [tx(forward ? 10 : 850, [change("0xs1", forward ? null : state(1), state(2))], true, "c1")];
    const original = mocks.gql.getMockImplementation()!;
    mocks.gql.mockImplementation((query: string, vars: Record<string, unknown>) => {
      if (query.includes("transaction(digest:")) {
        const index = vars.after === "c1" ? 2 : 3;
        return { transaction: { effects: { objectChanges: page([
          change(`0xs${index}`, forward ? null : state(1), state(2)),
        ], index === 2, index === 2 ? "c2" : null) } } };
      }
      return original(query, vars);
    });
    const cp = forward ? 100 : 800;
    const whole = await historicalStaking(owner, cp, 100);
    let result = await historicalStaking(owner, cp, 1);
    for (let i = 0; i < 2; i++) {
      expect(result.total_staked_mist).toBeNull();
      result = await historicalStaking(owner, cp, 1, continuationArgs(result).continuation);
    }
    expect(result).toMatchObject({ complete: true, replay_calls: 3, positions: whole.positions,
      total_staked_mist: "300", replay_transactions_scanned: 1, replay_object_change_pages: 3 });
  });

  it("rejects tampered, expired, mismatched and other-network continuations before chain reads", async () => {
    scanned = [tx(10, [change("0xs", null, state(1))])];
    scanMore = true;
    const result = await historicalStaking(owner, 100, 1);
    const token = continuationArgs(result).continuation;
    mocks.gql.mockClear();
    const altered = `${token.slice(0, 6)}${token[6] === "A" ? "B" : "A"}${token.slice(7)}`;
    for (const invalid of [altered, `${token}.`, token.replace("hs1.", "hs0.")]) {
      await expect(historicalStaking(owner, 100, 1, invalid)).rejects.toThrow(/Invalid or stale staking continuation/);
    }
    await expect(historicalStaking(other, 100, 1, token)).rejects.toThrow(/different address/);
    await expect(historicalStaking(owner, 101, 1, token)).rejects.toThrow(/as_of/);
    await expect(runWithNetwork("testnet", () => historicalStaking(owner, 100, 1, token))).rejects.toThrow(/mainnet.*testnet/);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1000 + 1);
    try { await expect(historicalStaking(owner, 100, 1, token)).rejects.toThrow(/lifetime has expired/); }
    finally { clock.mockRestore(); }
    expect(mocks.gql).not.toHaveBeenCalled();
    txRange = range(200, 1000);
    await expect(historicalStaking(owner, 100, 1, token)).rejects.toThrow(/no longer retains/);
  });
});
