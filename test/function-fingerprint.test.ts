import { describe, it, expect } from "vitest";
import { functionFingerprints } from "../src/utils/function-fingerprint.js";
import { moduleFingerprint } from "../src/utils/module-fingerprint.js";

type Op = ["call", string] | ["const", bigint] | ["u64", bigint] | ["add"] | ["sub"] | ["pop"] | ["ret"];

const uleb = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const u64 = (v: bigint): number[] => [...Array(8)].map((_, i) => Number((v >> BigInt(8 * i)) & 0xffn));

/**
 * A Move module (bytecode version 6) named `m` at `address`: one public
 * function per entry of `functions`, all taking and returning nothing, and a
 * constant pool of u64 `constants`. Ops name functions and constants; the
 * builder turns them into table indices in the order given.
 */
function moduleBytes(address: number, functions: Array<[string, Op[]]>, constants: bigint[] = []): Uint8Array {
  const names = functions.map(([name]) => name);
  const identifiers = ["m", ...names].flatMap((s) => [...uleb(s.length), ...Buffer.from(s)]);
  const addr = new Array(32).fill(0);
  addr[0] = address;
  const op = (o: Op): number[] => {
    switch (o[0]) {
      case "call": return [0x11, ...uleb(names.indexOf(o[1]))];
      case "const": return [0x07, ...uleb(constants.indexOf(o[1]))];
      case "u64": return [0x06, ...u64(o[1])];
      case "add": return [0x16];
      case "sub": return [0x17];
      case "pop": return [0x01];
      case "ret": return [0x02];
    }
  };
  const tables: Array<[number, number[]]> = [
    [0x07, identifiers],
    [0x08, addr],
    [0x01, [0, 0]], // module handle: address 0, name `m`
    [0x05, [0]], // signature 0: empty
    [0x06, constants.flatMap((c) => [0x03, 8, ...u64(c)])],
    [0x03, names.flatMap((_, i) => [0, ...uleb(i + 1), 0, 0, 0])],
    [0x0c, functions.flatMap(([, ops], i) => [...uleb(i), 1, 0, 0, 0, ...uleb(ops.length), ...ops.flatMap(op)])],
  ];
  const present = tables.filter(([, content]) => content.length > 0);
  const header: number[] = [...uleb(present.length)];
  let offset = 0;
  for (const [kind, content] of present) {
    header.push(kind, ...uleb(offset), ...uleb(content.length));
    offset += content.length;
  }
  return Uint8Array.from([0xa1, 0x1c, 0xeb, 0x0b, 6, 0, 0, 0, ...header, ...present.flatMap(([, c]) => c), 0]);
}

const code = (bytes: Uint8Array, fn: string) => functionFingerprints(bytes)?.get(fn)?.code;

// f loads a constant, calls g and adds.
const F: Op[] = [["const", 7n], ["u64", 1n], ["add"], ["pop"], ["call", "g"], ["ret"]];
const G: Op[] = [["ret"]];

describe("functionFingerprints", () => {
  it("keeps a function's fingerprint when another function and constant are added before it", () => {
    const before = moduleBytes(0x2b, [["f", F], ["g", G]], [7n]);
    const after = moduleBytes(0x2b, [["h", [["const", 9n], ["pop"], ["ret"]]], ["f", F], ["g", G]], [9n, 7n]);
    expect(moduleFingerprint(before)).not.toBe(moduleFingerprint(after));
    expect(code(before, "f")).toBeDefined();
    expect(code(after, "f")).toBe(code(before, "f"));
    expect(code(after, "g")).toBe(code(before, "g"));
  });

  it("tells a function apart when one instruction, a call target or a constant changes", () => {
    const base = code(moduleBytes(0x2b, [["f", F], ["g", G], ["h", G]], [7n]), "f");
    const withOp = F.map((o): Op => (o[0] === "add" ? ["sub"] : o));
    const withCall = F.map((o): Op => (o[0] === "call" ? ["call", "h"] : o));
    const withConst = F.map((o): Op => (o[0] === "const" ? ["const", 8n] : o));
    expect(code(moduleBytes(0x2b, [["f", withOp], ["g", G], ["h", G]], [7n]), "f")).not.toBe(base);
    expect(code(moduleBytes(0x2b, [["f", withCall], ["g", G], ["h", G]], [7n]), "f")).not.toBe(base);
    expect(code(moduleBytes(0x2b, [["f", withConst], ["g", G], ["h", G]], [8n]), "f")).not.toBe(base);
  });

  it("gives the same function published at another address one fingerprint", () => {
    const here = moduleBytes(0x2b, [["f", F], ["g", G]], [7n]);
    const there = moduleBytes(0x84, [["f", F], ["g", G]], [7n]);
    expect(code(there, "f")).toBeDefined();
    expect(code(there, "f")).toBe(code(here, "f"));
  });

  it("reads nothing from bytes that are not a readable Move module", () => {
    const good = moduleBytes(0x2b, [["f", F], ["g", G]], [7n]);
    const badMagic = Uint8Array.from(good);
    badMagic[0] = 0;
    expect(functionFingerprints(badMagic)).toBeNull();
    expect(functionFingerprints(good.slice(0, good.length - 4))).toBeNull();
  });
});
