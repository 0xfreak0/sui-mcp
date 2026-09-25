import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  addressArg,
  addressListArg,
  coinTypeArg,
  isAddressSchema,
  mvrNameArg,
  mvrTypeArg,
  numArg,
  refinePoint,
  timePointArg,
  toolArgsSchema,
  u64StringArg,
} from "../src/tools/args.js";

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

  // "1e309" spells a decimal number and Number() makes it Infinity, which a
  // field without .max() passed on: min_usd: Infinity pruned every branch.
  it("rejects a number too large to represent", () => {
    for (const bad of ["1e309", "-1e309", Infinity]) {
      const r = numArg().min(0).safeParse(bad);
      expect(r.success, String(bad)).toBe(false);
      expect(!r.success && r.error.issues[0].message).toMatch(/finite/);
    }
  });

  it("quotes at most 80 characters of the input back", () => {
    const r = numArg().safeParse("x".repeat(10_000));
    expect(!r.success && r.error.issues[0].message.length).toBeLessThan(150);
  });
});

describe("u64StringArg", () => {
  it("accepts a whole number as text or as a JSON number, trimmed", () => {
    expect(u64StringArg().parse(" 42 ")).toBe("42");
    expect(u64StringArg().parse(7)).toBe("7");
    expect(u64StringArg().parse("18446744073709551615")).toBe("18446744073709551615");
  });

  // BigInt(" ") is 0: a blank epoch asked for epoch 0 and got genesis.
  it("rejects blank, negative, fractional and out-of-range values", () => {
    for (const bad of ["", " ", "-1", "1.5", "abc", "18446744073709551616", -1, 1.5]) {
      expect(u64StringArg().safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("timePointArg and refinePoint", () => {
  it("accepts a checkpoint, 'now' and an ISO 8601 time", () => {
    for (const ok of ["190000000", "now", "NOW", "2025-09-07", "2025-09-07T16:00:00Z", "2025-09-07T16:00:00.5+02:00"]) {
      expect(timePointArg().safeParse(ok).success, ok).toBe(true);
    }
    expect(timePointArg().parse(" 2025-09-07T16:00:00Z ")).toBe("2025-09-07T16:00:00Z");
  });

  // Date.parse("-5") is a date in 6 BC, so "-5" became a window edge; a
  // month-13 date and a word are refused at the argument, not in the handler.
  it("rejects negative, malformed and impossible times", () => {
    for (const bad of ["-5", "yesterday", "2025-13-45T99:00:00Z", "12:00", "2025/09/07", "1.5"]) {
      expect(timePointArg().safeParse(bad).success, bad).toBe(false);
    }
  });

  it("checks both halves of a string-or-number field", () => {
    const point = z.union([numArg(), z.string()]).superRefine(refinePoint);
    expect(point.safeParse(1757260800).success).toBe(true);
    expect(point.safeParse("2025-09-07").success).toBe(true);
    for (const bad of [-1, 2.5, "-1", "NaN", "Infinity"]) {
      expect(point.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});

describe("coinTypeArg", () => {
  it("accepts struct types, short and padded, with type arguments", () => {
    for (const ok of [
      "0x2::sui::SUI",
      `0x${"0".repeat(63)}2::sui::SUI`,
      "0x2::coin::Coin<0x2::sui::SUI>",
      "0xabc::pool::Pool<0x2::sui::SUI, 0xdef::usdc::USDC>",
      "0x1::m::T<vector<u8>, address>",
    ]) {
      expect(coinTypeArg().safeParse(ok).success, ok).toBe(true);
    }
  });

  // A malformed type reached the chain as a filter that matched nothing, so
  // check_coin_restrictions said "no deny list" for 0x2::a::b::c.
  it("rejects what is not a Move struct type", () => {
    for (const bad of ["0x2::a::b::c", "0xZZ::a::A", "0x2::sui", "SUI", "u64", "0x2::sui::SUI<", "0x2::sui::SUI\" } query {", `0x2::sui::${"A".repeat(129)}`]) {
      const r = coinTypeArg().safeParse(bad);
      expect(r.success, bad).toBe(false);
      expect(!r.success && r.error.issues[0].message).toMatch(/Not a Move type/);
    }
  });
});

describe("MVR names", () => {
  it("accepts @org/app, a pinned version and the .sui form", () => {
    expect(mvrNameArg().parse(" @SuiNS/Core ")).toBe("@suins/core");
    expect(mvrNameArg().parse("@deepbook/core/4")).toBe("@deepbook/core/4");
    expect(mvrNameArg().parse("suins.sui/core")).toBe("suins.sui/core");
    expect(mvrTypeArg().parse("@suins/core::suins::SuiNS")).toBe("@suins/core::suins::SuiNS");
  });

  // The name is spliced into the registry URL path, so `../` or a query
  // string reached a different endpoint.
  it("rejects anything that is not a name", () => {
    for (const bad of ["not an mvr name", "@a/b/../../x", "@a/b?x=1", "@a", "suins/core"]) {
      expect(mvrNameArg().safeParse(bad).success, bad).toBe(false);
    }
    expect(mvrTypeArg().safeParse("@a/b::m").success).toBe(false);
  });
});

describe("toolArgsSchema", () => {
  const args = toolArgsSchema({
    package_id: z.string(),
    module_name: z.string().optional(),
    limit: numArg().optional().default(10),
    digests: z.array(z.string()).optional(),
  });

  // A misspelt argument was stripped and the tool answered another question:
  // disassemble_module {module: "pool"} listed the modules.
  it("refuses an unknown argument, naming the closest and every valid one", () => {
    const r = args.safeParse({ package_id: "0x2", module: "pool" });
    expect(r.success).toBe(false);
    const message = !r.success ? r.error.issues[0].message : "";
    expect(message).toMatch(/Unknown argument "module" \(did you mean module_name\?\)/);
    expect(message).toMatch(/Valid arguments: package_id, module_name, limit, digests\./);
    expect(args.safeParse({ package_id: "0x2", modul_name: "x" }).error?.issues[0].message).toMatch(/did you mean module_name/);
  });

  it("treats null as unset and a bare string as a one-item list", () => {
    expect(args.parse({ package_id: "0x2", limit: null, module_name: null, digests: "abc" })).toEqual({
      package_id: "0x2",
      limit: 10,
      digests: ["abc"],
    });
  });

  // `if (coin_type)` read "" as unset, BigInt(" ") read " " as 0, and
  // search_token's filter read "" as match-everything.
  it("refuses a blank string, alone or in a list", () => {
    for (const bad of [
      { package_id: "" },
      { package_id: "0x2", module_name: " \t " },
      { package_id: "0x2", digests: ["abc", " "] },
      { package_id: "0x2", digests: "" },
    ]) {
      const r = args.safeParse(bad);
      expect(r.success, JSON.stringify(bad)).toBe(false);
      expect(!r.success && r.error.issues[0].message).toMatch(/empty string/i);
    }
  });
});
