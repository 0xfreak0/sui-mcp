import { describe, expect, it } from "vitest";
import { oracleDrawState, oracleRequested } from "../scripts/probe/lib/oracle-draws.mjs";

const defaults = { pinned: null, txs: 4, ends: 6, router: 6, coins: 6 };

describe("oracle draw policy", () => {
  it("does not require a holder comparison when the coin source is disabled", () => {
    const disabled = { ...defaults, ends: 0, coins: 0, router: 2 };
    expect(oracleRequested("h", disabled)).toBe(false);
    expect(oracleRequested("d", disabled)).toBe(false);
    expect(oracleRequested("f", disabled)).toBe(false);
    expect(oracleRequested("b", disabled)).toBe(false);
    expect(oracleRequested("k", disabled)).toBe(true);
    expect(oracleDrawState("h", disabled, 0)).toBe("not_drawn");
    expect(oracleDrawState("k", disabled, 0)).toBe("unchecked");
  });

  it("still requires an enabled oracle to check at least one subject", () => {
    expect(oracleRequested("h", defaults)).toBe(true);
    expect(oracleRequested("k", defaults)).toBe(true);
    expect(oracleRequested("h", { ...defaults, pinned: { h: [] } })).toBe(false);
    expect(oracleRequested("h", { ...defaults, coins: 0, pinned: { h: ["0x2::sui::SUI"] } })).toBe(true);
    expect(oracleRequested("g", { ...defaults, txs: 0, router: 2 })).toBe(false);
    expect(oracleDrawState("h", defaults, 0)).toBe("unchecked");
    expect(oracleDrawState("h", defaults, 1)).toBe("checked");
    expect(oracleDrawState("h", { ...defaults, pinned: { h: [] } }, 0)).toBe("not_drawn");
    expect(oracleDrawState("h", { ...defaults, coins: 0, pinned: { h: ["0x2::sui::SUI"] } }, 0)).toBe("unchecked");
  });
});
