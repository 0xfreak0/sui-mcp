import { describe, it, expect } from "vitest";
import {
  allocateFifo,
  meetingPoints,
  pathTo,
  splitInflow,
  splitOrigin,
  splitSpend,
  TerminalLedger,
  valueWeights,
} from "../src/utils/flow-graph.js";
import { SUI, USDC, CETUS } from "./helpers/trace-shapes.js";

const A = `0xa1${"1".repeat(62)}`;
const B = `0xb2${"2".repeat(62)}`;
const C = `0xc3${"3".repeat(62)}`;
const RELAYER = `0xd4${"4".repeat(62)}`;

/** $1 per whole SUI and per whole USDC; CETUS unpriced. */
const usd = (c: { amount: string; coin_type: string }) =>
  c.coin_type === SUI ? Number(c.amount) / 1e9 : c.coin_type === USDC ? Number(c.amount) / 1e6 : null;

describe("splitSpend", () => {
  it("splits a payment between recipients in proportion to what each received", () => {
    const s = splitSpend({
      sender: A,
      holder: A,
      changes: [
        { address: A, amount: "-100000000000", coin_type: SUI },
        { address: B, amount: "75000000000", coin_type: SUI },
        { address: C, amount: "25000000000", coin_type: SUI },
      ],
      actions: [],
      trackedCoin: SUI,
    });
    expect(s.total).toBe(100000000000n);
    expect(s.branches.map((b) => [b.address, b.weight])).toEqual([
      [B, 0.75],
      [C, 0.25],
    ]);
    expect(s.unallocated).toBe(0);
  });

  it("removes gas before measuring the holder's outflow", () => {
    // The payer's SUI change includes gas: without removing it, 1 SUI of the
    // 101 reads as burned rather than paid.
    const s = splitSpend({
      sender: A,
      holder: A,
      changes: [
        { address: A, amount: "-101000000000", coin_type: SUI },
        { address: B, amount: "100000000000", coin_type: SUI },
      ],
      actions: [],
      trackedCoin: SUI,
      gas: { payer: A, net: 1000000000n },
    });
    expect(s.total).toBe(100000000000n);
    expect(s.unallocated).toBe(0);
    expect(s.branches[0].weight).toBe(1);
  });

  it("follows the holder into what it swapped for", () => {
    const s = splitSpend({
      sender: A,
      holder: A,
      changes: [
        { address: A, amount: "-10000000000", coin_type: SUI },
        { address: A, amount: "34000000", coin_type: USDC },
      ],
      actions: ["Swap SUI → USDC on Cetus"],
      trackedCoin: SUI,
      valueUsd: usd,
    });
    expect(s.branches).toEqual([
      { address: A, coin_type: USDC, amount: 34000000n, weight: 1, basis: "swap-follow" },
    ]);
  });

  it("credits a swap's proceeds to the traced coin only in proportion to its part of the input", () => {
    // 1 SUI and 999 USDC in, 1,000 CETUS out: the SUI bought a thousandth.
    const s = splitSpend({
      sender: A,
      holder: A,
      changes: [
        { address: A, amount: "-1000000000", coin_type: SUI },
        { address: A, amount: "-999000000", coin_type: USDC },
        { address: A, amount: "1000000000000", coin_type: CETUS },
      ],
      actions: ["Swap on Cetus"],
      trackedCoin: SUI,
      valueUsd: usd,
    });
    expect(s.branches).toHaveLength(1);
    expect(s.branches[0].amount).toBe(1000000000n);
    expect(s.branches[0].weight).toBe(1);
  });

  it("leaves a bridge exit's remainder as the exit, not as a relayer's conversion", () => {
    // A CCTP burn whose relayer receives a SUI gas drop: without the exit
    // flag the USDC reads as converted into the relayer's SUI.
    const changes = [
      { address: A, amount: "-500000000", coin_type: USDC },
      { address: RELAYER, amount: "1000000000", coin_type: SUI },
    ];
    const asExit = splitSpend({ sender: A, holder: A, changes, actions: [], trackedCoin: USDC, bridgeExit: true });
    expect(asExit.branches).toEqual([]);
    expect(asExit.unallocated).toBe(1);
    const plain = splitSpend({ sender: A, holder: A, changes, actions: [], trackedCoin: USDC });
    expect(plain.branches.map((b) => [b.address, b.basis])).toEqual([[RELAYER, "conversion"]]);
  });

  it("marks value no address received as unallocated", () => {
    const s = splitSpend({
      sender: A,
      holder: A,
      changes: [
        { address: A, amount: "-100", coin_type: SUI },
        { address: B, amount: "40", coin_type: SUI },
      ],
      actions: [],
      trackedCoin: SUI,
    });
    expect(s.branches[0].weight).toBeCloseTo(0.4);
    expect(s.unallocated).toBeCloseTo(0.6);
  });

  it("does not follow another party's gains when an object released the funds", () => {
    // The holder is an object; the sender claimed. Only the holder's own
    // outflow is being split, and the sender's gain is not a swap of it.
    const s = splitSpend({
      sender: C,
      holder: B,
      changes: [
        { address: B, amount: "-100", coin_type: SUI },
        { address: C, amount: "100", coin_type: SUI },
      ],
      actions: [],
      trackedCoin: SUI,
    });
    expect(s.branches.map((b) => [b.address, b.basis, b.weight])).toEqual([[C, "direct", 1]]);
  });
});

