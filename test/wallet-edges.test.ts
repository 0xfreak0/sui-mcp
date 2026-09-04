import { describe, it, expect } from "vitest";
import {
  EdgeSet,
  clusterEdges,
  SIGNAL_WEIGHTS,
  type WalletEdge,
} from "../src/utils/wallet-edges.js";

const A = "0xaa";
const B = "0xbb";
const C = "0xcc";
const D = "0xdd";

describe("EdgeSet", () => {
  it("canonicalizes a pair, so both orderings are one edge", () => {
    const s = new EdgeSet();
    s.add("sponsor", B, A, "shared sponsor", ["0x1"], "0xsp");
    s.add("co_tx", A, B, "same transaction", ["0x2"]);
    const edges = s.edges();
    expect(edges).toHaveLength(1);
    expect(edges[0].wallet_a).toBe(A);
    expect(edges[0].wallet_b).toBe(B);
    expect(edges[0].signal_types.sort()).toEqual(["co_tx", "sponsor"]);
  });

  it("counts each signal TYPE once, however many times it fires", () => {
    // Two shared funders is two coincidences but one *kind* of evidence.
    // Compounding it would let one mechanism clear a bar meant to require
    // independent corroboration.
    const s = new EdgeSet();
    s.add("cofunded", A, B, "shared funder 1", ["0x1"], "0xf1");
    s.add("cofunded", A, B, "shared funder 2", ["0x2"], "0xf2");
    const [e] = s.edges();
    expect(e.weight).toBe(SIGNAL_WEIGHTS.cofunded);
    // Both are still reported — the reader sees two independent funders.
    expect(e.signals).toHaveLength(2);
  });

  it("merges digests for the same signal from the same intermediary", () => {
    const s = new EdgeSet();
    s.add("sponsor", A, B, "shared sponsor", ["0x1"], "0xsp");
    s.add("sponsor", A, B, "shared sponsor", ["0x2"], "0xsp");
    const [e] = s.edges();
    expect(e.signals).toHaveLength(1);
    expect(e.signals[0].digests).toEqual(["0x1", "0x2"]);
  });

  it("caps evidence digests rather than growing without bound", () => {
    const s = new EdgeSet();
    for (let i = 0; i < 40; i++) s.add("sponsor", A, B, "shared sponsor", [`0x${i}`], "0xsp");
    expect(s.edges()[0].signals[0].digests).toHaveLength(5);
  });

  it("ignores a self-pair", () => {
    const s = new EdgeSet();
    s.add("co_tx", A, A, "same transaction");
    expect(s.edges()).toHaveLength(0);
  });

  it("expands a shared intermediary to every pair among its members", () => {
    const s = new EdgeSet();
    s.addGroup("cofunded", "0xfunder", [A, B, C], "funded by the same narrow address");
    expect(s.edges()).toHaveLength(3); // AB, AC, BC
    expect(s.edges().every((e) => e.signals[0].via === "0xfunder")).toBe(true);
  });

  it("orders strongest first, so a truncated read keeps the best evidence", () => {
    const s = new EdgeSet();
    s.add("co_tx", C, D, "same transaction");
    s.add("cofunded", A, B, "shared funder", [], "0xf");
    s.add("sponsor", A, B, "shared sponsor", [], "0xsp");
    expect(s.edges()[0].wallet_a).toBe(A);
  });
});

/** Build an edge directly, for cluster tests that don't care how it was found. */
function edge(a: string, b: string, types: Array<keyof typeof SIGNAL_WEIGHTS>): WalletEdge {
  const s = new EdgeSet();
  for (const t of types) s.add(t, a, b, t, [], `via-${t}`);
  return s.edges()[0];
}

describe("clusterEdges", () => {
  it("admits a lone cofunded edge but not a lone sponsor edge", () => {
    // Both survived the popularity filter, so the difference is what the
    // signal means: a shared narrow funder is a setup act, a shared sponsor
    // could still be a small relayer.
    const { clusters, untrusted_edges } = clusterEdges([
      edge(A, B, ["cofunded"]),
      edge(C, D, ["sponsor"]),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toEqual([A, B]);
    expect(untrusted_edges).toHaveLength(1);
    expect(untrusted_edges[0].wallet_a).toBe(C);
  });

  it("reports rejected pairs rather than dropping them silently", () => {
    const { untrusted_edges } = clusterEdges([edge(A, B, ["co_tx"])]);
    expect(untrusted_edges).toHaveLength(1);
  });

  it("links a chain of pairs into one component", () => {
    const { clusters } = clusterEdges([
      edge(A, B, ["cofunded"]),
      edge(B, C, ["funding_edge"]),
      edge(C, D, ["cofunded"]),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toEqual([A, B, C, D]);
  });

  it("omits singletons — an address linked to nobody is not a cluster", () => {
    const { clusters } = clusterEdges([edge(A, B, ["co_tx"])]);
    expect(clusters).toHaveLength(0);
  });

  it("refuses a merge that would exceed the size cap, and says so", () => {
    // A runaway component is worse than no answer.
    const edges = [];
    for (let i = 1; i <= 10; i++) edges.push(edge("0x00", `0x${i}`, ["cofunded"]));
    const { clusters, size_capped } = clusterEdges(edges, { maxClusterSize: 4 });
    expect(size_capped).toBeGreaterThan(0);
    expect(Math.max(...clusters.map((c) => c.size))).toBeLessThanOrEqual(4);
  });

  it("carries the WEAKEST merge into cluster confidence", () => {
    // A cluster assembled through one corroborated edge and one bare edge is
    // only as defensible as the bare one.
    const { clusters } = clusterEdges([
      edge(A, B, ["cofunded", "sponsor"]),
      edge(B, C, ["cofunded"]),
    ]);
    expect(clusters[0].size).toBe(3);
    expect(clusters[0].min_edge_signal_types).toBe(1);
    expect(clusters[0].confidence).toBe("medium");
  });

  it("calls a fully corroborated cluster high confidence", () => {
    const { clusters } = clusterEdges([
      edge(A, B, ["cofunded", "sponsor"]),
      edge(B, C, ["funding_edge", "sponsor"]),
    ]);
    expect(clusters[0].confidence).toBe("high");
  });
});

describe("the strict batch tuning misses ordinary personal alts", () => {
  /**
   * The signal shape measured on a real set of four co-owned mainnet addresses:
   * two direct funding edges, and a third pair whose only link is a shared
   * sponsor. Each pair is corroborated by exactly one mechanism, which is what
   * ordinary personal alt-wallets look like.
   */
  const groundTruth = [
    edge("0xw1", "0xw2", ["funding_edge"]),
    edge("0xw2", "0xw3", ["sponsor", "co_tx"]),
    edge("0xw3", "0xw4", ["funding_edge"]),
  ];

  it("links all four under the investigator default", () => {
    const { clusters } = clusterEdges(groundTruth);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(4);
  });

  it("finds nothing under the >=2-signal batch rule", () => {
    // Not a bug in either setting. The batch rule exists to avoid painting
    // honest wallets as operator crews across a whole-chain population; this
    // tool has one subject and an analyst reading the evidence. Pinned so the
    // default is never "tightened" back to the batch value by eye.
    const { clusters } = clusterEdges(groundTruth, { minSignalTypes: 2, minWeight: 1.5 });
    expect(clusters).toHaveLength(0);
  });
});
