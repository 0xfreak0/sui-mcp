import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { GrpcTypes } from "@mysten/sui/grpc";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function extractPackageIds(body: GrpcTypes.OpenSignatureBody): Set<string> {
  const ids = new Set<string>();
  if (body.type === GrpcTypes.OpenSignatureBody_Type.DATATYPE && body.typeName) {
    const parts = body.typeName.split("::");
    if (parts[0]?.startsWith("0x")) {
      ids.add(parts[0]);
    }
  }
  for (const child of body.typeParameterInstantiation) {
    for (const id of extractPackageIds(child)) {
      ids.add(id);
    }
  }
  return ids;
}

function extractDepsFromModule(mod: GrpcTypes.Module): Set<string> {
  const deps = new Set<string>();
  for (const fn of mod.functions) {
    for (const param of fn.parameters) {
      if (param.body) {
        for (const id of extractPackageIds(param.body)) deps.add(id);
      }
    }
    for (const ret of fn.returns) {
      if (ret.body) {
        for (const id of extractPackageIds(ret.body)) deps.add(id);
      }
    }
  }
  return deps;
}

interface PackageNode {
  package_id: string;
  version?: string;
  module_count: number;
  dependencies: string[];
}

export function registerDependencyTools(server: McpServer) {
  server.tool(
    "get_package_dependency_graph",
    "Get the dependency graph of a Sui Move package. Analyzes function signatures to discover which other packages it depends on, with optional recursive traversal.",
    {
      package_id: z.string().describe("Package ID (0x...)"),
      depth: z
        .number()
        .optional()
        .describe("Recursion depth (default 1, max 3). 1 = direct deps only."),
    },
    async ({ package_id, depth }) => {
      const maxDepth = Math.min(depth ?? 1, 3);
      const visited = new Map<string, PackageNode>();
      const queue: Array<{ id: string; level: number }> = [{ id: package_id, level: 0 }];

      while (queue.length > 0) {
        const item = queue.shift()!;
        if (visited.has(item.id)) continue;
        if (item.level > maxDepth) continue;

        try {
          const { response: res } = await sui.movePackageService.getPackage({
            packageId: item.id,
          });
          const pkg = res.package;
          if (!pkg) {
            visited.set(item.id, {
              package_id: item.id,
              module_count: 0,
              dependencies: [],
            });
            continue;
          }

          const allDeps = new Set<string>();
          for (const mod of pkg.modules) {
            for (const id of extractDepsFromModule(mod)) {
              allDeps.add(id);
            }
          }
          // Remove self-reference
          allDeps.delete(item.id);

          const node: PackageNode = {
            package_id: item.id,
            version: pkg.version?.toString(),
            module_count: pkg.modules.length,
            dependencies: [...allDeps],
          };
          visited.set(item.id, node);

          // Queue dependencies for next level
          if (item.level < maxDepth) {
            for (const depId of allDeps) {
              if (!visited.has(depId)) {
                queue.push({ id: depId, level: item.level + 1 });
              }
            }
          }
        } catch {
          visited.set(item.id, {
            package_id: item.id,
            module_count: 0,
            dependencies: [],
          });
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                root: package_id,
                depth: maxDepth,
                package_count: visited.size,
                graph: [...visited.values()],
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
