import { describe, it, expect, vi } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));

const { registerHolderTools } = await import("../src/tools/holders.js");

type Result = { isError?: boolean; content: { text: string }[] };
let handler: (a: Record<string, unknown>) => Promise<Result>;
registerHolderTools({
  tool: (n: string, _d: string, _s: unknown, h: typeof handler) => {
    if (n === "get_top_holders") handler = h;
  },
} as never);

describe("get_top_holders with both a type and a collection name", () => {
  // Both given scanned `type` and dropped the collection without a word.
  it("refuses the pair before scanning anything", async () => {
    const result = await handler({ type: "0x2::sui::SUI", collection_name: "gawblenz" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/not both/);
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });
});
