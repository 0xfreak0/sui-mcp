import { z } from "zod";
import { boolArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import { suivisionPackageUrl } from "../config.js";
import {
  resolvePackageId,
  fetchModuleNames,
  fetchModuleDisassembly,
} from "../utils/move-package.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerDisassemblyTools(server: McpServer) {
  server.tool(
    "disassemble_module",
    "(Developer) Disassemble Move module(s) from a Sui package into Move bytecode assembly, using the GraphQL endpoint — no external binary required. Lower-level than decompiled source (basic blocks, stack ops) but always available. If module_name is omitted, lists available modules. Set all_modules=true to disassemble the whole package. Accepts a 0x package ID or an MVR name (@org/app).",
    {
      package_id: z
        .string()
        .describe("Package ID (0x...) or MVR name (@org/app)"),
      module_name: z
        .string()
        .optional()
        .describe("Module to disassemble. If omitted, lists available modules."),
      all_modules: boolArg()
        .optional()
        .describe("Disassemble every module in the package (default: false)"),
    },
    async ({ package_id, module_name, all_modules }) => {
      try {
        const packageId = await resolvePackageId(package_id);

        // List modules when no target is specified.
        if (!module_name && !all_modules) {
          const modules = await fetchModuleNames(packageId);
          return json({
            package_id: packageId,
            modules,
            suivision_url: suivisionPackageUrl(packageId),
          });
        }

        if (all_modules) {
          const names = await fetchModuleNames(packageId);
          const modules = await Promise.all(
            names.map(async (name) => {
              try {
                return { module: name, disassembly: await fetchModuleDisassembly(packageId, name) };
              } catch (err) {
                return {
                  module: name,
                  disassembly: `// Error: ${err instanceof Error ? err.message : String(err)}`,
                };
              }
            }),
          );
          return json({
            package_id: packageId,
            module_count: modules.length,
            suivision_url: suivisionPackageUrl(packageId),
            modules,
          });
        }

        // Single module.
        const disassembly = await fetchModuleDisassembly(packageId, module_name!);
        return json({
          package_id: packageId,
          module: module_name,
          suivision_url: suivisionPackageUrl(packageId),
          disassembly,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}
