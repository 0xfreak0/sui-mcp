import { numArg, addressArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { getNetwork } from "../config.js";
import { describeError, errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface Dependency {
  /** The package version linked: the ID its calls are loaded from. */
  package_id: string;
  /** The first version's ID, when the linked version is an upgrade. */
  original_id?: string;
  linked_version: string | null;
}

interface PackageNode {
  package_id: string;
  version?: string;
  module_count?: number;
  dependencies?: Dependency[];
  error?: string;
}

/**
 * One package's version, module count and linkage table.
 *
 * The linkage table is the package's complete dependency list, each entry
 * pinned to the version it was built against. Reading dependencies off
 * function signatures instead misses every package used only inside function
 * bodies or struct fields: Nemo v1 calls `0x3` that way, and a math library
 * with no struct types in its signatures came out with no dependencies at all.
 */
async function readPackage(id: string): Promise<Omit<PackageNode, "package_id"> | null> {
  const { response } = await sui.ledgerService.getObject({
    objectId: id,
    readMask: { paths: ["object_id", "version", "package.linkage", "package.modules.name"] },
  });
  const pkg = response.object?.package;
  if (!pkg) return null;
  return {
    version: response.object?.version?.toString(),
    module_count: pkg.modules.length,
    dependencies: pkg.linkage
      .filter((l) => l.upgradedId && l.upgradedId !== id)
      .map((l) => ({
        package_id: l.upgradedId!,
        ...(l.originalId && l.originalId !== l.upgradedId ? { original_id: l.originalId } : {}),
        linked_version: l.upgradedVersion?.toString() ?? null,
      })),
  };
}

export function registerDependencyTools(server: McpServer) {
  server.tool(
    "get_package_dependency_graph",
    "(Developer) Get the dependency graph of a Sui Move package from its linkage table: every package it is linked against, with the exact version linked (`linked_version`), which can be older than the dependency's current version. With depth > 1 each dependency's own linkage is read too, up to depth 3. System packages (0x1, 0x2, 0x3) upgrade in place, so their nodes show the current version while the edge shows the one linked.",
    {
      package_id: addressArg().describe("Package ID (0x...)"),
      depth: numArg()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("Recursion depth (default 1, max 3). 1 = the root's own linkage only."),
    },
    async ({ package_id, depth }) => {
      const maxDepth = Math.min(depth ?? 1, 3);
      const root = await readPackage(package_id);
      if (!root) return errorResult(`${package_id} is an object, not a Move package.`);

      const visited = new Map<string, PackageNode>([[package_id, { package_id, ...root }]]);
      let frontier = root.dependencies ?? [];
      for (let level = 1; level <= maxDepth && frontier.length > 0; level++) {
        const next: Dependency[] = [];
        for (const dep of frontier) {
          if (visited.has(dep.package_id)) continue;
          // A failed read is reported on its node, never as a package with
          // no modules and no dependencies.
          let node: PackageNode;
          try {
            const read = await readPackage(dep.package_id);
            node = read ? { package_id: dep.package_id, ...read } : { package_id: dep.package_id, error: "Not a Move package." };
          } catch (err) {
            node = { package_id: dep.package_id, error: describeError(err, getNetwork()) };
          }
          visited.set(dep.package_id, node);
          // The last level lists its linkage without reading it.
          if (level < maxDepth) next.push(...(node.dependencies ?? []));
        }
        frontier = next;
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
