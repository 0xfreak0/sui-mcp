import { describe, expect, it } from "vitest";
import { checkableStakeWithdrawal, oracleDrawState, oracleRequested, stakeDrawExhausted } from "../scripts/probe/lib/oracle-draws.mjs";

const defaults = { pinned: null, txs: 4, ends: 6, router: 6, coins: 6 };

describe("oracle draw policy", () => {
  it("does not require a holder comparison when the coin source is disabled", () => {
    const disabled = { ...defaults, ends: 0, coins: 0, router: 2 };
    expect(oracleRequested("h", disabled)).toBe(false);
    expect(oracleRequested("d", disabled)).toBe(false);
    expect(oracleRequested("f", disabled)).toBe(false);
    expect(oracleRequested("b", disabled)).toBe(false);
    expect(oracleRequested("k", disabled)).toBe(true);
    expect(oracleDrawState("h", disabled, 0)).toBe("not_drawn");
    expect(oracleDrawState("k", disabled, 0)).toBe("unchecked");
  });

  it("requests every oracle under the default bounds and only the chain-wide ones with every source off", () => {
    const ids = "abcdefghijkl".split("");
    expect(ids.filter((id) => oracleRequested(id, defaults))).toEqual(ids);
    const off = { pinned: null, txs: 0, ends: 0, router: 0, coins: 0 };
    expect(ids.filter((id) => oracleRequested(id, off))).toEqual(["i", "j", "k", "l"]);
  });

  it("still requires an enabled oracle to check at least one subject", () => {
    expect(oracleRequested("h", defaults)).toBe(true);
    expect(oracleRequested("k", defaults)).toBe(true);
    expect(oracleRequested("h", { ...defaults, pinned: { h: [] } })).toBe(false);
    expect(oracleRequested("h", { ...defaults, coins: 0, pinned: { h: ["0x2::sui::SUI"] } })).toBe(true);
    expect(oracleRequested("g", { ...defaults, txs: 0, router: 2 })).toBe(false);
    expect(oracleDrawState("h", defaults, 0)).toBe("unchecked");
    expect(oracleDrawState("h", defaults, 1)).toBe("checked");
    expect(oracleDrawState("h", { ...defaults, pinned: { h: [] } }, 0)).toBe("not_drawn");
    expect(oracleDrawState("h", { ...defaults, coins: 0, pinned: { h: ["0x2::sui::SUI"] } }, 0)).toBe("unchecked");
    expect(oracleDrawState("i", { ...defaults, stakeBoundReached: true }, 0)).toBe("drawn_but_unverifiable");
    expect(oracleDrawState("i", { ...defaults, stakeBoundReached: true }, 1)).toBe("checked");
    expect(oracleDrawState("i", defaults, 0)).toBe("unchecked");
  });
});

describe("stake draw bound", () => {
  const base = { wanted: 3, maxReads: 60, lastPage: false, more: true };
  it("is exhausted only when the bound stopped it short of its subjects", () => {
    expect(stakeDrawExhausted({ ...base, found: 1, reads: 60 })).toBe(true);
    expect(stakeDrawExhausted({ ...base, found: 0, reads: 12, lastPage: true })).toBe(true);
    // Three subjects found on the last read or page: the bound did not cut the draw.
    expect(stakeDrawExhausted({ ...base, found: 3, reads: 60 })).toBe(false);
    expect(stakeDrawExhausted({ ...base, found: 3, reads: 9, lastPage: true })).toBe(false);
    // The range ended before the bound: nothing left to read.
    expect(stakeDrawExhausted({ ...base, found: 0, reads: 12, lastPage: true, more: false })).toBe(false);
    expect(stakeDrawExhausted({ ...base, found: 2, reads: 30 })).toBe(false);
  });
});

describe("stake withdrawal candidates", () => {
  const stake = "0x3::staking_pool::StakedSui";
  const event = { type: "0x3::validator::UnstakingRequestEvent" };
  const tx = (change: Record<string, unknown>, events: unknown[] = [event]) => ({
    sender: "0x4", checkpoint: 30, events, changes: new Map([["stake", change]]),
  });

  it("requires a deleted pre-existing StakedSui and withdrawal event", () => {
    expect(checkableStakeWithdrawal(tx({ deleted: true, input: { type: stake } }))).toBe(true);
    expect(checkableStakeWithdrawal(tx({ deleted: true, input: { type: "0x3::staking_pool::FungibleStakedSui" } }))).toBe(false);
    expect(checkableStakeWithdrawal(tx({ deleted: true, input: null }))).toBe(false);
    expect(checkableStakeWithdrawal(tx({ deleted: true, input: { type: stake } }, []))).toBe(false);
    expect(checkableStakeWithdrawal({ ...tx({ deleted: true, input: { type: stake } }), checkpoint: 1 })).toBe(false);
  });
});
