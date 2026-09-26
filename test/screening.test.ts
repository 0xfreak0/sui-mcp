import { describe, expect, it } from "vitest";
import { bridgeExitsOf, bridgeSentPerCoin, flowsOf, hitsFor, timeConsistent, type Leg, type ScreenTx } from "../src/utils/screening.js";
import { runWithNetwork } from "../src/config.js";

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const A = "0x" + "a1".repeat(32);
const B = "0x" + "b2".repeat(32);
const C = "0x" + "c3".repeat(32);
const SPONSOR = "0x85c81a4f616f87a303ba2ae34eed758a2cc1938f80c186526cd3122375b87a95";

const tx = (over: Partial<ScreenTx>): ScreenTx => ({
  digest: "d",
  timestamp: "2025-05-22T11:00:00Z",
  sender: A,
  status: "success",
  gasSponsor: A,
  netGas: null,
  changes: [],
  calls: [],
  eventTypes: [],
  ...over,
});

describe("flowsOf", () => {
  it("pairs the subject with counterparties that moved the same coin the opposite way", () => {
    const f = flowsOf(A, [
      tx({ digest: "pay", changes: [{ owner: A, coinType: SUI, amount: -100n }, { owner: B, coinType: SUI, amount: 99n }] }),
      tx({ digest: "recv", sender: C, gasSponsor: C, changes: [{ owner: C, coinType: USDC, amount: -5n }, { owner: A, coinType: USDC, amount: 5n }] }),
    ]);
    expect(f.out.get(B)).toEqual([{ digest: "pay", timestamp: "2025-05-22T11:00:00Z", coinType: SUI, amount: 99n }]);
    expect(f.in.get(C)).toEqual([{ digest: "recv", timestamp: "2025-05-22T11:00:00Z", coinType: USDC, amount: 5n }]);
    expect(f.out.has(C)).toBe(false);
  });

  it("does not read the other side of a swap on a different coin as a payment", () => {
    // A pays SUI and gains USDC; the account that gained SUI is a payee, but a
    // third account losing USDC is not "someone A paid".
    const f = flowsOf(A, [
      tx({
        changes: [
          { owner: A, coinType: SUI, amount: -10n },
          { owner: A, coinType: USDC, amount: 30n },
          { owner: B, coinType: USDC, amount: -30n },
        ],
      }),
    ]);
    expect(f.out.size).toBe(0);
    expect([...f.in.keys()]).toEqual([B]);
  });

  it("never treats a gas sponsor's SUI change as a leg, gas or storage rebate", () => {
    const f = flowsOf(A, [
      tx({
        gasSponsor: SPONSOR,
        changes: [
          { owner: A, coinType: SUI, amount: -1_000n },
          { owner: SPONSOR, coinType: SUI, amount: 5_748_960n },
          { owner: B, coinType: SUI, amount: 1_000n },
        ],
      }),
    ]);
    expect([...f.out.keys()]).toEqual([B]);
  });
});

describe("timeConsistent", () => {
  const leg = (timestamp: string): Leg => ({ digest: timestamp, timestamp, coinType: SUI, amount: 1n });
  const prior = [leg("2025-05-22T11:00:00Z"), leg("2025-05-22T12:00:00Z")];

  it("drops an onward outgoing leg that predates every earlier leg", () => {
    const kept = timeConsistent("out", [leg("2025-05-22T10:59:59Z"), leg("2025-05-22T11:30:00Z")], prior);
    expect(kept.map((l) => l.timestamp)).toEqual(["2025-05-22T11:30:00Z"]);
  });

  it("drops an upstream incoming leg that postdates every later leg", () => {
    const kept = timeConsistent("in", [leg("2025-05-22T11:30:00Z"), leg("2025-05-22T12:00:01Z")], prior);
    expect(kept.map((l) => l.timestamp)).toEqual(["2025-05-22T11:30:00Z"]);
  });

  it("keeps everything on the first hop", () => {
    expect(timeConsistent("out", prior, null)).toHaveLength(2);
  });
});

