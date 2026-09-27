import { describe, it, expect } from "vitest";
import {
  annotateLines,
  decodeCleverAbort,
  describeInteger,
  extractFunction,
  parseConstants,
} from "../src/utils/disassembly.js";

// Typus oracle version 10 (0x1ead8a0d…) as the GraphQL endpoint disassembles
// it: two clever abort codes in version_check and the constants they index.
const ORACLE_V10 = [
  "module 855eb2d260ee42b898266e6df90bfd3c4ed821ccb253a352c159c223244a4b8a.oracle {",
  "use 855eb2d260ee42b898266e6df90bfd3c4ed821ccb253a352c159c223244a4b8a::pyth_parser;",
  "use 714a63a0dba6da4f017b42d5d0fb78867f18bcde904868e51d951a5a6f5b7f57::math_u256;",
  "use 0000000000000000000000000000000000000000000000000000000000000002::dynamic_field;",
  "",
  "version_check(Arg0: &Oracle) {",
  "L1:\tloc0: u64",
  "B0:",
  "\t0: CopyLoc[0](Arg0: &Oracle)",
  "\t1: ImmBorrowField[0](Oracle.id: UID)",
  '\t2: LdConst[13](vector<u8>: "VER..)',
  "\t3: Call dynamic_field::exists_<String>(&UID, String): bool",
  "\t4: BrFalse(7)",
  "B1:",
  "\t5: LdU64(13906835690467295240)",
  "\t6: Abort",
  "B2:",
  "\t7: LdU64(13906835703352197128)",
  "\t8: Abort",
  "}",
  "",
  "public shift(Arg0: u256): u256 {",
  "B0:",
  "\t0: MoveLoc[0](Arg0: u256)",
  "\t1: LdU256(115792089237316195417293883273301227089434195242432897623355228563449095127040)",
  "\t2: Call math_u256::checked_shlw(u256): u256 * bool",
  "\t3: Pop",
  "\t4: Ret",
  "}",
  "",
  "Constants [",
  "\t0 => u64: 2",
  '\t7 => vector<u8>: "EInvalidVersion" // interpreted as UTF8 string',
  '\t8 => vector<u8>: "Invalid Version" // interpreted as UTF8 string',
  '\t13 => vector<u8>: "VERSION" // interpreted as UTF8 string',
  "]",
  "}",
];

describe("decodeCleverAbort", () => {
  const constants = parseConstants(ORACLE_V10);

  it("reads the source line and the error constant's name and value", () => {
    expect(decodeCleverAbort(13906835703352197128n, constants)).toEqual({
      line: 356,
      name: "EInvalidVersion",
      value: '"Invalid Version"',
    });
  });

  it("reads an explicit error code from the byte after the version", () => {
    // 0x2::coin_registry: #[error(code = 11)] EInvariantViolation at line 302.
    const pool = parseConstants([
      "Constants [",
      '\t20 => vector<u8>: "EInvariantViolation" // interpreted as UTF8 string',
      '\t21 => vector<u8>: "Code invariant violation" // interpreted as UTF8 string',
      "]",
    ]);
    expect(decodeCleverAbort(0xc00b012e00140015n, pool)).toEqual({
      line: 302,
      code: 11,
      name: "EInvariantViolation",
      value: '"Code invariant violation"',
    });
  });

  it("reads an abort with no error constant as its line alone", () => {
    expect(decodeCleverAbort(0x80000004ffffffffn, constants)).toEqual({ line: 4 });
  });

  it("rejects a plain abort code, an unknown version and an index outside the pool", () => {
    expect(decodeCleverAbort(7n, constants)).toBeNull();
    expect(decodeCleverAbort(0x40000004ffffffffn, constants)).toBeNull();
    expect(decodeCleverAbort(0x8000000400630064n, constants)).toBeNull();
    // Name index pointing at a u64 constant, not a string.
    expect(decodeCleverAbort(0x8000000400000008n, constants)).toBeNull();
  });
});

