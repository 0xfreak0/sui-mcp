import { describe, it, expect } from "vitest";
import { addressArg, addressListArg, numArg, isAddressSchema } from "../src/tools/args.js";

const V = "0x4fffd0005522be4bc029724c7f0f6ed7093a6bf3a09b90e62f61dc15181e1a3e";

describe("addressArg", () => {
  // The chain reports every address as 0x + 64 lower-case hex. Any other
  // spelling compared against it never matches: an upper-case validator
  // address read as a wallet, and an upper-case funding target as a dead end.
  it("returns upper-case input in canonical lower case", () => {
    expect(addressArg().parse(V.toUpperCase().replace("0X", "0x"))).toBe(V);
    expect(addressArg().parse(V.toUpperCase())).toBe(V);
  });

  it("left-pads a short address and accepts one without 0x", () => {
    expect(addressArg().parse("0x2")).toBe(`0x${"0".repeat(63)}2`);
    expect(addressArg().parse(V.slice(2))).toBe(V);
    expect(addressArg().parse(`  ${V}\n`)).toBe(V);
  });

  it("rejects what is not an address instead of padding it", () => {
    // normalizeSuiAddress alone turns "0xzz" into 0x000…0zz, which then
    // reached storage as a well-formed-looking account.
    for (const bad of ["0xzz", "hello", "", "0x", `0x${"a".repeat(65)}`]) {
      const r = addressArg().safeParse(bad);
      expect(r.success, bad).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toMatch(/Not a Sui address/);
    }
  });

  it("passes a SuiNS name through, lower-cased, for resolution", () => {
    expect(addressArg().parse("Example.SUI")).toBe("example.sui");
    expect(addressArg().parse("pay.example.sui")).toBe("pay.example.sui");
    expect(addressArg().safeParse("example.eth").success).toBe(false);
  });

  it("keeps canonicalising through .optional() and inside a list", () => {
    expect(addressArg().optional().parse(undefined)).toBeUndefined();
    expect(addressArg().optional().parse("0xA")).toBe(`0x${"0".repeat(63)}a`);
    expect(addressListArg().min(1).parse(["0xB", V.toUpperCase()])).toEqual([
      `0x${"0".repeat(63)}b`,
      V,
    ]);
    expect(addressListArg().min(1).safeParse(["0xB", "0xzz"]).success).toBe(false);
  });

  it("is recognised through the wrappers tool files add", () => {
    expect(isAddressSchema(addressArg().optional().describe("x"))).toBe("one");
    expect(isAddressSchema(addressListArg().min(1).max(5).optional())).toBe("list");
    expect(isAddressSchema(numArg().optional())).toBeNull();
  });
});

describe("numArg", () => {
  it("accepts a number and its decimal string form", () => {
    expect(numArg().parse(8)).toBe(8);
    expect(numArg().parse("8")).toBe(8);
    expect(numArg().parse(" 2.5 ")).toBe(2.5);
    expect(numArg().parse("1e3")).toBe(1000);
  });

  // Number("") and Number(false) are 0. As `limit` that returned an empty
  // page with has_next_page:false, which reads as "never sent anything".
  it("rejects empty, blank, boolean and non-decimal input rather than reading it as 0", () => {
    for (const bad of ["", "   ", false, true, "abc", "0x10", "8 txs", []]) {
      expect(numArg().safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const r = numArg().safeParse("");
    expect(!r.success && r.error.issues[0].message).toMatch(/empty string/);
  });

  it("keeps string parsing through chained refinements", () => {
    const limit = numArg().int().min(1).max(50).optional();
    expect(limit.parse("20")).toBe(20);
    expect(limit.parse(undefined)).toBeUndefined();
    expect(limit.safeParse("2.5").success).toBe(false);
    expect(limit.safeParse("51").success).toBe(false);
    expect(limit.safeParse("-5").success).toBe(false);
    expect(limit.safeParse("").success).toBe(false);
    expect(numArg().positive().max(12).parse("12")).toBe(12);
    expect(numArg().nonnegative().safeParse("-1").success).toBe(false);
  });
});
