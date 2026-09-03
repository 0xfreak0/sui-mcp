import { describe, it, expect } from "vitest";
import { detectBridges, resolvableHit, type CallSite } from "../src/utils/bridge/detect.js";

/**
 * Move calls captured from mainnet transaction
 * 7g4nQFxU4sP7DRWG8kJSAYLCnyVTxc1VefThUYAUnBLh, which exits through both
 * Wormhole and Circle CCTP in one PTB.
 */
const REAL_CALLS: CallSite[] = [
  { packageId: "0x1eabed72", module: "pool", function: "swap" },
  {
    packageId: "0x2aa6c5d5",
    module: "deposit_for_burn",
    function: "deposit_for_burn_with_caller_with_package_auth",
  },
  { packageId: "0x5306f64e", module: "publish_message", function: "publish_message" },
];

describe("detectBridges", () => {
  it("finds both bridges used in one real transaction", () => {
    const hits = detectBridges(REAL_CALLS);
    expect(hits.map((h) => h.protocol).sort()).toEqual(["Circle CCTP", "Wormhole"]);
  });

  it("matches a call-name variant by prefix", () => {
    // Mainnet uses deposit_for_burn_with_caller_with_package_auth; an exact
    // match on the bare name would miss every real CCTP transfer.
    const hits = detectBridges([REAL_CALLS[1]]);
    expect(hits[0].protocol).toBe("Circle CCTP");
    expect(hits[0].matched).toBe("call");
  });

  it("separates what can be followed from what can only be named", () => {
    const hits = detectBridges(REAL_CALLS);
    expect(hits.find((h) => h.protocol === "Wormhole")?.resolution).toBe("identifier");
    expect(hits.find((h) => h.protocol === "Circle CCTP")?.resolution).toBe("detect-only");
    expect(resolvableHit(hits)?.protocol).toBe("Wormhole");
  });

  it("returns no resolvable hit when only detect-only bridges are present", () => {
    // The caller must not be told to run a resolver that cannot help.
    expect(resolvableHit(detectBridges([REAL_CALLS[1]]))).toBeNull();
  });

  it("detects from events as well as calls", () => {
    const hits = detectBridges(
      [],
      ["0x5306f64e::publish_message::WormholeMessage"],
    );
    expect(hits[0].protocol).toBe("Wormhole");
    expect(hits[0].matched).toBe("event");
  });

  it("says nothing about ordinary traffic", () => {
    // No heuristic tier: guessing that an unknown package "looks bridge-shaped"
    // would manufacture exactly the unverifiable attribution this repo refuses
    // to ship.
    expect(detectBridges([{ packageId: "0xdeadbeef", module: "pool", function: "swap" }])).toEqual(
      [],
    );
  });

  it("does not report one protocol twice when call and registry both match", () => {
    const hits = detectBridges([
      { packageId: "0x5306f64e", module: "publish_message", function: "publish_message" },
      { packageId: "0x5306f64e", module: "publish_message", function: "publish_message" },
    ]);
    expect(hits).toHaveLength(1);
  });

  it("catches a curated bridge package with no marker of its own", () => {
    // The general tier: any package typed `bridge` in protocols.json is
    // detected with no per-protocol work, which is what makes adding a bridge
    // a one-line change rather than a new resolver.
    const hits = detectBridges([
      {
        packageId: "0x99de5c967d8206ef4b75c0afab3df2a59eb02b05c282821db803831008ac25b4",
        module: "whatever",
        function: "unknown_entry",
      },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].matched).toBe("protocol-registry");
    expect(hits[0].resolution).toBe("detect-only");
  });
});