describe("describeInteger", () => {
  it("writes a shifted run of ones and a power of two in shift form", () => {
    expect(describeInteger(115792089237316195417293883273301227089434195242432897623355228563449095127040n)).toBe(
      "0xffffffffffffffff << 192",
    );
    expect(describeInteger(6277101735386680763835789423207666416102355444464034512896n)).toBe("1 << 192");
    expect(describeInteger(18446744073709551615n)).toBe("0xffffffffffffffff");
  });

  it("writes any other large value in hex, and leaves small and round decimal values alone", () => {
    // Cetus MAX_SQRT_PRICE_X64.
    expect(describeInteger(79226673515401279992447579055n)).toBe("0xfffec4b135bb7f32a81b33af");
    expect(describeInteger(4294967295n)).toBeNull();
    expect(describeInteger(1000000000000n)).toBeNull();
  });
});

describe("annotateLines", () => {
  const out = annotateLines(ORACLE_V10, {
    packageId: "0x1ead8a0d21d4eb446a75e9125c2e53e9c6505c863c05424c6e898ee3415efbe4",
    linkage: [
      {
        originalId: "0x714a63a0dba6da4f017b42d5d0fb78867f18bcde904868e51d951a5a6f5b7f57",
        upgradedId: "0xe2b515f0052c0b3f83c23db045d49dbe1732818ccfc5d4596c9482f7f2e76a85",
        version: 3,
      },
      {
        originalId: "0x0000000000000000000000000000000000000000000000000000000000000002",
        upgradedId: "0x0000000000000000000000000000000000000000000000000000000000000002",
        version: 44,
      },
    ],
  });
  const line = (prefix: string) => out.find((l) => l.startsWith(prefix));

  it("keeps every line's text and the line count", () => {
    expect(out).toHaveLength(ORACLE_V10.length);
    out.forEach((l, i) => expect(l.startsWith(ORACLE_V10[i])).toBe(true));
  });

  it("names the linked version of a dependency and this package on its own modules", () => {
    expect(line("use 714a63a0")).toContain("0xe2b515f0052c0b3f83c23db045d49dbe1732818ccfc5d4596c9482f7f2e76a85");
    expect(line("use 714a63a0")).toMatch(/version 3\b/);
    expect(line("use 855eb2d2")).toContain("0x1ead8a0d21d4eb446a75e9125c2e53e9c6505c863c05424c6e898ee3415efbe4");
    // The framework upgrades in place; its linkage row pins nothing.
    expect(line("use 0000")).not.toContain("//");
  });

  it("decodes clever aborts, fills in truncated constants and writes large integers in hex", () => {
    const abort = line("\t7: LdU64")!;
    expect(abort).toContain("EInvalidVersion");
    expect(abort).toContain('"Invalid Version"');
    expect(abort).toMatch(/\b356\b/);
    expect(line("\t2: LdConst[13]")).toContain('"VERSION"');
    expect(line("\t1: LdU256")).toContain("0xffffffffffffffff << 192");
  });
});

describe("annotateLines on aliased imports, short headers and literals", () => {
  // Kai Finance ywhusdce (0x01c389a8…): the header drops the leading zero,
  // and a second `coin` module is imported under an alias.
  const KAI = "01c389a85e36a4c7a1cfad2a84f4e19a2fe6dc0d0ea6c5ea30f1fa9e0bcc1b6e";
  const OTHER = "5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf";
  const text = [
    `module ${KAI.replace(/^0+/, "")}.ywhusdce {`,
    `use ${KAI}::vault;`,
    `use ${OTHER}::coin as 0coin;`,
    "use 0000000000000000000000000000000000000000000000000000000000000002::coin;",
    "",
    "public mask(Arg0: u64): u64 {",
    "B0:",
    "\t0: MoveLoc[0](Arg0: u64)",
    "\t1: LdU64(9223372036854775808)",
    "\t2: BitOr",
    "\t3: Call 0coin::value(u64): u64",
    "\t4: Ret",
    "}",
    "",
    "Constants [",
    '\t0 => vector<u8>: "EOverflow" // interpreted as UTF8 string',
    "]",
    "}",
  ];
  const linkage = [{ originalId: `0x${OTHER}`, upgradedId: `0x${"ab".repeat(32)}`, version: 4 }];
  const out = annotateLines(text, { linkage, packageId: `0x${KAI}` });
  const line = (prefix: string) => out.find((l) => l.startsWith(prefix))!;

  it("names this package on its own modules when the header drops leading zeros", () => {
    expect(line(`use ${KAI}::vault;`)).toContain(`0x${KAI}`);
  });

  it("gives the linked version on an aliased import, and keeps it in the function's uses", () => {
    expect(line(`use ${OTHER}::coin as 0coin;`)).toContain(`0x${"ab".repeat(32)}`);
    const fn = extractFunction(out.join("\n"), "mask")!;
    expect(fn.uses).toHaveLength(1);
    expect(fn.uses[0]).toContain("as 0coin;");
  });

  it("reads a literal that fits the clever-abort layout as a literal when no Abort follows", () => {
    // 1 << 63 is version 0b1000, line 0, indices 0 and 0.
    expect(line("\t1: LdU64")).not.toContain("EOverflow");
    expect(extractFunction(out.join("\n"), "mask")!.constants).toEqual([]);
  });
});

