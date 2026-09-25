import { describe, it, expect } from "vitest";
import { readObjectMovements } from "../src/utils/object-flow.js";
import {
  evaluate,
  flagLookalikes,
  normalizeWatchAddress,
  planBatches,
  safeAdvance,
  summarizePoll,
  WATCH_BATCH_SIZE,
  type DeltaTx,
  type WatchEntry,
} from "../src/utils/watch.js";

const W = `0xaa${"1".repeat(62)}`;
const OTHER = `0xbb${"2".repeat(62)}`;
const SINK = `0xcc${"3".repeat(62)}`;
const SUI = "0x2::sui::SUI";

const entry = (over: Partial<WatchEntry> = {}): WatchEntry => ({
  address: W,
  last_checkpoint: 100,
  added_at: 0,
  ...over,
});

const tx = (
  checkpoint: number,
  changes: Array<[string, string]>,
  digest = `d${checkpoint}`,
): DeltaTx => ({
  digest,
  checkpoint,
  timestamp: "2026-09-11T00:00:00Z",
  balance_changes: changes.map(([address, amount]) => ({ address, amount, coin_type: SUI })),
});

describe("planBatches", () => {
  /**
   * The 5,000-byte query cap is what binds: 20 aliases of a minimal selection
   * measured 3,917 bytes and was accepted; 30 measured 5,877 and was rejected.
   * A batch that silently drops an address is a watch that reports nothing and
   * looks calm.
   */
  it("batches at the measured service limit", () => {
    expect(WATCH_BATCH_SIZE).toBe(20);
    const items = Array.from({ length: 45 }, (_, i) => i);
    const batches = planBatches(items);
    expect(batches.map((b) => b.length)).toEqual([20, 20, 5]);
    expect(batches.flat()).toEqual(items);
  });

  it("returns nothing for an empty set rather than one empty batch", () => {
    expect(planBatches([])).toEqual([]);
  });
});

