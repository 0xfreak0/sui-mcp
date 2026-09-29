import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ObjectMovement } from "../src/utils/object-flow.js";
import type { MovedObjectValue } from "../src/utils/moved-value.js";

// Only the synthetic readers registered below, and object states as read.
vi.mock("../src/utils/valuers/index.js", () => ({}));
/** Holder of an object at a version, by `id@version`; an address unless listed. */
const owners = new Map<string, { kind: "address" | "object"; address: string }>();
vi.mock("../src/utils/valuers/common.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prefetchCheckpoints: async () => undefined,
  readObjectVersions: async (keys: Array<{ object_id: string; version: string }>) =>
    new Map(
      keys.map((k) => [
        `${k.object_id}@${k.version}`,
        { object_id: k.object_id, version: k.version, type: "", json: { v: k.version }, current: false, owner: owners.get(`${k.object_id}@${k.version}`) },
      ]),
    ),
}));

/** Transactions the fullnode returns to `batchGetTransactions`, in request order. */
let fullnodeTxs: unknown[] = [];
vi.mock("../src/clients/grpc.js", () => {
  const client = {
    ledgerService: {
      batchGetTransactions: async () => ({
        response: { transactions: fullnodeTxs.map((transaction) => ({ result: { oneofKind: "transaction", transaction } })) },
      }),
    },
  };
  return { sui: client, archive: client };
});

// Imported after the mocks above.
const { registerValuer } = await import("../src/utils/position-value.js");
const { keptDelta, movedObjects, objectValueByAddress, readMovedObjects, valueMovedObjects, valueTransactionObjects } = await import("../src/utils/moved-value.js");

const STAKE = "0x0000000000000000000000000000000000000000000000000000000000000003::staking_pool::StakedSui";
const ART = `0x${"a".repeat(64)}::art::Art`;
const COIN_LIKE = `0x${"b".repeat(64)}::thing::Thing`;
const A = `0x${"a1".repeat(32)}`;
const B = `0x${"b1".repeat(32)}`;
const ID = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

const none = async () => ({ positions: [], unread: [] });
/**
 * Legs by object version: [coin, raw amount, usd, side]. A version with an
 * empty list has no position; one not listed is one unit of X at $1.
 */
let legsAt: Record<string, Array<[string, string, number | null, "supply" | "borrow"]>> = {};
registerValuer({
  name: "stake",
  value: none,
  handles: (t) => t === STAKE,
  valueObject: async (obj) => {
    const legs = legsAt[obj.version!] ?? [["X", "1", 1, "supply"]];
    if (legs.length === 0) return { positions: [], unread: [] };
    const assets = legs.map(([coin_type, amount, usd, side]) => ({ coin_type, amount, usd, side }));
    const net = assets.some((a) => a.usd === null) ? null : assets.reduce((t, a) => t + (a.side === "borrow" ? -a.usd! : a.usd!), 0);
    return {
      positions: [{ protocol: null, kind: "lending", object_id: obj.object_id, assets, usd_net: net, method: "synthetic", tier: "price-provider" }],
      unread: [],
    };
  },
});
beforeEach(() => {
  legsAt = {};
  owners.clear();
});
registerValuer({ name: "art", value: none, fallback: true, handles: (t) => t === ART, valueObject: none });

const move = (id: number, type: string, kind: ObjectMovement["kind"], from: string | null, to: string | null): ObjectMovement => ({
  object_id: ID(id),
  type,
  type_short: null,
  kind,
  from: from ? { kind: "address", address: from } : null,
  to: to ? { kind: "address", address: to } : null,
  category: "unknown",
  high_consequence: false,
});
const versions = (id: number, input: string | null, output: string | null, heldBy?: string, type = STAKE) => ({
  objectId: ID(id),
  objectType: type,
  inputVersion: input,
  outputVersion: output,
  ...(heldBy ? { heldBy } : {}),
});

