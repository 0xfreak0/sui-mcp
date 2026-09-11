import { describe, it, expect } from "vitest";
import {
  evaluate,
  planBatches,
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
