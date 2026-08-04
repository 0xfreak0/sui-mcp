import { describe, it, expect } from "vitest";
import { flagPtbAnomalies, type FormattedCommand } from "../src/utils/ptb-anomalies.js";

const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
const UNKNOWN = "0xbad00000000000000000000000000000000000000000000000000000000000ff";

const call = (target: string, protocol?: string): FormattedCommand => ({ type: "MoveCall", target, ...(protocol ? { protocol } : {}) });

function codes(cmds: FormattedCommand[]): string[] {
  return flagPtbAnomalies(cmds).map((a) => a.code);
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
});
