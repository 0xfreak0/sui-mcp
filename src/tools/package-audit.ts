import { z } from "zod";
import { numArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import {
  fetchAllModuleDisassemblyAtVersion,
  fetchPackageLatestVersion,
  fetchPackageVersion,
  resolvePackageId,
} from "../utils/move-package.js";
import {
  diffLinkage,
  diffPackages,
  type LinkageChange,
  type ModuleDiff,
  type PackageDiff,
  type VisibilityChange,
} from "../utils/package-diff.js";
import type { NextCall } from "../utils/output-cap.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MAX_SAMPLE_LINES = 2000;

/**
 * The call that shows what a truncated module sample left out: this call
 * with a budget that fits every change, or, past the largest budget, the
 * first function the sample misses, read whole in the version that has it.
 */
function sampleNextCall(
  m: ModuleDiff,
  diff: PackageDiff,
  budget: number,
  from: string,
  to: string,
): NextCall | undefined {
  if (m.sample_lines_needed === undefined || m.sample_lines_needed <= budget) return undefined;
  if (m.sample_lines_needed <= MAX_SAMPLE_LINES) {
    return { tool: "diff_package_upgrade", repeat_with: { max_sample_lines: m.sample_lines_needed } };
  }
  const fn = m.unsampled_functions?.[0] ?? m.partly_sampled_functions?.[0];
  const removed = diff.removed_functions.some((f) => f.module === m.module && f.function === fn);
  return {
    tool: "disassemble_module",
    args: { package_id: removed ? from : to, module_name: m.module, ...(fn ? { function_name: fn } : {}) },
  };
}

const short = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;

/** Up to eight names, then a count of the rest; the full lists are in the structured fields. */
function nameList(names: string[]): string {
  return names.length <= 8 ? names.join(", ") : `${names.slice(0, 8).join(", ")} and ${names.length - 8} more`;
}

/**
 * The one-paragraph answer to "what did this upgrade change". Every class of
 * change is named here, not only in the structured fields, because a reader
 * who stops at the summary must not come away thinking a relinked dependency,
 * a rewritten function body or a newly public function was a no-op.
 */
function summarize(diff: PackageDiff, linkage: LinkageChange[]): string {
  const deps = linkage.filter((l) => !l.system);
  const parts: string[] = [];
  if (diff.identical) {
    parts.push(
      deps.length
        ? "No module of this package changed, but the upgrade relinked its dependencies, so the code it runs did change."
        : "No bytecode changes between these versions (metadata-only upgrade).",
    );
  } else {
    const names = diff.changed_modules.map((m) => (m.renumbering_only ? `${m.module} (renumbering only)` : m.module));
    parts.push(
      `Upgrade changed ${diff.changed_modules.length} module(s)` +
        (diff.added_modules.length ? `, added ${diff.added_modules.length}` : "") +
        (diff.removed_modules.length ? `, removed ${diff.removed_modules.length}` : "") +
        (names.length ? `: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}` : "") +
        ".",
    );
  }
  const qualified = (f: { module: string; function: string }) => `${f.module}::${f.function}`;
  if (diff.changed_functions.length) {
    parts.push(`Function bodies changed (${diff.changed_functions.length}): ${nameList(diff.changed_functions.map(qualified))}.`);
  }
  const renumbered = diff.changed_modules.reduce((n, m) => n + (m.renumbering_only_functions?.length ?? 0), 0);
  if (renumbered) {
    parts.push(
      `${renumbered} other function(s) differ only in numbering (instruction offsets, locals, field or constant indices) and are listed in each module's renumbering_only_functions.`,
    );
  }
  if (diff.added_functions.length) {
    parts.push(`Functions added (${diff.added_functions.length}): ${nameList(diff.added_functions.map(qualified))}.`);
  }
  if (diff.removed_functions.length) {
    parts.push(`Functions removed (${diff.removed_functions.length}): ${nameList(diff.removed_functions.map(qualified))}.`);
  }
  const visibility = (v: VisibilityChange) => `${v.module}::${v.function} (${v.from} → ${v.to})`;
  const widened = diff.visibility_changes.filter((v) => v.widened);
  const narrowed = diff.visibility_changes.filter((v) => !v.widened);
  if (widened.length) parts.push(`Now callable from more places: ${widened.map(visibility).join(", ")}.`);
  if (narrowed.length) parts.push(`Now callable from fewer places: ${nameList(narrowed.map(visibility))}.`);
  for (const d of deps) {
    parts.push(
      d.change === "added"
        ? `New dependency ${short(d.package)} v${d.to?.version}.`
        : d.change === "removed"
          ? `Dropped dependency ${short(d.package)} v${d.from?.version}.`
          : `Dependency ${short(d.package)} relinked v${d.from?.version} → v${d.to?.version}; see what changed in it with diff_package_upgrade ${JSON.stringify(d.diff?.args)}.`,
    );
  }
  if (diff.changed_modules.some((m) => m.sample_truncated)) {
    parts.push(
      "Some module samples are truncated: each such module names the functions its sample leaves out (unsampled_functions, partly_sampled_functions), with sample_next_call where another call shows them; disassemble_module function_name reads one function in either version.",
    );
  }
  return parts.join(" ");
}

export function registerPackageAuditTools(server: McpServer) {
  server.tool(
    "diff_package_upgrade",
    "(Security) Diff two versions of a Move package to spot what an upgrade changed, the classic malicious-upgrade / backdoor vector. On Sui each upgrade publishes a new package address; this resolves the two versions, disassembles both, and reports added/removed modules; functions added, removed, made more or less reachable (e.g. private → public), and `changed_functions`, those whose instructions changed, all named in `summary`; each changed module as unified hunks; and dependency relinks with the call that diffs the dependency itself. Functions, structs and the constant pool are matched by name, so each `@@` hunk holds only the lines of the declaration it names, even when the upgrade compiled functions in another order. Lines that differ only in numbering a recompile shifts (instruction offsets, local slots, field, struct or constant indices, with branches and locals renumbered consistently) are counted in `renumbered_lines` and left out of the hunks; a function with nothing else is listed in `renumbering_only_functions`. Clever abort codes, truncated constants, large integers and `Shl`/`Shr` lines carry a `//` note. An upgrade can change behaviour through a dependency alone, with no module of its own changing. Defaults to comparing the latest upgrade (previous → latest). Accepts a 0x package ID (any version) or an MVR name.",
    {
      package: z
        .string()
        .describe("Package reference: a 0x package ID (any version in the family) or MVR name (@org/app)."),
      from_version: numArg()
        .int()
        .positive()
        .optional()
        .describe("Older version to compare from (default: latest - 1)."),
      to_version: numArg()
        .int()
        .positive()
        .optional()
        .describe("Newer version to compare to (default: latest)."),
      max_sample_lines: numArg()
        .int()
        .min(10)
        .max(MAX_SAMPLE_LINES)
        .optional()
        .describe(
          "Line budget per changed module for the unified hunks (default 60). Changed function bodies come first, the most rewritten (changed share of the body) first, and each gets its largest hunk before any gets a second; then added and removed functions, types, `use` lines and constants. Changed lines are shown before context. When some do not fit, `sample_truncated` is set, `unsampled_functions` and `partly_sampled_functions` name the functions left out, and `sample_next_call` is the call that shows them.",
        ),
    },
    async ({ package: pkgRef, from_version, to_version, max_sample_lines }) => {
      try {
        const baseId = await resolvePackageId(pkgRef);
        const latest = await fetchPackageLatestVersion(baseId);

        if (latest < 2 && from_version == null && to_version == null) {
          return errorResult(
            `Package ${baseId} is at version ${latest} — it has never been upgraded, so there is nothing to diff.`,
          );
        }

        const toV = to_version ?? latest;
        const fromV = from_version ?? Math.max(1, toV - 1);
        if (fromV >= toV) {
          return errorResult(`from_version (${fromV}) must be less than to_version (${toV}).`);
        }
        if (toV > latest) {
          return errorResult(`to_version (${toV}) exceeds the latest version (${latest}).`);
        }

        // Addresses are for reporting only; bytecode is read via packageAt so
        // each version's real modules are returned (not linkage-resolved latest).
        const [fromPkg, toPkg, fromMods, toMods] = await Promise.all([
          fetchPackageVersion(baseId, fromV),
          fetchPackageVersion(baseId, toV),
          fetchAllModuleDisassemblyAtVersion(baseId, fromV),
          fetchAllModuleDisassemblyAtVersion(baseId, toV),
        ]);

        const budget = max_sample_lines ?? 60;
        const diff = diffPackages(fromMods, toMods, budget);
        const linkage = diffLinkage(fromPkg.linkage, toPkg.linkage);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  package: baseId,
                  from: { version: fromPkg.version, address: fromPkg.address },
                  to: { version: toPkg.version, address: toPkg.address },
                  latest_version: latest,
                  summary: summarize(diff, linkage),
                  linkage_changes: linkage,
                  ...(linkage.some((l) => l.system)
                    ? {
                        linkage_note:
                          "Entries with system: true are framework packages (0x1, 0x2, 0x3 …). They upgrade in place and every package runs against the current framework, so those rows record which framework the upgrade was built against and change no behaviour.",
                      }
                    : {}),
                  diff: {
                    ...diff,
                    changed_modules: diff.changed_modules.map((m) => {
                      const next = sampleNextCall(m, diff, budget, fromPkg.address, toPkg.address);
                      return next ? { ...m, sample_next_call: next } : m;
                    }),
                  },
                },
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(`diff_package_upgrade failed: ${(err as Error).message}`);
      }
    },
  );
}
