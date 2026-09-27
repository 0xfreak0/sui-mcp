import { describe, it, expect } from "vitest";
import { flagPtbAnomalies, supersededWrites, type FormattedCommand, type FlagPtbAnomaliesOptions, type FunctionChangeSince, type PtbAnomaly } from "../src/utils/ptb-anomalies.js";
import type { PackageTrust } from "../src/protocols/registry.js";
import type { EffectsPayout } from "../src/utils/payouts.js";

const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
const UNKNOWN = "0xbad00000000000000000000000000000000000000000000000000000000000ff";
const CURATED = `0x${"c0".repeat(32)}`;
const SENDER = `0xa11ce0${"5".repeat(58)}`;
const STRANGER = "0x5ecf90fa681d13629e91067782316d89893c5cede1b889d7e2ea4eabd0e54088";

const call = (target: string, protocol?: string): FormattedCommand => ({ type: "MoveCall", target, ...(protocol ? { protocol } : {}) });
const trusted = (basis: PackageTrust["basis"], extra: Partial<PackageTrust> = {}): PackageTrust => ({ basis, protocols: basis ? ["Known"] : [], superseded: null, lineage: [], ...extra });
const trustOnly = (map: Record<string, PackageTrust>) => (pkg: string) => map[pkg] ?? trusted(null);
const transfer = (address: string | undefined, objectCount = 1): FormattedCommand => ({
  type: "TransferObjects",
  objects: new Array(objectCount).fill({ type: "Input" }),
  ...(address ? { address: { type: "Input", address } } : {}),
});
const frameworkCall = (target: string, recipient: string | undefined, argIdx: number, argCount = argIdx + 1): FormattedCommand => ({
  type: "MoveCall",
  target,
  arguments: Array.from({ length: argCount }, (_, i) =>
    i === argIdx && recipient ? { type: "Input", address: recipient } : { type: "Input" },
  ),
});

function codes(cmds: FormattedCommand[], opts?: FlagPtbAnomaliesOptions): string[] {
  return flagPtbAnomalies(cmds, opts).map((a) => a.code);
}

