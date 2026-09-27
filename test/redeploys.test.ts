import { describe, it, expect, vi } from "vitest";
import { moduleFingerprint } from "../src/utils/module-fingerprint.js";
import {
  compareOrder,
  findRedeploys,
  functionOrigins,
  identicalFunctions,
  identicalModules,
  moduleOrigins,
  type RelatedLineage,
  type VersionModules,
} from "../src/utils/redeploys.js";

// vi.mock is hoisted above the imports, so redeploys.ts sees this stub.
const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

/**
 * A minimal Move module binary: magic, version 6, an ADDRESS_IDENTIFIERS
 * table (kind 8) holding `address` and an IDENTIFIERS table (kind 7) holding
 * `code`.
 */
function moduleBytes(address: number, code: number[]): Uint8Array {
  const addr = new Array(32).fill(0);
  addr[31] = address;
  return Uint8Array.from([0xa1, 0x1c, 0xeb, 0x0b, 6, 0, 0, 0, 2, 0x08, 0, 32, 0x07, 32, code.length, ...addr, ...code]);
}

describe("moduleFingerprint", () => {
  it("gives the same code published at two addresses one fingerprint", () => {
    expect(moduleFingerprint(moduleBytes(0x2b, [1, 2, 3]))).toBe(moduleFingerprint(moduleBytes(0x84, [1, 2, 3])));
  });

  it("tells code apart when anything outside the address table differs", () => {
    expect(moduleFingerprint(moduleBytes(0x2b, [1, 2, 3]))).not.toBe(moduleFingerprint(moduleBytes(0x2b, [1, 2, 4])));
  });

  it("reads nothing from bytes that are not a Move module or whose tables run past the end", () => {
    const notMove = moduleBytes(0x2b, [1]);
    notMove[0] = 0;
    expect(moduleFingerprint(notMove)).toBeNull();
    expect(moduleFingerprint(moduleBytes(0x2b, [1, 2, 3]).slice(0, 30))).toBeNull();
  });
});

const version = (
  v: number,
  id: string,
  modules: Record<string, string>,
  published_at: string | null = null,
  functions: Record<string, [code: string, declared: string]> = {},
): VersionModules => ({
  version: v,
  package_id: id,
  published_at,
  modules: new Map(Object.entries(modules)),
  functions: new Map(Object.entries(functions).map(([name, [code, declared]]) => [name, { code, declared }])),
});

describe("identicalModules", () => {
  it("pairs each module with the earliest version on each side that shares its code", () => {
    // Nemo: py in 0x2b71 v1 equals 0x84d6 v3 only; market_math never changed.
    const here = [version(1, "0x2b71", { py: "p1", market_math: "m" }), version(8, "0x0f28", { py: "p8", market_math: "m" })];
    const there = [version(1, "0x84d6", { py: "p0", market_math: "m" }), version(3, "0xcf34", { py: "p1", market_math: "m" })];
    expect(identicalModules(here, there)).toEqual([
      { module: "market_math", here: { version: 1, package_id: "0x2b71", published_at: null }, there: { version: 1, package_id: "0x84d6", published_at: null } },
      { module: "py", here: { version: 1, package_id: "0x2b71", published_at: null }, there: { version: 3, package_id: "0xcf34", published_at: null } },
    ]);
  });

  it("reports nothing when no version shares any module's code", () => {
    expect(identicalModules([version(1, "0xa", { py: "x" })], [version(1, "0xb", { py: "y" }), version(2, "0xc", { sy: "x" })])).toEqual([]);
  });
});

describe("compareOrder", () => {
  it("compares lineages published before this one first, nearest first, then later ones, then undated", () => {
    const c = (id: string, published_at: string | null) => ({ id, published_at });
    const order = compareOrder(
      [c("oct-2025", "2025-10-10T00:00:00Z"), c("jan-04", "2025-01-04T00:00:00Z"), c("undated", null), c("feb-20", "2025-02-20T00:00:00Z"), c("mar-01", "2025-03-01T00:00:00Z")],
      "2025-02-24T13:25:30Z",
    );
    expect(order.map((x) => x.id)).toEqual(["feb-20", "jan-04", "mar-01", "oct-2025", "undated"]);
  });
});

describe("moduleOrigins", () => {
  const NEMO = "0x2b71";
  const lineage = (root: string, modules: Array<[string, string, string]>): RelatedLineage => ({
    root_package_id: root,
    latest_package_id: root,
    version_count: 1,
    published_at: modules[0][2],
    cap_held_by: "0xf55c",
    shared_module_names: modules.length,
    identical_modules: modules.map(([module, hereAt, thereAt]) => ({
      module,
      here: { version: 1, package_id: NEMO, published_at: hereAt },
      there: { version: 1, package_id: root, published_at: thereAt },
    })),
  });

  it("names, per module, the earliest version carrying the shared code and counts the compared lineages", () => {
    const FEB_24 = "2025-02-24T13:25:30Z";
    const origins = moduleOrigins(NEMO, [
      lineage("0xe4da", [["py", FEB_24, "2025-02-20T07:18:59Z"], ["sy", FEB_24, "2025-02-20T07:18:59Z"]]),
      lineage("0x84d6", [["py", FEB_24, "2025-01-04T16:10:28Z"]]),
    ]);
    expect(origins).toEqual([
      expect.objectContaining({ module: "py", root_package_id: "0x84d6", queried_lineage: false, lineages_with_it: 2 }),
      expect.objectContaining({ module: "sy", root_package_id: "0xe4da", queried_lineage: false, lineages_with_it: 1 }),
    ]);
  });

  it("names the queried lineage when it carried the code before every compared copy", () => {
    // Querying 0x84d6: its v3 had py on 2025-01-04, before 0xf2f7's copy on 2025-01-15.
    const origins = moduleOrigins(NEMO, [lineage("0xf2f7", [["py", "2025-01-04T16:10:28Z", "2025-01-15T12:26:53Z"]])]);
    expect(origins).toEqual([
      expect.objectContaining({ module: "py", root_package_id: NEMO, queried_lineage: true, published_at: "2025-01-04T16:10:28Z", lineages_with_it: 1 }),
    ]);
  });
});

