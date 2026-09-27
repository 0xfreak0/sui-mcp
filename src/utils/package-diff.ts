/**
 * Pure diff engine for comparing two versions of a Move package (disassembly
 * text per module). Kept side-effect-free so the upgrade comparison is
 * unit-testable without touching the chain.
 */

import {
  FUNCTION_DECL,
  SYSTEM_PACKAGE,
  annotateLines,
  branchTarget,
  instructionOffset,
  normalizeLines,
  sectionTitle,
  splitSections,
  toLines,
  type Section,
} from "./disassembly.js";

/** A function present in both versions whose instructions changed. */
export interface FunctionBodyChange {
  module: string;
  function: string;
  added_lines: number;
  removed_lines: number;
  /** Lines that differ only in numbering; counted here, not shown in hunks. */
  renumbered_lines: number;
}

export interface LineDiff {
  /** Lines added, not counting renumbered ones. */
  added: number;
  /** Lines removed, not counting renumbered ones. */
  removed: number;
  /**
   * Lines whose only difference is numbering a recompile shifts: instruction
   * offsets, local slots, and field, struct, constant or signature indices,
   * with branch targets and locals renumbered consistently. Not in `unified`.
   */
  renumbered: number;
  /**
   * Unified hunks: an `@@ -a,n +b,m @@ <declaration>` header, then
   * `+ `/`- `/`  ` prefixed lines with up to {@link CONTEXT_LINES} of context.
   * Each hunk stays inside one declaration, and declarations are matched by
   * name, so a hunk headed with a function holds only that function's lines.
   * Context shows the new version's text. Unchanged code outside the hunks is
   * never included.
   */
  unified: string[];
  /** Hunks in the full diff, whether or not all of them fit in `unified`. Null when a declaration was too changed to align. */
  hunk_count: number | null;
  /** True when `unified` does not show every changed line. */
  truncated: boolean;
  /** Lines `unified` needs to show every aligned change with no context. */
  lines_needed: number;
  /** Functions with changed lines of which `unified` shows none. */
  unsampled: string[];
  /** Functions of which `unified` shows some changed lines but not all. */
  partly_sampled: string[];
  /** Why some changes were counted rather than aligned, when that happened. */
  note?: string;
  /** Functions in both texts whose lines changed, by name, in the new text's order. */
  functions: { name: string; added: number; removed: number; renumbered: number }[];
}

/** Lines of unchanged context around each change, as in `diff -U3`. */
const CONTEXT_LINES = 3;

/**
 * Above this many edits in one declaration, its changes are counted instead
 * of aligned. The alignment is O((n+m)·d) time and O(d²) memory, so the limit
 * is what keeps a rewritten function from costing seconds and hundreds of
 * megabytes. A function with that many changed lines needs a full read, which
 * disassemble_module serves.
 */
const MAX_EDIT_DISTANCE = 2000;

type Op = { kind: "equal" | "renumbered" | "remove" | "add"; a: number; b: number };

function multisetDelta(a: string[], b: string[]): { added: number; removed: number } {
  const count = new Map<string, number>();
  for (const line of a) count.set(line, (count.get(line) ?? 0) + 1);
  let removed = 0;
  let added = 0;
  const bCount = new Map<string, number>();
  for (const line of b) bCount.set(line, (bCount.get(line) ?? 0) + 1);
  // added = lines in b not covered by a; removed = lines in a not covered by b.
  for (const [line, n] of bCount) {
    const inA = count.get(line) ?? 0;
    if (n > inA) added += n - inA;
  }
  for (const [line, n] of count) {
    const inB = bCount.get(line) ?? 0;
    if (n > inB) removed += n - inB;
  }
  return { added, removed };
}

/**
 * Myers' O(nd) shortest edit script, as a list of equal/remove/add ops in
 * order. Null when the edit distance exceeds `maxD`.
 *
 * Lines are interned to integers first so the inner loop compares numbers.
 * Only the reachable band `[-d, d]` of each round is kept for backtracking,
 * which is what bounds memory by d² rather than d·(n+m).
 */
