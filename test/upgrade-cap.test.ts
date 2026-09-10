import { describe, it, expect } from "vitest";
import { isUnspendableAddress, assessCapHolder } from "../src/utils/upgrade-cap.js";

const PUBLISHER = "0x158d6f855ae5a6836a7ebb8ac9de3a307245e4ac6b39bb16612d376ee762f31d";
const OTHER = "0xeda2e0ec67390985f70a0261992ce255f12122127374ffdc5494d4f665d36c2b";
const pad = (short: string) => `0x${short.replace(/^0x/, "").padStart(64, "0")}`;

describe("isUnspendableAddress", () => {
  /** The two destinations 27 of 30 departing mainnet caps actually went to. */
  it("recognises the zero address and the framework addresses", () => {
    expect(isUnspendableAddress(pad("0"))).toBe(true);
    expect(isUnspendableAddress(pad("2"))).toBe(true);
    expect(isUnspendableAddress(pad("b"))).toBe(true);
    expect(isUnspendableAddress("0x1")).toBe(true);
  });

  /**
   * Matched by numeric smallness rather than a fixed list: the reserved range
   * is allocated over time, and a newly reserved address should not silently
   * start reading as a live recipient.
   */
  it("accepts a reserved address that does not exist yet", () => {
    expect(isUnspendableAddress(pad("ff"))).toBe(true);
  });

  it("rejects an ordinary wallet", () => {
    expect(isUnspendableAddress(PUBLISHER)).toBe(false);
    expect(isUnspendableAddress(OTHER)).toBe(false);
  });

  /** A long address that merely starts with zeros is a real wallet. */
  it("does not mistake a leading-zero wallet for a burn address", () => {
    expect(isUnspendableAddress(`0x${"0".repeat(40)}${"a".repeat(24)}`)).toBe(false);
  });

  it("rejects malformed input rather than throwing", () => {
    expect(isUnspendableAddress("")).toBe(false);
    expect(isUnspendableAddress("nothex")).toBe(false);
  });
});

describe("assessCapHolder", () => {
  it("reports a cap still held by the publisher", () => {
    const a = assessCapHolder(PUBLISHER, PUBLISHER);
    expect(a.status).toBe("publisher");
  });

  it("is case-insensitive about the comparison", () => {
    expect(assessCapHolder(PUBLISHER.toUpperCase().replace("0X", "0x"), PUBLISHER).status).toBe(
      "publisher",
    );
  });

  /**
   * The distinction the whole module exists for. 20% of mainnet caps are not
   * with their publisher, but 27 of every 30 of those were burned — collapsing
   * the two would fire on a fifth of all packages and flag the responsible
   * choice as suspicious.
   */
  it("calls a burn a burn, and says it reduces risk", () => {
    const a = assessCapHolder(pad("2"), PUBLISHER);
    expect(a.status).toBe("burned");
    expect(a.note).toMatch(/renounced/i);
    expect(a.note).toMatch(/rather than a warning/i);
  });

  it("burns even when the publisher is unknown", () => {
    // An unspendable holder settles the question without needing a comparison.
    expect(assessCapHolder(pad("0"), null).status).toBe("burned");
  });

  it("flags a transfer to a live address and refuses to call it wrong", () => {
    const a = assessCapHolder(OTHER, PUBLISHER);
    expect(a.status).toBe("transferred");
    expect(a.publisher).toBe(PUBLISHER);
    expect(a.note).toMatch(/not by itself wrong/i);
    expect(a.note).toMatch(/2%/);
  });

  /**
   * "Could not look" and "still with the publisher" are opposite conclusions,
   * and publish transactions are frequently pruned — so an unresolved
   * publisher must never produce the reassuring answer.
   */
  it("does not report an unresolved publisher as a match", () => {
    const a = assessCapHolder(OTHER, null);
    expect(a.status).toBe("unknown");
    expect(a.note).toMatch(/not evidence/i);
  });

  it("handles a cap with no address owner at all", () => {
    const a = assessCapHolder(undefined, PUBLISHER);
    expect(a.status).toBe("unknown");
    expect(a.note).toMatch(/shared, immutable, or wrapped/i);
  });
});