describe("splitOrigin", () => {
  it("roots an exploit that credits only its sender at the sender", () => {
    const s = splitOrigin({
      changes: [{ address: A, amount: "144834000000000", coin_type: SUI }],
      trackedCoin: null,
      gas: { payer: A, net: 5000000n },
    });
    expect(s.branches.map((b) => [b.address, b.coin_type, b.basis])).toEqual([[A, SUI, "origin"]]);
  });

  it("gives an unpriced coin next to priced ones no share", () => {
    const s = splitOrigin({
      changes: [
        { address: A, amount: "10000000000", coin_type: SUI },
        { address: A, amount: "999999999999999", coin_type: CETUS },
      ],
      trackedCoin: null,
      valueUsd: usd,
    });
    expect(s.branches.map((b) => b.coin_type)).toEqual([SUI]);
  });
});

describe("splitInflow", () => {
  it("names every payer of the tracked coin, weighted by what each paid", () => {
    const s = splitInflow({
      sender: B,
      recipient: A,
      changes: [
        { address: B, amount: "-30", coin_type: SUI },
        { address: C, amount: "-10", coin_type: SUI },
        { address: A, amount: "40", coin_type: SUI },
      ],
      actions: [],
      trackedCoin: SUI,
      isPassThrough: () => false,
    });
    expect(s.branches.map((b) => [b.address, b.weight])).toEqual([
      [B, 0.75],
      [C, 0.25],
    ]);
  });

  it("follows the recipient's own swap back into the asset it paid", () => {
    const s = splitInflow({
      sender: A,
      recipient: A,
      changes: [
        { address: A, amount: "-34000000", coin_type: USDC },
        { address: A, amount: "10000000000", coin_type: SUI },
      ],
      actions: ["Swap USDC → SUI"],
      trackedCoin: SUI,
      isPassThrough: () => false,
    });
    expect(s.branches.map((b) => [b.address, b.coin_type, b.basis])).toEqual([[A, USDC, "swap-follow"]]);
  });

  it("reports a mint or withdrawal as unallocated rather than inventing a payer", () => {
    const s = splitInflow({
      sender: A,
      recipient: A,
      changes: [{ address: A, amount: "100", coin_type: SUI }],
      actions: [],
      trackedCoin: SUI,
      isPassThrough: () => false,
    });
    expect(s.branches).toEqual([]);
    expect(s.unallocated).toBe(1);
  });
});

describe("allocateFifo", () => {
  it("spends the traced amount first-in first-out and stops once it is covered", () => {
    const r = allocateFifo(
      [
        { amount: 60n, coin_type: SUI },
        { amount: 60n, coin_type: SUI },
        { amount: 60n, coin_type: SUI },
      ],
      100n,
    );
    expect(r.allocated).toEqual([60n, 40n, 0n]);
    expect(r.fractions).toEqual([0.6, 0.4, 0]);
    expect(r.remaining).toBe(0);
  });

  it("leaves the unspent part as remaining when the moves fall short", () => {
    const r = allocateFifo([{ amount: 25n, coin_type: SUI }], 100n);
    expect(r.remaining).toBe(0.75);
  });

  it("weights an address start's moves by value, since there is no amount to cover", () => {
    const r = allocateFifo(
      [
        { amount: 1n, coin_type: SUI, usd: 30 },
        { amount: 1n, coin_type: USDC, usd: 10 },
      ],
      null,
    );
    expect(r.fractions).toEqual([0.75, 0.25]);
  });
});

describe("valueWeights", () => {
  it("splits evenly when nothing across several coins is priced", () => {
    const r = valueWeights(
      [
        { amount: 1n, coin_type: SUI },
        { amount: 1000n, coin_type: CETUS },
      ],
      () => null,
    );
    expect(r).toEqual({ weights: [0.5, 0.5], weighting: "equal" });
  });

  it("compares one coin by raw amount without prices", () => {
    expect(valueWeights([{ amount: 3n, coin_type: SUI }, { amount: 1n, coin_type: SUI }]).weights).toEqual([0.75, 0.25]);
  });
});

describe("TerminalLedger", () => {
  it("sums shares by reason and merges repeats of the same node", () => {
    const l = new TerminalLedger();
    l.add("bridge_exit", { node: "exit:x", share: 0.5, usd: 100 });
    l.add("bridge_exit", { node: "exit:x", share: 0.2, usd: null });
    l.add("unspent", { node: "a", share: 0.3, usd: 60, detail: "held" });
    const s = l.summary();
    expect(s.map((g) => [g.code, g.share])).toEqual([
      ["bridge_exit", 0.7],
      ["unspent", 0.3],
    ]);
    expect(s[0].entries).toHaveLength(1);
    expect(l.total()).toBeCloseTo(1);
  });
});

describe("paths", () => {
  it("walks first-arrival edges back to the root", () => {
    const parent = new Map([
      ["b", { edge: "a>b", from: "a" }],
      ["c", { edge: "b>c", from: "b" }],
    ]);
    expect(pathTo("c", parent).map((s) => s.edge)).toEqual(["a>b", "b>c"]);
  });

  it("joins the two searches only where the money arrived before it moved on", () => {
    const forward = new Map([["x|SUI", { address: "x", arrivedAt: 100 }]]);
    const early = new Map([["x|SUI", { address: "x", arrivedAt: 90 }]]);
    const late = new Map([["x|USDC", { address: "x", arrivedAt: 120 }]]);
    expect(meetingPoints(forward, early)).toEqual([]);
    expect(meetingPoints(forward, late)).toEqual([{ forwardNode: "x|SUI", backwardNode: "x|USDC", address: "x" }]);
  });
});
