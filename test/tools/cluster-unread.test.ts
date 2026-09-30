import { describe, expect, it, vi } from "vitest";
import { registerClusterTools } from "../../src/tools/cluster.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../../src/utils/price-providers.js", () => ({ pricesForRanking: async () => new Map() }));
vi.mock("../../src/utils/identity.js", () => ({
  describeAddresses: async (addresses: string[]) => new Map(addresses.map((address) => [address, { address, kind: "wallet" }])),
  identityNote: () => undefined,
}));

let handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
registerClusterTools({ tool: (name: string, _description: string, _schema: unknown, callback: typeof handler) => {
  if (name === "build_wallet_edges") handler = callback;
} } as never);
const A = "0x" + "a1".repeat(32);
const B = "0x" + "b2".repeat(32);
const SUI = "0x" + "2".padStart(64, "0") + "::sui::SUI";

describe("wallet-edge exports with unread evidence", () => {
  it.each(["graph_json", "mermaid", "csv"])("reports a failed balance continuation in %s", async (format) => {
    gqlQuery.mockImplementation(async (_query: string, variables: Record<string, unknown>) => {
      if (variables.digest) return { transactionEffects: null };
      if (variables.first) return { transactions: { nodes: [] } };
      return { transactions: {
        nodes: [{
          digest: "synthetic-paged-evidence", sender: { address: A }, gasInput: { gasSponsor: { address: A } },
          effects: { balanceChanges: {
            nodes: Array.from({ length: 50 }, (_, i) => ({ owner: { address: "0x" + (i + 100).toString(16).padStart(64, "0") }, amount: "1", coinType: { repr: SUI } })),
            pageInfo: { hasNextPage: true, endCursor: "page-1" },
          } },
        }],
        pageInfo: { hasPreviousPage: false, startCursor: null },
      } };
    });
    const response = await handler({ addresses: [A, B], expand: false, format });
    const metadata = response.content.map((item) => item.text).filter((text) => text.trim().startsWith("{")).map((text) => JSON.parse(text));
    expect(metadata).toContainEqual(expect.objectContaining({
      truncated: true,
      notes: expect.arrayContaining([expect.stringContaining("synthetic-paged-evidence")]),
    }));
    if (format === "graph_json") expect(metadata[0].edges).toEqual([]);
    else expect(response.content[1].text).not.toContain("synthetic-paged-evidence");
  });
});