describe("flagPtbAnomalies", () => {
  it("flags publish/upgrade as high severity", () => {
    const a = flagPtbAnomalies([{ type: "Upgrade", package: UNKNOWN }]);
    expect(a[0]).toMatchObject({ code: "publishes-or-upgrades", severity: "high" });
  });

  it("flags calls into unrecognized non-system packages", () => {
    expect(codes([call(`${UNKNOWN}::evil::drain`)])).toContain("unverified-package-call");
  });

  it("does NOT flag system packages or packages the registry vouches for", () => {
    const cmds = [call(`${P2}::coin::split`), call(`${CURATED}::pool::swap`)];
    expect(codes(cmds, { trust: trustOnly({ [CURATED]: trusted("curated") }) })).not.toContain("unverified-package-call");
  });

  it("does NOT flag the native bridge 0xb or DeepBook v1 0xdee9, which are system packages", () => {
    expect(codes([call("0xb::bridge::send_token"), call("0xdee9::clob_v2::swap_exact_base_for_quote")])).not.toContain("unverified-package-call");
  });

  it("flags a package whose only name is a display name, such as a Move Registry name", () => {
    const a = flagPtbAnomalies([call(`${UNKNOWN}::evil::drain`, "@someone/app")], { trust: trustOnly({}) });
    expect(a.map((x) => x.code)).toContain("unverified-package-call");
  });

  it("reads a package published by a curated protocol's key as an unregistered lineage, not an unrecognized package", () => {
    const a = flagPtbAnomalies([call(`${UNKNOWN}::user::go`)], { trust: trustOnly({ [UNKNOWN]: trusted("publisher") }) });
    expect(a.map((x) => [x.code, x.severity])).toEqual([["unregistered-package-lineage", "info"]]);
  });

  it("flags flash-loan pattern by function name", () => {
    expect(codes([call("0xp::lending::flash_loan"), call("0xp::lending::flash_repay")])).toContain("flashloan-pattern");
  });

  it("flags borrow+repay as a flash-loan shape", () => {
    expect(codes([call("0xp::m::borrow"), call("0xp::m::repay")])).toContain("flashloan-pattern");
  });

  it("flags composition across >=4 distinct packages", () => {
    const cmds = ["0xa", "0xb", "0xc", "0xd"].map((p, i) => call(`${p}::m::f${i}`, "known"));
    expect(codes(cmds)).toContain("multi-package-composition");
  });

  it("returns nothing for a plain swap in a package the registry vouches for", () => {
    expect(flagPtbAnomalies([call(`${CURATED}::pool::swap`, "Cetus")], { trust: trustOnly({ [CURATED]: trusted("curated") }) })).toEqual([]);
  });

  it("orders most-severe first", () => {
    const cmds = [call(`${UNKNOWN}::evil::x`), { type: "Publish" } as FormattedCommand];
    const a = flagPtbAnomalies(cmds);
    expect(a[0].severity).toBe("high");
  });

  it("flags a TransferObjects to an address other than the sender", () => {
    expect(codes([transfer(STRANGER)], { sender: SENDER })).toContain("transfers-to-non-sender");
  });

  it("names the commands each flag is about, so a first page can list them", () => {
    const cmds = [transfer(SENDER), { type: "SplitCoins" } as FormattedCommand, call(`${UNKNOWN}::evil::drain`), transfer(STRANGER)];
    const a = flagPtbAnomalies(cmds, { sender: SENDER });
    expect(a.find((x) => x.code === "transfers-to-non-sender")?.commands).toEqual([3]);
    expect(a.find((x) => x.code === "unverified-package-call")?.commands).toEqual([2]);
  });

  it("does NOT flag a transfer back to the sender itself", () => {
    expect(flagPtbAnomalies([transfer(SENDER)], { sender: SENDER })).toEqual([]);
  });

  it("does NOT flag anything when no sender was given to compare against", () => {
    expect(flagPtbAnomalies([transfer(STRANGER)])).toEqual([]);
  });

  it("flags a MoveCall into a blocklisted package", () => {
    const a = flagPtbAnomalies([call(`${UNKNOWN}::managed::mint`)], { blocklistedPackages: new Set([UNKNOWN]) });
    expect(a.map((x) => x.code)).toContain("blocklisted-package-call");
  });

  it("does NOT flag a call into a package absent from the blocklist", () => {
    const a = flagPtbAnomalies([call(`${UNKNOWN}::managed::mint`)], { blocklistedPackages: new Set(["0xother"]) });
    expect(a.map((x) => x.code)).not.toContain("blocklisted-package-call");
  });

  it("drainer PTB: unverified call, blocklisted package and a payout to a stranger all fire together", () => {
    const cmds = [call(`${UNKNOWN}::managed::mint`), transfer(STRANGER, 3)];
    const a = flagPtbAnomalies(cmds, { sender: SENDER, blocklistedPackages: new Set([UNKNOWN]) });
    const codesFound = a.map((x) => x.code);
    expect(codesFound).toContain("unverified-package-call");
    expect(codesFound).toContain("blocklisted-package-call");
    expect(codesFound).toContain("transfers-to-non-sender");
    expect(codesFound.length).toBeGreaterThanOrEqual(2);
  });


  /**
   * `SplitCoins(GasCoin, [amt])` then
   * `0x2::transfer::public_transfer<Coin<SUI>>(Result(0), attacker)` pays
   * out without a TransferObjects command. Its recipient is a Pure `address`
   * argument exactly like a TransferObjects recipient, so the same check
   * flags it.
   */
  it("flags 0x2::transfer::public_transfer to a non-sender", () => {
    const cmds = [{ type: "SplitCoins" } as FormattedCommand, frameworkCall(`${P2}::transfer::public_transfer`, STRANGER, 1)];
    expect(codes(cmds, { sender: SENDER })).toContain("transfers-to-non-sender");
  });

  it("flags 0x2::pay::split_and_transfer to a non-sender", () => {
    expect(codes([frameworkCall(`${P2}::pay::split_and_transfer`, STRANGER, 2)], { sender: SENDER })).toContain("transfers-to-non-sender");
  });

  it("flags 0x2::sui::transfer to a non-sender", () => {
    expect(codes([frameworkCall(`${P2}::sui::transfer`, STRANGER, 1)], { sender: SENDER })).toContain("transfers-to-non-sender");
  });

  it("does NOT flag a framework transfer call back to the sender itself", () => {
    expect(flagPtbAnomalies([frameworkCall(`${P2}::transfer::public_transfer`, SENDER, 1)], { sender: SENDER })).toEqual([]);
  });

  it("does NOT misfire on an address-shaped argument at an unmapped function's argument index", () => {
    expect(flagPtbAnomalies([frameworkCall(`${P2}::coin::split`, STRANGER, 0)], { sender: SENDER })).toEqual([]);
  });

  /**
   * `SplitCoins(GasCoin)` then `0x2::coin::send_funds<SUI>(Result(0),
   * stranger)` pays a stranger, as does `MakeMoveVec` of two split coins into
   * `0x2::pay::join_vec_and_transfer<SUI>(vec, stranger)`.
   * The arguments are shaped as decode_ptb emits them: a Result with no
   * address, then the resolved Pure recipient.
   */
  it.each(["coin::send_funds", "balance::send_funds", "pay::join_vec_and_transfer", "token::transfer"])("flags 0x2::%s to a non-sender", (fn) => {
    const payout: FormattedCommand = {
      type: "MoveCall",
      target: `${P2}::${fn}`,
      arguments: [{ type: "Result", index: 0 }, { type: "Input", index: 1, address: STRANGER }],
    };
    const a = flagPtbAnomalies([{ type: "SplitCoins" } as FormattedCommand, payout], { sender: SENDER });
    const hit = a.find((x) => x.code === "transfers-to-non-sender");
    expect(hit?.evidence).toEqual([`${P2}::${fn} -> ${STRANGER}`]);
  });

  it("flags a party built for a non-sender, the recipient a public_party_transfer receives as a Result", () => {
    const cmds: FormattedCommand[] = [
      frameworkCall(`${P2}::party::single_owner`, STRANGER, 0),
      { type: "MoveCall", target: `${P2}::transfer::public_party_transfer`, arguments: [{ type: "Result", index: 0 }, { type: "Result", index: 0 }] },
    ];
    expect(codes(cmds, { sender: SENDER })).toContain("transfers-to-non-sender");
  });

  it("flags 0x2::coin::mint_and_transfer minting to a non-sender", () => {
    expect(codes([frameworkCall(`${P2}::coin::mint_and_transfer`, STRANGER, 2, 4)], { sender: SENDER })).toContain("transfers-to-non-sender");
  });

  it("does NOT flag send_funds or join_vec_and_transfer back to the sender", () => {
    const cmds = [frameworkCall(`${P2}::coin::send_funds`, SENDER, 1), frameworkCall(`${P2}::pay::join_vec_and_transfer`, SENDER, 1)];
    expect(flagPtbAnomalies(cmds, { sender: SENDER })).toEqual([]);
  });
});

