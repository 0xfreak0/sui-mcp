import { describe, it, expect } from "vitest";
import { isDigest, invalidDigestMessage, normalizeDigest } from "../src/utils/digest.js";

/** A real mainnet digest. */
const REAL = "6rbfmByTyP4k7EREQBV9XZNhaG4RPm2ExT5bhVDfhGpu";

describe("isDigest", () => {
  it("accepts a real digest", () => {
    expect(isDigest(REAL)).toBe(true);
  });

  /**
   * The reason the check is a decode rather than a character-class test: 44
   * ones are valid Base58 and decode to 44 zero bytes, which the node refuses
   * on length. An alphabet check would wave this through.
   */
  it("rejects 44 ones, which are valid Base58 but the wrong length", () => {
    expect(isDigest("1".repeat(44))).toBe(false);
  });

  it("rejects the obvious junk", () => {
    expect(isDigest("")).toBe(false);
    expect(isDigest("notadigest")).toBe(false);
    expect(isDigest("0x" + "a".repeat(64))).toBe(false);
    // 0, O, I and l are not in the Base58 alphabet.
    expect(isDigest(REAL.slice(0, -1) + "0")).toBe(false);
  });

  it("never throws, whatever it is given", () => {
    for (const s of ["", "!!!", " ", "é".repeat(50)]) {
      expect(() => isDigest(s)).not.toThrow();
    }
  });
});

describe("invalidDigestMessage", () => {
  /**
   * The distinction that matters: rejected before any request means this says
   * nothing about whether the transaction exists.
   */
  it("says it is not evidence the transaction is missing", () => {
    expect(invalidDigestMessage("oops")).toMatch(/not evidence/i);
  });

  it("describes a digest rather than Base58 internals", () => {
    const m = invalidDigestMessage("oops");
    expect(m).toMatch(/32 bytes/);
    expect(m).toContain("oops");
  });
});

describe("normalizeDigest", () => {
  /**
   * Whitespace carries no meaning in a digest and is the commonest artefact of
   * copying one out of a log or an explorer URL. Rejecting a correct digest for
   * a trailing space is a worse failure than the typo this module catches.
   */
  it("accepts a digest with surrounding whitespace", () => {
    expect(isDigest(`  ${REAL}\n`)).toBe(true);
    expect(normalizeDigest(`  ${REAL}\n`)).toBe(REAL);
  });

  it("leaves a clean digest untouched", () => {
    expect(normalizeDigest(REAL)).toBe(REAL);
  });
});
