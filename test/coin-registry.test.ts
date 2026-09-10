import { describe, it, expect } from "vitest";
import {
  normalizeCoinType,
  isVerifiedCoin,
  resolveVerifiedSymbol,
  registrySize,
} from "../src/utils/coin-registry.js";

const NATIVE_USDC =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
/** Returned by the old first-match scan for the symbol "USDC". */
const IMPOSTOR_USDC =
  "0x006e09c3c3ebb8c4670e0320da7efe926d35347608f964b4625dd47bae40a664::usdc::USDC";

describe("normalizeCoinType", () => {
  it("pads a short package address so 0x2::sui::SUI matches its canonical form", () => {
    expect(normalizeCoinType("0x2::sui::SUI")).toBe(`0x${"0".repeat(63)}2::sui::SUI`);
  });

  /**
   * Only the package address is case-normalized. Move module and struct names
   * ARE case-sensitive, so `::usdc::USDC` and `::USDC::USDC` are different
   * types — lowercasing the whole string would merge two distinct coins, the
   * same class of bug as lowercasing a base58 Solana address.
   */
  it("normalizes the package address but never the module or struct", () => {
    const shouty = `0xDBA34672E30CB065B1F93E3AB55318768FD6FEF66C15942C9F7CB846E2F900E7::usdc::USDC`;
    expect(normalizeCoinType(shouty)).toBe(NATIVE_USDC);
    // Same package, different module case: a different type, and kept apart.
    expect(normalizeCoinType(`${NATIVE_USDC.split("::")[0]}::USDC::USDC`)).not.toBe(NATIVE_USDC);
  });

  it("rejects anything that is not package::module::STRUCT", () => {
    expect(normalizeCoinType("0x2::sui")).toBeNull();
    expect(normalizeCoinType("notahex::sui::SUI")).toBeNull();
    expect(normalizeCoinType("")).toBeNull();
  });
});

describe("isVerifiedCoin", () => {
  it("accepts SUI written short", () => {
    expect(isVerifiedCoin("0x2::sui::SUI")).toBe(true);
  });

  it("accepts native USDC", () => {
    expect(isVerifiedCoin(NATIVE_USDC)).toBe(true);
  });

  /**
   * The whole point. This type is what the old symbol scan handed back for
   * "USDC" — same symbol, same module name, different package.
   */
  it("rejects the impostor that shares USDC's symbol and module name", () => {
    expect(isVerifiedCoin(IMPOSTOR_USDC)).toBe(false);
  });
});

describe("resolveVerifiedSymbol", () => {
  it("resolves a symbol only one verified coin claims", () => {
    const r = resolveVerifiedSymbol("SUI");
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.coin.coin_type).toBe(`0x${"0".repeat(63)}2::sui::SUI`);
    }
  });

  it("is case-insensitive and tolerates whitespace", () => {
    expect(resolveVerifiedSymbol("  sui ").status).toBe("resolved");
  });

  /**
   * Ambiguity is an ANSWER, not a failure. Circle's native USDC, Wormhole USDC
   * and Celer USDC are all legitimate and all verified; picking one silently
   * would misreport which asset moved.
   */
  it("returns candidates for a symbol several verified coins claim", () => {
    const r = resolveVerifiedSymbol("USDC");
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") {
      expect(r.candidates.length).toBeGreaterThan(1);
      expect(r.candidates.map((c) => c.coin_type)).toContain(NATIVE_USDC);
      // And never the impostor, whatever else is in there.
      expect(r.candidates.map((c) => c.coin_type)).not.toContain(IMPOSTOR_USDC);
    }
  });

  it("reports an uncurated symbol as unverified rather than guessing", () => {
    const r = resolveVerifiedSymbol("FIXWALLETSPLS");
    expect(r.status).toBe("unverified");
  });

  it("treats an unknown symbol as unverified, not ambiguous", () => {
    expect(resolveVerifiedSymbol("zzzznotacoin").status).toBe("unverified");
  });
});

describe("the registry itself", () => {
  it("is populated", () => {
    // Sized by Aftermath's verified list; a near-empty file means the sync
    // script failed and every symbol would silently become "unverified".
    expect(registrySize()).toBeGreaterThan(100);
  });
});