function editScript(aLines: string[], bLines: string[], maxD: number): Op[] | null {
  const ids = new Map<string, number>();
  const intern = (lines: string[]) =>
    Int32Array.from(lines, (l) => {
      let id = ids.get(l);
      if (id === undefined) ids.set(l, (id = ids.size));
      return id;
    });
  const a = intern(aLines);
  const b = intern(bLines);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const band = trace[d];
    const at = (k: number) => band[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "equal", a: x, b: y });
    }
    if (x === prevX) ops.push({ kind: "add", a: x, b: prevY });
    else ops.push({ kind: "remove", a: prevX, b: y });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: "equal", a: x, b: y });
  }
  return ops.reverse();
}

/**
 * Decide which line pairs matched on their normal form are a consistent
 * renumbering. Matched instructions give an old-to-new offset map and a vote
 * on which new local slot each old one became; a pair is renumbered only if
 * its branch target follows the offset map and its locals follow the winning
 * slot mapping. A pair that fails either reads different code, so it is
 * split into a removed and an added line, even when the two texts are equal.
 * Local declarations (`L4: loc2: u64`) list slots in order, so they are
 * matched on type alone.
 */
function reconcile(ops: Op[], aRaw: string[], bRaw: string[]): Op[] {
  const locals = (line: string) =>
    /^L\d+:\t/.test(line) ? [] : [...line.matchAll(/\bloc\d+\b/g)].map((m) => m[0]);
  const offsets = new Map<number, number>();
  const votes = new Map<string, Map<string, number>>();
  for (const op of ops) {
    if (op.kind !== "equal") continue;
    const oa = instructionOffset(aRaw[op.a]);
    const ob = instructionOffset(bRaw[op.b]);
    if (oa !== null && ob !== null) offsets.set(oa, ob);
    const lb = locals(bRaw[op.b]);
    locals(aRaw[op.a]).forEach((l, i) => {
      const row = votes.get(l) ?? new Map<string, number>();
      row.set(lb[i], (row.get(lb[i]) ?? 0) + 1);
      votes.set(l, row);
    });
  }
  // One-to-one, the most-voted pairs first.
  const ranked = [...votes]
    .flatMap(([from, row]) => [...row].map(([to, n]) => ({ from, to, n })))
    // A tie goes to the slot keeping its number, so a changed store or read
    // is the line flagged, not the unchanged ones around it.
    .sort((x, y) => y.n - x.n || Number(y.from === y.to) - Number(x.from === x.to));
  const slot = new Map<string, string>();
  const taken = new Set<string>();
  for (const { from, to } of ranked) {
    if (slot.has(from) || taken.has(to)) continue;
    slot.set(from, to);
    taken.add(to);
  }

  const out: Op[] = [];
  for (const op of ops) {
    if (op.kind !== "equal") {
      out.push(op);
      continue;
    }
    const a = aRaw[op.a];
    const b = bRaw[op.b];
    const ta = branchTarget(a);
    const mappedTarget = ta === null ? undefined : offsets.get(ta);
    // A target whose own instruction changed has no mapping; the hunk around
    // that instruction shows the change, so only a rewritten target counts.
    const branchMoved = ta !== null && (mappedTarget === undefined ? a !== b : mappedTarget !== branchTarget(b));
    const lb = locals(b);
    const localMoved = locals(a).some((l, i) => slot.get(l) !== lb[i]);
    if (branchMoved || localMoved) out.push({ kind: "remove", a: op.a, b: op.b }, { kind: "add", a: op.a, b: op.b });
    else out.push({ ...op, kind: a === b ? "equal" : "renumbered" });
  }
  return out;
}

/** One declaration's changes, as ops over the two versions' whole-module line indices. */
interface Piece {
  /** The declaration line heading its hunks, from the new version when it has one. */
  title: string;
  /** The function's name, for a function's piece. */
  fn?: string;
  /** Lower goes first in the excerpt. */
  priority: number;
  /**
   * For a changed function body, the share of its old and new lines that
   * changed: a body rewritten to `abort` ranks above a long body with a few
   * small edits. Higher goes first within a priority.
   */
  share: number;
  ops: Op[];
}

/**
 * Excerpt order: changed function bodies, then added and removed functions,
 * then types, the `use` block, the constant pool and the module's end.
 */
