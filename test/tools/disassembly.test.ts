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

/**
 * Answer the disassembly reads with `answer` and the linkage read, which
 * runs beside every module read, with `linkage`.
 */
function answer(value: unknown, linkage: unknown[] = []) {
  mockGql.mockImplementation(async (query: string) =>
    /\blinkage\b/.test(query) ? { object: { asMovePackage: { linkage } } } : value,
  );
}

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
    answer({
      object: { asMovePackage: { module: { name: "a", disassembly: "// Move bytecode v7\nmodule x.a {}" } } },
    });
    const out = parse(
      await tools.get("disassemble_module")!({ package_id: PKG, module_name: "a" }),
    );
    expect(out.module).toBe("a");
    expect(out.disassembly).toContain("Move bytecode");
  });

  it("errors cleanly when the package is not found", async () => {
    mockGql.mockResolvedValue({ object: null });
    const result = await tools.get("disassemble_module")!({ package_id: PKG, module_name: "a" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toContain("Package not found");
  });

  it("disassembles all modules when all_modules is set", async () => {
    answer({
      object: {
        asMovePackage: {
          modules: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ name: "a", disassembly: "code-a" }],
          },
        },
      },
    });
    const out = parse(
      await tools.get("disassemble_module")!({ package_id: PKG, all_modules: true }),
    );
    expect(out.module_count).toBe(1);
    expect(out.modules[0]).toEqual({ module: "a", disassembly: "code-a" });
  });

  // GraphQL's package(address:) resolves any version's address to the lineage's
  // latest version. The mock answers the way the service does (only the latest
  // has redeem_pt), so reading through package() fails.
  it("disassembles the version at the address given, not the lineage's latest", async () => {
    const V1 = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
    const latest = { module: { name: "py", disassembly: "public redeem_pt() {}" } };
    const exact = { module: { name: "py", disassembly: "public init_py_position() {}" } };
    mockGql.mockImplementation(async (query: string) =>
      /\bpackage\(address/.test(query)
        ? { package: latest }
        : /\blinkage\b/.test(query)
          ? { object: { asMovePackage: { linkage: [] } } }
          : { object: { asMovePackage: exact } },
    );
    const out = parse(await tools.get("disassemble_module")!({ package_id: V1, module_name: "py" }));
    expect(out.disassembly).toContain("init_py_position");
    expect(out.disassembly).not.toContain("redeem_pt");
  });

  it("says an object id is not a package", async () => {
    mockGql.mockResolvedValue({ object: { asMovePackage: null } });
    const result = await tools.get("disassemble_module")!({ package_id: PKG, module_name: "a" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toContain("not a package");
  });

  /**
   * A module runs to 250 KB. function_name returns one function, with the
   * `use` lines of the modules it calls and the version of each dependency
   * this package's linkage runs.
   */
  it("returns one function with the linked version of each dependency it calls", async () => {
    const MATE = "714a63a0dba6da4f017b42d5d0fb78867f18bcde904868e51d951a5a6f5b7f57";
    const MATE_V3 = "0xe2b515f0052c0b3f83c23db045d49dbe1732818ccfc5d4596c9482f7f2e76a85";
    const text = [
      "module 1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb.clmm_math {",
      `use ${MATE}::math_u256;`,
      `use ${MATE}::full_math_u128;`,
      "",
      "public get_delta_a(Arg0: u256): u256 {",
      "B0:",
      "\t0: MoveLoc[0](Arg0: u256)",
      "\t1: Call math_u256::checked_shlw(u256): u256 * bool",
      "\t2: Pop",
      "\t3: Ret",
      "}",
      "",
      "public other(): u64 {",
      "B0:",
      "\t0: LdU64(1)",
      "\t1: Ret",
      "}",
      "}",
    ].join("\n");
    answer({ object: { asMovePackage: { module: { name: "clmm_math", disassembly: text } } } }, [
      { originalId: `0x${MATE}`, upgradedId: MATE_V3, version: 3 },
    ]);
    const out = parse(
      await tools.get("disassemble_module")!({ package_id: PKG, module_name: "clmm_math", function_name: "get_delta_a" }),
    );
    expect(out.function).toBe("get_delta_a");
    expect(out.disassembly.startsWith("public get_delta_a(Arg0: u256): u256 {")).toBe(true);
    expect(out.disassembly).not.toContain("other");
    // Only the module it calls, with the version linked.
    expect(out.uses).toHaveLength(1);
    expect(out.uses[0]).toContain(`use ${MATE}::math_u256;`);
    expect(out.uses[0]).toContain(MATE_V3);
  });
});
