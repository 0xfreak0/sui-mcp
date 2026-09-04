import { z } from "zod";
import { numArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import {
  fetchAllModuleDisassemblyAtVersion,
  fetchPackageLatestVersion,
  resolvePackageId,
  resolveVersionAddress,
} from "../utils/move-package.js";
import { diffPackages } from "../utils/package-diff.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPackageAuditTools(server: McpServer) {
  server.tool(
    "diff_package_upgrade",
    "(Security) Diff two versions of a Move package to spot what an upgrade changed — the classic malicious-upgrade / backdoor vector. On Sui each upgrade publishes a new package address; this resolves the two versions, disassembles both, and reports added/removed modules plus a per-module line diff. Defaults to comparing the latest upgrade (previous → latest). Accepts a 0x package ID (any version) or an MVR name.",
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
    },
    async ({ package: pkgRef, from_version, to_version }) => {
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
          resolveVersionAddress(baseId, fromV),
          resolveVersionAddress(baseId, toV),
          fetchAllModuleDisassemblyAtVersion(baseId, fromV),
          fetchAllModuleDisassemblyAtVersion(baseId, toV),
        ]);

        const diff = diffPackages(fromMods, toMods);

        const changedNames = diff.changed_modules.map((m) => m.module);
        const headline = diff.identical
          ? "No bytecode changes between these versions (metadata-only upgrade)."
          : `Upgrade changed ${diff.changed_modules.length} module(s)` +
            (diff.added_modules.length ? `, added ${diff.added_modules.length}` : "") +
            (diff.removed_modules.length ? `, removed ${diff.removed_modules.length}` : "") +
            `. Review${changedNames.length ? " " + changedNames.slice(0, 5).join(", ") : ""}` +
            (changedNames.length > 5 ? ", …" : "") + ".";

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
                  summary: headline,
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