const PRIORITY: Record<Section["kind"], number> = { function: 0, struct: 3, enum: 3, header: 4, constants: 5, footer: 6 };

/** Unified hunks of one declaration, each a header line followed by its prefixed lines. */
function buildHunks(piece: Piece, aShow: string[], bShow: string[], context: number): string[][] {
  const { ops, title } = piece;
  const changes: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind === "remove" || op.kind === "add") changes.push(i);
  });
  const hunks: string[][] = [];
  let i = 0;
  while (i < changes.length) {
    const start = Math.max(0, changes[i] - context);
    let end = changes[i];
    // Merge changes whose context windows touch, as unified diff does.
    while (i + 1 < changes.length && changes[i + 1] - end <= 2 * context + 1) end = changes[++i];
    i++;
    const slice = ops.slice(start, Math.min(ops.length, end + context + 1));
    const aStart = slice[0].a;
    const bStart = slice[0].b;
    const aLen = slice.filter((o) => o.kind !== "add").length;
    const bLen = slice.filter((o) => o.kind !== "remove").length;
    hunks.push([
      `@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@${title ? ` ${title}` : ""}`,
      ...slice.map((o) =>
        o.kind === "remove" ? `- ${aShow[o.a]}` : o.kind === "add" ? `+ ${bShow[o.b]}` : `  ${bShow[o.b]}`,
      ),
    ]);
  }
  return hunks;
}

/**
 * Diff of two versions of one module's disassembly as unified hunks.
 *
 * Declarations are matched by name (functions, structs, enums) or role (the
 * `use` block, the constant pool), never by position, so a function the new
 * version compiled in another place is diffed against its own old body. Each
 * pair is aligned on {@link normalizeLines}, and pairs equal up to a
 * consistent renumbering are counted in `renumbered` rather than shown. Every
 * line is shown as {@link annotateLines} renders it.
 *
 * The excerpt is spent on changed lines first. Changed function bodies come
 * first, the largest share of the body changed first, then the other pieces
 * in {@link PRIORITY} order. The hunks are tried with three lines of context,
 * then two, one and none, and the first width at which all of them fit is
 * used. Only when the changed lines alone exceed `maxUnified` is the excerpt
 * cut, by {@link sampleHunks}; `truncated` says so and `unsampled` and
 * `partly_sampled` name the functions it leaves out. `hunk_count` is always
 * the count at three lines of context, so it does not depend on the budget.
 */
