import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGql = vi.fn();
vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: (...args: unknown[]) => mockGql(...args),
  graphqlClient: {},
}));

const { registerDisassemblyTools } = await import("../../src/tools/disassembly.js");
const { looksLikeMvrName, resolvePackageId } = await import(
  "../../src/utils/move-package.js"
);

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _d: string, _s: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;
registerDisassemblyTools(mockServer);

const PKG = "0x000000000000000000000000000000000000000000000000000000000000cafe";

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => mockGql.mockReset());

describe("looksLikeMvrName", () => {
  it("treats 0x ids as raw, @org/app and org/app as MVR names", () => {
    expect(looksLikeMvrName("0xabc")).toBe(false);
    expect(looksLikeMvrName("@suins/core")).toBe(true);
    expect(looksLikeMvrName("suins/core")).toBe(true);
  });
});

describe("resolvePackageId", () => {
  it("normalizes a raw 0x id without any network call", async () => {
    expect(await resolvePackageId("0x2")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    );
  });
});

describe("disassemble_module tool", () => {
  it("lists modules when no target is given", async () => {
    mockGql.mockResolvedValueOnce({
      object: {
        asMovePackage: {
          modules: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: "a" }, { name: "b" }] },
        },
      },
    });
    const out = parse(await tools.get("disassemble_module")!({ package_id: PKG }));
    expect(out.modules).toEqual(["a", "b"]);
    expect(out.suivision_url).toContain(PKG);
  });

  it("returns disassembly for a single module", async () => {
    mockGql.mockResolvedValueOnce({
      object: { asMovePackage: { module: { name: "a", disassembly: "// Move bytecode v7\nmodule x.a {}" } } },
    });
    const out = parse(
      await tools.get("disassemble_module")!({ package_id: PKG, module_name: "a" }),
    );
    expect(out.module).toBe("a");
    expect(out.disassembly).toContain("Move bytecode");
  });

  it("errors cleanly when the package is not found", async () => {
    mockGql.mockResolvedValueOnce({ object: null });
    const result = await tools.get("disassemble_module")!({ package_id: PKG, module_name: "a" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toContain("Package not found");
  });

  it("disassembles all modules when all_modules is set", async () => {
    mockGql
      .mockResolvedValueOnce({
        object: {
          asMovePackage: {
            modules: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: "a" }] },
          },
        },
      })
      .mockResolvedValueOnce({ object: { asMovePackage: { module: { name: "a", disassembly: "code-a" } } } });
    const out = parse(
      await tools.get("disassemble_module")!({ package_id: PKG, all_modules: true }),
    );
    expect(out.module_count).toBe(1);
    expect(out.modules[0]).toEqual({ module: "a", disassembly: "code-a" });
  });

  // GraphQL's package(address:) resolves any version's address to the lineage's
  // LATEST version: disassembling Nemo v1 showed redeem_pt, which v5 added. The
  // mock answers the way the service does, so reading through package() fails.
  it("disassembles the version at the address given, not the lineage's latest", async () => {
    const V1 = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
    const latest = { module: { name: "py", disassembly: "public redeem_pt() {}" } };
    const exact = { module: { name: "py", disassembly: "public init_py_position() {}" } };
    mockGql.mockImplementation(async (query: string) =>
      /\bpackage\(address/.test(query) ? { package: latest } : { object: { asMovePackage: exact } },
    );
    const out = parse(await tools.get("disassemble_module")!({ package_id: V1, module_name: "py" }));
    expect(out.disassembly).toContain("init_py_position");
    expect(out.disassembly).not.toContain("redeem_pt");
  });

  it("says an object id is not a package", async () => {
    mockGql.mockResolvedValueOnce({ object: { asMovePackage: null } });
    const result = await tools.get("disassemble_module")!({ package_id: PKG, module_name: "a" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toContain("not a package");
  });
});
