import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * build_wallet_edges with allowance links: an edge between a seed and the
 * spender it funds, a service spender listed rather than linked, and an
 * unfinished spender scan reported as truncated.
 */

const FUNDER = `0x${"f1".repeat(32)}`;
const SPENDER = `0x${"5e".repeat(32)}`;
const SERVICE = `0x${"5a".repeat(32)}`;
const OTHER = `0x${"0e".repeat(32)}`;
const SUI = `0x${"0".repeat(63)}2::sui::SUI`;

const { mockLinks } = vi.hoisted(() => ({ mockLinks: vi.fn() }));
vi.mock("../../src/utils/edge-probe.js", () => ({
  buildWalletEdges: async (seeds: string[]) => ({
    edges: [],
    examined: seeds,
    excluded_intermediaries: [],
    used_intermediaries: [],
    first_funders: {},
    queries_used: 3,
    truncated: false,
    notes: [],
  }),
  readAllowanceLinks: mockLinks,
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

const link = (allowance_id: string, funder: string, spender: string) => ({
  allowance_id,
  cap_id: `0x${"c1".repeat(32)}`,
  funder,
  spender,
  app: null,
  coin_type: SUI,
  status: "active",
});

beforeEach(() => mockLinks.mockReset());

describe("build_wallet_edges allowance links", () => {
  it("links a seed to the spender it funds and lists a service spender instead of linking it", async () => {
    mockLinks.mockResolvedValue({
      links: [link(`0x${"a1".repeat(32)}`, FUNDER, SPENDER), link(`0x${"a2".repeat(32)}`, FUNDER, SERVICE)],
      reach: new Map([
        [SPENDER, { funders: 1, complete: true }],
        [SERVICE, { funders: 14, complete: true }],
      ]),
      funder_reads_incomplete: [],
      spender_scan: { status: "complete", scanned: 125, as_of: "2026-11-25T00:00:00.000Z" },
    });
    const r = JSON.parse((await handler({ addresses: [FUNDER, OTHER], expand: false })).content[0].text);
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0].signal_types).toEqual(["allowance"]);
    expect(r.edges[0].signals[0].object_ids).toContain(`0x${"a1".repeat(32)}`);
    expect(r.allowance_links.excluded_spenders).toEqual([{ address: SERVICE, funders: 14, reach_complete: true, reason: "service" }]);
    expect(r.clusters[0].evidence_tier).toBe("heuristic");
    expect(r.truncated).toBe(false);
  });

  it("marks the build truncated when the spender scan did not finish", async () => {
    mockLinks.mockResolvedValue({
      links: [],
      reach: new Map(),
      funder_reads_incomplete: [],
      spender_scan: { status: "truncated", scanned: 5000, as_of: "2026-11-25T00:00:00.000Z" },
    });
    const r = JSON.parse((await handler({ addresses: [FUNDER, OTHER], expand: false })).content[0].text);
    expect(r.edge_count).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.allowance_links.spender_scan.status).toBe("truncated");
  });
});