describe("movedObjects", () => {
  it("values a transfer at its output version for both sides, a deletion at its input version", () => {
    const out = movedObjects(
      [move(1, STAKE, "transferred", A, B), move(2, STAKE, "deleted", A, null)],
      [versions(1, "7", "8"), versions(2, "5", null)],
    );
    expect(out).toEqual([
      { object_id: ID(1), type: STAKE, from: A, to: B, version: "8" },
      { object_id: ID(2), type: STAKE, from: A, to: null, version: "5" },
    ]);
  });

  it("leaves out types no reader values", () => {
    expect(movedObjects([move(3, COIN_LIKE, "transferred", A, B)], [versions(3, "1", "2")])).toEqual([]);
  });

  it("values a kept object's change only through a specific reader", () => {
    const out = movedObjects([], [versions(4, "7", "8", A), versions(5, "7", "8", A, ART)]);
    expect(out).toEqual([{ object_id: ID(4), type: STAKE, from: A, to: A, version: "8", before_version: "7" }]);
  });

  it("leaves a kept coin to its balance change", () => {
    const LP_COIN = `0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<${STAKE}>`;
    registerValuer({ name: "lp_coin", value: none, handles: (t) => t === LP_COIN, valueObject: none });
    expect(movedObjects([], [versions(6, "7", "8", A, LP_COIN)])).toEqual([]);
  });

  it("marks an object wrapped into or unwrapped from another object as a custody change", () => {
    const out = movedObjects([move(7, STAKE, "wrapped", A, null), move(8, STAKE, "unwrapped", null, A)], [versions(7, "3", null), versions(8, null, "4")]);
    expect(out.map((m) => m.custody)).toEqual(["wrapped", "unwrapped"]);
  });

  it("resolves an object whose previous holder went unrecorded from its input version", () => {
    const out = movedObjects([move(9, STAKE, "appeared", null, B), move(10, STAKE, "appeared", null, B)], [versions(9, "3", "4"), versions(10, null, "4")]);
    expect(out[0]).toMatchObject({ from: null, to: B, prior_version: "3" });
    expect(out[0].custody).toBeUndefined();
    expect(out[1].custody).toBe("prior_holder_unknown");
  });

  it("resolves an object effects v1 deleted or wrapped from its input version, since they name no holder", () => {
    const ended = (id: number, kind: "deleted" | "wrapped") => ({ ...move(id, STAKE, kind, null, null), source_unrecorded: true });
    const out = movedObjects([ended(18, "deleted"), ended(19, "wrapped")], [versions(18, "15", null), versions(19, "6", null)]);
    expect(out).toEqual([
      { object_id: ID(18), type: STAKE, from: null, to: null, version: "15", prior_version: "15" },
      { object_id: ID(19), type: STAKE, from: null, to: null, version: "6", prior_version: "6", custody: "wrapped" },
    ]);
  });
});

describe("keptDelta", () => {
  const leg = (coin_type: string, amount: string, usd: number | null, side: "supply" | "borrow" = "supply") => ({ coin_type, amount, usd, side });

  it("prices both sides at the after side's prices, so a price refresh alone moves nothing", () => {
    expect(keptDelta([leg("BTC", "148", 125_000)], [leg("BTC", "148", 125_600)])).toBe(0);
  });

  it("counts the change in amounts, borrows subtracting", () => {
    // Before: 10 X supplied, 4 Y borrowed. After: 12 X, 2 Y. X $1, Y $2 a unit.
    const d = keptDelta([leg("X", "12", 12), leg("Y", "2", 4, "borrow")], [leg("X", "10", 11), leg("Y", "4", 9, "borrow")]);
    expect(d).toBeCloseTo(2 + 4);
  });

  it("uses the given prices over either side's", () => {
    expect(keptDelta([leg("X", "3", 3)], [leg("X", "1", 1)], new Map([["X", 5]]))).toBe(10);
  });

  it("prices a coin present only before at its own price, and has no answer without one", () => {
    expect(keptDelta([], [leg("X", "2", 4)])).toBe(-4);
    expect(keptDelta([leg("X", "1", null)], [])).toBeNull();
  });
});

describe("plausibility bound", () => {
  it("never counts a position valued past what any protocol holds", async () => {
    legsAt = { "9": [["X", "1", 1e23, "supply"]] };
    const r = await valueMovedObjects([{ object_id: ID(17), type: STAKE, from: A, to: B, version: "9" }], "100");
    expect(r.rows).toEqual([]);
    expect(r.unread.map((u) => u.what)).toContain(ID(17));
  });
});

