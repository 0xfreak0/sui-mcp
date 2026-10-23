import { describe, expect, it, vi } from "vitest";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

const { digestsSentBy } = await import("../src/utils/attack-read.js");

describe("incident sender transaction pages", () => {
  it("continues from the last complete page without repeating or losing a digest", async () => {
    gqlQuery.mockReset().mockImplementation(async (_query: string, vars: { first: number; after?: string }) => {
      const all = ["first", "second", "third", "fourth", "fifth"];
      const offset = vars.after ? Number(vars.after) : 0;
      const nodes = all.slice(offset, offset + vars.first).map((digest) => ({ digest }));
      const end = offset + nodes.length;
      return { transactions: { nodes, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } };
    });

    const first = await digestsSentBy("0x1", { afterCheckpoint: 1 }, 2);
    expect(first).toEqual({ digests: ["first", "second"], truncated: true, nextCursor: "2" });
    const second = await digestsSentBy("0x1", { afterCheckpoint: 1 }, 2, first.nextCursor);
    expect(second).toEqual({ digests: ["third", "fourth"], truncated: true, nextCursor: "4" });
    const third = await digestsSentBy("0x1", { afterCheckpoint: 1 }, 2, second.nextCursor);
    expect(third).toEqual({ digests: ["fifth"], truncated: false });
    expect(gqlQuery.mock.calls.map(([, vars]) => [vars.first, vars.after])).toEqual([[2, undefined], [2, "2"], [2, "4"]]);
  });

  it("marks an unusable cursor incomplete without offering a repeating continuation", async () => {
    gqlQuery.mockReset().mockResolvedValue({ transactions: { nodes: [{ digest: "first" }], pageInfo: { hasNextPage: true, endCursor: null } } });
    expect(await digestsSentBy("0x1", {}, 1)).toEqual({ digests: ["first"], truncated: true });
  });
});