const COIN_SUI = `${P2}::coin::Coin<${P2}::sui::SUI>`;
const severityOf = (a: PtbAnomaly[], code: string) => a.find((x) => x.code === code)?.severity;

describe("unverified-package-call grading by value", () => {
  it("reads info when the unrecognized package takes and returns nothing of value", () => {
    const a = flagPtbAnomalies([{ type: "MoveCall", target: `${UNKNOWN}::recorder::record`, arguments: [{ type: "Input", index: 0 }], returns: ["u64"] }], {
      sender: SENDER,
      inputs: [{ type: "SharedObject", mutable: true, object_type: `${UNKNOWN}::recorder::Log` }],
    });
    expect(severityOf(a, "unverified-package-call")).toBe("info");
  });

  it("reads medium when a split coin is passed into the unrecognized package", () => {
    const cmds: FormattedCommand[] = [
      { type: "SplitCoins", coin: { type: "GasCoin" }, amounts: [{ type: "Input", index: 0 }] },
      { type: "MoveCall", target: `${UNKNOWN}::router::swap`, arguments: [{ type: "NestedResult", result: 0, subresult: 0 }] },
    ];
    expect(severityOf(flagPtbAnomalies(cmds, { sender: SENDER, inputs: [{ type: "Pure" }] }), "unverified-package-call")).toBe("medium");
  });

  it("reads medium when the unrecognized package returns a coin", () => {
    const a = flagPtbAnomalies([{ type: "MoveCall", target: `${UNKNOWN}::vault::withdraw`, arguments: [], returns: [COIN_SUI] }], { sender: SENDER });
    expect(severityOf(a, "unverified-package-call")).toBe("medium");
  });

  it("counts an address argument only when the effects show that address gained", () => {
    const cmds: FormattedCommand[] = [{ type: "MoveCall", target: `${UNKNOWN}::recorder::record`, arguments: [{ type: "Input", index: 0, value_type: "address", address: STRANGER }] }];
    const inputs = [{ type: "Pure" }];
    expect(severityOf(flagPtbAnomalies(cmds, { sender: SENDER, inputs }), "unverified-package-call")).toBe("medium");
    expect(severityOf(flagPtbAnomalies(cmds, { sender: SENDER, inputs, effects: { payouts: [], gainers: new Set(), sender_lost: false, sender_received: false } }), "unverified-package-call")).toBe("info");
    expect(severityOf(flagPtbAnomalies(cmds, { sender: SENDER, inputs, effects: { payouts: [{ to: STRANGER, coin_type: `${P2}::sui::SUI`, amount: "5" }], gainers: new Set([STRANGER]), sender_lost: true, sender_received: false } }), "unverified-package-call")).toBe("medium");
  });

  it("reads medium beside another medium or high lead even when no value moves through it", () => {
    const cmds = [call(`${UNKNOWN}::managed::mint`)];
    expect(severityOf(flagPtbAnomalies(cmds), "unverified-package-call")).toBe("info");
    expect(severityOf(flagPtbAnomalies(cmds, { blocklistedPackages: new Set([UNKNOWN]) }), "unverified-package-call")).toBe("medium");
    const lead = { severity: "high" as const, code: "outsized-mint", title: "", detail: "", evidence: [] };
    expect(severityOf(flagPtbAnomalies(cmds, { leads: [lead] }), "unverified-package-call")).toBe("medium");
  });
});