describe("evaluate — direction and amounts", () => {
  it("reports value arriving", () => {
    const { hits } = evaluate(entry(), [tx(101, [[W, "5000"], [OTHER, "-5000"]])]);
    expect(hits[0]!.reasons).toContain("value_in");
    expect(hits[0]!.net).toEqual({ [SUI]: "5000" });
    expect(hits[0]!.counterparties).toEqual([OTHER]);
  });

  it("reports value leaving", () => {
    const { hits } = evaluate(entry(), [tx(101, [[W, "-5000"], [OTHER, "5000"]])]);
    expect(hits[0]!.reasons).toContain("value_out");
  });

  /**
   * An NFT or a capability moves without producing a balance change. A watch
   * that only fired on coin movement would be blind to exactly the transfers
   * object flow exists to catch.
   */
  it("still fires when no coin moved", () => {
    const { hits } = evaluate(entry(), [{ digest: "d1", checkpoint: 101, balance_changes: [] }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.reasons).toEqual(["appeared"]);
    expect(hits[0]!.net).toBeUndefined();
  });

  it("flags reaching a labelled sink", () => {
    const { hits } = evaluate(entry(), [tx(101, [[W, "-5000"], [SINK, "5000"]])], {
      isSink: (a) => a === SINK,
    });
    expect(hits[0]!.reasons).toContain("sink_reached");
  });
});

describe("evaluate — the high-water mark", () => {
  it("advances to the highest checkpoint seen", () => {
    const { last_checkpoint } = evaluate(entry(), [
      tx(101, [[W, "1"]]),
      tx(140, [[W, "1"]]),
      tx(120, [[W, "1"]]),
    ]);
    expect(last_checkpoint).toBe(140);
  });

  it("does not move backwards on an empty delta", () => {
    expect(evaluate(entry({ last_checkpoint: 500 }), []).last_checkpoint).toBe(500);
  });

  /**
   * The trap: a transaction filtered out by a threshold has still been SEEN.
   * Leaving the cursor behind would re-read it on every poll forever, and
   * report it the moment the threshold changed.
   */
  it("advances past transactions a threshold suppressed", () => {
    const r = evaluate(entry({ min_amount: "1000000" }), [tx(150, [[W, "5"], [OTHER, "-5"]])]);
    expect(r.hits).toEqual([]);
    expect(r.last_checkpoint).toBe(150);
  });
});

describe("evaluate — thresholds filter value, not findings", () => {
  const small = tx(101, [[W, "5"], [OTHER, "-5"]]);

  it("suppresses a small coin movement", () => {
    expect(evaluate(entry({ min_amount: "1000" }), [small]).hits).toEqual([]);
  });

  it("passes a movement at the floor", () => {
    const { hits } = evaluate(entry({ min_amount: "5" }), [small]);
    expect(hits).toHaveLength(1);
  });

  /** A sink is a finding whatever the amount; so is a transfer of no coin. */
  it("never suppresses a sink on size", () => {
    const { hits } = evaluate(entry({ min_amount: "10000000" }), [tx(101, [[W, "-5"], [SINK, "5"]])], {
      isSink: (a) => a === SINK,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.reasons).toContain("sink_reached");
  });

  it("never suppresses a transaction that moved no coin", () => {
    const { hits } = evaluate(entry({ min_amount: "10000000" }), [
      { digest: "d1", checkpoint: 101, balance_changes: [] },
    ]);
    expect(hits).toHaveLength(1);
  });

  it("measures the floor against the largest coin, not the net of all", () => {
    // +1000 of one coin and -1000 of another nets to zero across coins, which
    // would wrongly read as nothing moving.
    const mixed: DeltaTx = {
      digest: "d1",
      checkpoint: 101,
      balance_changes: [
        { address: W, amount: "1000", coin_type: SUI },
        { address: W, amount: "-1000", coin_type: "0xa::t::T" },
      ],
    };
    expect(evaluate(entry({ min_amount: "900" }), [mixed]).hits).toHaveLength(1);
  });
});

describe("summarizePoll", () => {
  /**
   * The empty poll is the common one and the reason this is affordable: it must
   * stay tiny and carry no prose. Repeated every minute, a paragraph saying
   * nothing happened is exactly the cost this design avoids.
   */
  it("is small and silent when nothing happened", () => {
    const s = summarizePoll(20, [], 1);
    expect(s).toEqual({ watched: 20, active: 0, hits: [], requests: 1 });
    expect(JSON.stringify(s).length).toBeLessThan(80);
  });

  it("counts distinct active addresses, not hits", () => {
    const h = (address: string, digest: string) => ({
      address,
      digest,
      checkpoint: 1,
      reasons: ["value_in" as const],
    });
    const s = summarizePoll(20, [h(W, "a"), h(W, "b"), h(OTHER, "c")], 2);
    expect(s.active).toBe(2);
    expect(s.hits).toHaveLength(3);
    expect(s.note).toMatch(/get_transaction/);
  });
});

describe("summarizePoll — a saturated poll is not a complete one", () => {
  /**
   * Measured on a real mainnet address doing a transaction every two seconds:
   * it fills the per-poll cap every time. Without saying so, the watch falls
   * permanently behind while every poll reads as a full report.
   */
  it("says when an address filled the cap", () => {
    const s = summarizePoll(2, [{ address: W, digest: "d", checkpoint: 1, reasons: ["value_out"] }], 3, [W]);
    expect(s.more_pending).toEqual([W]);
    expect(s.note).toMatch(/more happened than is listed/i);
    expect(s.note).toMatch(/never be fully reported/i);
  });

  it("reports saturation even when every hit was filtered out", () => {
    // A threshold can suppress all of them while the cap was still hit; the
    // caller still needs to know the read was partial.
    const s = summarizePoll(1, [], 1, [W]);
    expect(s.more_pending).toEqual([W]);
    expect(s.hits).toEqual([]);
  });

  it("stays silent and tiny when nothing was capped", () => {
    expect(summarizePoll(5, [], 1).more_pending).toBeUndefined();
  });
});

describe("evaluate — a transaction read in part", () => {
  it("marks the hit when its object changes ran past the page read", () => {
    const { hits } = evaluate(entry(), [{ ...tx(101, [[W, "5"], [OTHER, "-5"]]), object_changes_truncated: true }]);
    expect(hits[0]!.incomplete).toEqual(["object_changes"]);
  });

  it("leaves a fully read transaction unmarked", () => {
    const { hits } = evaluate(entry(), [tx(101, [[W, "5"], [OTHER, "-5"]])]);
    expect(hits[0]!.incomplete).toBeUndefined();
  });
});

describe("evaluate — objects, not just coins", () => {
  const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
  const addrOwner = (a: string) => ({ __typename: "AddressOwner", address: { address: a } });
  const st = (type: string, owner: unknown) => ({
    asMoveObject: { contents: { type: { repr: type } } },
    owner: owner as never,
  });
  const objTx = (type: string, from: string, to: string): DeltaTx => ({
    digest: "dobj",
    checkpoint: 101,
    balance_changes: [],
    object_movements: readObjectMovements([
      { address: "0xobj", idCreated: false, idDeleted: false, inputState: st(type, addrOwner(from)), outputState: st(type, addrOwner(to)) },
    ]),
  });

  /**
   * A capability changes hands with NO balance change, which is precisely the
   * transfer worth waking someone for: mint authority, upgrade rights.
   */
  it("fires capability_moved when mint authority leaves", () => {
    const { hits } = evaluate(entry(), [objTx(`${P2}::coin::TreasuryCap<0xa::t::T>`, W, OTHER)]);
    expect(hits[0]!.reasons).toContain("capability_moved");
    expect(hits[0]!.reasons).not.toContain("appeared");
    expect(hits[0]!.objects).toEqual(["coin::TreasuryCap"]);
    expect(hits[0]!.capability_note).toMatch(/create supply without limit/i);
  });

  it("reports an ordinary object move without the capability language", () => {
    const { hits } = evaluate(entry(), [objTx("0xabc::hero::Hero", W, OTHER)]);
    expect(hits[0]!.reasons).toEqual(["object_moved"]);
    expect(hits[0]!.capability_note).toBeUndefined();
  });

  /** An amount floor must never suppress a transfer that has no amount. */
  it("never suppresses a capability move on min_amount", () => {
    const { hits } = evaluate(entry({ min_amount: "99999999" }), [
      objTx(`${P2}::package::UpgradeCap`, W, OTHER),
    ]);
    expect(hits).toHaveLength(1);
  });

  it("ignores an object move between two other parties", () => {
    const { hits } = evaluate(entry(), [objTx("0xabc::hero::Hero", OTHER, SINK)]);
    expect(hits[0]!.reasons).toEqual(["appeared"]);
    expect(hits[0]!.objects).toBeUndefined();
  });

  /** A renounced capability is the opposite finding and must not read as theft. */
  it("does not call a renunciation a capability move", () => {
    const burn = `0x${"0".repeat(64)}`;
    const { hits } = evaluate(entry(), [objTx(`${P2}::package::UpgradeCap`, W, burn)]);
    expect(hits[0]!.reasons).toContain("object_moved");
    expect(hits[0]!.reasons).not.toContain("capability_moved");
  });
});

describe("flagLookalikes", () => {
  const WATCHED = `0xcafe${"1".repeat(56)}beef`;
  const TWIN = `0xcaf1${"2".repeat(56)}beef`;
  const hit = (counterparties: string[]) => ({
    address: WATCHED,
    digest: "d1",
    checkpoint: 1,
    reasons: ["value_in" as const],
    counterparties,
  });

  /**
   * The shape of address poisoning against an investigation: a lookalike of a
   * WATCHED address turns up as a new counterparty of that same wallet.
   */
  it("flags a new counterparty that resembles a watched address", () => {
    const out = flagLookalikes([WATCHED], [hit([TWIN])]);
    expect(out[0]!.reasons).toContain("lookalike_appeared");
  });

  it("does not flag an ordinary counterparty", () => {
    const out = flagLookalikes([WATCHED], [hit([`0x9999${"3".repeat(56)}0000`])]);
    expect(out[0]!.reasons).not.toContain("lookalike_appeared");
  });

  /**
   * Two watched addresses resembling each other is a fact about the watch set,
   * not an event. Re-reporting it every poll would be noise.
   */
  it("does not flag two watched addresses resembling each other", () => {
    const out = flagLookalikes([WATCHED, TWIN], [hit([TWIN])]);
    expect(out[0]!.reasons).not.toContain("lookalike_appeared");
  });

  it("leaves hits untouched when there are no counterparties", () => {
    const h = [{ address: WATCHED, digest: "d", checkpoint: 1, reasons: ["appeared" as const] }];
    expect(flagLookalikes([WATCHED], h)).toEqual(h);
  });
});

/**
 * One bad address must never cost the other nineteen their poll.
 *
 * The delta query interpolates a whole batch into one aliased GraphQL document,
 * and the service answers a single unparseable `SuiAddress` with a top-level
 * `data: null` rather than a null for that alias. Verified against mainnet: a
 * batch of two where one address was `not-an-address` returned no data for
 * either.
 */
describe("normalizeWatchAddress", () => {
  it("pads a short address to its canonical form", () => {
    expect(normalizeWatchAddress("0x2")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    );
  });

  it("accepts a full address and lowercases it", () => {
    const a = "0x" + "AB".repeat(32);
    expect(normalizeWatchAddress(a)).toBe("0x" + "ab".repeat(32));
  });

  it("rejects a non-hex string that normalization would happily pad", () => {
    // normalizeSuiAddress pads this into a 66-character string that LOOKS
    // well-formed, which is why validity is checked separately.
    expect(normalizeWatchAddress("not-an-address")).toBeNull();
  });

  it("rejects a value carrying GraphQL query text", () => {
    expect(normalizeWatchAddress('0xa"} b:__typename x{')).toBeNull();
  });

  it("rejects empty and whitespace", () => {
    expect(normalizeWatchAddress("")).toBeNull();
    expect(normalizeWatchAddress("   ")).toBeNull();
  });

  it("rejects an over-long address", () => {
    expect(normalizeWatchAddress("0x" + "a".repeat(65))).toBeNull();
  });
});

/**
 * `afterCheckpoint` is exclusive at CHECKPOINT granularity while the page cap
 * cuts at TRANSACTION granularity, so a full page usually ends part-way through
 * a checkpoint. Advancing to that checkpoint excludes the rest of it from every
 * future poll. Measured on one mainnet address: 30 transactions over 13
 * checkpoints, 8 of them holding more than one.
 */
describe("safeAdvance", () => {
  const tx = (checkpoint: number, digest = `d${checkpoint}`) => ({ digest, checkpoint });

  it("advances to the highest checkpoint when the page was not full", () => {
    expect(safeAdvance([tx(10), tx(11), tx(12)], false, 9)).toEqual({
      checkpoint: 12,
      stalled: false,
    });
  });

  it("stops one checkpoint short of a saturated page, so the boundary is re-read", () => {
    // The page ended inside checkpoint 12; transactions there that did not fit
    // would be excluded forever by afterCheckpoint: 12.
    expect(safeAdvance([tx(10), tx(11), tx(12)], true, 9)).toEqual({
      checkpoint: 11,
      stalled: false,
    });
  });

  it("does not advance when a full page sits inside one checkpoint", () => {
    // Stopping short cannot make progress and advancing drops the remainder,
    // so neither is chosen silently.
    expect(safeAdvance([tx(12, "a"), tx(12, "b")], true, 11)).toEqual({
      checkpoint: 11,
      stalled: true,
    });
  });

  it("never moves the cursor backwards", () => {
    // Spans two checkpoints, so this reaches the `Math.max(high - 1, current)`
    // guard rather than short-circuiting on the single-checkpoint stall.
    const r = safeAdvance([tx(10), tx(11)], true, 50);
    expect(r.checkpoint).toBe(50);
    expect(r.stalled).toBe(false);
  });

  /**
   * A FULL page is not the same claim as "there is more". At perAddress 1 every
   * non-empty page is full and sits in one checkpoint, so reading full as
   * saturated stalled the cursor on a single new transaction, forever.
   */
  it("advances on a single transaction when nothing more is pending", () => {
    expect(safeAdvance([tx(101)], false, 100)).toEqual({
      checkpoint: 101,
      stalled: false,
    });
  });

  it("leaves the cursor alone when nothing came back", () => {
    expect(safeAdvance([], false, 7)).toEqual({ checkpoint: 7, stalled: false });
  });
});

/**
 * The reason claims a new counterparty resembles a WATCHED address. Two
 * counterparties resembling each other says nothing about the subject, and
 * reporting it reads as impersonation of the address under investigation.
 */
describe("flagLookalikes only fires against a watched address", () => {
  // Every address here needs real entropy in the middle: `lowEntropy` drops a
  // candidate with four or fewer distinct hex characters (or a run of twelve
  // zeroes) BEFORE any bucketing, so a lazily built pair is discarded by the
  // filter rather than by the rule under test, and the assertion passes with
  // the fix reverted.
  const mid = (seed: string) => (seed + "13579bdf2468ace0").repeat(3).slice(0, 48);
  const WATCHED = "0xaaaabbbb" + mid("4f1c") + "ccccdddd";
  const LOOKALIKE = "0xaaaabbbb" + mid("9b7e") + "ccccdddd";
  const OTHER_A = "0xeeeeffff" + mid("2c6a") + "11112222";
  const OTHER_B = "0xeeeeffff" + mid("8d3b") + "11112222";

  const hit = (counterparties: string[]) => ({
    address: WATCHED,
    digest: "d",
    checkpoint: 1,
    reasons: ["value_in" as const],
    counterparties,
  });

  it("flags a counterparty that resembles the watched address", () => {
    const out = flagLookalikes([WATCHED], [hit([LOOKALIKE])]);
    expect(out[0]!.reasons).toContain("lookalike_appeared");
  });

  it("does NOT flag two counterparties that resemble only each other", () => {
    const out = flagLookalikes([WATCHED], [hit([OTHER_A, OTHER_B])]);
    expect(out[0]!.reasons).not.toContain("lookalike_appeared");
  });
});
