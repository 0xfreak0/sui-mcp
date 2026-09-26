import { describe, it, expect, vi } from "vitest";

/**
 * build_wallet_edges on two wallets it cannot link returns empty edges and
 * clusters. Every cluster of none passes the chain-derived test, but the null
 * result of a behavioural search is heuristic.
 */

const A = "0x86427087eece4817cce92c6e9ea0bba2755208169457ba68b1bf70ba6dd315d5";
const B = "0x9ed8295abb9a7cc4804e85c97aef099b257cd686d4987dbb246a9d705f2483c9";

vi.mock("../../src/utils/edge-probe.js", () => ({
  buildWalletEdges: async (seeds: string[]) => ({
    edges: [],
    examined: seeds,
    excluded_intermediaries: [],
    used_intermediaries: [],
    first_funders: {},
    queries_used: 12,
    truncated: false,
    notes: [],
  }),
}));
vi.mock("../../src/utils/identity.js", () => ({
  describeAddresses: async (addresses: string[]) => new Map(addresses.map((a) => [a, { address: a, kind: "wallet" }])),
  identityNote: () => undefined,
}));
vi.mock("../../src/utils/labels.js", () => ({ getLabel: () => null }));

const { registerClusterTools } = await import("../../src/tools/cluster.js");

let handler: (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
registerClusterTools({
  tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
    if (name === "build_wallet_edges") handler = h;
  },
} as never);

describe("build_wallet_edges evidence tier", () => {
  it("does not call an empty result chain-derived", async () => {
    const r = JSON.parse((await handler({ addresses: [A, B], expand: false })).content[0].text);
    expect(r.edge_count).toBe(0);
    expect(r.clusters).toEqual([]);
    expect(r.evidence_tier).toBe("heuristic");
  });
});