describe("functionOrigins", () => {
  const DEC = "2025-12-10T18:49:10Z";
  const FEB = "2026-02-10T21:00:26Z";
  const APR = "2026-04-01T00:00:00Z";
  // Queried: clearing_house changed as a whole since December, but two of its
  // functions kept their code; math shares no whole module with anyone.
  const here = [
    version(1, "0x21d0", { ch: "ch-apr", math: "math-apr" }, APR, {
      "ch::fees": ["c1", "public"],
      "ch::info": ["c2", "public"],
      "ch::open": ["c3", "public"],
      "math::mul": ["c4", "public"],
    }),
  ];
  const early = [version(1, "0x2892", { ch: "ch-dec", math: "math-dec" }, DEC, { "ch::fees": ["c1", "private"], "ch::info": ["c2", "public"] })];
  const late = [
    version(1, "0x9a17", { ch: "ch-apr", math: "math-feb" }, FEB, {
      "ch::fees": ["c1", "public"],
      "ch::info": ["c2", "public"],
      "ch::open": ["c3", "public"],
      "math::mul": ["c4", "public"],
    }),
  ];
  const related = (root: string, there: VersionModules[]): RelatedLineage => ({
    root_package_id: root,
    latest_package_id: root,
    version_count: there.length,
    published_at: there[0].published_at,
    cap_held_by: "0x4b02",
    shared_module_names: 2,
    identical_modules: identicalModules(here, there),
  });

  it("names functions whose code predates their module's origin and counts those the module origin already dates", () => {
    const modules = moduleOrigins("0x21d0", [related("0x2892", early), related("0x9a17", late)]);
    expect(modules).toEqual([expect.objectContaining({ module: "ch", root_package_id: "0x9a17", published_at: FEB })]);
    const { origins, functions, implied } = functionOrigins(
      "0x21d0",
      [
        { root: "0x2892", functions: identicalFunctions(here, early) },
        { root: "0x9a17", functions: identicalFunctions(here, late) },
      ],
      modules,
    );
    // A module no compared lineage carries whole ranks first, then the longest lead.
    expect(origins.map((o) => [o.module, o.functions, o.root_package_id, o.module_origin?.root_package_id ?? null])).toEqual([
      ["math", ["mul"], "0x9a17", null],
      ["ch", ["fees", "info"], "0x2892", "0x9a17"],
    ]);
    expect(functions).toBe(3);
    expect(implied).toBe(1);
    expect(origins[1]).toMatchObject({ lineages_with_it: 2, declared_changes: [{ function: "fees", at_origin: "private", here: "public" }] });
    expect(origins[0]).not.toHaveProperty("declared_changes");
  });

  it("dates a function by this lineage's own earlier version when it carried the code first", () => {
    const own = [
      version(1, "0x21d0", { ch: "ch-v1" }, DEC, { "ch::fees": ["c1", "public"] }),
      version(2, "0x9e20", { ch: "ch-v2" }, APR, { "ch::fees": ["c1", "public"] }),
    ];
    const copy = [version(1, "0x9a17", { ch: "ch-v2" }, FEB, { "ch::fees": ["c1", "public"] })];
    const rel: RelatedLineage = { ...related("0x9a17", copy), identical_modules: identicalModules(own, copy) };
    const modules = moduleOrigins("0x21d0", [rel]);
    const { origins } = functionOrigins("0x21d0", [{ root: "0x9a17", functions: identicalFunctions(own, copy) }], modules);
    expect(origins).toEqual([expect.objectContaining({ module: "ch", functions: ["fees"], queried_lineage: true, package_id: "0x21d0", published_at: DEC })]);
  });
});

describe("findRedeploys", () => {
  it("reads no module bytes when the searched addresses hold no other lineage", async () => {
    gqlQuery.mockImplementation(async (q: string) =>
      q.includes("UpgradeCap")
        ? { address: { objects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }
        : { p0: { asMovePackage: { modules: { nodes: [{ name: "py" }] } } } },
    );
    const r = await findRedeploys("0x2b71", [{ version: 1, package_id: "0x2b71", published_at: null }], ["0xf55c"]);
    expect(r.lineages_found).toBe(0);
    expect(r.package_reads).toBe(0);
    expect(gqlQuery.mock.calls.some(([q]) => String(q).includes("bytes"))).toBe(false);
  });
});
