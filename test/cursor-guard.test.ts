import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));

const { fetchModuleNames } = await import("../src/utils/move-package.js");

beforeEach(() => mockGqlQuery.mockReset());

/**
 * A connection that claims another page and hands back no cursor sends the
 * `after` variable to null, which asks for page one again. `event-json.ts`
 * guards this and has done since it was written; every other paginated walk in
 * the repo did not.
 *
 * The severity split by loop shape: walks bounded by a page counter or a
 * collection target terminated but re-read page one and returned duplicates,
 * while `fetchModuleNames` pages with `for(;;)` and would never return at all.
 */
describe("a page claimed with no cursor does not restart the walk", () => {
  it("stops instead of hanging forever", async () => {
    mockGqlQuery.mockResolvedValue({
      package: {
        modules: {
          nodes: [{ name: "a" }, { name: "b" }],
          // The shape that used to loop: another page, no cursor to reach it.
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      },
    });

    // Would never resolve before the guard; the assertion is that it resolves.
    const names = await fetchModuleNames("0xpkg");
    expect(names).toEqual(["a", "b"]);
    // One request, not an unbounded stream of identical ones.
    expect(mockGqlQuery).toHaveBeenCalledTimes(1);
  });

  it("still pages normally when a cursor is handed back", async () => {
    mockGqlQuery
      .mockResolvedValueOnce({
        package: { modules: { nodes: [{ name: "a" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } },
      })
      .mockResolvedValueOnce({
        package: { modules: { nodes: [{ name: "b" }], pageInfo: { hasNextPage: false, endCursor: null } } },
      });

    expect(await fetchModuleNames("0xpkg")).toEqual(["a", "b"]);
    expect(mockGqlQuery).toHaveBeenCalledTimes(2);
  });

  it("returns a single complete page without asking for another", async () => {
    mockGqlQuery.mockResolvedValue({
      package: { modules: { nodes: [{ name: "only" }], pageInfo: { hasNextPage: false, endCursor: null } } },
    });
    expect(await fetchModuleNames("0xpkg")).toEqual(["only"]);
    expect(mockGqlQuery).toHaveBeenCalledTimes(1);
  });
});
