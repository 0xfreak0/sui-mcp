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
