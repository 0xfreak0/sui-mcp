import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { DECOMPILER_PATH } from "../config.js";
import { errorResult } from "../utils/errors.js";
import { execFile } from "node:child_process";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GrpcTypes } from "@mysten/sui/grpc";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function runDecompiler(bytecodeFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      DECOMPILER_PATH,
      ["-b", bytecodeFile],
      { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message;
          if (msg.includes("ENOENT")) {
            reject(
              new Error(
                "move-decompiler binary not found. Run scripts/build-decompiler.sh and set SUI_DECOMPILER_PATH."
              )
            );
          } else {
            reject(new Error(msg));
          }
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

async function fetchPackageModules(packageId: string) {
  const { response } = await sui.ledgerService.getObject({
    objectId: packageId,
    readMask: { paths: ["object_id", "package"] },
  });
  return response.object?.package;
}

async function decompileModule(
  mod: GrpcTypes.Module,
  dir: string
): Promise<string> {
  const mvFile = join(dir, `${mod.name}.mv`);
  try {
    await writeFile(mvFile, mod.contents!);
    return await runDecompiler(mvFile);
  } finally {
    await unlink(mvFile).catch(() => {});
  }
}

export function registerDecompilerTools(server: McpServer) {
  server.tool(
    "decompile_module",
    "(Developer) Decompile Move module(s) from a Sui package into readable source code. Requires external move-decompiler binary. If module_name is omitted, lists available modules. Set all_modules=true to decompile the entire package.",
    {
      package_id: z.string().describe("Package ID (0x...)"),
      module_name: z
        .string()
        .optional()
        .describe("Module name to decompile. If omitted, lists available modules."),
      all_modules: z
        .boolean()
        .optional()
        .describe("Decompile all modules in the package (default: false)"),
    },
    async ({ package_id, module_name, all_modules }) => {
      const pkg = await fetchPackageModules(package_id);
      if (!pkg) return errorResult("Package not found");

      // List modules if no target specified
      if (!module_name && !all_modules) {
        const modules = pkg.modules.map((m) => m.name);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { package_id: pkg.storageId, modules },
                null,
                2
              ),
            },
          ],
        };
      }

      const dir = await mkdtemp(join(tmpdir(), "sui-decompile-"));

      // Decompile all modules
      if (all_modules) {
        const modulesWithBytecode = pkg.modules.filter(
          (m) => m.contents && m.contents.length > 0
        );
        if (modulesWithBytecode.length === 0) {
          return errorResult("Package has no modules with bytecode");
        }

        const results: { module: string; source: string }[] = [];
        for (const mod of modulesWithBytecode) {
          try {
            const source = await decompileModule(mod, dir);
            results.push({ module: mod.name!, source });
          } catch (err) {
            results.push({
              module: mod.name!,
              source: `// Error decompiling: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  package_id: pkg.storageId,
                  module_count: results.length,
                  modules: results,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Decompile single module
      const mod = pkg.modules.find((m) => m.name === module_name);
      if (!mod) {
        const available = pkg.modules.map((m) => m.name);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error: `Module '${module_name}' not found`,
                  available_modules: available,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      if (!mod.contents || mod.contents.length === 0) {
        return errorResult("Module has no bytecode");
      }

      const source = await decompileModule(mod, dir);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { package_id: pkg.storageId, module: module_name, source },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
