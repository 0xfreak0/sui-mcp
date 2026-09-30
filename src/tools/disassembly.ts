import { z } from "zod";
import { boolArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import { suivisionPackageUrl } from "../config.js";
import {
  resolvePackageId,
  fetchModuleNames,
  fetchModuleDisassembly,
  fetchAllModuleDisassembly,
  fetchPackageLinkage,
} from "../utils/move-package.js";
import { annotateDisassembly, extractFunction, functionNames } from "../utils/disassembly.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerDisassemblyTools(server: McpServer) {
  server.tool(
    "disassemble_module",
    "(Developer) Disassemble Move module(s) from a Sui package into Move bytecode assembly, using the GraphQL endpoint. No external binary is needed, so it always works. Lower-level than decompiled source (basic blocks, stack ops). Pass function_name with module_name for one function's bytecode plus the `use` lines and constants it refers to; a module runs to 250 KB. If module_name is omitted, lists available modules. Set all_modules=true to disassemble the whole package. Operands the raw text leaves opaque carry a `//` note: a clever abort code's error name, message and source line; a large integer's hex or shift form (`0xffff << 240`); a truncated constant's full value; on a `Shl` or `Shr`, that the bits shifted out are dropped with no abort; and on each `use` line of a dependency, the version and ID this package's linkage table runs, since the line prints the dependency's original ID. Accepts a 0x package ID or an MVR name (@org/app).",
    {
      package_id: z
        .string()
        .describe("Package ID (0x...) or MVR name (@org/app)"),
      module_name: z
        .string()
        .optional()
        .describe("Module to disassemble. If omitted, lists available modules."),
      function_name: z
        .string()
        .optional()
        .describe("Return only this function of module_name (default: the whole module)."),
      all_modules: boolArg()
        .optional()
        .describe("Disassemble every module in the package (default: false)"),
    },
    async ({ package_id, module_name, function_name, all_modules }) => {
      try {
        if (function_name && !module_name) {
          return errorResult("function_name needs module_name: name the module that declares the function.");
        }
        if (function_name && all_modules) {
          return errorResult("function_name reads one function of module_name; drop all_modules.");
        }
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

        // The linkage only annotates `use` lines, so a failed read leaves them
        // plain and says so rather than failing the disassembly.
        const linkageRead = fetchPackageLinkage(packageId).then(
          (linkage) => ({ linkage, unavailable: {} }),
          (err: unknown) => ({
            linkage: undefined,
            unavailable: {
              linkage_unavailable: `The package's linkage table could not be read (${err instanceof Error ? err.message : String(err)}), so \`use\` lines give each dependency's original ID without the version this package runs.`,
            },
          }),
        );

        if (all_modules) {
          const [texts, { linkage, unavailable }] = await Promise.all([fetchAllModuleDisassembly(packageId), linkageRead]);
          const modules = [...texts].map(([module, text]) => ({
            module,
            disassembly: annotateDisassembly(text, { linkage, packageId }),
          }));
          return json({
            package_id: packageId,
            module_count: modules.length,
            suivision_url: suivisionPackageUrl(packageId),
            ...unavailable,
            modules,
          });
        }

        const [text, { linkage, unavailable }] = await Promise.all([
          fetchModuleDisassembly(packageId, module_name!),
          linkageRead,
        ]);
        const disassembly = annotateDisassembly(text, { linkage, packageId });
        if (!function_name) {
          return json({
            package_id: packageId,
            module: module_name,
            suivision_url: suivisionPackageUrl(packageId),
            ...unavailable,
            disassembly,
          });
        }

        const fn = extractFunction(disassembly, function_name);
        if (!fn) {
          return errorResult(
            `Module '${module_name}' of ${packageId} declares no function '${function_name}'. It declares: ${functionNames(text).join(", ")}.`,
          );
        }
        return json({
          package_id: packageId,
          module: module_name,
          function: function_name,
          suivision_url: suivisionPackageUrl(packageId),
          ...unavailable,
          disassembly: fn.text,
          ...(fn.uses.length ? { uses: fn.uses } : {}),
          ...(fn.constants.length ? { constants: fn.constants } : {}),
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}