export function diffLines(aLines: string[], bLines: string[], maxUnified = 80): LineDiff {
  const aNorm = normalizeLines(aLines);
  const bNorm = normalizeLines(bLines);
  const aShow = annotateLines(aLines);
  const bShow = annotateLines(bLines);
  const key = (s: Section) => `${s.kind}:${s.name}`;
  const aSections = splitSections(aLines);
  const bSections = splitSections(bLines);
  const aByKey = new Map(aSections.map((s) => [key(s), s]));
  const bKeys = new Set(bSections.map(key));

  const pieces: Piece[] = [];
  const functions: LineDiff["functions"] = [];
  const unaligned: string[] = [];
  let added = 0;
  let removed = 0;
  let renumbered = 0;
  for (const b of bSections) {
    const a = aByKey.get(key(b));
    if (!a) {
      pieces.push({
        title: sectionTitle(b),
        ...(b.kind === "function" ? { fn: b.name } : {}),
        priority: b.kind === "function" ? 1 : PRIORITY[b.kind],
        share: 1,
        ops: b.lines.map((_, i) => ({ kind: "add", a: 0, b: b.start + i })),
      });
      added += b.lines.length;
      continue;
    }
    if (a.lines.join("\n") === b.lines.join("\n")) continue;
    const aNormSection = aNorm.slice(a.start, a.start + a.lines.length);
    const bNormSection = bNorm.slice(b.start, b.start + b.lines.length);
    const script = editScript(aNormSection, bNormSection, MAX_EDIT_DISTANCE);
    if (!script) {
      // Counted on the raw lines: the normal forms mask branch targets and
      // locals that reconcile never checked here, so a retargeted branch
      // would count as nothing.
      const counted = multisetDelta(a.lines, b.lines);
      // The texts differ (checked above), so lines that only moved still count.
      const d = counted.added + counted.removed ? counted : { added: b.lines.length, removed: a.lines.length };
      added += d.added;
      removed += d.removed;
      unaligned.push(b.name || b.kind);
      if (b.kind === "function") functions.push({ name: b.name, added: d.added, removed: d.removed, renumbered: 0 });
      continue;
    }
    const ops = reconcile(
      script.map((o) => ({ ...o, a: o.a + a.start, b: o.b + b.start })),
      aLines,
      bLines,
    );
    const count = (kind: Op["kind"]) => ops.filter((o) => o.kind === kind).length;
    const change = { added: count("add"), removed: count("remove"), renumbered: count("renumbered") };
    added += change.added;
    removed += change.removed;
    renumbered += change.renumbered;
    if (b.kind === "function") functions.push({ name: b.name, ...change });
    if (change.added + change.removed) {
      pieces.push({
        title: sectionTitle(b),
        ...(b.kind === "function" ? { fn: b.name } : {}),
        priority: PRIORITY[b.kind],
        share: (change.added + change.removed) / (a.lines.length + b.lines.length),
        ops,
      });
    }
  }
  for (const a of aSections) {
    if (bKeys.has(key(a))) continue;
    pieces.push({
      title: sectionTitle(a),
      ...(a.kind === "function" ? { fn: a.name } : {}),
      priority: a.kind === "function" ? 2 : PRIORITY[a.kind],
      share: 1,
      ops: a.lines.map((_, i) => ({ kind: "remove", a: a.start + i, b: 0 })),
    });
    removed += a.lines.length;
  }
  pieces.sort((x, y) => x.priority - y.priority || y.share - x.share);

  const partial = unaligned.length > 0;
  const base = {
    added,
    removed,
    renumbered,
    functions,
    ...(partial
      ? {
          note: `${unaligned.length} declaration(s) changed in more than ${MAX_EDIT_DISTANCE} lines, so their changes were counted rather than aligned: ${unaligned.join(", ")}. Read them with disassemble_module.`,
        }
      : {}),
  };
  const complete = { unsampled: [], partly_sampled: [] };
  if (!pieces.length) return { ...base, unified: [], hunk_count: partial ? null : 0, truncated: partial, lines_needed: 0, ...complete };

  let hunk_count = 0;
  let byPiece: string[][][] = [];
  let lines_needed = 0;
  for (let context = CONTEXT_LINES; context >= 0; context--) {
    byPiece = pieces.map((p) => buildHunks(p, aShow, bShow, context));
    const hunks = byPiece.flat();
    if (context === CONTEXT_LINES) hunk_count = hunks.length;
    lines_needed = hunks.reduce((s, h) => s + h.length, 0);
    if (lines_needed <= maxUnified) {
      return { ...base, unified: hunks.flat(), hunk_count: partial ? null : hunk_count, truncated: partial, lines_needed, ...complete };
    }
  }
  return { ...base, ...sampleHunks(pieces, byPiece, maxUnified), hunk_count: partial ? null : hunk_count, truncated: true, lines_needed };
}

/**
 * Spend `maxUnified` lines on hunks that do not all fit, breadth first over
 * the changed function bodies: each, in `share` order, gets its largest hunk
 * before any gets a second, since a function's first hunk is often only its
 * declaration. That hunk may take half the room left, or all of it for the
 * last function, so one rewritten function cannot use the whole budget. Then
 * the other hunks of those functions round by round in line order, then the
 * rest of any cut hunk, then the other pieces in order. A hunk that does not
 * fit is cut short if its header and one line fit, and its function gets no
 * other hunk. The sample lists each piece's hunks together, in line order.
 */
