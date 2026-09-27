/**
 * Guard data flow over a package's disassembly. Each function's stack and
 * locals are interpreted abstractly: every value carries the set of sources
 * it was computed from (a parameter, a read of an object a parameter
 * references, the transaction sender, a check's result), and calls into the
 * same package are followed through per-function summaries. Three rules read
 * the result, none of them keyed on a function, type or field name:
 *
 * - `discarded-check`: a bool from a comparison, or from a call that only
 *   reads, that reaches no branch, abort, return, store or other use.
 * - `sibling-guard-gap`: a public function that mutates an object of a
 *   package type without a check-like call that most other public functions
 *   of the module mutating that type make.
 * - `unchecked-state-write`: a public function that writes a caller-supplied
 *   value into a field of a shared object with no branch comparing it
 *   against stored state and no authority check on the path.
 *
 * Each result is a lead with the instructions that support it, graded by how
 * directly the data flow supports it. None of them says the code is wrong.
 */

import { FUNCTION_DECL, splitSections, toLines } from "./disassembly.js";

// ---------------------------------------------------------------------------
// Parsed form
// ---------------------------------------------------------------------------

interface Instr {
  off: number;
  op: string;
  text: string;
}

interface FnIR {
  module: string;
  name: string;
  /** Callable from a transaction or another package: `public` or `entry`. */
  external: boolean;
  params: string[];
  returns: string[];
  blocks: Instr[][];
  native: boolean;
}

interface ModuleIR {
  name: string;
  /** Module prefixes (name or alias) of the calls that land in this package. */
  local: Map<string, string>;
  /** Field count and abilities of each struct and enum the module declares. */
  structs: Map<string, { fields: number; key: boolean; copy: boolean }>;
  /** `Struct.field` of every field typed `UID`: reading one reaches dynamic fields or the ID, not a stored value. */
  uid: Set<string>;
  fns: Map<string, FnIR>;
}

const MODULE_LINE = /^module ([0-9a-f]+)\.([A-Za-z_][A-Za-z0-9_]*) \{$/;
const USE = /^use ([0-9a-f]{64})::([A-Za-z_][A-Za-z0-9_]*)(?: as ([0-9]+[A-Za-z_][A-Za-z0-9_]*))?;/;
const INSTR = /^\t(\d+): ([A-Za-z0-9]+)(.*)$/;
const JUMP = /=> jump (\d+)$/;
/** Split at `sep` outside angle brackets and parentheses. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "<" || ch === "(") depth++;
    if (ch === ">" || ch === ")") depth--;
    if (depth === 0 && s.startsWith(sep, i)) {
      out.push(cur.trim());
      cur = "";
      i += sep.length - 1;
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Parameter types as printed, `Arg0: ` prefixes dropped: `Arg0: &mut Pool<A, B>, Arg1: u64` → two. */
const splitTypes = (s: string) => splitTop(s, ",").map((p) => p.replace(/^Arg\d+: /, ""));

/** The text between the bracket at `open` and its match. */
function balanced(s: string, open: number): { inner: string; end: number } | null {
  const o = s[open];
  const c = o === "(" ? ")" : ">";
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === o) depth++;
    else if (s[i] === c && --depth === 0) return { inner: s.slice(open + 1, i), end: i };
  }
  return null;
}

/** A type without its reference marker and type arguments: `&mut Pool<T>` → `Pool`. */
function baseType(t: string): string {
  return t.replace(/^&(mut )?/, "").replace(/<.*$/, "");
}

