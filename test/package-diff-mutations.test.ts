import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { diffPackages } from "../src/utils/package-diff.js";
import { splitSections } from "../src/utils/disassembly.js";

/**
 * Real module disassemblies, each mutated one instruction at a time in a way
 * that changes what the code does. Whatever the mutation, the diff must list
 * the function in `changed_functions`: never identical, never renumbering only.
 *
 * - spool: Scallop spool v2 (0xec1ac7f4…), branches, locals and fields.
 * - allowance: 0x2::allowance, enum variants and a variant jump table.
 * - oracle: Typus oracle v12 (0xe684e378…), clever abort codes and constants.
 */
const FIXTURES = ["scallop-spool-v2", "sui-allowance", "typus-oracle-v12"].map((name) => ({
  name,
  text: readFileSync(new URL(`./fixtures/disassembly/${name}.txt`, import.meta.url), "utf8"),
}));

interface Mutation {
  fn: string;
  kind: string;
  /** Line index in the module, and its replacement(s) in order. */
  at: number;
  lines: string[];
}

const OFFSET = /^\t(\d+): (.*)$/;
const LOCAL = /\b(StLoc|MoveLoc|CopyLoc|ImmBorrowLoc|MutBorrowLoc)\[(\d+)\]\((loc\d+): (.*)\)$/;

/** Every one-line semantic mutation of every function in `text`. */
function mutations(text: string): Mutation[] {
  const lines = text.split("\n");
  const out: Mutation[] = [];
  const constants = new Map<number, string>();
  for (const l of lines) {
    const m = /^\t(\d+) => (.*)$/.exec(l);
    if (m) constants.set(Number(m[1]), m[2]);
  }
  for (const s of splitSections(lines)) {
    if (s.kind !== "function") continue;
    const offsets = new Set(s.lines.map((l) => OFFSET.exec(l)?.[1]).filter(Boolean).map(Number));
    // Locals declared in this function, by type.
    const declared = [...s.lines.join("\n").matchAll(/^L(\d+):\t(loc\d+): (.*)$/gm)].map((m) => ({
      slot: Number(m[1]),
      name: m[2],
      type: m[3],
    }));
    s.lines.forEach((line, k) => {
      const at = s.start + k;
      const push = (kind: string, next: string) => {
        if (next !== line) out.push({ fn: s.name, kind, at, lines: [next] });
      };
      // Retarget a branch or a jump-table arm to another instruction.
      const br = /\b(Branch|BrTrue|BrFalse)\((\d+)\)|=> jump (\d+)$/.exec(line);
      if (br) {
        const target = Number(br[2] ?? br[3]);
        const other = [...offsets].find((o) => o !== target);
        if (other !== undefined) push("retarget", line.replace(/\((\d+)\)$|jump \d+$/, (m) => (m.startsWith("(") ? `(${other})` : `jump ${other}`)));
      }
      // Change a literal.
      const lit = /\bLd(U8|U16|U32|U64|U128|U256)\((\d+)\)$/.exec(line);
      if (lit) push("literal", line.replace(/\((\d+)\)$/, `(${BigInt(lit[2]) + 1n})`));
      // Load a different constant.
      const ld = /\bLdConst\[(\d+)\]/.exec(line);
      if (ld) {
        const value = constants.get(Number(ld[1]));
        const other = [...constants].find(([, v]) => v !== value);
        if (other) push("constant", line.replace(/LdConst\[\d+\]\(.*\)$/, `LdConst[${other[0]}](${other[1].replace(/ \/\/.*$/, "")})`));
      }
      // Pack or unpack a different enum variant.
      const variant = /\b(VariantHandleIndex|VariantInstantiationHandleIndex)\((\d+)\)/.exec(line);
      if (variant) push("variant", line.replace(variant[0], `${variant[1]}(${Number(variant[2]) + 1})`));
      // Use another local of the same type.
      const local = LOCAL.exec(line);
      if (local) {
        const other = declared.find((d) => d.type === local[4] && d.name !== local[3]);
        if (other) push("local", line.replace(LOCAL, `${local[1]}[${other.slot}](${other.name}: ${other.type})`));
      }
      // Swap two adjacent reads with different operands.
      const next = s.lines[k + 1];
      const a = OFFSET.exec(line);
      const b = next ? OFFSET.exec(next) : null;
      if (a && b && /^(MoveLoc|CopyLoc)\[/.test(a[2]) && /^(MoveLoc|CopyLoc)\[/.test(b[2]) && a[2] !== b[2]) {
        out.push({ fn: s.name, kind: "swap", at, lines: [`\t${a[1]}: ${b[2]}`, `\t${b[1]}: ${a[2]}`] });
      }
    });
  }
  return out;
}

describe("diff of a semantic one-instruction change", () => {
  for (const { name, text } of FIXTURES) {
    it(`lists the changed function for every mutation of ${name}`, () => {
      const all = mutations(text);
      // Every kind the fixture can carry is exercised.
      expect(all.length).toBeGreaterThan(20);
      const missed: string[] = [];
      for (const m of all) {
        const lines = text.split("\n");
        lines.splice(m.at, m.lines.length, ...m.lines);
        const d = diffPackages(new Map([["m", text]]), new Map([["m", lines.join("\n")]]));
        const listed = d.changed_functions.some((f) => f.function === m.fn);
        if (d.identical || !listed) missed.push(`${m.kind} in ${m.fn} at line ${m.at + 1}: ${m.lines.join(" / ").trim()}`);
      }
      expect(missed).toEqual([]);
    });
  }

  it("covers each mutation kind across the fixtures", () => {
    const kinds = new Set(FIXTURES.flatMap(({ text }) => mutations(text).map((m) => m.kind)));
    expect([...kinds].sort()).toEqual(["constant", "literal", "local", "retarget", "swap", "variant"]);
  });
});
