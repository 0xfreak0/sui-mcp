import { z } from "zod";
import { boolArg, addressArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { DECOMPILER_PATH, suivisionPackageUrl } from "../config.js";
import { errorResult } from "../utils/errors.js";
import { annotateSource, extractSourceFunction, sourceFunctionNames } from "../utils/move-source.js";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat, writeFile, unlink, mkdtemp } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import type { GrpcTypes } from "@mysten/sui/grpc";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Bounds on `all_modules`, which is the expensive path: it shells out once per
 * module, and both the module count and the bytecode size are chosen by whoever
 * published the package. Without a ceiling, a package with a few hundred
 * modules turns one tool call into tens of minutes of subprocesses and hundreds
 * of megabytes buffered in memory before serialization — a denial of service
 * that costs an attacker one publish.
 *
 * Every limit is reported in the response rather than applied silently, so a
 * truncated result can never be mistaken for a complete one.
 */
export const DECOMPILE_LIMITS = {
  /** Modules decompiled in a single all_modules call. */
  maxModules: 32,
  /** Wall-clock budget for the whole call, checked between modules. */
  totalTimeoutMs: 120_000,
  /** Combined source bytes retained before the run stops early. */
  maxTotalOutputBytes: 8 * 1024 * 1024,
  /** Per-subprocess limits, enforced by execFile itself. */
  perModuleTimeoutMs: 30_000,
  perModuleOutputBytes: 5 * 1024 * 1024,
} as const;

/**
 * Decide which modules a single call will attempt. Split out from the loop so
 * the ceiling is testable without invoking a decompiler binary.
 */
export function planModuleBatch<T>(modules: T[]): { selected: T[]; skipped: number } {
  const selected = modules.slice(0, DECOMPILE_LIMITS.maxModules);
  return { selected, skipped: modules.length - selected.length };
}

/**
 * No decompiler binary at SUI_DECOMPILER_PATH or on PATH, or the variable is
 * set blank. Its own class so a whole-package run stops at the first module
 * instead of returning this message as the "source" of every module. The
 * wording avoids "not found", which the error cleaner reads as an object
 * missing on this network.
 */
export class MissingDecompiler extends Error {
  constructor() {
    super(
      "No move-decompiler binary is configured, so this cannot be decompiled. The bytecode reads without it: " +
        "disassemble_module (function_name for one function), get_move_function for a signature, and " +
        "diff_package_upgrade for what an upgrade changed. To decompile as well, build the optional binary " +
        "(https://github.com/0xfreak0/sui-mcp, `npm run build:decompiler`) and set SUI_DECOMPILER_PATH to it.",
    );
  }
}

/**
 * Whether the decompiler can be started: the trimmed `path` as an executable
 * regular file, or for a bare name, an executable file of that name in a
 * `searchPath` directory, as execFile looks it up. A blank path is no
 * decompiler.
 */
export async function decompilerAvailable(path = DECOMPILER_PATH, searchPath = process.env.PATH ?? ""): Promise<boolean> {
  const bin = path.trim();
  if (!bin) return false;
  const candidates = /[\\/]/.test(bin)
    ? [bin]
    : searchPath
        .split(delimiter)
        .filter(Boolean)
        .flatMap((dir) => (process.platform === "win32" ? [join(dir, bin), join(dir, `${bin}.exe`)] : [join(dir, bin)]));
  for (const candidate of candidates) {
    try {
      // A directory passes the execute check too.
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // Not here; try the next directory.
    }
  }
  return false;
}

