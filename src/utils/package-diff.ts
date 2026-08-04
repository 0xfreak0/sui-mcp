/**
 * Pure diff engine for comparing two versions of a Move package (disassembly
 * text per module). Kept dependency-free and side-effect-free so the upgrade
 * comparison is unit-testable without touching the chain.
 */

export interface LineDiff {
  added: number;
  removed: number;
  /** Unified-style excerpt (`+`/`-`/` ` prefixed), truncated to `maxUnified`. */
  unified: string[];
  truncated: boolean;
}

// Above this many lines on either side, the O(n·m) LCS is skipped in favor of a
// cheap multiset delta — a full unified diff of a huge module isn't worth the CPU.
const LCS_LINE_CAP = 4000;

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
 * Line-level diff of two texts via LCS. Returns added/removed counts and a
 * truncated unified excerpt. Falls back to a multiset delta (no unified body)
 * when either side is very large.
 */
export function diffLines(aLines: string[], bLines: string[], maxUnified = 80): LineDiff {
  if (aLines.length > LCS_LINE_CAP || bLines.length > LCS_LINE_CAP) {
    const { added, removed } = multisetDelta(aLines, bLines);
    return { added, removed, unified: [], truncated: true };
  }

  const n = aLines.length;
  const m = bLines.length;
  // LCS length table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const unified: string[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  let i = 0;
  let j = 0;
  const push = (s: string) => {
    if (unified.length < maxUnified) unified.push(s);
    else truncated = true;
  };
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      push(`  ${aLines[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(`- ${aLines[i]}`);
      removed++;
      i++;
    } else {
      push(`+ ${bLines[j]}`);
      added++;
      j++;
    }
  }
  while (i < n) {
    push(`- ${aLines[i]}`);
    removed++;
    i++;
  }
  while (j < m) {
    push(`+ ${bLines[j]}`);
    added++;
    j++;
  }
  return { added, removed, unified, truncated };
}

export interface ModuleDiff {
  module: string;
  status: "added" | "removed" | "changed";
  added_lines: number;
  removed_lines: number;
  sample?: string[];
}

export interface PackageDiff {
  from_module_count: number;
  to_module_count: number;
  added_modules: string[];
  removed_modules: string[];
  changed_modules: ModuleDiff[];
  unchanged_count: number;
  /** True if nothing changed across the whole package. */
  identical: boolean;
}

function toLines(code: string): string[] {
  // Normalize trailing whitespace / CRLF so cosmetic differences don't show up.
  return code.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
}

/**
 * Diff two versions of a package by module. `from`/`to` map module name →
 * disassembly text. Reports added/removed modules and, for modules present in
 * both, a per-module line diff when the code differs.
 */
export function diffPackages(
  from: Map<string, string>,
  to: Map<string, string>,
  maxSampleLines = 60,
): PackageDiff {
  const added_modules: string[] = [];
  const removed_modules: string[] = [];
  const changed_modules: ModuleDiff[] = [];
  let unchanged_count = 0;

  for (const name of to.keys()) {
    if (!from.has(name)) added_modules.push(name);
  }
  for (const name of from.keys()) {
    if (!to.has(name)) removed_modules.push(name);
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
      sample: d.unified.length ? d.unified : undefined,
    });
  }

  changed_modules.sort((x, y) => y.added_lines + y.removed_lines - (x.added_lines + x.removed_lines));

  return {
    from_module_count: from.size,
    to_module_count: to.size,
    added_modules: added_modules.sort(),
    removed_modules: removed_modules.sort(),
    changed_modules,
    unchanged_count,
    identical:
      added_modules.length === 0 && removed_modules.length === 0 && changed_modules.length === 0,
  };
}
