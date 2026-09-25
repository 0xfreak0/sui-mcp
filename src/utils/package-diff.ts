/**
 * Pure diff engine for comparing two versions of a Move package (disassembly
 * text per module). Kept dependency-free and side-effect-free so the upgrade
 * comparison is unit-testable without touching the chain.
 */

export interface LineDiff {
  added: number;
  removed: number;
  /**
   * Unified hunks: an `@@ -a,n +b,m @@ <enclosing declaration>` header, then
   * `+ `/`- `/`  ` prefixed lines with up to {@link CONTEXT_LINES} of context.
   * Unchanged code outside the hunks is never included.
   */
  unified: string[];
  /** Hunks in the full diff, whether or not all of them fit in `unified`. */
  hunk_count: number | null;
  /** True when `unified` does not show every changed line. */
  truncated: boolean;
  /** Why no hunks could be computed, when that happened. */
  note?: string;
}

/** Lines of unchanged context around each change, as in `diff -U3`. */
const CONTEXT_LINES = 3;

/**
 * Above this many edits, the diff falls back to counting lines instead of
 * aligning them. The alignment is O((n+m)·d) time and O(d²) memory, so the
 * limit is what keeps a rewritten module from costing seconds and hundreds of
 * megabytes. An upgrade with that many changed lines needs a full review of
 * the module, which disassemble_module serves.
 */
const MAX_EDIT_DISTANCE = 2000;

type Op = { kind: "equal" | "remove" | "add"; a: number; b: number };

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
 * A declaration line in disassembly: a function (`public foo<T>(…) {`), a
 * struct/enum, or the constant pool. Used to name the code a hunk sits in, the
 * way `git diff` prints the enclosing function after `@@`.
 */
const DECLARATION = /^(?:(?:(?:entry|native|public(?:\([a-z]+\))?) )*[A-Za-z_][A-Za-z0-9_]*[<(]|(?:struct|enum) |Constants \[)/;

function enclosingDeclaration(lines: string[], before: number): string {
  for (let i = Math.min(before, lines.length) - 1; i >= 0; i--) {
    if (DECLARATION.test(lines[i])) return lines[i].replace(/\s*[{;]$/, "");
  }
  return "";
}

/** Unified hunks, each a header line followed by its prefixed lines. */
function buildHunks(ops: Op[], aLines: string[], bLines: string[], context: number): string[][] {
  const changes: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind !== "equal") changes.push(i);
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
    const where = enclosingDeclaration(bLines, bStart);
    hunks.push([
      `@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@${where ? ` ${where}` : ""}`,
      ...slice.map((o) =>
        o.kind === "equal" ? `  ${aLines[o.a]}` : o.kind === "remove" ? `- ${aLines[o.a]}` : `+ ${bLines[o.b]}`,
      ),
    ]);
  }
  return hunks;
}

/**
 * Line-level diff of two texts as unified hunks.
 *
 * The excerpt is spent on changed lines first. The hunks are tried with three
 * lines of context, then two, one and none, and the first width at which all
 * of them fit is used. Only when the changed lines alone exceed `maxUnified`
 * is the excerpt cut, in hunk order, and `truncated` says so. `hunk_count` is
 * always the count at three lines of context, so it does not depend on the
 * budget.
 */
export function diffLines(aLines: string[], bLines: string[], maxUnified = 80): LineDiff {
  const ops = editScript(aLines, bLines, MAX_EDIT_DISTANCE);
  if (!ops) {
    const { added, removed } = multisetDelta(aLines, bLines);
    return {
      added,
      removed,
      unified: [],
      hunk_count: null,
      truncated: true,
      note: `More than ${MAX_EDIT_DISTANCE} lines differ, so the changes were counted rather than aligned. Read the whole module with disassemble_module.`,
    };
  }
  const added = ops.filter((o) => o.kind === "add").length;
  const removed = ops.filter((o) => o.kind === "remove").length;
  if (added + removed === 0) return { added, removed, unified: [], hunk_count: 0, truncated: false };

  let hunk_count = 0;
  let hunks: string[][] = [];
  for (let context = CONTEXT_LINES; context >= 0; context--) {
    hunks = buildHunks(ops, aLines, bLines, context);
    if (context === CONTEXT_LINES) hunk_count = hunks.length;
    if (hunks.reduce((s, h) => s + h.length, 0) <= maxUnified) {
      return { added, removed, unified: hunks.flat(), hunk_count, truncated: false };
    }
  }

  // Even without context the changes do not fit: show hunks in order until
  // the budget runs out, cutting the last one short if its header and at
  // least one line still fit.
  const unified: string[] = [];
  for (const h of hunks) {
    const room = maxUnified - unified.length;
    if (room <= 1) break;
    unified.push(...h.slice(0, room));
  }
  return { added, removed, unified, hunk_count, truncated: true };
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

const FUNCTION_DECL = /^((?:(?:entry|native|public(?:\([a-z]+\))?) )*)([A-Za-z_][A-Za-z0-9_]*)(?:<[^(]*>)?\(/;

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
  added_lines: number;
  removed_lines: number;
  /** Hunks in this module's diff. Null when the diff was too large to align. */
  hunk_count: number | null;
  /** Unified hunks; see {@link LineDiff.unified}. */
  sample?: string[];
  /** True when `sample` does not show every changed line of this module. */
  sample_truncated: boolean;
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
  /** True if nothing changed across the whole package. */
  identical: boolean;
}

function toLines(code: string): string[] {
  // Normalize trailing whitespace / CRLF so cosmetic differences don't show up.
  return code.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
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

  // Common modules: diff line-by-line.
  const common = [...from.keys()].filter((n) => to.has(n)).sort();
  for (const name of common) {
    const a = from.get(name)!;
    const b = to.get(name)!;
    if (a === b) {
      unchanged_count++;
      continue;
    }
    const d = diffLines(toLines(a), toLines(b), maxSampleLines);
    if (d.added === 0 && d.removed === 0) {
      // Differences were only trailing whitespace / line endings.
      unchanged_count++;
      continue;
    }
    changed_modules.push({
      module: name,
      status: "changed",
      added_lines: d.added,
      removed_lines: d.removed,
      hunk_count: d.hunk_count,
      sample: d.unified.length ? d.unified : undefined,
      sample_truncated: d.truncated,
      ...(d.note ? { note: d.note } : {}),
    });

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

/** Framework packages live at small reserved addresses (0x1, 0x2, 0x3, 0xb, 0xdee9). */
const SYSTEM_PACKAGE = /^0x0{60}[0-9a-f]{4}$/;

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
