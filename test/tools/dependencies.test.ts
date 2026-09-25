import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMockClient } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));

// Imported after the mock above, which the factory closes over.
const { registerDependencyTools } = await import("../../src/tools/dependencies.js");

const tools = new Map<string, Function>();
registerDependencyTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as McpServer);

const pad = (hex: string) => `0x${hex.padStart(64, "0")}`;
const NEMO_V1 = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const MATH = "0xec4f1ffc3ae33792da03fc072ea80fedb44eb20d40ab08611c427e29247fbf2b";

/** A package as ledgerService.getObject returns it for `package.linkage` / `package.modules.name`. */
function packageObject(version: bigint, modules: string[], linkage: Array<[string, bigint]>) {
  return {
    response: {
      object: {
        version,
        package: {
          modules: modules.map((name) => ({ name, datatypes: [], functions: [] })),
          linkage: linkage.map(([id, v]) => ({ originalId: id, upgradedId: id, upgradedVersion: v })),
        },
      },
    },
  };
}

describe("get_package_dependency_graph", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads dependencies from the linkage table, with the version linked", async () => {
    // Nemo v1's linkage on mainnet. Its function signatures never mention
    // 0x3, and the math library's mention no package at all.
    mockSui.ledgerService.getObject.mockImplementation(async ({ objectId }: { objectId: string }) => {
      if (objectId === NEMO_V1) {
        return packageObject(1n, ["py", "market"], [[pad("1"), 14n], [pad("2"), 30n], [pad("3"), 18n], [MATH, 1n]]);
      }
      if (objectId === MATH) return packageObject(1n, ["math64"], [[pad("1"), 14n], [pad("2"), 30n]]);
      return packageObject(60n, ["coin"], []);
    });

    const data = JSON.parse((await tools.get("get_package_dependency_graph")!({ package_id: NEMO_V1 })).content[0].text);
    const root = data.graph.find((n: { package_id: string }) => n.package_id === NEMO_V1);
    const math = data.graph.find((n: { package_id: string }) => n.package_id === MATH);

    expect(root.dependencies.map((d: { package_id: string }) => d.package_id)).toContain(pad("3"));
    expect(root.dependencies.find((d: { package_id: string }) => d.package_id === pad("2")).linked_version).toBe("30");
    expect(math.dependencies.map((d: { package_id: string }) => d.package_id)).toEqual([pad("1"), pad("2")]);
  });

  it("refuses an object that is not a package", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({ response: { object: { version: 5n } } });

    const result = await tools.get("get_package_dependency_graph")!({ package_id: pad("6") });

    expect(result.isError).toBe(true);
  });

  it("marks a dependency that could not be read instead of listing it empty", async () => {
    mockSui.ledgerService.getObject.mockImplementation(async ({ objectId }: { objectId: string }) => {
      if (objectId === NEMO_V1) return packageObject(1n, ["py"], [[MATH, 1n]]);
      throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { code: "RESOURCE_EXHAUSTED" });
    });

    const data = JSON.parse((await tools.get("get_package_dependency_graph")!({ package_id: NEMO_V1 })).content[0].text);
    const math = data.graph.find((n: { package_id: string }) => n.package_id === MATH);

    expect(math.error).toBeTruthy();
    expect(math.dependencies).toBeUndefined();
  });
});
