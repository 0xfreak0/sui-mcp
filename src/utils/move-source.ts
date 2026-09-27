/**
 * Reading Move source text, as an external decompiler prints it: one
 * function out of a module, and notes on large decimal literals. Everything
 * here matches declarations on code only, so a `fun` or a brace inside a
 * string or comment never counts.
 */

import { describeInteger } from "./disassembly.js";

/**
 * The source with every string literal's contents and every comment replaced
 * by spaces, newlines kept, so offsets and line numbers match the original
 * and patterns over the result see code only. Move strings are `"…"`, `b"…"`
 * and `x"…"` with `\` escapes; comments are `//` to the end of the line and
 * `/* … *\/`.
 */
export function maskSource(src: string): string {
  const out = src.split("");
  const blank = (i: number) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") blank(i++);
    } else if (c === "/" && next === "*") {
      blank(i++);
      blank(i++);
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) blank(i++);
      if (i < src.length) {
        blank(i++);
        blank(i++);
      }
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") blank(i++);
        if (i < src.length) blank(i++);
      }
      i++;
    } else i++;
  }
  return out.join("");
}

const MODIFIERS = String.raw`(?:(?:public(?:\s*\(\s*[a-z]+\s*\))?|entry|native|inline|macro)\s+)*`;

const IDENTIFIER = "[A-Za-z_][A-Za-z0-9_]*";

/** A function declaration: modifiers, `fun`, the name, then type parameters or `(`. */
function functionDecl(name: string): RegExp {
  return new RegExp(String.raw`^[ \t]*${MODIFIERS}fun\s+(${name})\s*[<(]`, "gm");
}

/** Names of the functions the source declares, in order. */
export function sourceFunctionNames(src: string): string[] {
  return [...maskSource(src).matchAll(functionDecl(IDENTIFIER))].map((m) => m[1]);
}

export interface SourceFunction {
  /** The declaration, with any attributes and doc comments directly above it, and body. */
  text: string;
  /** The module's `use` lines naming a module or member the function refers to. */
  uses: string[];
  /** The module's `const` declarations the function refers to. */
  constants: string[];
}

const USE_DECL = /^[ \t]*use\s+([^;]+);/gm;
const CONST_DECL = /^[ \t]*const\s+([A-Za-z_][A-Za-z0-9_]*)\s*:[^;]*;/gm;

/** The names a `use` path brings into scope: `a::m`, `a::m as n`, `a::m::{Self, f as g}`. */
function useNames(path: string): string[] {
  const group = /^(.*)::\{([^}]*)\}\s*$/.exec(path);
  const one = (item: string, mod: string) => {
    const alias = /\bas\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(item);
    if (alias) return alias[1];
    const last = item.trim().split("::").pop()!.trim();
    return last === "Self" ? mod : last;
  };
  if (!group) return [one(path, "")];
  const mod = group[1].split("::").pop()!.trim();
  return group[2].split(",").filter((s) => s.trim()).map((s) => one(s, mod));
}

/**
 * One function of a module's Move source, with the `use` lines and constants
 * it refers to. Braces are matched on the masked source, so a brace inside a
 * string or comment does not end the body; a `native` declaration ends at
 * its `;`. Null when the module declares no function of that name.
 */
export function extractSourceFunction(src: string, name: string): SourceFunction | null {
  if (!new RegExp(`^${IDENTIFIER}$`).test(name)) return null;
  const masked = maskSource(src);
  const decl = functionDecl(name).exec(masked);
  if (!decl) return null;

  let end = -1;
  let depth = 0;
  for (let i = decl.index + decl[0].length; i < masked.length; i++) {
    const c = masked[i];
    if (c === ";" && depth === 0) {
      end = i + 1;
      break;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end < 0) end = masked.length;

  // Attributes and doc comments directly above the declaration belong to it.
  const lines = src.slice(0, decl.index).split("\n");
  lines.pop();
  let start = decl.index;
  for (let j = lines.length - 1; j >= 0 && /^\s*(#\[|\/\/\/)/.test(lines[j]); j--) {
    start -= lines[j].length + 1;
  }
  const text = src.slice(start, end);
  const code = masked.slice(decl.index, end);
  const words = new Set(code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

  const uses = [...masked.matchAll(USE_DECL)]
    .filter((m) => useNames(m[1]).some((n) => words.has(n)))
    .map((m) => src.slice(m.index, m.index + m[0].length).trim());
  const constants = [...masked.matchAll(CONST_DECL)]
    .filter((m) => words.has(m[1]))
    .map((m) => src.slice(m.index, m.index + m[0].length).trim());
  return { text: dedent(text), uses, constants };
}

/** Remove the indentation every non-blank line shares. */
function dedent(text: string): string {
  const lines = text.split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(cut, /^[ \t]*/.exec(l)![0].length))).join("\n");
}

const DECIMAL = /(?<![A-Za-z0-9_.])(\d[\d_]*)(?:u8|u16|u32|u64|u128|u256)?(?![A-Za-z0-9_])/g;

/**
 * Append a ` // …` note to each line holding a decimal literal that reads
 * better in hex or shift form ({@link describeInteger}), as the disassembly
 * does. No line's text or the line count changes. A line with several such
 * literals names each one.
 */
export function annotateSource(src: string): string {
  const masked = maskSource(src).split("\n");
  return src
    .split("\n")
    .map((line, i) => {
      const found: [string, string][] = [];
      for (const m of masked[i].matchAll(DECIMAL)) {
        const digits = m[1].replace(/_/g, "");
        const form = describeInteger(BigInt(digits));
        if (form) found.push([digits, form]);
      }
      if (!found.length) return line;
      const note = found.length === 1 ? found[0][1] : found.map(([d, f]) => `${d} = ${f}`).join("; ");
      return `${line} // ${note}`;
    })
    .join("\n");
}