describe("bridgeExitsOf", () => {
  // Call lists as mainnet Mayan MCTP transactions carry them.
  const mayanCctp = [
    { packageId: "0x1", module: "calculate_mctp_fee", function: "calculate_mctp_fee" },
    { packageId: "0x2", module: "deposit_for_burn", function: "deposit_for_burn_with_caller_with_package_auth" },
  ];

  /**
   * The Mayan order 62MTsGpC… fires Mayan's, Wormhole's and CCTP's markers
   * (event types below, as mainnet returns them). It counts as one exit,
   * under Mayan, with the bridges it settled over as its route.
   */
  it("counts a Mayan order once, under Mayan, with the bridges it settled over as its route", () => {
    const exits = bridgeExitsOf(A, [
      tx({
        digest: "62MTsGpC8t9TosVErGxMfUNc1LnR2hJdLBNmDM8yBXrT",
        calls: [
          { packageId: "0x1", module: "calculate_mctp_fee", function: "calculate_mctp_fee" },
          { packageId: "0x2", module: "deposit_for_burn", function: "deposit_for_burn_with_caller_with_package_auth" },
          { packageId: "0x3", module: "publish_message", function: "publish_message" },
          { packageId: "0x1", module: "init_order", function: "log_initialize_mctp" },
        ],
        eventTypes: [
          "0x08d87d37ba49e785dde270a83f8e979605b03dc552b5548f26fdf2f49bf7ed1b::send_message::MessageSent",
          "0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e::deposit_for_burn::DepositForBurn",
          "0xb5bd3599ec7f4ae86afd84398f6f2d862deecce965e8ace2d8d8c8108d5076df::init_order::OrderCreated",
          "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a::publish_message::WormholeMessage",
          "0xb5bd3599ec7f4ae86afd84398f6f2d862deecce965e8ace2d8d8c8108d5076df::init_order::InitMctpLogged",
        ],
      }),
      tx({ digest: "7ehoqkiBm3WxmYzUPirH6a9TePErt8ESavNpJdVDw2Vs", calls: [{ packageId: "0x2", module: "deposit_for_burn", function: "deposit_for_burn" }] }),
    ]);
    expect(exits.map((e) => [e.tx.digest, e.protocol, [...e.route].sort()])).toEqual([
      ["62MTsGpC8t9TosVErGxMfUNc1LnR2hJdLBNmDM8yBXrT", "Mayan MCTP", ["Circle CCTP", "Wormhole"]],
      ["7ehoqkiBm3WxmYzUPirH6a9TePErt8ESavNpJdVDw2Vs", "Circle CCTP", []],
    ]);
  });

  it("excludes a failed transaction — a bridge call in an aborted PTB moved nothing", () => {
    // A Mayan MCTP attempt that aborted with INSUFFICIENT_COIN_BALANCE still
    // carries the bridge call.
    const exits = bridgeExitsOf(A, [tx({ digest: "aborted", calls: mayanCctp, status: "failure" })]);
    expect(exits).toHaveLength(0);
  });

  it("reports an exit visible only in events, as a wrapper's is", () => {
    // Mayan's bridge_with_fee (777Emr4V…) puts no marker call in the PTB; its
    // order marker, CCTP burn and Wormhole message are events.
    const exits = bridgeExitsOf(A, [
      tx({
        eventTypes: [
          "0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e::deposit_for_burn::DepositForBurn",
          "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a::publish_message::WormholeMessage",
          "0xb5bd3599ec7f4ae86afd84398f6f2d862deecce965e8ace2d8d8c8108d5076df::init_order::InitMctpLogged",
        ],
      }),
    ]);
    expect(exits.map((e) => e.protocol)).toEqual(["Mayan MCTP"]);
  });

  it("keeps a transaction with two unrelated bridges as one exit, naming the other apart from its route", () => {
    const exits = bridgeExitsOf(A, [
      tx({
        eventTypes: [
          "0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e::deposit_for_burn::DepositForBurn",
          "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a::publish_message::WormholeMessage",
        ],
      }),
    ]);
    expect(exits).toHaveLength(1);
    expect(exits[0].route).toEqual([]);
    expect([exits[0].protocol, ...exits[0].alsoExited].sort()).toEqual(["Circle CCTP", "Wormhole"]);
  });

  it("ignores transactions the address did not send", () => {
    expect(bridgeExitsOf(A, [tx({ sender: B, calls: mayanCctp })])).toEqual([]);
  });

  it("does not call a price-VAA verification against the Wormhole package a bridge exit", () => {
    // A lending deposit verifies a Pyth price VAA through Wormhole's package,
    // which the registry types as a bridge. That is no exit.
    const wormholePkg = "0x99de5c967d8206ef4b75c0afab3df2a59eb02b05c282821db803831008ac25b4";
    const exits = bridgeExitsOf(A, [tx({ calls: [{ packageId: wormholePkg, module: "vaa", function: "parse_and_verify" }] })]);
    expect(exits).toEqual([]);
  });
});

