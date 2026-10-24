import { describe, expect, it, vi } from "vitest";
const { mockBuildWalletEdges } = vi.hoisted(() => ({ mockBuildWalletEdges: vi.fn() }));
vi.mock("../src/utils/edge-probe.js", () => ({ buildWalletEdges: mockBuildWalletEdges }));
vi.mock("../src/utils/identity.js", () => ({ describeAddresses: async () => new Map(), identityNote: () => undefined }));
import { pageEdgeEvidence, registerClusterTools } from "../src/tools/cluster.js";
import { EdgeSet } from "../src/utils/wallet-edges.js";

describe("cluster edge evidence pages", () => {
  it("keeps the full evidence for scoring and exposes each digest in a finite continuation", () => {
    const set = new EdgeSet();
    for (let i = 0; i < 12; i++) set.add("sponsor", "0xaa", "0xbb", "gas sponsor", [`digest-${i}`], "0xcc");
    const edge = set.edges()[0];
    const args = { addresses: ["0xaa", "0xbb"] };
    const first = pageEdgeEvidence(edge, 0, args).signals[0];
    expect(first.digests).toEqual(Array.from({ length: 5 }, (_, i) => `digest-${i}`));
    expect(first.digest_listing).toMatchObject({ total: 12, next_call: { tool: "build_wallet_edges", args: { ...args, format: "json", digest_offset: 5 } } });
    const second = pageEdgeEvidence(edge, 5, args).signals[0];
    const last = pageEdgeEvidence(edge, 10, args).signals[0];
    expect([...first.digests, ...second.digests, ...last.digests]).toEqual(edge.signals[0].digests);
    expect(last.digest_listing).toMatchObject({ total: 12, offset: 10 });
    expect(last.digest_listing).not.toHaveProperty("next_call");
  });
});

it("keeps expansion and reciprocal offsets when continuing an edge's digest list", async () => {
  const set = new EdgeSet();
  for (let i = 0; i < 7; i++) set.add("sponsor", "0xaa", "0xbb", "gas sponsor", [`digest-${i}`], "0xcc");
  mockBuildWalletEdges.mockResolvedValue({
    examined: ["0xaa", "0xbb"], edges: set.edges(), first_funders: [], queries_used: 2,
    truncated: true, notes: [], used_intermediaries: [], excluded_intermediaries: [],
    expansion_scan: { total: 10, offset: 5, checked: 2, next_offset: 7 },
    reciprocal_scan: { total: 9, offset: 3, checked: 2, next_offset: 5 },
  });
  const tools = new Map<string, Function>();
  registerClusterTools({ tool: (name: string, _description: string, _schema: unknown, handler: Function) => tools.set(name, handler) } as never);
  const args = {
    addresses: ["0xaa", "0xbb"], expand_offset: 5, reciprocal_offset: 3,
    digest_offset: 0, expand_budget: 2, reciprocal_budget: 2, format: "json",
  };
  const response = await tools.get("build_wallet_edges")!(args);
  const data = JSON.parse(response.content[0].text);
  expect(data.edges[0].signals[0].digest_listing.next_call.args).toMatchObject({
    ...args, digest_offset: 5,
  });
  expect(data.expansion_scan.next_call.args).toMatchObject({ ...args, expand_offset: 7 });
  expect(data.reciprocal_scan.next_call.args).toMatchObject({ ...args, reciprocal_offset: 5 });
});
