import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockGraphql } from "../helpers/mock-grpc.js";

const mockGqlQuery = createMockGraphql();
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerPackageLineageTools } = await import("../../src/tools/package-lineage.js");

const tools = new Map<string, Function>();
registerPackageLineageTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as never);

const WALLET = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";

/** GraphQL as mainnet answers it for an address that holds no package. */
function answerForNonPackage(query: string) {
  if (query.includes("checkpoints(last: 1)")) {
    return Promise.resolve({ checkpoints: { nodes: [{ sequenceNumber: 190_000_000, timestamp: "2025-09-07T16:00:00Z" }] } });
  }
  if (query.includes("packageVersions")) return Promise.resolve({ packageVersions: { nodes: [] } });
  throw new Error(`unexpected query: ${query}`);
}

describe("resolve_protocol_packages on an ID that is not a package", () => {
  beforeEach(() => vi.clearAllMocks());

  // A wallet address walked to zero versions and came back as a lineage with
  // nothing emitting, which reads as a protocol gone quiet.
  it("is an error, not an empty lineage", async () => {
    mockGqlQuery.mockImplementation(answerForNonPackage);
    const result = await tools.get("resolve_protocol_packages")!({ package_id: WALLET });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe(
      `${WALLET} is not a package on this network: no package versions were found for it.`,
    );
  });

  // Unknown is not "not a package": a failed read reports the failure.
  it("reports a failed lineage read as that failure", async () => {
    mockGqlQuery.mockImplementation((query: string) =>
      query.includes("packageVersions") ? Promise.reject(new Error("GraphQL 503")) : answerForNonPackage(query),
    );
    const result = await tools.get("resolve_protocol_packages")!({ package_id: WALLET });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("GraphQL 503");
  });
});