describe("annotateLines on shifts", () => {
  // Cetus integer-mate v3 math_u256::checked_shlw (0xe2b515f0…), with a
  // shift right and an addition appended.
  const text = [
    "public checked_shlw(Arg0: u256): u256 * bool {",
    "L1:\tloc0: u256",
    "L2:\tloc1: bool",
    "B0:",
    "\t0: CopyLoc[0](Arg0: u256)",
    "\t1: LdU256(115792089237316195417293883273301227089434195242432897623355228563449095127040)",
    "\t2: Gt",
    "\t3: BrFalse(9)",
    "B1:",
    "\t4: LdU256(0)",
    "\t5: LdTrue",
    "\t6: StLoc[2](loc1: bool)",
    "\t7: StLoc[1](loc0: u256)",
    "\t8: Branch(15)",
    "B2:",
    "\t9: MoveLoc[0](Arg0: u256)",
    "\t10: LdU8(64)",
    "\t11: Shl",
    "\t12: LdU8(1)",
    "\t13: Shr",
    "\t14: LdU256(1)",
    "\t15: Add",
    "\t16: LdFalse",
    "\t17: Ret",
    "}",
  ];
  const out = annotateLines(text);

  it("notes on Shl and Shr lines, and on no other arithmetic, that dropped bits do not abort", () => {
    expect(out).toHaveLength(text.length);
    out.forEach((l, i) => expect(l.startsWith(text[i])).toBe(true));
    const noted = out.filter((l, i) => l !== text[i] && !text[i].includes("LdU256"));
    expect(noted.map((l) => l.split(" // ")[0])).toEqual(["\t11: Shl", "\t13: Shr"]);
    expect(noted.every((l) => l.split(" // ").length === 2)).toBe(true);
    // Patterns over the raw text, such as a load of 64 followed by Shl, still match.
    expect(out.join("\n")).toMatch(/LdU8\(64\)\n\t\d+: Shl/);
  });
});

describe("extractFunction", () => {
  it("returns one function with the use lines and constants it refers to", () => {
    const fn = extractFunction(ORACLE_V10.join("\n"), "version_check")!;
    expect(fn.text.split("\n")[0]).toBe("version_check(Arg0: &Oracle) {");
    expect(fn.text.endsWith("\t8: Abort\n}")).toBe(true);
    expect(fn.text).not.toContain("shift");
    expect(fn.uses).toEqual(["use 0000000000000000000000000000000000000000000000000000000000000002::dynamic_field;"]);
    expect(fn.constants).toEqual([
      '7 => vector<u8>: "EInvalidVersion" // interpreted as UTF8 string',
      '8 => vector<u8>: "Invalid Version" // interpreted as UTF8 string',
      '13 => vector<u8>: "VERSION" // interpreted as UTF8 string',
    ]);
  });

  it("returns null for a function the module does not declare", () => {
    expect(extractFunction(ORACLE_V10.join("\n"), "update_v2")).toBeNull();
  });
});
