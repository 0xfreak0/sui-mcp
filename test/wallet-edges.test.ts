import { describe, it, expect } from "vitest";
import {
  EdgeSet,
  clusterEdges,
  SIGNAL_WEIGHTS,
  PARTIAL_CO_SIGNER_WEIGHT,
  addCoSignerEdges,
  DEFAULT_CO_SIGNER_LIMIT,
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

  it("addStar links members to seeds but never member to member", () => {
    // A narrow sponsor with 50 members expands to 1,225 pairs under addGroup,
    // none of which can merge on their own weight — pure noise burying the
    // edges an analyst came for.
    const s = new EdgeSet();
    s.addStar("sponsor", "0xsp", [A], [B, C, D], "shared sponsor");
    const pairs = s.edges().map((e) => `${e.wallet_a}|${e.wallet_b}`);
    expect(pairs).toHaveLength(3);
    expect(pairs.every((p) => p.includes(A))).toBe(true);
  });

  it("addStar still yields one component, so the saving costs no recall", () => {
    const s = new EdgeSet();
    s.addStar("cofunded", "0xf", [A], [B, C, D], "shared funder");
    const { clusters } = clusterEdges(s.edges());
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(4);
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

describe("independent intermediaries", () => {
  it("counts one when every edge runs through the same address", () => {
    // Sixteen edges through one shared funder is ONE fact stated sixteen
    // times. The edge count reads as corroboration and is not.
    const s = new EdgeSet();
    s.addStar("cofunded", "0xf", [A], [B, C, D], "shared funder");
    const { clusters } = clusterEdges(s.edges());
    expect(clusters[0].independent_intermediaries).toBe(1);
  });

  it("refuses high confidence on a single point of failure", () => {
    // However strong the edges look, one popularity misjudgement collapses the
    // whole cluster at once.
    const s = new EdgeSet();
    s.add("cofunded", A, B, "shared funder", [], "0xf");
    s.add("sponsor", A, B, "shared sponsor", [], "0xf");
    const { clusters } = clusterEdges(s.edges());
    expect(clusters[0].min_edge_weight).toBeGreaterThanOrEqual(1.5);
    expect(clusters[0].independent_intermediaries).toBe(1);
    expect(clusters[0].confidence).toBe("medium");
  });

  it("allows high confidence once two independent intermediaries agree", () => {
    const s = new EdgeSet();
    s.add("cofunded", A, B, "shared funder", [], "0xfunder");
    s.add("sponsor", A, B, "shared sponsor", [], "0xsponsor");
    const { clusters } = clusterEdges(s.edges());
    expect(clusters[0].independent_intermediaries).toBe(2);
    expect(clusters[0].confidence).toBe("high");
  });

  it("counts a signal with no intermediary as its own basis", () => {
    // A direct funding edge stands on its own rather than resting on a third
    // party, so it must not be lumped in with shared-intermediary signals.
    const s = new EdgeSet();
    s.add("funding_edge", A, B, "A first-funded B");
    s.add("sponsor", A, B, "shared sponsor", [], "0xsp");
    const { clusters } = clusterEdges(s.edges());
    expect(clusters[0].independent_intermediaries).toBe(2);
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

describe("addCoSignerEdges", () => {
  const safe = "0xsafe";
  const [m0, m1, m2] = ["0xm0", "0xm1", "0xm2"];

  const committee = (threshold: number, weights: number[]) => ({
    multisig: safe,
    threshold,
    members: weights.map((weight, i) => ({ address: `0xm${i}`, weight })),
  });

  it("links a unilateral member to the wallet it can spend", () => {
    const s = new EdgeSet();
    addCoSignerEdges(s, [committee(1, [1, 1])]);
    const e = s.edges();
    expect(e).toHaveLength(2);
    expect(e[0].weight).toBe(SIGNAL_WEIGHTS.co_signer);
    expect(e[0].signal_types).toEqual(["co_signer"]);
  });

  /**
   * The trap this signal exists to avoid. A 4-of-7 treasury has seven signers
   * BECAUSE they are meant to be separate parties; linking them to each other
   * would report a DAO's governance as one operator's wallet crew.
   */
  it("never links two members to each other", () => {
    const s = new EdgeSet();
    addCoSignerEdges(s, [committee(4, [1, 1, 1, 1, 1, 1, 1])]);
    for (const e of s.edges()) {
      expect([e.wallet_a, e.wallet_b]).toContain(safe);
    }
  });

  it("emits a star, one edge per member", () => {
    const s = new EdgeSet();
    addCoSignerEdges(s, [committee(4, [1, 1, 1, 1, 1, 1, 1])]);
    expect(s.edges()).toHaveLength(7);
  });

  it("weights a member who cannot spend alone below the merge floor", () => {
    const s = new EdgeSet();
    addCoSignerEdges(s, [committee(2, [1, 1, 1])]);
    const e = s.edges();
    expect(e[0].weight).toBe(PARTIAL_CO_SIGNER_WEIGHT);
    // Below 1.0, so it cannot merge a cluster on its own.
    expect(clusterEdges(e, {}).clusters).toHaveLength(0);
  });

  it("treats weight against threshold, not member count", () => {
    // One member holds 3 of a threshold of 3: unilateral despite 3 members.
    const s = new EdgeSet();
    addCoSignerEdges(s, [committee(3, [3, 1, 1])]);
    const byMember = new Map(s.edges().map((e) => [e.wallet_a === safe ? e.wallet_b : e.wallet_a, e]));
    expect(byMember.get(m0)!.weight).toBe(SIGNAL_WEIGHTS.co_signer);
    expect(byMember.get(m1)!.weight).toBe(PARTIAL_CO_SIGNER_WEIGHT);
    expect(byMember.get(m2)!.weight).toBe(PARTIAL_CO_SIGNER_WEIGHT);
  });

  it("says in the detail whether the member can spend alone", () => {
    const s = new EdgeSet();
    addCoSignerEdges(s, [committee(1, [1, 1])]);
    expect(s.edges()[0].signals[0].detail).toContain("alone");
    const t = new EdgeSet();
    addCoSignerEdges(t, [committee(2, [1, 1])]);
    expect(t.edges()[0].signals[0].detail).toContain("cannot");
  });

  it("merges a unilateral member into a cluster with the wallet", () => {
    const s = new EdgeSet();
    addCoSignerEdges(s, [committee(1, [1, 1])]);
    const { clusters } = clusterEdges(s.edges(), {});
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toEqual([safe, m0, m1].sort());
  });

  it("ignores a committee with no members", () => {
    const s = new EdgeSet();
    addCoSignerEdges(s, [{ multisig: safe, threshold: 1, members: [] }]);
    expect(s.edges()).toHaveLength(0);
  });

  it("skips a member whose address is the multisig itself", () => {
    const s = new EdgeSet();
    addCoSignerEdges(s, [
      { multisig: safe, threshold: 1, members: [{ address: safe, weight: 1 }] },
    ]);
    expect(s.edges()).toHaveLength(0);
  });
});

describe("clusterEdges — evidence tier", () => {
  it("rates a cluster built only on unilateral co-signature chain-derived", () => {
    const s = new EdgeSet();
    addCoSignerEdges(s, [
      { multisig: "0xsafe", threshold: 1, members: [{ address: "0xm0", weight: 1 }] },
    ]);
    expect(clusterEdges(s.edges(), {}).clusters[0].evidence_tier).toBe("chain-derived");
  });

  it("rates a cluster built on behavioural signals heuristic", () => {
    const s = new EdgeSet();
    s.add("cofunded", "0xa", "0xb", "same funder", ["0xd1"], "0xf");
    expect(clusterEdges(s.edges(), {}).clusters[0].evidence_tier).toBe("heuristic");
  });

  /**
   * Weakest link, the same rule `min_edge_weight` already follows: a component
   * that needed a behavioural edge to hold together is only as defensible as
   * that edge, whatever else it contains.
   */
  it("drops a mixed cluster to heuristic", () => {
    const s = new EdgeSet();
    addCoSignerEdges(s, [
      { multisig: "0xsafe", threshold: 1, members: [{ address: "0xm0", weight: 1 }] },
    ]);
    s.add("cofunded", "0xm0", "0xc", "same funder", ["0xd1"], "0xf");
    const c = clusterEdges(s.edges(), {}).clusters[0];
    expect(c.members).toContain("0xc");
    expect(c.evidence_tier).toBe("heuristic");
  });
});

describe("addCoSignerEdges — service keys", () => {
  /**
   * Found by running the real tool against a mainnet seed: one key sat on 31
   * distinct 1-of-2 committees, each with a different second member, and the
   * star fused 31 strangers into one 63-member cluster rated chain-derived and
   * high. The key really can spend all 31 wallets — that part is true — but
   * "shares an operator with" is a claim about the OTHER members, and a
   * wallet provider's recovery key says nothing about them.
   *
   * Same guard the funder signals already apply, and for the same reason: an
   * intermediary has to be measured before shared ancestry through it means
   * anything.
   */
  const serviceCommittees = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      multisig: `0xsafe${i}`,
      threshold: 1,
      members: [
        { address: "0xservice", weight: 1 },
        { address: `0xuser${i}`, weight: 1 },
      ],
    }));

  it("excludes a key that co-signs more wallets than the limit", () => {
    const s = new EdgeSet();
    const { excluded } = addCoSignerEdges(s, serviceCommittees(31), { memberLimit: 5 });
    expect(excluded.map((e) => e.address)).toEqual(["0xservice"]);
    expect(excluded[0].committees).toBe(31);
    // Every user's own key still links to their own wallet.
    for (const e of s.edges()) expect([e.wallet_a, e.wallet_b]).not.toContain("0xservice");
    expect(s.edges()).toHaveLength(31);
  });

  it("does not fuse strangers once the service key is excluded", () => {
    const s = new EdgeSet();
    addCoSignerEdges(s, serviceCommittees(31), { memberLimit: 5 });
    const { clusters } = clusterEdges(s.edges(), {});
    // 31 separate two-member clusters, not one cluster of 62.
    expect(clusters).toHaveLength(31);
    expect(new Set(clusters.map((c) => c.size))).toEqual(new Set([2]));
  });

  it("keeps a key that co-signs only a few wallets", () => {
    const s = new EdgeSet();
    const { excluded } = addCoSignerEdges(s, serviceCommittees(3), { memberLimit: 5 });
    expect(excluded).toHaveLength(0);
    expect(s.edges()).toHaveLength(6);
  });

  /**
   * The count is over the committees actually examined, so it is a lower
   * bound: a key seen on six is on at least six. That only ever makes the
   * filter fire late, never early, which is the safe direction — the cost of a
   * missed exclusion is a fused cluster, and the cost of a false one is a lost
   * true edge.
   */
  it("counts a member once per multisig, not once per appearance", () => {
    const s = new EdgeSet();
    const dup = [
      { multisig: "0xsafe0", threshold: 1, members: [{ address: "0xk", weight: 1 }] },
      { multisig: "0xsafe0", threshold: 1, members: [{ address: "0xk", weight: 1 }] },
    ];
    expect(addCoSignerEdges(s, dup, { memberLimit: 1 }).excluded).toHaveLength(0);
  });

  it("never excludes on the multisig side of the star", () => {
    // A 10-member committee is not a hub; the cap is about keys, not wallets.
    const s = new EdgeSet();
    const big = {
      multisig: "0xsafe",
      threshold: 1,
      members: Array.from({ length: 10 }, (_, i) => ({ address: `0xm${i}`, weight: 1 })),
    };
    const { excluded } = addCoSignerEdges(s, [big], { memberLimit: 5 });
    expect(excluded).toHaveLength(0);
    expect(s.edges()).toHaveLength(10);
  });
});
