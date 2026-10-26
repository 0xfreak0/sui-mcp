import { describe, expect, it } from "vitest";
import { buyerReceivedLaunchCoin, creatorPaid, launchTopup, SUI_LAUNCH_TYPE } from "../src/utils/launch-evidence.js";

const creator = "0xc0";
const buyer = "0xb1";
const sponsor = "0x5a";
const destination = "0xd1";
const change = (address: string, amount: bigint, coin_type = SUI_LAUNCH_TYPE) => ({ address, amount, coin_type });

describe("launch payment evidence", () => {
  it("never attributes a gas sponsor debit or rebate as launch funding", () => {
    expect(launchTopup({
      sender: creator, sponsor, gas: 20n, changes: [
        change(creator, -10n), change(buyer, 10n), change(sponsor, -20n)
      ]
    }, buyer)).toEqual({ source: creator, amountMist: 10n });
    expect(launchTopup({
      sender: creator, sponsor: buyer, gas: 20n, changes: [
        change(creator, -10n), change(buyer, 3n)
      ]
    }, buyer)).toBeNull();
    expect(launchTopup({
      sender: creator, sponsor: null, gas: 30n, changes: [
        change(creator, -40n), change(buyer, 10n)
      ]
    }, buyer)).toEqual({ source: creator, amountMist: 10n });
  });

  it("requires an actual creator debit in the credited asset and excludes sponsor rebates", () => {
    const token = "0x2::coin::TEST";
    expect(creatorPaid({
      sender: creator, sponsor, gas: 100n, changes: [
        change(creator, -9n, token), change(destination, 9n, token), change(sponsor, 20n)
      ]
    }, creator, destination, token)).toBe(9n);
    expect(creatorPaid({
      sender: creator, sponsor, gas: 100n, changes: [
        change(sponsor, 9n), change(creator, -100n)
      ]
    }, creator, sponsor, SUI_LAUNCH_TYPE)).toBe(0n);
    expect(creatorPaid({
      sender: creator, sponsor: null, gas: 5n, changes: [
        change(creator, -5n), change(destination, 10n)
      ]
    }, creator, destination, SUI_LAUNCH_TYPE)).toBe(0n);
    expect(creatorPaid({
      sender: creator, sponsor: null, gas: 5n, changes: [
        change(creator, -15n), change(destination, 10n)
      ]
    }, creator, destination, SUI_LAUNCH_TYPE)).toBe(10n);
  });

  it("flags session-signing keys that did not receive the event's tokens", () => {
    const token = "0x2::coin::TEST";
    const tx = { sender: buyer, sponsor: null, gas: 1n, changes: [change(buyer, -10n), change("0xsession", 100n, token)] };
    expect(buyerReceivedLaunchCoin(tx, buyer, token)).toBe(false);
    expect(buyerReceivedLaunchCoin({ ...tx, changes: [change(buyer, 100n, token)] }, buyer, token)).toBe(true);
  });
});