describe("bridgeSentPerCoin", () => {
  it("excludes a bridge fee and a relayer payment from what left Sui", () => {
    // Balance changes of transaction 7ehoqkiB…, a 400,000 USDC CCTP burn. The
    // sender's negative changes include the USDC bridge fee and the SUI
    // relayer payment, which other Sui addresses received, so neither is sent.
    const FEE = "0xbfa1240e48c622d97881473953be730091161b7931d89bd6afe667841cf69ef4";
    const RELAYER = "0xfa922d7f6eaad8b0014ed9ac262ea0d8f19f4a7a7f2caf249b4cd1ad05c45e18";
    const t = tx({
      changes: [
        { owner: FEE, coinType: USDC, amount: 40_000_000n },
        { owner: A, coinType: SUI, amount: -559_771_286n },
        { owner: A, coinType: USDC, amount: -400_000_000_000n },
        { owner: RELAYER, coinType: SUI, amount: 559_771_286n },
      ],
    });
    const sent = bridgeSentPerCoin(t);
    expect(sent.get(USDC)).toBe(399_960_000_000n);
    expect(sent.has(SUI)).toBe(false);
  });

  it("removes gas from the sender's own row before splitting fee legs out", () => {
    // Same burn, with the sender's SUI row also carrying its gas charge:
    // netGas must come off before what is left of the relayer fee is found,
    // or the leftover gas reads as bridged SUI.
    const RELAYER = "0xfa922d7f6eaad8b0014ed9ac262ea0d8f19f4a7a7f2caf249b4cd1ad05c45e18";
    const t = tx({
      netGas: 3_400_492n,
      changes: [
        { owner: A, coinType: SUI, amount: -563_171_778n },
        { owner: RELAYER, coinType: SUI, amount: 559_771_286n },
      ],
    });
    expect(bridgeSentPerCoin(t).has(SUI)).toBe(false);
  });
});

describe("hitsFor", () => {
  it("returns a disclosed attacker label with its post-mortem source, on the EVM side of a bridge", () => {
    const hits = hitsFor("eip155:1:0x89012a55cd6b88e407c9d4ae9b3425f55924919b");
    expect(hits).toEqual([
      expect.objectContaining({
        category: "malicious",
        evidence: "victim-postmortem",
        source_url: expect.stringContaining("cetusprotocol.notion.site"),
      }),
    ]);
  });

  it("scopes a mainnet disclosure to mainnet", () => {
    const binance = "0x935029ca5219502a47ac9b69f556ccf6e2198b5e7815cf50f68846f723739cbd";
    expect(runWithNetwork("mainnet", () => hitsFor(binance))).toEqual([
      expect.objectContaining({ category: "cex", entity: "Binance", evidence: "proof-of-reserves-listed" }),
    ]);
    expect(runWithNetwork("testnet", () => hitsFor(binance))).toEqual([]);
  });

  it("does not report a category that is context rather than exposure", () => {
    // The zero address is a curated burn sink, which a screen does not report.
    expect(hitsFor("0x0")).toEqual([]);
  });
});