function sampleHunks(
  pieces: Piece[],
  byPiece: string[][][],
  maxUnified: number,
): Pick<LineDiff, "unified" | "unsampled" | "partly_sampled"> {
  /** Per piece, the shown part of each hunk by its index. */
  const shown = pieces.map(() => new Map<number, string[]>());
  /** Pieces with a hunk cut short, and that hunk's index. */
  const cut = new Map<number, number>();
  let room = maxUnified;
  const take = (i: number, h: number, cap: number) => {
    const hunk = byPiece[i][h];
    const n = Math.min(hunk.length, cap, room);
    if (n < 2) return;
    shown[i].set(h, hunk.slice(0, n));
    room -= n;
    if (n < hunk.length) cut.set(i, h);
  };

  const bodies = pieces.flatMap((p, i) => (p.priority === PRIORITY.function ? [i] : []));
  bodies.forEach((i, k) => {
    const largest = byPiece[i].reduce((best, h, j) => (h.length > byPiece[i][best].length ? j : best), 0);
    take(i, largest, k === bodies.length - 1 ? room : Math.max(2, Math.floor(room / 2)));
  });
  for (let round = 0; room >= 2 && bodies.some((i) => byPiece[i].length > round); round++) {
    for (const i of bodies) {
      if (!cut.has(i) && shown[i].size && round < byPiece[i].length && !shown[i].has(round)) take(i, round, room);
    }
  }
  for (const [i, h] of cut) {
    const hunk = byPiece[i][h];
    const n = Math.min(hunk.length, shown[i].get(h)!.length + room);
    room -= n - shown[i].get(h)!.length;
    shown[i].set(h, hunk.slice(0, n));
    if (n === hunk.length) cut.delete(i);
  }
  pieces.forEach((p, i) => {
    if (p.priority === PRIORITY.function) return;
    for (let h = 0; h < byPiece[i].length && room >= 2 && !cut.has(i); h++) take(i, h, room);
  });

  const unsampled: string[] = [];
  const partly_sampled: string[] = [];
  pieces.forEach((p, i) => {
    if (!p.fn) return;
    if (!shown[i].size) unsampled.push(p.fn);
    else if (cut.has(i) || shown[i].size < byPiece[i].length) partly_sampled.push(p.fn);
  });
  const unified = shown.flatMap((m) => [...m].sort(([x], [y]) => x - y).flatMap(([, lines]) => lines));
  return { unified, unsampled, partly_sampled };
}

// ---------------------------------------------------------------------------
// Function surface
// ---------------------------------------------------------------------------

export interface FunctionDecl {
  name: string;
  /** `public`, `public(friend)`, `public(package)` or `private`. */
  visibility: string;
  entry: boolean;
  /** The declaration line as disassembled, without the trailing `{` / `;`. */
  signature: string;
}