function runDecompiler(bytecodeFile: string): Promise<string> {
  // The path decompilerAvailable checked. execFile throws synchronously on an
  // empty file argument.
  const bin = DECOMPILER_PATH.trim();
  if (!bin) return Promise.reject(new MissingDecompiler());
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["-b", bytecodeFile],
      {
        timeout: DECOMPILE_LIMITS.perModuleTimeoutMs,
        maxBuffer: DECOMPILE_LIMITS.perModuleOutputBytes,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message;
          if (msg.includes("ENOENT")) {
            // The binary is never bundled: it's a ~3.5MB platform-specific Rust
            // build, so an npm tarball could only ever ship the wrong arch. The
            // build script that produces it lives in the git repo and is not in
            // the published `files` list, so an npx/npm install has no local
            // copy to point at — hence the repo URL rather than a relative path.
            reject(new MissingDecompiler());
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

/**
 * Move identifiers are `[a-zA-Z_][a-zA-Z0-9_]*` — no dots, no separators.
 *
 * Module names arrive from on-chain package data, i.e. from whoever published
 * the package, by way of whatever RPC endpoint the user configured. Anything
 * that reaches `join()` from that source is untrusted input: a name like
 * `../../../evil` would place an attacker-controlled write outside the temp
 * directory. The Move verifier should make that impossible, but "the remote
 * side promised" is not a boundary, and this costs one regex.
 */
export function isValidModuleName(name: string | undefined): name is string {
  return !!name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

async function decompileModule(
  mod: GrpcTypes.Module,
  dir: string
): Promise<string> {
  if (!isValidModuleName(mod.name)) {
    throw new Error(
      `Refusing to decompile module with an invalid name: ${JSON.stringify(mod.name)}. ` +
        "Move identifiers are letters, digits and underscores only.",
    );
  }
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
    "(Developer) Decompile Move module(s) from a Sui package into readable source code. Optional: requires an external move-decompiler binary (SUI_DECOMPILER_PATH). disassemble_module, get_move_function and diff_package_upgrade read the same bytecode with no binary. If module_name is omitted, lists available modules and says whether the binary is available. Pass function_name with module_name for one function's source plus the `use` lines and constants it refers to, when the decompiler prints them. Set all_modules=true to decompile the entire package. A line holding a large decimal literal carries a `//` note with its hex or shift form, as disassemble_module gives.",
    {
      package_id: addressArg().describe("Package ID (0x...)"),
      module_name: z
        .string()
        .optional()
        .describe("Module name to decompile. If omitted, lists available modules."),
      function_name: z
        .string()
        .optional()
        .describe("Return only this function of module_name (default: the whole module)."),
      all_modules: boolArg()
        .optional()
        .describe("Decompile all modules in the package (default: false)"),
    },
    async ({ package_id, module_name, function_name, all_modules }) => {
      if (function_name && !module_name) {
        return errorResult("function_name needs module_name: name the module that declares the function.");
      }
      if (function_name && all_modules) {
        return errorResult("function_name reads one function of module_name; drop all_modules.");
      }
      const pkg = await fetchPackageModules(package_id);
      if (!pkg) return errorResult("Package not found");

      // List modules if no target specified
      if (!module_name && !all_modules) {
        const modules = pkg.modules.map((m) => m.name);
        const available = await decompilerAvailable();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  package_id,
                  modules,
                  suivision_url: suivisionPackageUrl(package_id),
                  decompiler_available: available,
                  ...(available
                    ? {}
                    : {
                        note: "No move-decompiler binary is configured, so decompiling these modules will fail. disassemble_module reads them with no binary (function_name for one function); SUI_DECOMPILER_PATH points the server at the optional decompiler.",
                      }),
                },
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

        const { selected, skipped } = planModuleBatch(modulesWithBytecode);
        const notes: string[] = [];
        if (skipped > 0) {
          notes.push(
            `Package has ${modulesWithBytecode.length} modules with bytecode; ` +
              `decompiled the first ${selected.length}. Request the remaining ${skipped} ` +
              "individually with module_name.",
          );
        }

        const results: { module: string; source: string }[] = [];
        const startedAt = Date.now();
        let totalBytes = 0;

        for (const mod of selected) {
          // Both budgets are checked between modules rather than mid-subprocess:
          // execFile already bounds a single module, so the only unbounded axis
          // is how many of them we agree to run.
          if (Date.now() - startedAt > DECOMPILE_LIMITS.totalTimeoutMs) {
            notes.push(
              `Stopped after ${results.length} of ${selected.length} modules: exceeded the ` +
                `${DECOMPILE_LIMITS.totalTimeoutMs / 1000}s budget for one call.`,
            );
            break;
          }
          if (totalBytes > DECOMPILE_LIMITS.maxTotalOutputBytes) {
            notes.push(
              `Stopped after ${results.length} of ${selected.length} modules: output exceeded ` +
                `${DECOMPILE_LIMITS.maxTotalOutputBytes / 1024 / 1024}MB.`,
            );
            break;
          }

          try {
            const source = annotateSource(await decompileModule(mod, dir));
            totalBytes += source.length;
            results.push({ module: mod.name!, source });
          } catch (err) {
            if (err instanceof MissingDecompiler) return errorResult(err.message);
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
                  package_id,
                  module_count: results.length,
                  // Surfaced so a truncated result is never mistaken for the
                  // whole package.
                  total_modules_with_bytecode: modulesWithBytecode.length,
                  complete: results.length === modulesWithBytecode.length,
                  ...(notes.length ? { notes } : {}),
                  suivision_url: suivisionPackageUrl(package_id),
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

      let source: string;
      try {
        source = annotateSource(await decompileModule(mod, dir));
      } catch (err) {
        if (err instanceof MissingDecompiler) return errorResult(err.message);
        throw err;
      }

      if (!function_name) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { package_id, module: module_name, suivision_url: suivisionPackageUrl(package_id), source },
                null,
                2
              ),
            },
          ],
        };
      }

      const fn = extractSourceFunction(source, function_name);
      if (!fn) {
        return errorResult(
          `Module '${module_name}' of ${package_id} declares no function '${function_name}'. It declares: ${sourceFunctionNames(source).join(", ")}.`,
        );
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                package_id,
                module: module_name,
                function: function_name,
                suivision_url: suivisionPackageUrl(package_id),
                source: fn.text,
                ...(fn.uses.length ? { uses: fn.uses } : {}),
                ...(fn.constants.length ? { constants: fn.constants } : {}),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
