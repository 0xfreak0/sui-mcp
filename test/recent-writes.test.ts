import { describe, it, expect } from "vitest";
import { consequencesOf, decisiveChanges, recentWriteAnomaly, type ForeignWrite } from "../src/utils/recent-writes.js";

const SIGNER = `0x${"a".repeat(64)}`;
const COLLECTOR = `0x${"c".repeat(64)}`;
const OTHER = `0x${"d".repeat(64)}`;
const SUI = "0x2::sui::SUI";

const tx = {
  sender: SIGNER,
  balanceChanges: [
    { address: SIGNER, coinType: SUI, amount: "-5367827991" },
    { address: COLLECTOR, coinType: SUI, amount: "4025870993" },
  ],
  movements: [],
};

describe("consequencesOf", () => {
  it("collects the addresses other than the signer that gained, and every amount moved", () => {
    const c = consequencesOf(tx);
    expect([...c.recipients]).toEqual([COLLECTOR]);
    expect([...c.amounts].sort()).toEqual(["4025870993", "5367827991"]);
  });
});

describe("decisiveChanges", () => {
  const c = consequencesOf(tx);

  it("keeps a flipped boolean, an address set to a gainer and a number set to an amount moved, lists included", () => {
    const before = { initialized: false, wallet: OTHER, details: { coin_details: [{ amount: "0" }] }, counter: "7" };
    const after = { initialized: true, wallet: COLLECTOR, details: { coin_details: [{ amount: "5367827991" }] }, counter: "8" };
    expect(decisiveChanges(before, after, c)).toEqual([
      { path: "initialized", kind: "gate", before: "false", after: "true" },
      { path: "wallet", kind: "recipient", before: OTHER, after: COLLECTOR },
      { path: "details.coin_details[0].amount", kind: "amount", before: "0", after: "5367827991" },
    ]);
  });

  it("ignores reserves, prices and counters that moved, an address that gains nothing, and fields that did not exist before", () => {
    const before = { reserve: "1000", price: "740500000", owner: OTHER };
    const after = { reserve: "1200", price: "741000000", owner: `0x${"e".repeat(64)}`, added: true };
    expect(decisiveChanges(before, after, c)).toEqual([]);
  });
});

describe("recentWriteAnomaly", () => {
  const write = (ms_before: number): ForeignWrite => ({
    object: "0xparams",
    object_type: "0x1::claim::ClaimParams",
    writer: OTHER,
    digest: "D",
    ms_before,
    changed: [{ path: "initialized", kind: "gate", before: "false", after: "true" }],
  });

  it("grades by recency and by the value the signer lost to others", () => {
    expect(recentWriteAnomaly([write(935)], 2400)?.severity).toBe("high");
    expect(recentWriteAnomaly([write(30_000)], 2400)?.severity).toBe("medium");
    expect(recentWriteAnomaly([write(935)], 0.2)?.severity).toBe("info");
    expect(recentWriteAnomaly([], 2400)).toBeNull();
  });
});
