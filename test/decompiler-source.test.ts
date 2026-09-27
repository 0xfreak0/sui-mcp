import { describe, it, expect } from "vitest";
import { annotateSource, extractSourceFunction, sourceFunctionNames } from "../src/utils/move-source.js";

// Cetus integer-mate v3 math_u256 (0xe2b515f0…) as move-decompiler 1.0.1 prints it.
const MATH_U256 = [
  "module 0x714a63a0dba6da4f017b42d5d0fb78867f18bcde904868e51d951a5a6f5b7f57::math_u256 {",
  "    public fun checked_shlw(arg0: u256) : (u256, bool) {",
  "        if (arg0 > 115792089237316195417293883273301227089434195242432897623355228563449095127040) {",
  "            (0, true)",
  "        } else {",
  "            (arg0 << 64, false)",
  "        }",
  "    }",
  "",
  "    public fun shlw(arg0: u256) : u256 {",
  "        arg0 << 64",
  "    }",
  "",
  "    // decompiled from Move bytecode v6",
  "}",
].join("\n");

// Source as another decompiler or the original package prints it: `use` and
// `const` declarations, attributes, braces inside strings and comments.
const POOL = [
  "module 0xabc::pool {",
  "    use sui::balance::{Self, Balance};",
  "    use sui::event;",
  "    use 0xdef::math as m;",
  "",
  "    const EPaused: u64 = 1;",
  "    const MAX: u128 = 340282366920938463463374607431768211455;",
  "",
  "    struct Pool has key { id: UID, paused: bool }",
  "",
  "    /// Split with a check; `}` in a doc comment.",
  "    #[allow(unused)]",
  "    public(package) entry fun split<T: store>(p: &mut Pool, b: &mut Balance<T>) {",
  "        assert!(!p.paused, EPaused);",
  '        let s = b"}{ not a brace \\" still a string }";',
  "        /* a } in a block comment */",
  "        if (m::lt(1, 2)) { balance::split(b, 1); } // } trailing",
  "    }",
  "",
  "    native fun hash(data: vector<u8>): vector<u8>;",
  "",
  "    fun emit_it() { event::emit(1) }",
  '    // fun ghost() { } lives in a comment',
  "}",
].join("\n");

describe("extractSourceFunction", () => {
  it("returns one function up to its own closing brace", () => {
    const fn = extractSourceFunction(MATH_U256, "checked_shlw")!;
    const lines = fn.text.split("\n");
    expect(lines[0]).toMatch(/^public fun checked_shlw\(/);
    expect(lines[lines.length - 1]).toBe("}");
    expect(fn.text).not.toContain("shlw(arg0: u256) : u256");
    expect(fn.uses).toEqual([]);
    expect(fn.constants).toEqual([]);
  });

  it("reads modifiers and type parameters, and skips braces inside strings and comments", () => {
    const fn = extractSourceFunction(POOL, "split")!;
    const lines = fn.text.split("\n");
    expect(lines[0]).toMatch(/^\/\/\//);
    expect(lines[1]).toMatch(/^#\[allow/);
    expect(lines[lines.length - 1]).toBe("}");
    expect(lines).toHaveLength(8);
    expect(fn.text).not.toContain("native fun hash");
  });

  it("keeps the use lines and constants the function refers to", () => {
    const fn = extractSourceFunction(POOL, "split")!;
    expect(fn.uses).toEqual(["use sui::balance::{Self, Balance};", "use 0xdef::math as m;"]);
    expect(fn.constants).toEqual(["const EPaused: u64 = 1;"]);
    expect(extractSourceFunction(POOL, "emit_it")!.uses).toEqual(["use sui::event;"]);
  });

  it("ends a native declaration at its semicolon", () => {
    expect(extractSourceFunction(POOL, "hash")!.text).toBe("native fun hash(data: vector<u8>): vector<u8>;");
  });

  it("returns null for a name the module does not declare, including one only in a comment", () => {
    expect(extractSourceFunction(POOL, "ghost")).toBeNull();
    expect(extractSourceFunction(POOL, "spl")).toBeNull();
    expect(extractSourceFunction(POOL, "split(")).toBeNull();
    expect(sourceFunctionNames(POOL)).toEqual(["split", "hash", "emit_it"]);
  });
});

describe("annotateSource", () => {
  it("appends the hex or shift form of a large literal and changes no text", () => {
    const out = annotateSource(MATH_U256).split("\n");
    const src = MATH_U256.split("\n");
    expect(out).toHaveLength(src.length);
    out.forEach((l, i) => expect(l.startsWith(src[i])).toBe(true));
    expect(out[2]).toMatch(/ \/\/ 0xffffffffffffffff << 192$/);
    expect(out.filter((l, i) => l !== src[i])).toHaveLength(1);
  });

  it("leaves digits inside strings and comments alone", () => {
    const src = '    let s = b"340282366920938463463374607431768211455"; // 340282366920938463463374607431768211455';
    expect(annotateSource(src)).toBe(src);
    expect(annotateSource(POOL).split("\n")[6]).toMatch(/ \/\/ 0xffffffffffffffffffffffffffffffff$/);
  });
});
