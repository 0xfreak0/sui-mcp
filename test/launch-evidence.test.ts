import { describe, expect, it } from "vitest";
import { buyerReceivedLaunchCoin, creatorPaid, launchAccountingComplete, launchTotalsPartial, launchTopup, SUI_LAUNCH_TYPE, uniqueCreatorPayments } from "../src/utils/launch-evidence.js";
import { scoreLaunch, type LaunchBuyer } from "../src/utils/launch-scoring.js";

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
  it("deduplicates a creator payment found through both a shared destination and buyer pair", () => {
    const sharedDestination = "0xd11";
    const payment = { to: sharedDestination, asset: "sui" as const, amount: 600_000_000n, digest: "creator-to-buyer" };
    const buyerAt = (address: string): LaunchBuyer => ({
      address, funding: [], payments: [], referrals: [], suinsNames: [],
      transfers: [{ destination: sharedDestination, asset: "sui", amount: 2_000_000_000n, digest: `${address}-forward`, qualifies: true }]
    });
    const buyers = [buyerAt(buyer), buyerAt("0xb2")];
    const destinations = [{ address: sharedDestination, kind: "wallet" as const, popularity: "narrow" as const }];
    const input = (payments: typeof payment[]) => ({
      creator: { address: creator, payments }, buyers, destinations, totalSupplyRaw: 1_000_000_000n
    });
    expect(scoreLaunch(input([payment, payment])).pairs.some(pair => pair.signals.some(signal => signal.type === "creator_linked_destination"))).toBe(true);
    const unique = uniqueCreatorPayments([[payment], [payment], [{ ...payment, asset: "token" as const }]]);
    expect(unique).toHaveLength(2);
    expect(uniqueCreatorPayments([[payment], [payment]])).toEqual([payment]);
    const result = scoreLaunch(input([unique[0]]));
    expect(result.pairs.find(pair => pair.a === creator || pair.b === creator)).toBeUndefined();
    expect(result.destinations.find(row => row.address === sharedDestination)?.affiliation).toBe("buyer_shared");
  });

  it("marks unread pool swaps as partial even when window balances reconcile", () => {
    expect(launchAccountingComplete(true, true, 0)).toBe(true);
    expect(launchAccountingComplete(true, true, 1)).toBe(false);
    expect(launchAccountingComplete(true, false, 0)).toBe(false);
    expect(launchTotalsPartial([{ raw: { unread_pool_events: 0 } }])).toBe(false);
    expect(launchTotalsPartial([{ raw: { unread_pool_events: 0 } }, { raw: { unread_pool_events: 1 } }])).toBe(true);
  });
});
