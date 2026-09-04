import { describe, it, expect } from "vitest";
import { chooseNextHop, type HopChange } from "../src/utils/trace-hop.js";

const SUI = "0x2::sui::SUI";
const USDC = "0xa::coin::USDC";
const attacker = "0xattacker";
const victim = "0xvictim";
const pool = "0xpool";

const noPools = () => false;

describe("chooseNextHop — backward", () => {
  it("follows the sender regardless of changes", () => {
    const d = chooseNextHop({
      sender: attacker,
      changes: [],
      actions: [],
      direction: "backward",
      trackedCoin: SUI,
      isPassThrough: noPools,
    });
    expect(d).toMatchObject({ nextAddress: attacker, nextCoinType: SUI, isSwap: false });
  });
});

describe("chooseNextHop — forward, plain transfer", () => {
  it("follows the recipient of the outflow", () => {
    const changes: HopChange[] = [
      { address: attacker, amount: "-1000", coin_type: SUI },
      { address: victim, amount: "1000", coin_type: SUI },
    ];
    const d = chooseNextHop({
      sender: attacker,
      changes,
      actions: ["Transfer to recipient"],
      direction: "forward",
      trackedCoin: SUI,
      isPassThrough: noPools,
    });
    expect(d.nextAddress).toBe(victim);
    expect(d.isSwap).toBe(false);
  });

  it("skips pool/protocol recipients when a real recipient exists", () => {
    const changes: HopChange[] = [
      { address: pool, amount: "500", coin_type: SUI },
      { address: victim, amount: "500", coin_type: SUI },
    ];
    const d = chooseNextHop({
      sender: attacker,
      changes,
      actions: ["Transfer to recipient"],
      direction: "forward",
      trackedCoin: SUI,
      isPassThrough: (a) => a === pool,
    });
    expect(d.nextAddress).toBe(victim);
  });

  it("falls back to a pool recipient when that's all there is, with a note", () => {
    const changes: HopChange[] = [{ address: pool, amount: "500", coin_type: SUI }];
    const d = chooseNextHop({
      sender: attacker,
      changes,
      actions: [],
      direction: "forward",
      trackedCoin: SUI,
      isPassThrough: (a) => a === pool,
    });
    expect(d.nextAddress).toBe(pool);
    expect(d.note).toMatch(/pool/i);
  });

  it("stops when there is no outflow to anyone else", () => {
    const d = chooseNextHop({
      sender: attacker,
      changes: [{ address: attacker, amount: "-1000", coin_type: SUI }],
      actions: [],
      direction: "forward",
      trackedCoin: SUI,
      isPassThrough: noPools,
    });
    expect(d.nextAddress).toBeNull();
  });
});

describe("chooseNextHop — forward, swap", () => {
  it("follows the swapper and switches the tracked coin to what they received", () => {
    // Attacker swaps SUI -> USDC on a pool: pays SUI, receives USDC.
    const changes: HopChange[] = [
      { address: attacker, amount: "-1000000000", coin_type: SUI },
      { address: pool, amount: "1000000000", coin_type: SUI },
      { address: attacker, amount: "2000000", coin_type: USDC },
      { address: pool, amount: "-2000000", coin_type: USDC },
    ];
    const d = chooseNextHop({
      sender: attacker,
      changes,
      actions: ["Swap SUI → USDC on Cetus"],
      direction: "forward",
      trackedCoin: SUI,
      isPassThrough: (a) => a === pool,
    });
    expect(d.isSwap).toBe(true);
    expect(d.nextAddress).toBe(attacker); // keep following the actor, not the pool
    expect(d.nextCoinType).toBe(USDC); // now track the output asset
    expect(d.note).toMatch(/swap/i);
  });
});