function parseFunction(module: string, lines: string[]): FnIR | null {
  const head = lines[0];
  const d = FUNCTION_DECL.exec(head);
  if (!d) return null;
  const mods = d[1];
  const open = d[0].length - 1;
  const p = balanced(head, open);
  if (!p) return null;
  const rest = head.slice(p.end + 1).replace(/\s*[{;]$/, "");
  const returns = rest.startsWith(": ") ? splitTop(rest.slice(2), " * ") : [];
  const native = /\bnative\b/.test(mods);
  const external = /\bentry\b/.test(mods) || /(^| )public (?!\()/.test(` ${mods}`);
  const instrs: Instr[] = [];
  const targets = new Set<number>();
  for (const line of lines.slice(1)) {
    const m = INSTR.exec(line);
    if (m) {
      instrs.push({ off: Number(m[1]), op: m[2], text: `${m[1]}: ${m[2]}${m[3]}` });
      const t = /\b(?:Branch|BrTrue|BrFalse)\((\d+)\)/.exec(line);
      if (t) targets.add(Number(t[1]));
      continue;
    }
    const j = JUMP.exec(line);
    if (j) targets.add(Number(j[1]));
  }
  // Basic blocks as the bytecode verifier cuts them: at every jump target and
  // after every instruction that ends one. The verifier requires the stack to
  // be empty at each block's end.
  const blocks: Instr[][] = [];
  let cur: Instr[] = [];
  for (const ins of instrs) {
    if (targets.has(ins.off) && cur.length) {
      blocks.push(cur);
      cur = [];
    }
    cur.push(ins);
    if (/^(Branch|BrTrue|BrFalse|Ret|Abort|VariantSwitch)$/.test(ins.op)) {
      blocks.push(cur);
      cur = [];
    }
  }
  if (cur.length) blocks.push(cur);
  return {
    module,
    name: d[2],
    external,
    params: splitTypes(p.inner),
    returns,
    blocks,
    native,
  };
}

function parseModule(text: string): ModuleIR | null {
  const lines = toLines(text);
  const header = lines.map((l) => MODULE_LINE.exec(l)).find((m) => m);
  if (!header) return null;
  const self = header[1].padStart(64, "0");
  const local = new Map<string, string>([["", header[2]]]);
  for (const l of lines) {
    const u = USE.exec(l);
    if (u && u[1] === self) local.set(u[3] ?? u[2], u[2]);
  }
  const structs = new Map<string, { fields: number; key: boolean; copy: boolean }>();
  const uid = new Set<string>();
  const fns = new Map<string, FnIR>();
  for (const s of splitSections(lines)) {
    if (s.kind === "struct" || s.kind === "enum") {
      // An enum is never an object (`key`) and is built by PackVariant, so
      // its field count is unused; its abilities still say whether a caller
      // can copy it.
      const abilities = /\bhas ([a-z, ]+)/.exec(s.lines[0])?.[1] ?? "";
      structs.set(s.name, {
        fields: s.kind === "enum" ? 0 : s.lines.slice(1).filter((l) => /^\t[A-Za-z_][A-Za-z0-9_]*: /.test(l)).length,
        key: /\bkey\b/.test(abilities),
        copy: /\bcopy\b/.test(abilities),
      });
      for (const l of s.lines.slice(1)) {
        const f = /^\t([A-Za-z_][A-Za-z0-9_]*): UID,?$/.exec(l);
        if (f) uid.add(`${s.name}.${f[1]}`);
      }
    } else if (s.kind === "function") {
      const f = parseFunction(header[2], s.lines);
      if (f) fns.set(f.name, f);
    }
  }
  return { name: header[2], local, structs, uid, fns };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------
//
// `p<i>`  the value of parameter i (a plain value, or a local copy of one)
// `r<i>`  a reference reached from reference parameter i
// `s<i>`  a value read through such a reference: state stored in i's object
// `snd`   the transaction sender
// `c@<k>` the result of the check at instruction k
// `l<n>`  a reference to local slot n, so a write through it reaches the local
// `q<a>|<b>` sources a and b stood on opposite sides of one comparison (or
//         were separate arguments of one check), so one bounds the other. A
//         value computed from both and compared with a constant carries a and
//         b but no pair: nothing compared them with each other.
// `k<a>|<b>` a call that changes what a reads through, given b, can abort on
//         the two together (`balance::split`, `table::add`): a bound, but not
//         a test of b's identity, so a `k` pair with the sender checks no one.

type Labels = Set<string>;

const union = (...xs: Labels[]): Labels => {
  const out = new Set<string>();
  for (const x of xs) for (const l of x) out.add(l);
  return out;
};

/** A read through a reference: what it pointed into becomes stored state. */
const readThrough = (x: Labels): Labels =>
  new Set([...x].filter((l) => l[0] !== "l").map((l) => (l[0] === "r" ? `s${l.slice(1)}` : l)));

/** Labels of a value computed from others: what they point to is not carried. */
const valueOf = (...xs: (Labels | undefined)[]): Labels =>
  new Set(xs.flatMap((x) => [...(x ?? [])]).filter((l) => l[0] !== "l"));

const paramOf = (l: string): number | null => (/^[prs]\d+$/.test(l) ? Number(l.slice(1)) : null);

/** The reference labels of a value: which parameters' objects it points into. */
const refsOf = (x: Labels): Labels => new Set([...x].filter((l) => l[0] === "r"));

const SOURCE = /^([prs]\d+|snd)$/;

/**
 * Pair labels (`q` or `k`) for operands tested together: every source on
 * one side against every source on the other. A callee's parameters may be
 * the caller's values or stored state, so every pair is kept for the caller
 * to map.
 */
function pairs(kind: "q" | "k", ...sides: Labels[]): Labels {
  const out = new Set<string>();
  for (let i = 0; i < sides.length; i++)
    for (let j = i + 1; j < sides.length; j++)
      for (const a of sides[i])
        for (const b of sides[j]) {
          if (a === b || !SOURCE.test(a) || !SOURCE.test(b)) continue;
          out.add(a < b ? `${kind}${a}|${b}` : `${kind}${b}|${a}`);
        }
  return out;
}

/**
 * Whether a chain of comparisons in `conditions` links parameter label `p`
 * to stored state: `p` compared with stored state, or with another value
 * that is (a message checked for equality and then verified against a
 * stored key binds every value the message was built from).
 */
function comparedWithStored(conditions: Labels[], p: string): boolean {
  const next = new Map<string, string[]>();
  for (const c of conditions)
    for (const l of c) {
      if (l[0] !== "q" && l[0] !== "k") continue;
      const [a, b] = l.slice(1).split("|");
      next.set(a, [...(next.get(a) ?? []), b]);
      next.set(b, [...(next.get(b) ?? []), a]);
    }
  const seen = new Set([p]);
  const todo = [p];
  while (todo.length) {
    for (const n of next.get(todo.pop()!) ?? []) {
      if (/^[rs]\d+$/.test(n)) return true;
      if (!seen.has(n)) {
        seen.add(n);
        todo.push(n);
      }
    }
  }
  return false;
}

interface Write {
  /** Reference labels of the written location. */
  target: Labels;
  value: Labels;
  /** `module::fn: offset: instruction` of the WriteRef. */
  at: string;
}

interface Guard {
  key: string;
  /** Parameter labels (`r<i>`, `s<i>`, `p<i>`) the guard read. */
  on: Labels;
  at: string;
}

interface Summary {
  fn: FnIR;
  returns: Labels[];
  /** Labels whose value reaches a use other than Pop or an unread local. */
  used: Labels;
  /** Label sets that reached a branch condition, an abort or a check call. */
  conditions: Labels[];
  writes: Write[];
  mutated: Labels;
  guards: Guard[];
  /** Some path aborts, here or in a same-package callee. */
  aborts: boolean;
  /** Check results that reach no use, with the instruction that made them. */
  dropped: { at: string; inputs: Labels }[];
  /** Stack arities could not all be resolved. */
  partial: boolean;
  /** `Struct.field` names borrowed immutably and mutably, here or in a same-package callee. */
  fieldsRead: Set<string>;
  fieldsMut: Set<string>;
}

const PLAIN = /^(bool|u8|u16|u32|u64|u128|u256|address|String|TypeName|ID|vector<(?:bool|u8|u16|u32|u64|u128|u256|address)>)$/;
const COMPARISON = /^(Eq|Neq|Lt|Gt|Le|Ge)$/;
const BINARY = /^(Add|Sub|Mul|Div|Mod|BitOr|BitAnd|Xor|Shl|Shr|Or|And)$/;
const LOAD = /^(LdConst|LdU8|LdU16|LdU32|LdU64|LdU128|LdU256|LdTrue|LdFalse)$/;
const PASS = /^(ImmBorrowField|ImmBorrowFieldGeneric|MutBorrowField|MutBorrowFieldGeneric|FreezeRef|Not|CastU8|CastU16|CastU32|CastU64|CastU128|CastU256)$/;

interface CallSite {
  module: string;
  name: string;
  params: string[];
  returns: string[];
}

function parseCall(text: string): CallSite | null {
  const m = /^\d+: Call ([A-Za-z0-9_]+::)?([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  if (!m) return null;
  let i = m[0].length;
  if (text[i] === "<") {
    const g = balanced(text, i);
    if (!g) return null;
    i = g.end + 1;
  }
  if (text[i] !== "(") return null;
  const p = balanced(text, i);
  if (!p) return null;
  const rest = text.slice(p.end + 1);
  return {
    module: m[1] ? m[1].slice(0, -2) : "",
    name: m[2],
    params: p.inner.trim() ? splitTypes(p.inner) : [],
    returns: rest.startsWith(": ") ? splitTop(rest.slice(2), " * ") : [],
  };
}

/** Parameters that cannot change state: immutable references and plain values. */
const readOnly = (params: string[]) => params.every((p) => (p.startsWith("&") && !p.startsWith("&mut ")) || PLAIN.test(p));

/**
 * A call whose one result is a bool and which cannot change state: its only
 * effect is that bool, so dropping it drops the whole call. A call taking
 * `&mut` returns a status beside a state change (`table::remove`), and a bool
 * inside a tuple is one field of a record read out, not a check.
 */
const isCheckCall = (c: CallSite) => c.returns.length === 1 && c.returns[0] === "bool" && readOnly(c.params);

// ---------------------------------------------------------------------------
// Package analysis
// ---------------------------------------------------------------------------

class PackageFlow {
  readonly modules = new Map<string, ModuleIR>();
  private readonly summaries = new Map<string, Summary | null>();
  /** Struct and enum names the package declares, with abilities. */
  readonly structs = new Map<string, { key: boolean; copy: boolean }>();
  /** Struct names the package passes to `share_object`/`public_share_object`. */
  readonly shared = new Set<string>();
  /**
   * Struct types the package copies by value somewhere. Only a type with the
   * `copy` ability can be copied, and such a type has no `key`: it is a plain
   * value, never an object, capability or receipt.
   */
  readonly copied = new Set<string>();
  /** `Struct.field` of every field typed `UID`. */
  readonly uid = new Set<string>();

  constructor(disassembly: Map<string, string>) {
    for (const text of disassembly.values()) {
      const m = parseModule(text);
      if (!m) continue;
      this.modules.set(m.name, m);
      for (const [n, s] of m.structs) this.structs.set(n, s);
      for (const f of m.uid) this.uid.add(f);
      for (const f of m.fns.values())
        for (const b of f.blocks)
          for (const ins of b) {
            const s = /Call transfer::(?:public_)?share_object<(.+)>\(/.exec(ins.text);
            if (s) this.shared.add(baseType(s[1]));
            const c = /^\d+: CopyLoc\[\d+\]\([A-Za-z0-9]+: ([^&].*)\)$/.exec(ins.text);
            if (c) this.copied.add(baseType(c[1]));
          }
    }
  }

  private resolve(from: ModuleIR, call: CallSite): FnIR | null {
    const mod = from.local.get(call.module);
    if (mod === undefined) return null;
    return this.modules.get(mod)?.fns.get(call.name) ?? null;
  }

  summary(module: string, name: string): Summary | null {
    const key = `${module}::${name}`;
    if (this.summaries.has(key)) return this.summaries.get(key) ?? null;
    const mod = this.modules.get(module);
    const fn = mod?.fns.get(name);
    if (!mod || !fn || fn.native) return null;
    this.summaries.set(key, null); // recursion reads as an unknown callee
    const s = this.interpret(mod, fn);
    this.summaries.set(key, s);
    return s;
  }

  private arity(mod: ModuleIR, ins: Instr): { pop: number; push: number } | null {
    const { op, text } = ins;
    if (/^(MoveLoc|CopyLoc|ImmBorrowLoc|MutBorrowLoc)$/.test(op) || LOAD.test(op)) return { pop: 0, push: 1 };
    if (/^(StLoc|Pop|BrTrue|BrFalse|Abort|VariantSwitch)$/.test(op)) return { pop: 1, push: 0 };
    if (PASS.test(op) || /^(ReadRef|VecLen|VecPopBack)$/.test(op)) return { pop: 1, push: 1 };
    if (BINARY.test(op) || COMPARISON.test(op) || /^(VecImmBorrow|VecMutBorrow)$/.test(op)) return { pop: 2, push: 1 };
    if (/^(WriteRef|VecPushBack)$/.test(op)) return { pop: 2, push: 0 };
    if (op === "VecSwap") return { pop: 3, push: 0 };
    if (/^(Branch|Nop)$/.test(op)) return { pop: 0, push: 0 };
    if (op === "VecPack") {
      const n = /\(\d+, (\d+)\)/.exec(text);
      return n ? { pop: Number(n[1]), push: 1 } : null;
    }
    if (op === "VecUnpack") {
      const n = /\(\d+, (\d+)\)/.exec(text);
      return n ? { pop: 1, push: Number(n[1]) } : null;
    }
    if (/^(Pack|PackGeneric|Unpack|UnpackGeneric)$/.test(op)) {
      const n = /\]\(([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
      const s = n ? mod.structs.get(n[1]) : undefined;
      if (!s) return null;
      return op.startsWith("Pack") ? { pop: s.fields, push: 1 } : { pop: 1, push: s.fields };
    }
    if (op === "Call") {
      const c = parseCall(text);
      return c ? { pop: c.params.length, push: c.returns.length } : null;
    }
    if (/^(Pack|Unpack)Variant/.test(op)) {
      const f = this.variantFields(mod).get(/\((Variant\w*HandleIndex\(\d+\))\)/.exec(text)?.[1] ?? "");
      if (f === undefined) return null;
      return op.startsWith("Pack") ? { pop: f, push: 1 } : { pop: 1, push: f };
    }
    return null;
  }

  private readonly variants = new Map<string, Map<string, number>>();

  /**
   * Field count of each variant handle a module uses. The disassembly names
   * a handle only by index, so the counts are solved from the verifier's
   * rule that every basic block leaves the stack as it found it (empty): a
   * block whose one unknown is a handle fixes that handle's count, which may
   * then resolve other blocks.
   */
  private variantFields(mod: ModuleIR): Map<string, number> {
    const known = this.variants.get(mod.name);
    if (known) return known;
    const solved = new Map<string, number>();
    this.variants.set(mod.name, solved);
    const equations: { net: number; coef: Map<string, number> }[] = [];
    for (const fn of mod.fns.values())
      for (const b of fn.blocks) {
        let net = 0;
        const coef = new Map<string, number>();
        let opaque = false;
        for (const ins of b) {
          const handle = /^(Pack|Unpack)Variant/.test(ins.op) ? /\((Variant\w*HandleIndex\(\d+\))\)/.exec(ins.text)?.[1] : undefined;
          if (handle) {
            // Pack: pops f, pushes 1. Unpack (by value or reference): pops 1, pushes f.
            const sign = ins.op.startsWith("Pack") ? -1 : 1;
            net -= sign;
            coef.set(handle, (coef.get(handle) ?? 0) + sign);
            continue;
          }
          const a = ins.op === "Ret" ? { pop: fn.returns.length, push: 0 } : this.arity(mod, ins);
          if (!a) opaque = true;
          else net += a.push - a.pop;
        }
        if (!opaque && coef.size) equations.push({ net, coef });
      }
    for (let progress = true; progress; ) {
      progress = false;
      for (const e of equations) {
        const open = [...e.coef].filter(([k, c]) => c !== 0 && !solved.has(k));
        if (open.length !== 1) continue;
        const rest = [...e.coef].reduce((acc, [k, c]) => acc + (solved.has(k) ? c * (solved.get(k) ?? 0) : 0), e.net);
        const [k, c] = open[0];
        const f = -rest / c;
        if (Number.isInteger(f) && f >= 0) {
          solved.set(k, f);
          progress = true;
        }
      }
    }
    return solved;
  }

  private interpret(mod: ModuleIR, fn: FnIR): Summary {
    const where = (ins: Instr) => `${fn.module}::${fn.name}: ${ins.text}`;
    let partial = false;
    const arities = new Map<Instr, { pop: number; push: number }>();
    for (const b of fn.blocks)
      for (const ins of b) {
        const a = ins.op === "Ret" ? { pop: fn.returns.length, push: 0 } : this.arity(mod, ins);
        if (a) arities.set(ins, a);
        else partial = true;
      }

    const locals = new Map<number, Labels>();
    fn.params.forEach((t, i) => locals.set(i, new Set([t.startsWith("&") ? `r${i}` : `p${i}`])));
    const origins = new Map<string, { at: string; inputs: Labels }>();

    const out: Summary = {
      fn,
      returns: fn.returns.map(() => new Set()),
      used: new Set(),
      conditions: [],
      writes: [],
      mutated: new Set(),
      guards: [],
      aborts: false,
      dropped: [],
      partial,
      fieldsRead: new Set(),
      fieldsMut: new Set(),
    };
    const condKeys = new Set<string>();
    const addCondition = (x: Labels) => {
      const k = [...x].sort().join(",");
      if (!x.size || condKeys.has(k)) return;
      condKeys.add(k);
      out.conditions.push(x);
    };
    const writeKeys = new Set<string>();
    const addWrite = (w: Write) => {
      const k = `${[...w.target].sort()}|${[...w.value].sort()}|${w.at}`;
      if (writeKeys.has(k)) return;
      writeKeys.add(k);
      out.writes.push(w);
    };
    const guardKeys = new Set<string>();
    const addGuard = (g: Guard) => {
      const k = `${g.key}|${[...g.on].sort()}`;
      if (guardKeys.has(k)) return;
      guardKeys.add(k);
      out.guards.push(g);
    };

    const run = (record: boolean): boolean => {
      let changed = false;
      const store = (slot: number, v: Labels) => {
        const cur = locals.get(slot) ?? new Set<string>();
        const size = cur.size;
        for (const l of v) cur.add(l);
        locals.set(slot, cur);
        if (cur.size !== size) changed = true;
      };
      const use = (v: Labels) => {
        if (record) for (const l of v) out.used.add(l);
      };
      for (const b of fn.blocks) {
        const stack: Labels[] = [];
        const pop = () => stack.pop() ?? new Set<string>();
        const popN = (n: number) => stack.splice(Math.max(0, stack.length - n), n);
        for (const ins of b) {
          const a = arities.get(ins);
          if (!a) break;
          const slot = /^[A-Za-z]+\[(\d+)\]/.exec(ins.text.replace(/^\d+: /, ""));
          const { op } = ins;
          if (op === "MoveLoc" || op === "CopyLoc") {
            stack.push(new Set(locals.get(Number(slot?.[1])) ?? []));
          } else if (op === "ImmBorrowLoc" || op === "MutBorrowLoc") {
            stack.push(union(locals.get(Number(slot?.[1])) ?? new Set(), new Set([`l${slot?.[1]}`])));
          } else if (op === "StLoc") {
            store(Number(slot?.[1]), pop());
          } else if (op === "Pop") {
            pop();
          } else if (LOAD.test(op)) {
            stack.push(new Set());
          } else if (PASS.test(op)) {
            const field = /BorrowField(?:Generic)?\[\d+\]\(([A-Za-z0-9_]+\.[A-Za-z0-9_]+):/.exec(ins.text);
            if (record && field) (op.startsWith("Mut") ? out.fieldsMut : out.fieldsRead).add(field[1]);
            stack.push(pop());
          } else if (op === "ReadRef" || op === "VecLen") {
            stack.push(readThrough(pop()));
          } else if (op === "VecPopBack") {
            const r = pop();
            if (record) for (const l of refsOf(r)) out.mutated.add(l);
            stack.push(readThrough(r));
          } else if (op === "WriteRef" || op === "VecPushBack") {
            // WriteRef: reference on top, value beneath. VecPushBack: value on top.
            const [x, y] = popN(2);
            const [ref, val] = op === "WriteRef" ? [y, x] : [x, y];
            use(val);
            for (const l of ref) if (l[0] === "l") store(Number(l.slice(1)), val);
            const target = refsOf(ref);
            if (record && target.size) {
              for (const l of target) out.mutated.add(l);
              addWrite({ target, value: val, at: where(ins) });
            }
          } else if (op === "VecSwap") {
            popN(2);
            const r = pop();
            if (record) for (const l of refsOf(r)) out.mutated.add(l);
          } else if (BINARY.test(op)) {
            const [x, y] = popN(2);
            stack.push(valueOf(x, y));
          } else if (COMPARISON.test(op)) {
            const [x, y] = popN(2);
            const id = `c@${ins.off}`;
            const inputs = valueOf(x, y);
            origins.set(id, { at: where(ins), inputs });
            stack.push(union(inputs, pairs("q", x, y), new Set([id])));
          } else if (op === "VecImmBorrow" || op === "VecMutBorrow") {
            const [r, i] = popN(2);
            stack.push(union(r ?? new Set(), i ?? new Set()));
          } else if (op === "BrTrue" || op === "BrFalse" || op === "VariantSwitch") {
            const c = pop();
            use(c);
            if (record) addCondition(c);
          } else if (op === "Abort") {
            use(pop());
            if (record) out.aborts = true;
          } else if (op === "Branch" || op === "Nop") {
            // no data
          } else if (op === "Ret") {
            // A returned check is the caller's to use. A returned parameter
            // is followed through the caller's use of the result instead.
            const vs = popN(a.pop);
            vs.forEach((v, k) => {
              use(new Set([...v].filter((l) => paramOf(l) === null)));
              if (record) for (const l of v) out.returns[k]?.add(l);
            });
          } else if (op === "Call") {
            this.call(mod, fn, ins, popN(a.pop), stack, origins, record, out, { use, store, addCondition, addWrite, addGuard, where });
          } else {
            // Pack, Unpack, vectors of values, variants: data moves as a whole.
            const vs = popN(a.pop);
            const all = union(...vs);
            if (/^(Pack|VecPack)/.test(op)) use(all);
            for (let k = 0; k < a.push; k++) stack.push(new Set(all));
          }
        }
      }
      return changed;
    };

    for (let i = 0; i < 50 && run(false); i++);
    run(true);

    for (const [id, o] of origins) {
      if (!out.used.has(id)) out.dropped.push({ at: o.at, inputs: o.inputs });
    }
    return out;
  }

  private call(
    mod: ModuleIR,
    fn: FnIR,
    ins: Instr,
    args: Labels[],
    stack: Labels[],
    origins: Map<string, { at: string; inputs: Labels }>,
    record: boolean,
    out: Summary,
    h: {
      use: (v: Labels) => void;
      store: (slot: number, v: Labels) => void;
      addCondition: (v: Labels) => void;
      addWrite: (w: Write) => void;
      addGuard: (g: Guard) => void;
      where: (i: Instr) => string;
    },
  ): void {
    const c = parseCall(ins.text);
    if (!c) return;
    const at = h.where(ins);
    const key = `${c.module ? `${mod.local.get(c.module) ?? c.module}::` : `${mod.name}::`}${c.name}`;
    const callee = this.resolve(mod, c);
    const s = callee ? this.summary(callee.module, callee.name) : null;
    // A same-package callee that can abort enforces its own condition, so
    // dropping its bool drops nothing.
    const pushResults = (res: Labels[]) => {
      if (!isCheckCall(c) || s?.aborts) return void stack.push(...res);
      const id = `c@${ins.off}`;
      origins.set(id, { at, inputs: valueOf(...args) });
      stack.push(union(res[0], new Set([id])));
    };

    if (s) {
      // Callee labels in caller terms.
      const map = (x: Labels): Labels => {
        const o = new Set<string>();
        for (const l of x) {
          const i = paramOf(l);
          if (i !== null && args[i]) for (const y of l[0] === "s" ? readThrough(args[i]) : args[i]) o.add(y);
          else if (l === "snd") o.add(l);
          else if (l[0] === "q" || l[0] === "k") {
            const [a, b] = l.slice(1).split("|");
            for (const y of pairs(l[0] as "q" | "k", map(new Set([a])), map(new Set([b])))) o.add(y);
          }
        }
        return o;
      };
      args.forEach((a, i) => {
        if (s.used.has(`p${i}`) || s.used.has(`r${i}`)) h.use(a);
      });
      // A write the callee makes through a parameter lands in the caller's
      // local when the argument was a reference to one.
      for (const w of s.writes)
        for (const t of w.target) {
          const j = paramOf(t);
          if (j !== null) for (const l of args[j] ?? []) if (l[0] === "l") h.store(Number(l.slice(1)), map(w.value));
        }
      if (record) {
        for (const cond of s.conditions) h.addCondition(map(cond));
        for (const w of s.writes) {
          const target = refsOf(map(w.target));
          if (target.size) h.addWrite({ target, value: map(w.value), at: w.at });
        }
        for (const l of refsOf(map(s.mutated))) out.mutated.add(l);
        for (const g of s.guards) h.addGuard({ key: g.key, on: map(g.on), at: g.at });
        if (s.aborts) out.aborts = true;
        for (const f of s.fieldsRead) out.fieldsRead.add(f);
        for (const f of s.fieldsMut) out.fieldsMut.add(f);
        // A same-package call that only reads and returns nothing is a check.
        if (!c.returns.length && readOnly(c.params) && s.aborts) {
          h.addGuard({ key, on: union(...args), at });
        }
      }
      pushResults(s.returns.map((r) => map(r)));
      return;
    }

    // Another package, or a native: every argument is used and every result
    // is computed from all of them.
    for (const a of args) h.use(a);
    if (c.module === "tx_context" && c.name === "sender") {
      stack.push(new Set(["snd"]));
      return;
    }
    const ro = readOnly(c.params);
    const sides = args.map((a, i) => (c.params[i]?.startsWith("&") ? readThrough(a) : a));
    const read = union(...sides);
    // A call answering one bool without a `&mut` argument compares its
    // arguments with each other (`le(a, b)`, a signature check), as does
    // one that only reads and returns nothing.
    const verdict = c.returns.length === 1 && c.returns[0] === "bool" && !c.params.some((p) => p.startsWith("&mut "));
    const compared = verdict || (!c.returns.length && ro) ? union(read, pairs("q", ...sides)) : read;
    // A call taking `&mut` may store its other arguments where that reference points.
    c.params.forEach((p, i) => {
      if (!p.startsWith("&mut ")) return;
      const rest = valueOf(...args.filter((_, k) => k !== i));
      for (const l of args[i] ?? []) if (l[0] === "l") h.store(Number(l.slice(1)), rest);
    });
    if (record) {
      c.params.forEach((p, i) => {
        if (!p.startsWith("&mut ")) return;
        const target = refsOf(args[i]);
        for (const l of target) out.mutated.add(l);
      });
      // A call that changes what a reference points into, given a value too,
      // can abort on the two together (`balance::split`, `table::add`):
      // count it as comparing them. A call that only reads compares through
      // its result, which is followed instead.
      const through = args.filter((a, i) => c.params[i]?.startsWith("&") && refsOf(a).size);
      if (!ro && through.length && args.length > through.length) h.addCondition(union(read, pairs("k", ...sides)));
      // A call that only reads and returns nothing can only abort: a check.
      if (!c.returns.length && ro && args.length) {
        const on = union(...args);
        h.addCondition(compared);
        h.addGuard({ key, on, at });
      }
    }
    // A returned reference points into what the reference arguments point to.
    const into = union(...args.filter((_, i) => c.params[i]?.startsWith("&")));
    pushResults(c.returns.map((t) => (t.startsWith("&") ? union(into, valueOf(...args)) : new Set(compared))));
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export type LeadGrade = "strong" | "medium" | "weak";

export interface CodeLead {
  /** `module::function` the lead is about. */
  function: string;
  grade: LeadGrade;
  /** What the data flow shows, as a fact about the bytecode. */
  note: string;
  /** The instructions the note rests on, `module::fn: offset: instruction`. */
  instructions: string[];
}

export interface CodeGuardReport {
  discarded_checks: CodeLead[];
  sibling_guard_gaps: CodeLead[];
  unchecked_state_writes: CodeLead[];
  functions_analyzed: number;
  /** Functions with an instruction whose stack arity could not be resolved; their results are partial. */
  functions_partial: string[];
}

const GRADE_ORDER: Record<LeadGrade, number> = { strong: 0, medium: 1, weak: 2 };

const hasStored = (x: Labels) => [...x].some((l) => /^[rs]\d+$/.test(l));

/**
 * A value parameter the caller chooses freely: a plain value, or a struct
 * with `copy` (declared so here, or copied by value somewhere in the
 * package). A coin, a capability or a receipt cannot be copied, so none of
 * them is free.
 */
function callerValue(flow: PackageFlow, t: string): boolean {
  if (t.startsWith("&")) return false;
  if (PLAIN.test(t)) return true;
  const base = baseType(t);
  return !!flow.structs.get(base)?.copy || flow.copied.has(base);
}

/** Framework objects any transaction may pass: holding one gates nothing. */
const SYSTEM_OBJECT = /^(Clock|TxContext|Random|DenyList|SuiSystemState)$/;

/**
 * A parameter whose possession gates the call: an owned (never shared)
 * object of this package, or a value of one of its structs that is neither
 * an object nor copyable (a witness or permit only the package can make).
 */
function heldAuthority(flow: PackageFlow, t: string): boolean {
  const base = baseType(t);
  const own = flow.structs.get(base);
  if (!own) return false;
  return own.key ? !flow.shared.has(base) : !own.copy && !t.startsWith("&");
}

/**
 * A struct from another package that cannot be copied, taken by immutable
 * reference or by value: it may be a capability, a witness or a receipt
 * whose possession gates the call. Its abilities are not in this package's
 * bytecode, so it stays a possibility.
 */
function opaqueToken(flow: PackageFlow, t: string): boolean {
  if (t.startsWith("&mut ")) return false;
  const base = baseType(t);
  if (PLAIN.test(t) || /^Ty\d+$/.test(base) || SYSTEM_OBJECT.test(base)) return false;
  return !flow.structs.has(base) && !flow.copied.has(base);
}

/**
 * A returned value the caller must hand back or consume elsewhere: a struct
 * that cannot be copied and is not a coin or balance (a request, a receipt).
 * The effect may be settled by whoever consumes it.
 */
function obligation(flow: PackageFlow, t: string): boolean {
  const base = baseType(t);
  if (t.startsWith("&") || PLAIN.test(t) || /^(Coin|Balance|Ty\d+)$/.test(base)) return false;
  const own = flow.structs.get(base);
  return own ? !own.copy && !own.key : !flow.copied.has(base);
}

/**
 * Run the three rules over one package version's disassembly. Every public or
 * entry function is summarised, following calls into the package's own
 * modules; calls into other packages are opaque and count as using their
 * arguments.
 */
export function analyzeCodeGuards(disassembly: Map<string, string>): CodeGuardReport {
  const flow = new PackageFlow(disassembly);
  const report: CodeGuardReport = {
    discarded_checks: [],
    sibling_guard_gaps: [],
    unchecked_state_writes: [],
    functions_analyzed: 0,
    functions_partial: [],
  };
  const summaries: Summary[] = [];
  for (const m of flow.modules.values())
    for (const f of m.fns.values()) {
      const s = flow.summary(m.name, f.name);
      if (!s) continue;
      summaries.push(s);
      if (s.partial) report.functions_partial.push(`${m.name}::${f.name}`);
    }
  report.functions_analyzed = summaries.length;
  const q = (s: Summary) => `${s.fn.module}::${s.fn.name}`;

  // (a) A check whose result reaches nothing.
  for (const s of summaries)
    for (const d of s.dropped) {
      const grade: LeadGrade = d.inputs.has("snd") || hasStored(d.inputs) ? "strong" : [...d.inputs].some((l) => /^p\d+$/.test(l)) ? "medium" : "weak";
      const read = d.inputs.has("snd") ? "the sender" : hasStored(d.inputs) ? "an object parameter" : [...d.inputs].some((l) => /^p\d+$/.test(l)) ? "a value parameter" : "local values";
      report.discarded_checks.push({
        function: q(s),
        grade,
        note: `The bool computed here from ${read} reaches no branch, abort, return or store: whatever it checks, execution continues the same way.`,
        instructions: [d.at],
      });
    }

  // One lead per function and missing check: the strongest of its types.
  const gaps = new Map<string, CodeLead>();
  // (b) Public functions that mutate an object type without the check most
  // of their public siblings in the module make.
  for (const m of flow.modules.values()) {
    const byType = new Map<string, { s: Summary; param: number }[]>();
    for (const s of summaries) {
      if (s.fn.module !== m.name || !s.fn.external) continue;
      s.fn.params.forEach((t, j) => {
        const base = baseType(t);
        if (!t.startsWith("&mut ") || !flow.structs.get(base)?.key || !s.mutated.has(`r${j}`)) return;
        const list = byType.get(base) ?? [];
        if (!list.some((x) => x.s === s)) list.push({ s, param: j });
        byType.set(base, list);
      });
    }
    for (const [type, siblings] of byType) {
      if (siblings.length < 3) continue;
      const keys = new Set(siblings.flatMap(({ s }) => s.guards.map((g) => g.key)));
      for (const key of keys) {
        const withKey = siblings.filter(({ s }) => s.guards.some((g) => g.key === key));
        if (withKey.length < 2 || withKey.length * 2 <= siblings.length) continue;
        const guardOf = (s: Summary) => s.guards.find((g) => g.key === key);
        // A check that reads no object validates arguments, not state.
        const objectsRead = (s: Summary) =>
          new Set([...(guardOf(s)?.on ?? [])].filter((l) => /^[rs]\d+$/.test(l)).map((l) => l.slice(1)));
        if (withKey.filter(({ s }) => objectsRead(s).size).length * 2 <= withKey.length) continue;
        // A check that relates this object to another parameter (an ID or
        // ownership binding) rather than reading only its own state.
        const relational = withKey.filter(({ s, param }) => {
          const objects = objectsRead(s);
          return objects.has(String(param)) && objects.size >= 2;
        });
        const binding = relational.length * 2 > withKey.length;
        // A relational check needs every object it relates: a function that
        // does not receive them all cannot make it, so only a function
        // holding each of those types is a sibling that skipped it. The types
        // are those of the sibling's parameters the check read, directly or
        // through a value derived from them. A check that validates an owned
        // capability gates the functions that take one, and a function
        // without that capability type is outside it.
        const call = /(\d+: Call .*)$/.exec(guardOf(withKey[0].s)?.at ?? "");
        const guardParams = call ? (parseCall(call[1])?.params ?? []) : [];
        const related = binding ? [...objectsRead(relational[0].s)].map((i) => relational[0].s.fn.params[Number(i)]) : [];
        const needed = [...related, ...guardParams.filter((t) => heldAuthority(flow, t))].map(baseType);
        // A function that mutates a field the check reads maintains the
        // check's own state (a version bump, a pause flag): it is the
        // check's counterpart, not a sibling that skipped it.
        const [gm, gn] = key.split("::");
        const guardReads = flow.summary(gm, gn)?.fieldsRead ?? new Set<string>();
        for (const { s, param } of siblings) {
          if (withKey.some((w) => w.s === s)) continue;
          if ([...guardReads].some((f) => s.fieldsMut.has(f))) continue;
          if (!needed.every((t) => s.fn.params.some((p) => baseType(p) === t))) continue;
          // Another check reading most of the same stored fields stands in
          // for this one.
          const covered = s.guards.some((g) => {
            const [om, on] = g.key.split("::");
            const reads = flow.summary(om, on)?.fieldsRead ?? new Set<string>();
            return [...guardReads].filter((f) => reads.has(f)).length * 2 > guardReads.size;
          });
          if (covered) continue;
          const held = s.fn.params.some((t, i) => i !== param && heldAuthority(flow, t));
          const share = withKey.length / siblings.length;
          // A missing binding between two objects is the strong shape; a
          // missing check of one object's own state (a version, a pause
          // flag) is often a deliberate exception, so it stays weak.
          const grade: LeadGrade = held || !binding || share < 2 / 3 ? "weak" : share >= 0.75 ? "strong" : "medium";
          const write = s.writes.find((w) => w.target.has(`r${param}`));
          const what = binding ? `relates the ${type} to another parameter` : `reads an object's stored state`;
          const prior = gaps.get(`${q(s)}|${key}`);
          if (prior && GRADE_ORDER[prior.grade] <= GRADE_ORDER[grade]) continue;
          gaps.set(`${q(s)}|${key}`, {
            function: q(s),
            grade,
            note: `Mutates its &mut ${type} (parameter ${param}) and never calls ${key}, which ${withKey.length} of the ${siblings.length} public functions in ${m.name} that mutate a ${type} call; in most of them the call ${what}${held ? `. This function takes an owned object of the package, which may gate it instead` : ""}.`,
            instructions: [
              ...(write ? [write.at] : []),
              ...withKey.slice(0, 3).map(({ s: w }) => guardOf(w)?.at ?? q(w)),
            ],
          });
        }
      }
    }
  }

  report.sibling_guard_gaps = [...gaps.values()];

  // (c) A caller's value written into a shared object's field unchecked.
  for (const s of summaries) {
    if (!s.fn.external) continue;
    const free = s.fn.params.flatMap((t, i) => (callerValue(flow, t) ? [`p${i}`] : []));
    if (!free.length) continue;
    if (s.fn.params.some((t) => heldAuthority(flow, t))) continue;
    if (s.conditions.some((c) => c.has("snd"))) continue;
    for (const w of s.writes) {
      const shared = [...w.target].filter((l) => {
        const t = s.fn.params[Number(l.slice(1))];
        return t?.startsWith("&mut ") && flow.shared.has(baseType(t));
      });
      if (!shared.length) continue;
      const from = free.filter((p) => w.value.has(p));
      if (!from.length) continue;
      // Cleared by comparisons linking the value to stored state. A value
      // computed from both and compared with a constant bounds neither by
      // the other.
      if (from.some((p) => comparedWithStored(s.conditions, p))) continue;
      const checked = from.some((p) => s.conditions.some((c) => c.has(p)));
      const token = s.fn.params.find((t) => opaqueToken(flow, t));
      const owed = s.fn.returns.find((t) => obligation(flow, t));
      const target = s.fn.params[Number(shared[0].slice(1))];
      const names = from.map((p) => `parameter ${p.slice(1)} (${s.fn.params[Number(p.slice(1))]})`).join(", ");
      const gate = token
        ? ` It takes a ${baseType(token)} from another package, which may be a capability that gates it.`
        : owed
          ? ` It returns a ${baseType(owed)} the caller must hand on, which may settle or authorise the change.`
          : "";
      report.unchecked_state_writes.push({
        function: q(s),
        grade: gate ? "weak" : checked ? "medium" : "strong",
        note: `Writes a value computed from ${names} into a field of the shared ${baseType(target)}. ${checked ? "Branches compare the value only with constants or other arguments" : "No branch or check reads the value"}; none compares it with stored state, checks the sender, or rests on an owned object of this package.${gate}`,
        instructions: [w.at],
      });
      break;
    }
  }

  const order = (xs: CodeLead[]) => xs.sort((a, b) => GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade] || a.function.localeCompare(b.function));
  order(report.discarded_checks);
  order(report.sibling_guard_gaps);
  order(report.unchecked_state_writes);
  return report;
}

// ---------------------------------------------------------------------------
// Across versions
// ---------------------------------------------------------------------------

/** One version of a package lineage and its disassembly. */
export interface VersionCode {
  version: number;
  package_id: string;
  disassembly: Map<string, string>;
}

/**
 * Older versions whose public functions mutate a shared type without a
 * check the newest version's public functions on that type make. Every
 * version of a package stays callable, and its types are the lineage's
 * types, so the older functions run against the objects the newest version
 * manages. Consecutive versions exposing the same functions are one lead.
 */
export interface UngatedVersionLead {
  /** The older versions, oldest first, and their package ids in the same order. */
  versions: number[];
  package_ids: string[];
  /** The shared type both mutate. */
  type: string;
  /** The check the newest version makes, `module::function`. */
  gate: string;
  /** The newest version, its public functions that mutate the type, and how many make the check. */
  newest: { version: number; package_id: string; mutators: number; gated: number };
  grade: LeadGrade;
  /**
   * The older versions' public functions that mutate the type without the
   * check. Strong: the newest version's function of the same name makes it.
   * Medium: the newest version has no function of that name. Weak: it
   * returns a request or receipt the caller must hand on, whose consumer
   * may authorise the change.
   */
  functions: { function: string; grade: LeadGrade }[];
  /** Where the newest version makes the check, `module::fn: offset: instruction`. */
  instructions: string[];
}

interface Mutator {
  s: Summary;
  param: number;
}

/** Public functions mutating each shared type through a `&mut` parameter. */
function mutatorsByType(flow: PackageFlow, shared: Set<string>): Map<string, Mutator[]> {
  const out = new Map<string, Mutator[]>();
  for (const m of flow.modules.values())
    for (const f of m.fns.values()) {
      if (!f.external) continue;
      const s = flow.summary(m.name, f.name);
      if (!s) continue;
      const seen = new Set<string>();
      f.params.forEach((t, j) => {
        const base = baseType(t);
        if (!t.startsWith("&mut ") || !shared.has(base) || seen.has(base) || !s.mutated.has(`r${j}`)) return;
        seen.add(base);
        out.set(base, [...(out.get(base) ?? []), { s, param: j }]);
      });
    }
  return out;
}

/**
 * Compare a lineage's older versions with its newest. In the newest, a gate
 * for a shared type is a check (a call that only reads, returns nothing and
 * can abort) reading a shared object, made by at least two and more than
 * half of the public functions that mutate the type: the version's own
 * policy for that type. An older version's public function mutating the
 * same type is gated when it makes that check, or reads a stored field the
 * check reads (the older code's own test of the same state, such as a
 * version number newer versions bump). A function that compares the sender
 * with something or takes an owned object of the package is gated by its
 * caller. The rest are leads. A function whose namesake in the newest
 * version also skips the check is left out: the newest version exposes the
 * same thing.
 */
export function ungatedOlderVersions(versions: VersionCode[]): UngatedVersionLead[] {
  if (versions.length < 2) return [];
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const newest = sorted[sorted.length - 1];
  const flows = sorted.map((v) => new PackageFlow(v.disassembly));
  const flowN = flows[flows.length - 1];
  const shared = new Set(flows.flatMap((f) => [...f.shared]));
  const q = (s: Summary) => `${s.fn.module}::${s.fn.name}`;

  const gates: { type: string; key: string; fields: Set<string>; mutators: Mutator[]; gated: Mutator[] }[] = [];
  for (const [type, mutators] of mutatorsByType(flowN, shared)) {
    const readsShared = (s: Summary, key: string) =>
      s.guards.some(
        (g) =>
          g.key === key &&
          [...g.on].some((l) => {
            const i = paramOf(l);
            return i !== null && l[0] !== "p" && shared.has(baseType(s.fn.params[i] ?? ""));
          }),
      );
    const keys = new Set(mutators.flatMap(({ s }) => s.guards.map((g) => g.key)));
    let best: (typeof gates)[number] | null = null;
    for (const key of keys) {
      const gated = mutators.filter(({ s }) => readsShared(s, key));
      if (gated.length < 2 || gated.length * 2 <= mutators.length) continue;
      if (best && best.gated.length >= gated.length) continue;
      const [gm, gn] = key.split("::");
      const fields = new Set([...(flowN.summary(gm, gn)?.fieldsRead ?? [])].filter((f) => !flowN.uid.has(f)));
      best = { type, key, fields, mutators, gated };
    }
    if (best) gates.push(best);
  }
  if (!gates.length) return [];

  const newestFn = new Map<string, Summary>();
  for (const m of flowN.modules.values())
    for (const f of m.fns.values()) {
      const s = f.external ? flowN.summary(m.name, f.name) : null;
      if (s) newestFn.set(q(s), s);
    }

  const out: UngatedVersionLead[] = [];
  const last = new Map<string, UngatedVersionLead>();
  sorted.slice(0, -1).forEach((v, k) => {
    const flow = flows[k];
    const byType = mutatorsByType(flow, shared);
    for (const g of gates) {
      const functions: { function: string; grade: LeadGrade }[] = [];
      for (const { s, param } of byType.get(g.type) ?? []) {
        if (s.guards.some((x) => x.key === g.key)) continue;
        if ([...s.fieldsRead].some((f) => g.fields.has(f))) continue;
        if (s.conditions.some((c) => [...c].some((l) => l[0] === "q" && l.slice(1).split("|").includes("snd")))) continue;
        if (s.fn.params.some((t, i) => i !== param && heldAuthority(flow, t))) continue;
        const twin = newestFn.get(q(s));
        if (twin && !g.gated.some((x) => x.s === twin)) continue;
        const grade: LeadGrade = s.fn.returns.some((t) => obligation(flow, t)) ? "weak" : twin ? "strong" : "medium";
        functions.push({ function: q(s), grade });
      }
      const key = `${g.type}|${g.key}`;
      if (!functions.length) {
        last.delete(key);
        continue;
      }
      functions.sort((a, b) => GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade] || a.function.localeCompare(b.function));
      const prior = last.get(key);
      if (prior && JSON.stringify(prior.functions) === JSON.stringify(functions)) {
        prior.versions.push(v.version);
        prior.package_ids.push(v.package_id);
        continue;
      }
      const lead: UngatedVersionLead = {
        versions: [v.version],
        package_ids: [v.package_id],
        type: g.type,
        gate: g.key,
        newest: { version: newest.version, package_id: newest.package_id, mutators: g.mutators.length, gated: g.gated.length },
        grade: functions.reduce<LeadGrade>((best, f) => (GRADE_ORDER[f.grade] < GRADE_ORDER[best] ? f.grade : best), "weak"),
        functions,
        instructions: g.gated.slice(0, 3).map(({ s }) => s.guards.find((x) => x.key === g.key)?.at ?? q(s)),
      };
      last.set(key, lead);
      out.push(lead);
    }
  });
  return out.sort((a, b) => GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade] || a.versions[0] - b.versions[0]);
}
