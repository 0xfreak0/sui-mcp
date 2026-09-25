import { z } from "zod";
import { numArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import {
  fetchAllModuleDisassemblyAtVersion,
  fetchPackageLatestVersion,
  fetchPackageVersion,
  resolvePackageId,
} from "../utils/move-package.js";
import { diffLinkage, diffPackages, type LinkageChange, type PackageDiff } from "../utils/package-diff.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const short = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;

/**
 * The one-paragraph answer to "what did this upgrade change". Every class of
 * change is named here, not only in the structured fields, because a reader
 * who stops at the summary must not come away thinking a relinked dependency
 * or a newly public function was a no-op.
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
    const names = diff.changed_modules.map((m) => m.module);
    parts.push(
      `Upgrade changed ${diff.changed_modules.length} module(s)` +
        (diff.added_modules.length ? `, added ${diff.added_modules.length}` : "") +
        (diff.removed_modules.length ? `, removed ${diff.removed_modules.length}` : "") +
        (names.length ? `: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}` : "") +
        ".",
    );
  }
  const widened = diff.visibility_changes.filter((v) => v.widened);
  if (widened.length) {
    parts.push(
      `Now callable from more places: ${widened.map((v) => `${v.module}::${v.function} (${v.from} → ${v.to})`).join(", ")}.`,
    );
  }
  if (diff.added_functions.length || diff.removed_functions.length) {
    parts.push(`Functions added: ${diff.added_functions.length}, removed: ${diff.removed_functions.length}.`);
  }
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
    parts.push("Some module samples are truncated: raise max_sample_lines or read the module with disassemble_module.");
  }
  return parts.join(" ");
}

export function registerPackageAuditTools(server: McpServer) {
  server.tool(
    "diff_package_upgrade",
    "(Security) Diff two versions of a Move package to spot what an upgrade changed, the classic malicious-upgrade / backdoor vector. On Sui each upgrade publishes a new package address; this resolves the two versions, disassembles both, and reports added/removed modules, each changed module as unified hunks (changed lines with 3 lines of context and `@@` headers naming the enclosing function), functions added, removed or made more reachable (e.g. private → public), and dependency relinks with the call that diffs the dependency itself. An upgrade can change behaviour through a dependency alone, with no module of its own changing. Defaults to comparing the latest upgrade (previous → latest). Accepts a 0x package ID (any version) or an MVR name.",
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
        .max(2000)
        .optional()
        .describe(
          "Line budget per changed module for the unified hunks (default 60). Changed lines are shown before context; `sample_truncated` says when some did not fit.",
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

        const diff = diffPackages(fromMods, toMods, max_sample_lines ?? 60);
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
                  diff,
                },
                null,
                2,
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