describe("chooseNextHop — split transfers", () => {
  const w1 = "0xw1";
  const w2 = "0xw2";
  const w3 = "0xw3";

  const split: HopChange[] = [
    { address: attacker, amount: "-6000", coin_type: SUI },
    { address: w1, amount: "1000", coin_type: SUI },
    { address: w2, amount: "3000", coin_type: SUI },
    { address: w3, amount: "2000", coin_type: SUI },
  ];

  it("reports every recipient it did not follow", () => {
    // Splitting funds across wallets is the ordinary laundering move. Reporting
    // only the followed branch reads as "the money went to w2" when it went to
    // three places.
    const d = chooseNextHop({
      sender: attacker,
      changes: split,
      actions: [],
      direction: "forward",
      trackedCoin: SUI,
      isPassThrough: noPools,
    });
    expect(d.nextAddress).toBe(w2);
    expect(d.unfollowed.map((u) => u.address).sort()).toEqual([w1, w3]);
  });

  it("follows the largest by value, not by array position", () => {
    // The old note claimed it followed "the largest" while taking
    // positiveToOthers[0] — first in the array, unsorted.
    const reordered = [split[0], split[1], split[3], split[2]];
    const d = chooseNextHop({
      sender: attacker,
      changes: reordered,
      actions: [],
      direction: "forward",
      trackedCoin: SUI,
      isPassThrough: noPools,
    });
    expect(d.nextAddress).toBe(w2);
  });

  it("ranks by USD, not raw units, across different coins", () => {
    // 1 USDC is 1e6 raw units and 1 SUI is 1e9, so a raw comparison ranks by
    // decimal places. Without prices this follows the dust.
    const mixed: HopChange[] = [
      { address: attacker, amount: "-1", coin_type: SUI },
      { address: w1, amount: "5000000000", coin_type: SUI }, // 5 SUI
      { address: w2, amount: "9000000", coin_type: USDC }, // 9 USDC
    ];
    const valueUsd = (c: HopChange) =>
      c.coin_type === SUI ? Number(c.amount) / 1e9 * 2 : Number(c.amount) / 1e6;

    const withPrices = chooseNextHop({
      sender: attacker, changes: mixed, actions: [], direction: "forward",
      trackedCoin: SUI, isPassThrough: noPools, valueUsd,
    });
    // 5 SUI at $2 = $10 beats 9 USDC.
    expect(withPrices.nextAddress).toBe(w1);
    expect(withPrices.unfollowed[0]).toMatchObject({ address: w2, usd_value: 9 });

    // Without prices, raw magnitude wins — which is why the USD path exists.
    const withoutPrices = chooseNextHop({
      sender: attacker, changes: mixed, actions: [], direction: "forward",
      trackedCoin: SUI, isPassThrough: noPools,
    });
    expect(withoutPrices.nextAddress).toBe(w1);
    expect(withoutPrices.unfollowed[0].usd_value).toBeNull();
  });

  it("marks a pool fallback so the caller knows the next hop is shared", () => {
    const d = chooseNextHop({
      sender: attacker,
      changes: [
        { address: attacker, amount: "-1000", coin_type: SUI },
        { address: pool, amount: "1000", coin_type: SUI },
      ],
      actions: [],
      direction: "forward",
      trackedCoin: SUI,
      isPassThrough: (a) => a === pool,
    });
    expect(d.basis).toBe("pool-fallback");
    expect(d.note).toMatch(/shared contract/i);
  });

  it("marks a plain transfer as direct and a swap as swap-follow", () => {
    const direct = chooseNextHop({
      sender: attacker,
      changes: [
        { address: attacker, amount: "-1000", coin_type: SUI },
        { address: victim, amount: "1000", coin_type: SUI },
      ],
      actions: [],
      direction: "forward",
      trackedCoin: SUI,
      isPassThrough: noPools,
    });
    expect(direct.basis).toBe("direct");

    const swap = chooseNextHop({
      sender: attacker,
      changes: [
        { address: attacker, amount: "-1000", coin_type: SUI },
        { address: attacker, amount: "500", coin_type: USDC },
      ],
      actions: ["Swap SUI → USDC on Cetus"],
      direction: "forward",
      trackedCoin: SUI,
      isPassThrough: noPools,
    });
    expect(swap.basis).toBe("swap-follow");
  });

  it("still reports other recipients paid on a swap hop", () => {
    // A swap that also pays a fee collector is common; that branch is dropped
    // too and should be visible.
    const d = chooseNextHop({
      sender: attacker,
      changes: [
        { address: attacker, amount: "-1000", coin_type: SUI },
        { address: attacker, amount: "500", coin_type: USDC },
        { address: w1, amount: "10", coin_type: SUI },
      ],
      actions: ["Swap SUI → USDC on Cetus"],
      direction: "forward",
      trackedCoin: SUI,
      isPassThrough: noPools,
    });
    expect(d.nextAddress).toBe(attacker);
    expect(d.unfollowed.map((u) => u.address)).toEqual([w1]);
  });
});