describe("unverified-package-call by effects round trip", () => {
  const splitIntoRouter: FormattedCommand[] = [
    { type: "SplitCoins", coin: { type: "GasCoin" }, amounts: [{ type: "Input", index: 0 }] },
    { type: "MoveCall", target: `${UNKNOWN}::router::swap`, arguments: [{ type: "NestedResult", result: 0, subresult: 0 }], returns: [COIN_SUI] },
  ];
  const inputs = [{ type: "Pure" }];
  const effects = (sender_lost: boolean, sender_received: boolean, payouts: EffectsPayout[] = []) => ({
    payouts,
    gainers: new Set(payouts.map((p) => p.to)),
    sender_lost,
    sender_received,
  });

  it("reads info when the sender got value back and nobody else gained what it lost", () => {
    expect(severityOf(flagPtbAnomalies(splitIntoRouter, { sender: SENDER, inputs, effects: effects(true, true) }), "unverified-package-call")).toBe("info");
  });

  it("reads info when the sender lost nothing but gas", () => {
    expect(severityOf(flagPtbAnomalies(splitIntoRouter, { sender: SENDER, inputs, effects: effects(false, false) }), "unverified-package-call")).toBe("info");
  });

  it("reads medium when the sender lost value and received nothing", () => {
    expect(severityOf(flagPtbAnomalies(splitIntoRouter, { sender: SENDER, inputs, effects: effects(true, false) }), "unverified-package-call")).toBe("medium");
  });

  it("reads medium when another address gained what the sender lost, even if the sender also got something back", () => {
    const payouts = [{ to: STRANGER, coin_type: `${P2}::sui::SUI`, amount: "5" }];
    expect(severityOf(flagPtbAnomalies(splitIntoRouter, { sender: SENDER, inputs, effects: effects(true, true, payouts) }), "unverified-package-call")).toBe("medium");
  });

  it("reads medium on a round trip when another medium or high lead fires", () => {
    const lead = { severity: "medium" as const, code: "unreconciled-gain", title: "", detail: "", evidence: [] };
    expect(severityOf(flagPtbAnomalies(splitIntoRouter, { sender: SENDER, inputs, effects: effects(true, true), leads: [lead] }), "unverified-package-call")).toBe("medium");
  });

  it("keeps the structural grade before signing, when there are no effects", () => {
    expect(severityOf(flagPtbAnomalies(splitIntoRouter, { sender: SENDER, inputs }), "unverified-package-call")).toBe("medium");
  });
});

