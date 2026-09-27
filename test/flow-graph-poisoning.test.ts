import { describe, it, expect, vi, beforeEach } from "vitest";
import { candidates, gqlTx, type HopSpec } from "./helpers/trace-shapes.js";

/**
 * Tool-level cover for trace_flow_graph's address-poisoning warning in every
 * output format. The mermaid, csv and graph_json formats never include the
 * `json` object, so the warning has to sit in the prose every format carries
 * and, for graph_json, as a top-level field.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/archive-fallback.js", () => ({ withArchiveFallback: async () => null }));
vi.mock("../src/utils/identity.js", () => ({ describeAddresses: async () => new Map(), identityNote: () => null }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false, labelProvenance: () => null }));
vi.mock("../src/utils/price-providers.js", () => ({
  pricesForRanking: async () => new Map(),
  pythApiKey: () => null,
  fetchDefiLlama: async () => ({ quotes: new Map(), unanswered: new Set(), unsupported: new Set() }),
}));
const mockFanout = vi.fn();
vi.mock("../src/utils/fanout.js", () => ({ measureFanout: mockFanout }));
vi.mock("../src/utils/store.js", () => ({ getCachedTransaction: () => null, saveTransaction: () => {} }));

const { registerFlowGraphTools } = await import("../src/tools/flow-graph.js");

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
let traceFlowGraph!: Handler;
registerFlowGraphTools({
  tool: (n: string, _d: string, _s: unknown, h: Handler) => {
    if (n === "trace_flow_graph") traceFlowGraph = h;
  },
} as never);

// A pair sharing 4 leading and 3 trailing characters.
const VICTIM = `0x5e${"1".repeat(62)}`;
const REAL = "0x6b74e92cfc7890b7a4a48c933bb8da38bb2897f3962f33af20f5f7101d2d93cf";
const LOOKALIKE = "0x6b745225460cf4aeebe5edb4e381474a58abf206aa34dd838eb6570edd67b3cf";

/** The victim pays the real address, then a sliver to the lookalike. */
const payReal: HopSpec = { digest: "0xreal", sender: VICTIM, checkpoint: 1000, changes: [[VICTIM, "-209800000000"], [REAL, "209800000000"]] };
const payLookalike: HopSpec = { digest: "0xloss", sender: VICTIM, checkpoint: 1001, changes: [[VICTIM, "-1188330952"], [LOOKALIKE, "1188330952"]] };

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockFanout.mockReset();
  mockFanout.mockResolvedValue({ classification: "narrow", counterparty_count: 2, scanned_transactions: 5, truncated: false });
  const all = new Map([payReal, payLookalike].map((h) => [h.digest, h]));
  mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
    const q = String(query);
    if (q.includes("transactions(")) {
      const list = q.includes("sentAddress") && vars.address === VICTIM ? [payReal, payLookalike] : [];
      return candidates(list, q.includes("last:") ? "backward" : "forward");
    }
    const h = all.get(String(vars.digest));
    return h ? gqlTx(h) : { transaction: null };
  });
});

describe("trace_flow_graph puts the lookalike warning where each format is read", () => {
  it("states the pair in the prose that accompanies a mermaid diagram", async () => {
    const r = await traceFlowGraph({ address: VICTIM, format: "mermaid" });
    const summary = r.content[0]!.text;
    expect(summary).toMatch(/close enough to be mistaken for one another/i);
    expect(summary).toContain("0x6b745225…dd67b3cf");
    expect(summary).toContain("0x6b74e92c…1d2d93cf");
  });

  it("states it in the csv prose too, and as a top-level field of graph_json", async () => {
    const csv = await traceFlowGraph({ address: VICTIM, format: "csv" });
    expect(csv.content[0]!.text).toMatch(/close enough to be mistaken/i);
    const graph = JSON.parse((await traceFlowGraph({ address: VICTIM, format: "graph_json" })).content[0]!.text);
    const suspects = graph.address_poisoning.pairs.map((p: { suspect: string; established: string }) => [p.established, p.suspect].sort());
    expect(suspects).toEqual([[REAL, LOOKALIKE].sort()]);
  });
});

describe("trace_flow_graph reports the lookalike check when nothing collides", () => {
  it("emits address_poisoning with the addresses compared and no pairs", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) {
        const list = q.includes("sentAddress") && vars.address === VICTIM ? [payReal] : [];
        return candidates(list, q.includes("last:") ? "backward" : "forward");
      }
      return String(vars.digest) === payReal.digest ? gqlTx(payReal) : { transaction: null };
    });
    const r = await traceFlowGraph({ address: VICTIM });
    const json = JSON.parse(r.content[1]!.text);
    expect(json.address_poisoning.pairs).toEqual([]);
    expect(json.address_poisoning.addresses_compared).toBeGreaterThan(0);
    expect(r.content[0]!.text).not.toMatch(/close enough to be mistaken/i);
  });
});

describe("trace_flow_graph's graph_json carries what a terminal node says", () => {
  it("keeps a consumed node's cross-chain lead", async () => {
    const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
    const POOL = `0x${"9a".repeat(32)}`;
    const EVM = Buffer.from("1f9840a85d5af5bf1d1762f925bdaddc4201f984", "hex").toString("base64");
    const EVENT = "0x7a1e0000000000000000000000000000000000000000000000000000000000aa::gateway::Sent";
    // The victim's USDC goes into an object, and the transaction emits a cross-chain message.
    const dump: HopSpec = {
      digest: "0xdump",
      sender: VICTIM,
      checkpoint: 1000,
      changes: [[VICTIM, "-30000000000", USDC]],
      events: [EVENT],
      objects: [{ id: POOL, type: "0xabc::pool::Pool", shared: true }],
    };
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      const q = String(query);
      if (q.includes("transactions(")) return candidates(q.includes("sentAddress") && vars.address === VICTIM ? [dump] : [], q.includes("last:") ? "backward" : "forward");
      if (q.includes("json")) {
        return { transaction: { effects: { events: { pageInfo: { hasNextPage: false }, nodes: [{ contents: { type: { repr: EVENT }, json: { dst_chain_id: "2", recipient: EVM } } }] } } } };
      }
      return String(vars.digest) === dump.digest ? gqlTx(dump) : { transaction: null };
    });
    const graph = JSON.parse((await traceFlowGraph({ address: VICTIM, format: "graph_json", min_share: 0 })).content[0]!.text);
    const withLead = (graph.nodes as Array<{ kind: string; cross_chain_leads?: Array<{ chain_field: string }> }>).find((n) => n.cross_chain_leads);
    expect(withLead?.kind).toBe("consumed");
    expect(withLead?.cross_chain_leads?.map((l) => l.chain_field)).toEqual(["dst_chain_id"]);
  });
});
