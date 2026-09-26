import { describe, it, expect } from "vitest";
import { flagPtbAnomalies, type FormattedCommand, type FlagPtbAnomaliesOptions } from "../src/utils/ptb-anomalies.js";

const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
const UNKNOWN = "0xbad00000000000000000000000000000000000000000000000000000000000ff";
const SENDER = "0xecb58af86777cd758f4f1c7c3fb25880ab5aa22cd24eb77fa4871703d239b633";
const STRANGER = "0x5ecf90fa681d13629e91067782316d89893c5cede1b889d7e2ea4eabd0e54088";

const call = (target: string, protocol?: string): FormattedCommand => ({ type: "MoveCall", target, ...(protocol ? { protocol } : {}) });
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

  it("does NOT flag system packages or known protocols", () => {
    const cmds = [call(`${P2}::coin::split`), call("0xcetuspkg::pool::swap", "Cetus")];
    expect(codes(cmds)).not.toContain("unverified-package-call");
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

  it("returns nothing for a plain single-protocol swap", () => {
    expect(flagPtbAnomalies([call("0xcetus::pool::swap", "Cetus")])).toEqual([]);
  });

  it("orders most-severe first", () => {
    const cmds = [call(`${UNKNOWN}::evil::x`), { type: "Publish" } as FormattedCommand];
    const a = flagPtbAnomalies(cmds);
    expect(a[0].severity).toBe("high");
  });

  it("flags a TransferObjects to an address other than the sender", () => {
    expect(codes([transfer(STRANGER)], { sender: SENDER })).toContain("transfers-to-non-sender");
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
