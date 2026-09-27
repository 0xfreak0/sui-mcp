/**
 * Reading the Move bytecode disassembly that the GraphQL endpoint returns:
 * splitting a module into its declarations, decoding operands the text leaves
 * raw (clever abort codes, truncated constants, large integers, dependency
 * addresses), and the normal form `diff_package_upgrade` aligns versions on.
 * Pure text in, text out, so every rule here is testable offline.
 */

import type { LinkageEntry } from "./package-diff.js";

/** Trailing whitespace and CRLF are not part of the bytecode. */
export function toLines(code: string): string[] {
  return code.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** A function declaration line: modifiers, name, optional type parameters, `(`. */
export const FUNCTION_DECL = /^((?:(?:entry|native|public(?:\([a-z]+\))?) )*)([A-Za-z_][A-Za-z0-9_]*)(?:<[^(]*>)?\(/;
const DATATYPE_DECL = /^(struct|enum) ([A-Za-z_][A-Za-z0-9_]*)/;
const CONSTANTS_DECL = /^Constants \[/;

export interface Section {
  /**
   * `header` is the module line and its `use` lines, before any declaration;
   * `footer` is the module's closing brace.
   */
  kind: "header" | "function" | "struct" | "enum" | "constants" | "footer";
  /** The declared name; empty for the header, footer and constant pool. */
  name: string;
  /** Index of the section's first line in the module's lines. */
  start: number;
  lines: string[];
}

/**
 * Split a module's lines at each top-level declaration. A declaration runs
 * to its closing `}` (or `]` for the constant pool, or its own line for a
 * native function) plus the blank lines after it. The module's closing brace
 * is a section of its own, so it stays put when declarations move.
 */
export function splitSections(lines: string[]): Section[] {
  const out: Section[] = [];
  let current: Section = { kind: "header", name: "", start: 0, lines: [] };
  let closed = false;
  lines.forEach((line, i) => {
    let next: Section | null = null;
    const fn = FUNCTION_DECL.exec(line);
    const dt = fn ? null : DATATYPE_DECL.exec(line);
    if (fn) next = { kind: "function", name: fn[2], start: i, lines: [] };
    else if (dt) next = { kind: dt[1] as "struct" | "enum", name: dt[2], start: i, lines: [] };
    else if (CONSTANTS_DECL.test(line)) next = { kind: "constants", name: "", start: i, lines: [] };
    else if (closed && line !== "") next = { kind: "footer", name: "", start: i, lines: [] };
    if (next) {
      if (current.lines.length) out.push(current);
      current = next;
      closed = false;
    }
    current.lines.push(line);
    if (current.kind !== "header" && current.kind !== "footer") {
      closed ||= line === "}" || line === "]" || (current.lines.length === 1 && line.endsWith(";"));
    }
  });
  if (current.lines.length) out.push(current);
  return out;
}

/** The declaration line of a section, without its trailing `{` or `;`. */
export function sectionTitle(s: Section): string {
  return s.kind === "header" || s.kind === "footer" ? "" : s.lines[0].replace(/\s*[{;]$/, "");
}

// ---------------------------------------------------------------------------
// Constant pool
// ---------------------------------------------------------------------------

export interface Constant {
  type: string;
  /** The value as printed, without the disassembler's trailing comment. */
  value: string;
  /** The printed value is a string (`vector<u8>` that decodes as UTF-8). */
  isString: boolean;
}

const CONSTANT_ENTRY = /^\t(\d+) => (.+?): (.*)$/;
const UTF8_NOTE = " // interpreted as UTF8 string";

/** The module's constant pool by index, read from its `Constants [ … ]` block. */
export function parseConstants(lines: string[]): Map<number, Constant> {
  const out = new Map<number, Constant>();
  const at = lines.findIndex((l) => CONSTANTS_DECL.test(l));
  if (at < 0) return out;
  for (let i = at + 1; i < lines.length && lines[i] !== "]"; i++) {
    const m = CONSTANT_ENTRY.exec(lines[i]);
    if (!m) continue;
    const isString = m[3].endsWith(UTF8_NOTE);
    out.set(Number(m[1]), {
      type: m[2],
      value: isString ? m[3].slice(0, -UTF8_NOTE.length) : m[3],
      isString,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clever abort codes
// ---------------------------------------------------------------------------

export interface CleverAbort {
  /** Source line of the abort. */
  line: number;
  /** The `#[error(code = N)]` value, when one was set. */
  code?: number;
  /** The error constant's name, e.g. `EInvalidVersion`. */
  name?: string;
  /** The error constant's value as printed, e.g. `"Invalid Version"`. */
  value?: string;
}

const U16_NONE = 0xffff;

/**
 * Decode a clever abort code against the module's constant pool.
 *
 * Layout from the most significant bit: a 4-bit version (0b1000, or 0b1100,
 * which current compilers always write), 4 reserved bits, the 8-bit
 * `#[error(code)]` byte (0xff when unset; not read under 0b1000), then 16
 * bits each of source line,
 * constant-pool index of the error's name and constant-pool index of its
 * value. Both indices are 0xffff for an `assert!` or `abort` with no error
 * constant. Null when the value does not have this layout or an index does
 * not resolve, as Sui's own resolver treats it.
 */
export function decodeCleverAbort(bits: bigint, constants: Map<number, Constant>): CleverAbort | null {
  if (bits < 0n || bits >= 1n << 64n) return null;
  const version = Number((bits >> 60n) & 0xfn);
  if (version !== 0b1000 && version !== 0b1100) return null;
  const code = Number((bits >> 48n) & 0xffn);
  const line = Number((bits >> 32n) & 0xffffn);
  const nameIndex = Number((bits >> 16n) & 0xffffn);
  const valueIndex = Number(bits & 0xffffn);
  if (line === U16_NONE) return null;
  const out: CleverAbort = { line, ...(version === 0b1100 && code !== 0xff ? { code } : {}) };
  if (nameIndex === U16_NONE && valueIndex === U16_NONE) return out;
  const name = constants.get(nameIndex);
  const value = constants.get(valueIndex);
  if (!name?.isString || !value) return null;
  return { ...out, name: name.value.slice(1, -1), value: value.value };
}

function describeAbort(a: CleverAbort): string {
  const code = a.code !== undefined ? ` (code ${a.code})` : "";
  return a.name
    ? `abort ${a.name}${code}: ${a.value}, source line ${a.line}`
    : `abort${code} at source line ${a.line}`;
}

// ---------------------------------------------------------------------------
// Integers
// ---------------------------------------------------------------------------

/**
 * A reading of a large integer that decimal hides: `1 << k` for a power of
 * two, `0xff…ff << k` for a run of ones, otherwise hex. Null below 2^32, and
 * for a decimal that ends in 000, which reads better as it is.
 */
export function describeInteger(n: bigint): string | null {
  if (n < 1n << 32n) return null;
  let shift = 0;
  let m = n;
  while ((m & 1n) === 0n) {
    m >>= 1n;
    shift++;
  }
  if (m === 1n) return `1 << ${shift}`;
  if ((m & (m + 1n)) === 0n && m >= 0xffn) return shift ? `0x${m.toString(16)} << ${shift}` : `0x${m.toString(16)}`;
  if (n.toString().endsWith("000")) return null;
  return `0x${n.toString(16)}`;
}

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

const LD_INT = /\bLd(U64|U128|U256)\((\d+)\)$/;
const LD_CONST = /\bLdConst\[(\d+)\]\((.*)\)$/;
const INT_TYPE = /^u(8|16|32|64|128|256)$/;
/**
 * A `use` line. A module imported under a second name, because two imported
 * modules share one, is printed `use <addr>::pool as 0pool;` and called as
 * `0pool::swap`; group 3 is that alias.
 */
const USE_LINE = /^use ([0-9a-f]{64})::([A-Za-z_][A-Za-z0-9_]*)(?: as ([0-9]+[A-Za-z_][A-Za-z0-9_]*))?;$/;
const ABORT = /^\t\d+: Abort$/;
const SHIFT = /^\t\d+: (Shl|Shr)$/;
/**
 * Move aborts on `Add`, `Sub` and `Mul` overflow but not on a shift that
 * loses bits, which the bare opcode does not tell a reader.
 */
const SHIFT_NOTE: Record<string, string> = {
  Shl: "bits shifted past the type's width are dropped, no abort; only a shift amount >= the width aborts",
  Shr: "low bits shifted out are dropped; only a shift amount >= the width aborts",
};

/** Framework packages live at small reserved addresses (0x1, 0x2, 0x3, 0xb, 0xdee9). */
export const SYSTEM_PACKAGE = /^0x0{60}[0-9a-f]{4}$/;

export interface AnnotateOptions {
  /**
   * The linkage table of the package being read. Each `use` of a dependency
   * then names the version the package runs, since the disassembly prints the
   * dependency's original ID.
   */
  linkage?: LinkageEntry[];
  /** The ID of the package version being read, named on `use` lines of its own modules. */
  packageId?: string;
}

/**
 * The clever abort an `LdU64` operand encodes. Clever codes are compiled only
 * as the operand of `abort` or `assert!`, so a value is read as one only where
 * the next instruction is `Abort`; elsewhere a literal such as `1 << 63` fits
 * the layout by chance.
 */
function cleverAt(lines: string[], i: number, constants: Map<number, Constant>): CleverAbort | null {
  const m = /\bLdU64\((\d+)\)$/.exec(lines[i]);
  if (!m || !ABORT.test(lines[i + 1] ?? "")) return null;
  return decodeCleverAbort(BigInt(m[1]), constants);
}

/** {@link describeInteger} for an integer constant; null for any other type. */
function describeConstant(c: Constant): string | null {
  return INT_TYPE.test(c.type) && /^\d+$/.test(c.value) ? describeInteger(BigInt(c.value)) : null;
}

/**
 * Append a `// …` note to lines whose operand the disassembly leaves raw. The
 * line count and every line's original text are unchanged, so line numbers
 * and patterns over the original text still hold.
 *
 * - `LdU64` of a clever abort code: the error's name, value and source line.
 * - `LdU64`/`LdU128`/`LdU256` of a large integer: its hex or shift form.
 * - `LdConst` whose operand the disassembler cut short (`"VER..`): the full
 *   value from the constant pool; a large integer constant also its hex form.
 * - A constant-pool entry holding a large integer: its hex or shift form.
 * - `use` of another package's module, given its linkage: the version linked
 *   and its ID, since the line prints the dependency's original ID.
 * - `Shl`/`Shr`: that bits shifted out are dropped without an abort.
 */
export function annotateLines(lines: string[], opts: AnnotateOptions = {}): string[] {
  const constants = parseConstants(lines);
  // The header drops leading zeros (`module 2.coin`); `use` lines print all 64 digits.
  const self = /^module ([0-9a-f]{1,64})\./.exec(lines.find((l) => l.startsWith("module ")) ?? "")?.[1]?.padStart(64, "0");
  const linked = new Map<string, LinkageEntry>();
  for (const l of opts.linkage ?? []) linked.set(l.originalId.replace(/^0x/, "").padStart(64, "0"), l);
  const constantsAt = lines.findIndex((l) => CONSTANTS_DECL.test(l));

  return lines.map((line, i) => {
    let note: string | null = null;
    const clever = cleverAt(lines, i, constants);
    const ldInt = LD_INT.exec(line);
    const ldConst = LD_CONST.exec(line);
    const use = USE_LINE.exec(line);
    const shift = SHIFT.exec(line);
    if (clever) note = describeAbort(clever);
    else if (ldInt) note = describeInteger(BigInt(ldInt[2]));
    else if (ldConst) {
      const c = constants.get(Number(ldConst[1]));
      const int = c ? describeConstant(c) : null;
      note = c && ldConst[2].endsWith("..") ? (int ? `${c.value} (${int})` : c.value) : int;
    } else if (constantsAt >= 0 && i > constantsAt) {
      const entry = CONSTANT_ENTRY.exec(line);
      const c = entry ? constants.get(Number(entry[1])) : undefined;
      note = c ? describeConstant(c) : null;
    } else if (use) {
      const dep = linked.get(use[1]);
      if (use[1] === self && opts.packageId) note = `this package: ${opts.packageId}`;
      else if (dep && !SYSTEM_PACKAGE.test(dep.originalId)) note = `linked version ${dep.version}: ${dep.upgradedId}`;
    } else if (shift) note = SHIFT_NOTE[shift[1]];
    return note ? `${line} // ${note}` : line;
  });
}

/** {@link annotateLines} over a whole module's text. */
export function annotateDisassembly(text: string, opts: AnnotateOptions = {}): string {
  return annotateLines(text.split("\n"), opts).join("\n");
}

// ---------------------------------------------------------------------------
// One function
// ---------------------------------------------------------------------------

export interface FunctionExtract {
  /** The function's declaration and body. */
  text: string;
  /** The `use` lines of the modules the body calls into. */
  uses: string[];
  /** Constant-pool entries the body loads, directly or as a clever abort's name and value. */
  constants: string[];
}

/** Names of the functions a module declares, in order. */
export function functionNames(text: string): string[] {
  return splitSections(text.split("\n"))
    .filter((s) => s.kind === "function")
    .map((s) => s.name);
}

/**
 * One function of a module's (annotated) disassembly, with the `use` lines
 * and constant-pool entries it refers to, so it reads without the rest of
 * the module. Null when the module declares no function of that name.
 */
export function extractFunction(text: string, name: string): FunctionExtract | null {
  const lines = text.split("\n");
  const sections = splitSections(lines);
  const fn = sections.find((s) => s.kind === "function" && s.name === name);
  if (!fn) return null;
  const body = [...fn.lines];
  while (body.length && body[body.length - 1] === "") body.pop();
  const bodyText = body.join("\n");

  // A module is called by its name, or by its alias (`0pool::swap`).
  const called = new Set([...bodyText.matchAll(/\b([A-Za-z0-9_]+)::/g)].map((m) => m[1]));
  const uses = lines.filter((l) => {
    const m = USE_LINE.exec(l.replace(/ \/\/ .*$/, ""));
    return !!m && called.has(m[3] ?? m[2]);
  });

  const pool = parseConstants(lines);
  const wanted = new Set<number>();
  for (const m of bodyText.matchAll(/\bLdConst\[(\d+)\]/g)) wanted.add(Number(m[1]));
  body.forEach((line, i) => {
    const m = /\bLdU64\((\d+)\)/.exec(line);
    if (!m || !cleverAt(body.map((l) => l.replace(/ \/\/ .*$/, "")), i, pool)?.name) return;
    const bits = BigInt(m[1]);
    wanted.add(Number((bits >> 16n) & 0xffffn));
    wanted.add(Number(bits & 0xffffn));
  });
  const constants = lines.filter((l) => {
    const m = CONSTANT_ENTRY.exec(l);
    return !!m && wanted.has(Number(m[1]));
  });
  return { text: bodyText, uses, constants: constants.map((l) => l.replace(/^\t/, "")) };
}

// ---------------------------------------------------------------------------
// Normal form for aligning versions
// ---------------------------------------------------------------------------

/**
 * Each line with the numbering a recompile shifts replaced by what it names:
 * instruction offsets, block labels, branch and jump targets, local slots,
 * field and struct indices (the name is printed beside them) and vector
 * signature indices are masked; a constant load becomes the constant's value;
 * a clever abort code becomes its error name and value without the source
 * line. Argument slots, field and type names, call targets and literal
 * operands stay, so two lines with the same normal form do the same thing up
 * to that numbering.
 *
 * A vector instruction's element type is fixed by the verified types of the
 * values around it, which are printed, so its signature index can be masked.
 * A variant handle index (`PackVariant(VariantHandleIndex(0))`) is the only
 * thing that names the variant, and two variants of one enum have the same
 * type, so it stays: a renumbered variant table shows as a change rather than
 * a changed variant hiding as renumbering.
 *
 * Branch targets and local slots are masked here and checked for a
 * consistent renumbering by the caller: a jump to a different instruction
 * normalises the same as one to the same instruction.
 */
export function normalizeLines(lines: string[]): string[] {
  const constants = parseConstants(lines);
  const constantsAt = lines.findIndex((l) => CONSTANTS_DECL.test(l));
  return lines.map((line, i) => {
    if (constantsAt >= 0 && i > constantsAt) return line.replace(/^\t\d+ => /, "\t# => ");
    let s = line
      .replace(/^\t\d+: /, "\t#: ")
      .replace(/^B\d+:$/, "B#:")
      .replace(/^L\d+:\tloc\d+: /, "L#:\tloc#: ")
      .replace(/^\[\d+\]:/, "[#]:")
      .replace(/\b(Branch|BrTrue|BrFalse)\(\d+\)/, "$1(@)")
      .replace(/=> jump \d+$/, "=> jump @")
      .replace(/\[\d+\]\(loc\d+: /, "[#](loc#: ")
      .replace(/\b(Vec[A-Za-z]+)\(\d+/, "$1(#");
    const ldConst = /\bLdConst\[(\d+)\]\(.*$/.exec(s);
    if (ldConst) {
      const c = constants.get(Number(ldConst[1]));
      s = s.slice(0, ldConst.index) + (c ? `LdConst(${c.type}: ${c.value})` : "LdConst[#](?)");
    } else {
      s = s.replace(/^(\t#: \w+)\[\d+\]\((?!Arg\d)/, "$1[#](");
    }
    const clever = cleverAt(lines, i, constants);
    if (clever) {
      const what = [clever.name ?? "", clever.code ?? "", clever.value ?? ""].join("|");
      s = s.replace(/\bLdU64\(\d+\)$/, `LdU64(abort ${what})`);
    }
    return s;
  });
}

/** Instruction offset of a disassembly line, or null for a label, local or declaration. */
export function instructionOffset(line: string): number | null {
  const m = /^\t(\d+): /.exec(line);
  return m ? Number(m[1]) : null;
}

/** The branch or jump-table target a line names, if any. */
export function branchTarget(line: string): number | null {
  const m = /\b(?:Branch|BrTrue|BrFalse)\((\d+)\)|=> jump (\d+)$/.exec(line);
  return m ? Number(m[1] ?? m[2]) : null;
}
