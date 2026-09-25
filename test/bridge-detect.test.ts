import { describe, it, expect } from "vitest";
import {
  detectBridges,
  resolvableHit,
  type BridgeHit,
  type CallSite,
} from "../src/utils/bridge/detect.js";

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
    expect(hits.find((h) => h.protocol === "Circle CCTP")?.resolution).toBe("identifier");
    expect(resolvableHit(hits)?.protocol).toBe("Wormhole");
  });

  it("returns no resolvable hit when only detect-only bridges are present", () => {
    // The caller must not be told to run a resolver that cannot help. Meson
    // is the detect-only case: its destination is not in Sui data at all.
    const hits = detectBridges([
      { packageId: "0xf0509f8b", module: "MesonSwap", function: "postSwapFromInitiator" },
    ]);
    expect(hits[0].protocol).toBe("Meson");
    expect(resolvableHit(hits)).toBeNull();
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

  it("does not call a Pyth price update through Wormhole core a bridge exit", () => {
    // EpA8fqmv… is a NAVI deposit of 400 SUI. Its Pyth update verifies a VAA
    // in the Wormhole core package, which the registry types `bridge`; the
    // registry tier reported "Value left Sui via Wormhole".
    const naviDeposit: CallSite[] = [
      { packageId: "0x99de5c967d8206ef4b75c0afab3df2a59eb02b05c282821db803831008ac25b4", module: "vaa", function: "parse_and_verify" },
      { packageId: "0x55300367a2d40813727ccac4ecee977a39fb9cdb46f2e6b2c354b9798f5de2c0", module: "pyth", function: "update_single_price_feed" },
      { packageId: "0x512f2826", module: "incentive_v3", function: "entry_deposit" },
    ];
    expect(detectBridges(naviDeposit, ["0x55300367::event::PriceFeedUpdateEvent"])).toEqual([]);
  });

  it("matches an event marker on a generic event type", () => {
    // A type argument ends the type string, so a suffix test on the raw repr
    // never matched a generic event.
    const hits = detectBridges([], ["0x5306f64e::publish_message::WormholeMessage<0x1::coin::COIN>"]);
    expect(hits.map((h) => h.protocol)).toEqual(["Wormhole"]);
    expect(detectBridges([], ["0xabc::xpublish_message::WormholeMessage"])).toEqual([]);
  });

  it("finds an exit reached through a wrapper package from its events", () => {
    // 777Emr4V…: Mayan's bridge_with_fee wrapper burns USDC over CCTP to Base.
    // No marker call is in the PTB; the events are the only signal.
    const hits = detectBridges(
      [{ packageId: "0xb5bd3599", module: "bridge_with_fee", function: "prepare_bridge_with_fee" }],
      [
        "0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e::deposit_for_burn::DepositForBurn",
        "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a::publish_message::WormholeMessage",
        "0xb5bd3599ec7f4ae86afd84398f6f2d862deecce965e8ace2d8d8c8108d5076df::init_order::InitMctpLogged",
      ],
    );
    expect(hits.map((h) => h.protocol).sort()).toEqual(["Circle CCTP", "Mayan MCTP", "Wormhole"]);
  });
});

describe("Sui native bridge detection", () => {
  it("detects an outbound send_token, including the v2 variant", () => {
    for (const fn of ["send_token", "send_token_v2"]) {
      const hits = detectBridges([
        {
          packageId: "0x000000000000000000000000000000000000000000000000000000000000000b",
          module: "bridge",
          function: fn,
        },
      ]);
      expect(hits[0]?.protocol).toBe("Sui Bridge");
      expect(hits[0]?.resolution).toBe("identifier");
    }
  });

  it("detects the deposit event", () => {
    const hits = detectBridges([], ["0x0b::bridge::TokenDepositedEvent"]);
    expect(hits[0]?.protocol).toBe("Sui Bridge");
  });

  it("does not treat an inbound claim as an exit", () => {
    // TokenTransferClaimed is value ARRIVING on Sui. Calling it an exit would
    // send an investigator to the wrong chain.
    expect(detectBridges([], ["0x0b::bridge::TokenTransferClaimed"])).toEqual([]);
  });
});

describe("Mayan MCTP", () => {
  it("names the service alongside the bridge legs it routes over", () => {
    // Captured from mainnet 7g4nQFx…JWPX, which settles through Wormhole and
    // CCTP in one PTB. All three belong in the answer: the legs are what to
    // follow, the service is who initiated it.
    const hits = detectBridges([
      { packageId: "0xc6c1c127", module: "calculate_mctp_fee", function: "prepare_calc_mctp_fee" },
      { packageId: "0xb5bd3599", module: "init_order", function: "log_initialize_mctp" },
      { packageId: "0x2aa6c5d5", module: "deposit_for_burn", function: "deposit_for_burn_with_caller_with_package_auth" },
      { packageId: "0x5306f64e", module: "publish_message", function: "publish_message" },
    ]);
    expect(hits.map((h) => h.protocol).sort()).toEqual([
      "Circle CCTP",
      "Mayan MCTP",
      "Wormhole",
    ]);
    // resolve_bridge_transfer reads the beneficiary from the order event.
    expect(hits.find((h) => h.protocol === "Mayan MCTP")?.resolution).toBe("identifier");
  });

  it("does not fire on a DEX order book", () => {
    // The reason the markers carry "mctp" rather than the generic `init_order`
    // module: order events are among the most frequent on mainnet.
    expect(
      detectBridges(
        [{ packageId: "0xdex", module: "init_order", function: "initialize_order" }],
        ["0xdex::order::OrderCanceled", "0xdex::order_info::OrderPlaced"],
      ),
    ).toEqual([]);
  });
});

describe("address-label provenance", () => {
  it("is a distinct, weaker basis than a call or event match", () => {
    // A labeled bridge is an investigator's assertion, not something read off
    // the transaction — and it is the case curated markers miss: a relayer
    // forward, an unlisted protocol, a plain transfer into a deposit address.
    // Reporting it under the same `matched` value as a call match would let the
    // weaker claim borrow the stronger one's standing.
    const bases: Array<BridgeHit["matched"]> = [
      "call",
      "event",
      "protocol-registry",
      "address-label",
    ];
    expect(new Set(bases).size).toBe(4);
  });
});
