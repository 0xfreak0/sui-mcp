import { describe, it, expect } from "vitest";
import {
  coinScale,
  decimalsForCoinType,
  displayCoin,
  symbolOf,
  toHumanAmount,
} from "../src/utils/valuation.js";

const REAL_SUI = "0x2::sui::SUI";
const REAL_USDC =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
/** Struct name says SUI; nothing vouches for it. Real one found on mainnet. */
const FAKE_SUI = "0x00a3017cc5fd396c38263ec57c8f2266507ce1a737000000000000000000000f::sui::SUI";

describe("coinScale", () => {
  it("takes decimals from the registry for a verified coin", () => {
    expect(coinScale(REAL_SUI)).toEqual({ decimals: 9, source: "registry" });
    expect(coinScale(REAL_USDC)).toEqual({ decimals: 6, source: "registry" });
  });

  /**
   * The bug this replaces: decimals were keyed on the STRUCT NAME, so any coin
   * whose type ends `::sui::SUI` inherited SUI's 9. Measured on mainnet, 47 of
   * 289 impostors carrying a hardcoded symbol declare different decimals —
   * including a fake SUI with 0, which would have reported amounts 10^9 out.
   */
  it("does not give an impostor the decimals of the coin it imitates", () => {
    const scale = coinScale(FAKE_SUI);
    expect(scale.source).toBe("assumed");
  });

  it("marks an unknown coin as assumed rather than guessing silently", () => {
    const scale = coinScale(`0x${"f".repeat(64)}::wat::WAT`);
    expect(scale.source).toBe("assumed");
    expect(scale.decimals).toBe(9);
  });

  it("handles a malformed type without throwing", () => {
    expect(() => coinScale("not::a")).not.toThrow();
    expect(coinScale("not::a").source).toBe("assumed");
  });

  it("matches a short-form type against its padded registry entry", () => {
    expect(coinScale("0x2::sui::SUI").source).toBe("registry");
    expect(coinScale(`0x${"0".repeat(63)}2::sui::SUI`).source).toBe("registry");
  });
});

describe("decimalsForCoinType", () => {
  it("still returns a plain number for callers that only need the scale", () => {
    expect(decimalsForCoinType(REAL_USDC)).toBe(6);
    expect(decimalsForCoinType(FAKE_SUI)).toBe(9);
  });

  /** A 10^9 error is the difference between 1 SUI and a billion. */
  it("would have mis-scaled the fake SUI under the old symbol rule", () => {
    // Its real decimals are 0, so a raw 1 is one whole token.
    expect(toHumanAmount(1n, 0)).toBe(1);
    // We do not know that, so we say 9 AND mark it assumed rather than assert 1.
    expect(coinScale(FAKE_SUI).source).toBe("assumed");
  });
});

describe("displayCoin", () => {
  it("reports a verified coin with its registry symbol", () => {
    expect(displayCoin(REAL_USDC)).toMatchObject({ symbol: "USDC", verified: true });
  });

  /**
   * The symbol still shows — refusing to print it would make results unreadable
   * — but it is marked, because the symbol is a claim made by whoever minted
   * the coin, not an identification.
   */
  it("marks an unverified coin's symbol as a claim", () => {
    const d = displayCoin(FAKE_SUI);
    expect(d.symbol).toBe("SUI");
    expect(d.verified).toBe(false);
  });

  it("keeps the full coin type so a reader can tell two SUIs apart", () => {
    expect(displayCoin(FAKE_SUI).coin_type).not.toBe(displayCoin(REAL_SUI).coin_type);
  });
});

describe("symbolOf", () => {
  it("still reads the struct name, which is all it ever claimed to do", () => {
    expect(symbolOf(REAL_SUI)).toBe("SUI");
    expect(symbolOf(FAKE_SUI)).toBe("SUI");
  });
});