describe("valueMovedObjects", () => {
  it("keeps a position found inside the moved object, reported under its inner id", async () => {
    const WRAP = `0x${"c".repeat(64)}::farm::WrappedPositionNFT`;
    registerValuer({
      name: "held",
      value: none,
      fallback: true,
      handles: (t) => t === WRAP,
      valueObject: async (obj) => ({
        positions: [
          { protocol: "Cetus", kind: "clmm", object_id: ID(777), assets: [], usd_net: 31000, method: "inner", tier: "price-provider", detail: { held_in: { object_id: obj.object_id, type: WRAP } } },
        ],
        unread: [],
      }),
    });
    const r = await valueMovedObjects([{ object_id: ID(16), type: WRAP, from: null, to: B, version: "2" }], "100");
    expect(r.rows).toEqual([expect.objectContaining({ object_id: ID(16), kind: "clmm", usd: 31000 })]);
  });

  it("values a kept position whose side is empty as zero", async () => {
    legsAt = { "7": [], "8": [["X", "30", 30, "supply"]] };
    const r = await valueMovedObjects([{ object_id: ID(11), type: STAKE, from: A, to: A, version: "8", before_version: "7" }], "100");
    expect(r.rows).toEqual([expect.objectContaining({ object_id: ID(11), usd: 30, changed_in_place: true })]);
  });

  it("drops a kept position whose amounts did not change, whatever the prices did", async () => {
    legsAt = { "7": [["BTC", "148", 125_600, "supply"]], "8": [["BTC", "148", 125_000, "supply"]] };
    const r = await valueMovedObjects([{ object_id: ID(12), type: STAKE, from: A, to: A, version: "8", before_version: "7" }], "100");
    expect(r.rows).toEqual([]);
  });

  it("counts an unrecorded holder's object as changed in place when the same address held it", async () => {
    owners.set(`${ID(13)}@3`, { kind: "address", address: B });
    legsAt = { "3": [["X", "50", 50, "supply"]], "4": [["X", "52", 52, "supply"]] };
    const r = await valueMovedObjects([{ object_id: ID(13), type: STAKE, from: null, to: B, version: "4", prior_version: "3" }], "100");
    expect(r.rows).toEqual([expect.objectContaining({ from: B, to: B, usd: 2, changed_in_place: true })]);
  });

  it("counts it as a transfer when another address held it", async () => {
    owners.set(`${ID(14)}@3`, { kind: "address", address: A });
    const r = await valueMovedObjects([{ object_id: ID(14), type: STAKE, from: null, to: B, version: "4", prior_version: "3" }], "100");
    expect(r.rows).toEqual([expect.objectContaining({ from: A, to: B, usd: 1 })]);
    expect(r.rows[0].changed_in_place).toBeUndefined();
  });

  it("lists it as a custody change when an object held it", async () => {
    owners.set(`${ID(15)}@3`, { kind: "object", address: ID(99) });
    const r = await valueMovedObjects([{ object_id: ID(15), type: STAKE, from: null, to: B, version: "4", prior_version: "3" }], "100");
    expect(r.rows[0].custody).toBe("unwrapped");
    expect(objectValueByAddress(r.rows).get(B)).toMatchObject({ usd_net: 0, usd_gained: 0 });
  });

  it("drops an object effects v1 deleted from another object, and lists one whose holder could not be read", async () => {
    owners.set(`${ID(21)}@15`, { kind: "object", address: ID(99) });
    const r = await valueMovedObjects(
      [
        { object_id: ID(21), type: STAKE, from: null, to: null, version: "15", prior_version: "15" },
        { object_id: ID(22), type: STAKE, from: null, to: null, version: "15", prior_version: "15" },
      ],
      "100",
    );
    expect(r.rows).toEqual([]);
    expect(r.unread).toEqual([{ what: ID(22), reason: "its holder at version 15 could not be read" }]);
  });
});

describe("objectValueByAddress", () => {
  const row = (over: Partial<MovedObjectValue>): MovedObjectValue => ({
    object_id: ID(1),
    type: STAKE,
    from: A,
    to: B,
    protocol: null,
    kind: "staked_sui",
    usd: 100,
    estimate: false,
    tier: "price-provider",
    method: "synthetic",
    ...over,
  });

  it("debits the holder it left and credits the one it reached", () => {
    const by = objectValueByAddress([row({})]);
    expect(by.get(A)).toMatchObject({ usd_net: -100, usd_gained: 0 });
    expect(by.get(B)).toMatchObject({ usd_net: 100, usd_gained: 100 });
  });

  it("keeps estimates and unpriced objects out of the priced net", () => {
    const by = objectValueByAddress([row({ estimate: true, tier: "heuristic" }), row({ object_id: ID(2), usd: null })]);
    expect(by.get(B)).toMatchObject({ usd_net: 0, estimate_usd_net: 100, unpriced: 1 });
  });

  it("lists custody changes without counting them", () => {
    const by = objectValueByAddress([row({ to: null, custody: "wrapped" })]);
    expect(by.get(A)).toMatchObject({ usd_net: 0, usd_gained: 0 });
    expect(by.get(A)!.custody).toHaveLength(1);
  });

  it("counts a kept object's signed change for its holder only", () => {
    const by = objectValueByAddress([row({ from: A, to: A, usd: -40, changed_in_place: true })]);
    expect(by.get(A)).toMatchObject({ usd_net: -40, usd_gained: 0 });
    expect(by.get(A)!.changed).toHaveLength(1);
    expect(by.size).toBe(1);
  });
});