describe("stale-package-version", () => {
  const OLD = `0x${"01".repeat(32)}`;
  const NEW = `0x${"04".repeat(32)}`;
  const ROOT = `0x${"00".repeat(31)}f1`;
  const superseded = { version: 2, newest_version: 4, newest: NEW };
  const writesPool = (poolType: string): Pick<FlagPtbAnomaliesOptions, "inputs"> & { cmds: FormattedCommand[] } => ({
    cmds: [{ type: "MoveCall", target: `${OLD}::user::update_points`, arguments: [{ type: "Input", index: 0 }] }],
    inputs: [{ type: "SharedObject", mutable: true, object_type: poolType }],
  });

  const changes = (c: FunctionChangeSince) => new Map([[`${OLD}::user::update_points`, c]]);

  it.each(["curated", "publisher", null] as const)("reads medium for a %s lineage when the call writes its own lineage's shared object and the newest version changed the function", (basis) => {
    const { cmds, inputs } = writesPool(`${ROOT}::spool::Spool`);
    const trust = trustOnly({ [OLD]: trusted(basis, { superseded, lineage: [ROOT, OLD, NEW] }) });
    const a = flagPtbAnomalies(cmds, { inputs, trust, supersededChanges: changes("changed") });
    expect(severityOf(a, "stale-package-version")).toBe("medium");
    expect(a.find((x) => x.code === "stale-package-version")!.evidence[0]).toContain(`${OLD}::user::update_points`);
  });

  it("reads medium when the newest version removed the function", () => {
    const { cmds, inputs } = writesPool(`${ROOT}::spool::Spool`);
    const a = flagPtbAnomalies(cmds, { inputs, trust: trustOnly({ [OLD]: trusted("curated", { superseded, lineage: [ROOT, OLD, NEW] }) }), supersededChanges: changes("removed") });
    expect(severityOf(a, "stale-package-version")).toBe("medium");
  });

  it("reads info when the function is unchanged in the newest version, or was not compared", () => {
    const { cmds, inputs } = writesPool(`${ROOT}::spool::Spool`);
    const trust = trustOnly({ [OLD]: trusted("publisher", { superseded, lineage: [ROOT, OLD, NEW] }) });
    expect(severityOf(flagPtbAnomalies(cmds, { inputs, trust, supersededChanges: changes("same") }), "stale-package-version")).toBe("info");
    expect(severityOf(flagPtbAnomalies(cmds, { inputs, trust }), "stale-package-version")).toBe("info");
  });

  it("reads info when the superseded version only writes another lineage's objects, even if the function changed", () => {
    const { cmds, inputs } = writesPool(`${UNKNOWN}::pool::Pool`);
    const a = flagPtbAnomalies(cmds, { inputs, trust: trustOnly({ [OLD]: trusted("publisher", { superseded, lineage: [ROOT, OLD, NEW] }) }), supersededChanges: changes("changed") });
    expect(severityOf(a, "stale-package-version")).toBe("info");
  });

  it("asks to compare only the calls that write their own lineage's shared objects", () => {
    const own = writesPool(`${ROOT}::spool::Spool`);
    const trust = trustOnly({ [OLD]: trusted("curated", { superseded, lineage: [ROOT, OLD, NEW] }) });
    expect(supersededWrites(own.cmds, own.inputs!, trust)).toEqual([{ target: `${OLD}::user::update_points`, newest: NEW }]);
    const foreign = writesPool(`${UNKNOWN}::pool::Pool`);
    expect(supersededWrites(foreign.cmds, foreign.inputs!, trust)).toEqual([]);
  });
});

describe("transfers-to-non-sender by effects", () => {
  const payout = { to: STRANGER, coin_type: `${P2}::sui::SUI`, amount: "1000" };

  it("reports a payout only the effects show at info on its own", () => {
    const a = flagPtbAnomalies([call(`${CURATED}::market::buy`)], { sender: SENDER, trust: trustOnly({ [CURATED]: trusted("curated") }), effects: { payouts: [payout], gainers: new Set([STRANGER]), sender_lost: true, sender_received: false } });
    expect(a.map((x) => [x.code, x.severity])).toEqual([["transfers-to-non-sender", "info"]]);
  });

  it("reads medium beside a blocklisted package", () => {
    const a = flagPtbAnomalies([call(`${UNKNOWN}::managed::mint`)], {
      sender: SENDER,
      blocklistedPackages: new Set([UNKNOWN]),
      effects: { payouts: [payout], gainers: new Set([STRANGER]), sender_lost: true, sender_received: false },
    });
    expect(severityOf(a, "transfers-to-non-sender")).toBe("medium");
  });

  it("stays high when a command pays the stranger, with the effects' amounts beside it", () => {
    const a = flagPtbAnomalies([transfer(STRANGER)], { sender: SENDER, effects: { payouts: [payout], gainers: new Set([STRANGER]), sender_lost: true, sender_received: false } });
    const hit = a.find((x) => x.code === "transfers-to-non-sender")!;
    expect(hit.severity).toBe("high");
    expect(hit.evidence.some((e) => e.includes("1000"))).toBe(true);
  });
});