/** Every function declared in one module's disassembly, by name. */
export function parseFunctions(disassembly: string): Map<string, FunctionDecl> {
  const out = new Map<string, FunctionDecl>();
  for (const raw of toLines(disassembly)) {
    const m = FUNCTION_DECL.exec(raw);
    if (!m) continue;
    const modifiers = m[1].trim().split(/\s+/).filter(Boolean);
    out.set(m[2], {
      name: m[2],
      visibility: modifiers.find((w) => w.startsWith("public")) ?? "private",
      entry: modifiers.includes("entry"),
      signature: raw.replace(/\s*[{;]$/, ""),
    });
  }
  return out;
}

/** How a function can be reached, e.g. `public entry`, `private`. */
function reach(f: FunctionDecl): string {
  return f.entry ? `${f.visibility} entry` : f.visibility;
}

export interface FunctionChange {
  module: string;
  function: string;
  visibility: string;
  entry: boolean;
  signature: string;
}

export interface VisibilityChange {
  module: string;
  function: string;
  from: string;
  to: string;
  /**
   * True when the function became callable from more places: private or
   * friend-only to public, or newly `entry` so a transaction can call it
   * directly.
   */
  widened: boolean;
}

const REACH_RANK: Record<string, number> = {
  private: 0,
  "public(friend)": 1,
  "public(package)": 1,
  public: 2,
};

function widened(from: FunctionDecl, to: FunctionDecl): boolean {
  const rank = (f: FunctionDecl) => REACH_RANK[f.visibility] ?? 0;
  return rank(to) > rank(from) || (to.entry && !from.entry);
}

// ---------------------------------------------------------------------------
// Package diff
// ---------------------------------------------------------------------------

export interface ModuleDiff {
  module: string;
  status: "added" | "removed" | "changed";
  /** Lines added, not counting renumbered ones. */
  added_lines: number;
  /** Lines removed, not counting renumbered ones. */
  removed_lines: number;
  /** Lines that differ only in numbering; see {@link LineDiff.renumbered}. */
  renumbered_lines: number;
  /** Set when every difference in this module is renumbering. */
  renumbering_only?: true;
  /** Functions whose only difference is renumbering. */
  renumbering_only_functions?: string[];
  /** Hunks in this module's diff. Null when a declaration was too changed to align. */
  hunk_count: number | null;
  /** Unified hunks; see {@link LineDiff.unified}. */
  sample?: string[];
  /** True when `sample` does not show every changed line of this module. */
  sample_truncated: boolean;
  /** Lines `sample` needs to show every aligned change with no context; set when truncated. */
  sample_lines_needed?: number;
  /** Functions with changed lines of which `sample` shows none; set when there are any. */
  unsampled_functions?: string[];
  /** Functions of which `sample` shows some changed lines but not all; set when there are any. */
  partly_sampled_functions?: string[];
  note?: string;
}

export interface PackageDiff {
  from_module_count: number;
  to_module_count: number;
  added_modules: string[];
  removed_modules: string[];
  changed_modules: ModuleDiff[];
  unchanged_count: number;
  /** Functions present in the new version only, including those of added modules. */
  added_functions: FunctionChange[];
  removed_functions: FunctionChange[];
  /** Functions whose visibility or `entry` flag changed. */
  visibility_changes: VisibilityChange[];
  /** Functions in both versions with a change beyond renumbering, largest change first. */
  changed_functions: FunctionBodyChange[];
  /** True if nothing changed across the whole package. */
  identical: boolean;
}

function functionChange(module: string, f: FunctionDecl): FunctionChange {
  return { module, function: f.name, visibility: f.visibility, entry: f.entry, signature: f.signature };
}

/**
 * Diff two versions of a package by module. `from`/`to` map module name →
 * disassembly text. Reports added/removed modules, the function surface that
 * changed, and, for modules present in both, a per-module line diff as
 * unified hunks.
 */
export function diffPackages(
  from: Map<string, string>,
  to: Map<string, string>,
  maxSampleLines = 60,
): PackageDiff {
  const added_modules: string[] = [];
  const removed_modules: string[] = [];
  const changed_modules: ModuleDiff[] = [];
  const added_functions: FunctionChange[] = [];
  const removed_functions: FunctionChange[] = [];
  const visibility_changes: VisibilityChange[] = [];
  const changed_functions: FunctionBodyChange[] = [];
  let unchanged_count = 0;

  for (const [name, code] of to) {
    if (from.has(name)) continue;
    added_modules.push(name);
    for (const f of parseFunctions(code).values()) added_functions.push(functionChange(name, f));
  }
  for (const [name, code] of from) {
    if (to.has(name)) continue;
    removed_modules.push(name);
    for (const f of parseFunctions(code).values()) removed_functions.push(functionChange(name, f));
  }

  // Common modules: diff declaration by declaration.
  const common = [...from.keys()].filter((n) => to.has(n)).sort();
  for (const name of common) {
    const a = from.get(name)!;
    const b = to.get(name)!;
    if (a === b) {
      unchanged_count++;
      continue;
    }
    const d = diffLines(toLines(a), toLines(b), maxSampleLines);
    if (d.added + d.removed + d.renumbered === 0) {
      // Differences were only trailing whitespace / line endings.
      unchanged_count++;
      continue;
    }
    const renumberedOnly = d.functions.filter((f) => f.added + f.removed === 0).map((f) => f.name);
    changed_modules.push({
      module: name,
      status: "changed",
      added_lines: d.added,
      removed_lines: d.removed,
      renumbered_lines: d.renumbered,
      ...(d.added + d.removed === 0 ? { renumbering_only: true as const } : {}),
      ...(renumberedOnly.length ? { renumbering_only_functions: renumberedOnly } : {}),
      hunk_count: d.hunk_count,
      sample: d.unified.length ? d.unified : undefined,
      sample_truncated: d.truncated,
      ...(d.truncated ? { sample_lines_needed: d.lines_needed } : {}),
      ...(d.unsampled.length ? { unsampled_functions: d.unsampled } : {}),
      ...(d.partly_sampled.length ? { partly_sampled_functions: d.partly_sampled } : {}),
      ...(d.note ? { note: d.note } : {}),
    });
    for (const f of d.functions) {
      if (!(f.added + f.removed)) continue;
      changed_functions.push({
        module: name,
        function: f.name,
        added_lines: f.added,
        removed_lines: f.removed,
        renumbered_lines: f.renumbered,
      });
    }

    const before = parseFunctions(a);
    const after = parseFunctions(b);
    for (const [fn, decl] of after) {
      const old = before.get(fn);
      if (!old) added_functions.push(functionChange(name, decl));
      else if (reach(old) !== reach(decl)) {
        visibility_changes.push({ module: name, function: fn, from: reach(old), to: reach(decl), widened: widened(old, decl) });
      }
    }
    for (const [fn, decl] of before) {
      if (!after.has(fn)) removed_functions.push(functionChange(name, decl));
    }
  }

  changed_modules.sort((x, y) => y.added_lines + y.removed_lines - (x.added_lines + x.removed_lines));
  // Largest rewrites first, so the summary's short list names them.
  changed_functions.sort((x, y) => y.added_lines + y.removed_lines - (x.added_lines + x.removed_lines));

  return {
    from_module_count: from.size,
    to_module_count: to.size,
    added_modules: added_modules.sort(),
    removed_modules: removed_modules.sort(),
    changed_modules,
    unchanged_count,
    added_functions,
    removed_functions,
    visibility_changes,
    changed_functions,
    identical:
      added_modules.length === 0 && removed_modules.length === 0 && changed_modules.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Dependency linkage
// ---------------------------------------------------------------------------

/** One row of a package version's linkage table, as GraphQL reports it. */
export interface LinkageEntry {
  /** The dependency's lineage root: stable across its versions. */
  originalId: string;
  /** The version of the dependency this package version is linked against. */
  upgradedId: string;
  version: number;
}

export interface LinkageChange {
  /** The dependency's lineage root. */
  package: string;
  change: "upgraded" | "downgraded" | "added" | "removed";
  from: { version: number; address: string } | null;
  to: { version: number; address: string } | null;
  /**
   * A framework package (0x1, 0x2, 0x3 …). Those upgrade in place and every
   * package runs against the current framework whatever its linkage says, so
   * a version change here records which framework the upgrade was built
   * against and changes no behaviour.
   */
  system: boolean;
  /** The call that diffs the dependency itself, when both sides exist. */
  diff?: { tool: "diff_package_upgrade"; args: { package: string; from_version: number; to_version: number } };
}

/**
 * Which dependencies a package upgrade relinked. An upgrade that swaps only a
 * dependency changes no module of its own, so a diff of the package's
 * modules alone reads it as a no-op even though the code it runs changed.
 */
export function diffLinkage(from: LinkageEntry[], to: LinkageEntry[]): LinkageChange[] {
  const before = new Map(from.map((l) => [l.originalId, l]));
  const after = new Map(to.map((l) => [l.originalId, l]));
  const out: LinkageChange[] = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    if (was && was.upgradedId === now.upgradedId && was.version === now.version) continue;
    const system = SYSTEM_PACKAGE.test(id);
    out.push({
      package: id,
      change: !was ? "added" : now.version < was.version ? "downgraded" : "upgraded",
      from: was ? { version: was.version, address: was.upgradedId } : null,
      to: { version: now.version, address: now.upgradedId },
      system,
      ...(was && !system
        ? {
            diff: {
              tool: "diff_package_upgrade" as const,
              args: {
                package: id,
                from_version: Math.min(was.version, now.version),
                to_version: Math.max(was.version, now.version),
              },
            },
          }
        : {}),
    });
  }
  for (const [id, was] of before) {
    if (after.has(id)) continue;
    out.push({
      package: id,
      change: "removed",
      from: { version: was.version, address: was.upgradedId },
      to: null,
      system: SYSTEM_PACKAGE.test(id),
    });
  }
  // Non-framework changes first: those are the ones that change behaviour.
  return out.sort((x, y) => Number(x.system) - Number(y.system) || x.package.localeCompare(y.package));
}