describe("valueTransactionObjects", () => {
  const tx = (digest: string, count: number, start: number) => ({
    digest,
    checkpoint: "10",
    moved: Array.from({ length: count }, (_, i) => ({ object_id: ID(start + i), type: STAKE, from: A, to: B, version: "2" })),
  });

  it("values whole transactions, newest first, until the object budget is spent, and lists the rest", async () => {
    const r = await valueTransactionObjects([tx("t1", 3, 100), tx("t2", 3, 200), tx("t3", 1, 300)], { maxTxs: 10, maxObjects: 5 });

    expect(new Set(r.rows.map((row) => row.digest))).toEqual(new Set(["t1"]));
    expect(r.skipped).toEqual(["t2", "t3"]);
  });

  it("counts a kept position's change once when several transactions of one checkpoint touched it", async () => {
    legsAt = { "1": [["X", "1", 1, "supply"]], "2": [["X", "3", 3, "supply"]] };
    const kept = (digest: string) => ({
      digest,
      checkpoint: "10",
      moved: [{ object_id: ID(400), type: STAKE, from: A, to: A, version: "2", before_version: "1" }],
    });
    const r = await valueTransactionObjects([kept("t1"), kept("t2")], { maxTxs: 10, maxObjects: 10 });
    expect(r.rows).toEqual([expect.objectContaining({ digest: "t1", usd: 2, same_checkpoint_digests: ["t2"] })]);
  });

  it("counts each same-checkpoint change of a position valued from its own versions", async () => {
    legsAt = { "1": [["X", "1", 1, "supply"]], "2": [["X", "5", 5, "supply"]], "3": [] };
    const kept = (digest: string, before: string, after: string) => ({
      digest,
      checkpoint: "10",
      moved: [{ object_id: ID(401), type: STAKE, from: A, to: A, version: after, before_version: before }],
    });
    const r = await valueTransactionObjects([kept("t1", "1", "2"), kept("t2", "2", "3")], { maxTxs: 10, maxObjects: 10 });
    expect(r.rows.map((row) => [row.digest, row.usd])).toEqual([
      ["t1", 4],
      ["t2", -5],
    ]);
  });

  it("always values the first transaction, however many objects it moved", async () => {
    const r = await valueTransactionObjects([tx("t1", 7, 100)], { maxTxs: 10, maxObjects: 5 });
    expect(r.rows).toHaveLength(7);
    expect(r.skipped).toEqual([]);
  });
});

describe("readMovedObjects", () => {
  it("lists a stake withdrawal under effects v1, which name no owner for the StakedSui it deleted", async () => {
    // The gRPC shape of an effects-v1 request_withdraw_stake: the StakedSui's
    // input existed and its output does not, with no owner on either side;
    // the SUI paid out is a coin, left to the balance changes.
    fullnodeTxs = [
      {
        checkpoint: 500n,
        effects: {
          version: 1,
          changedObjects: [
            {
              objectId: ID(30),
              objectType: "0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI>",
              inputState: 1,
              outputState: 2,
              outputVersion: 41n,
              outputOwner: { kind: 1, address: A },
              idOperation: 2,
            },
            { objectId: ID(31), objectType: STAKE, inputState: 2, inputVersion: 15n, outputState: 1, outputVersion: 41n, outputDigest: "7gyGAp71YXQRoxmFBaHxofQXAipvgHyBKPyxmdSJxyvz", idOperation: 3 },
          ],
        },
      },
    ];
    owners.set(`${ID(31)}@15`, { kind: "address", address: A });
    const read = await readMovedObjects(["w1"], true);
    const r = await valueTransactionObjects(read.txs, { maxTxs: 10, maxObjects: 10 });
    expect(r.rows).toEqual([expect.objectContaining({ digest: "w1", object_id: ID(31), from: A, to: null, usd: 1 })]);
    expect(r.unread).toEqual([]);
  });
});
