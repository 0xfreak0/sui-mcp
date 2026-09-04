/**
 * Wallet edges: shared-control signals between two addresses, and the
 * connected components they form.
 *
 * This is the on-the-fly counterpart to a batch clustering pipeline. A pipeline
 * precomputes edges over the whole chain and can afford to ask "how many
 * wallets did this funder ever fund"; here every number has to come from a
 * bounded live scan. The design that makes that work is in `edge-probe.ts` —
 * this file is the pure half: no network, no store, fully testable.
 *
 * ## Edges are facts, clusters are inferences
 *
 * "These two addresses were funded by the same address, in transactions X and
 * Y" is chain-derived and checkable. "Therefore one person controls both" is
 * not. The two are kept separate all the way into the response so nothing
 * promotes the second by borrowing the first's confidence — the same rule the
 * bridge resolvers follow with `chain-derived` vs `indexer-attested`.
 *
 * ## Absence of an edge is not evidence of separate control
 *
 * Every observation feeding this comes from a capped scan, and the signals only
 * see what a wallet shares publicly. A wallet funded out-of-band, sponsored by
 * nobody and never co-appearing in a transaction is invisible here no matter
 * how many alts it has. Callers must report that, which is why the tool emits
 * `truncated` and a standing caveat rather than leaving it to documentation.
 */

/**
 * Signal types, in the order they are worth trusting.
 *
 * Deliberately excluded: plain transfer volume between two addresses. Everyone
 * pays an exchange, so "A sent to B" is the single most common relationship on
 * chain and clusters the world together. `funding_edge` is the narrow, defended
 * case — A was the *first* inflow that made B exist, which is a setup act, not
 * a payment.
 */
export type SignalType = "cofunded" | "funding_edge" | "sponsor" | "co_tx";

/**
 * Per-signal confidence weight.
 *
 * `cofunded` and `funding_edge` sit at 1.0 because both survive the popularity
 * filter: the shared funder has already been measured as narrow, so the
 * coincidence is not explained by "it's an exchange". `sponsor` is a shade
 * below — paying someone's gas is a strong link but sponsorship services exist
 * and only the popularity probe separates them. `co_tx` is weak on its own:
 * appearing in one transaction's balance changes covers a swap counterparty as
 * readily as an alt.
 */
export const SIGNAL_WEIGHTS: Record<SignalType, number> = {
  cofunded: 1.0,
  funding_edge: 1.0,
  sponsor: 0.7,
  co_tx: 0.5,
};

/** One reason two addresses are linked, with the chain data to check it. */
export interface EdgeEvidence {
  type: SignalType;
  /** The shared intermediary, when the signal is a shared one. */
  via?: string;
  /** Transaction digests supporting this signal. Capped; see MAX_EVIDENCE. */
  digests: string[];
  /** Plain-language statement of the observed fact — never the inference. */
  detail: string;
}

export interface WalletEdge {
  /** Canonical ordering: `wallet_a` sorts before `wallet_b`, so a pair has one row. */
  wallet_a: string;
  wallet_b: string;
  signals: EdgeEvidence[];
  /** Distinct signal types on this pair. The corroboration count. */
  signal_types: SignalType[];
  /** Summed weight of the distinct signal types. */
  weight: number;
}

/**
 * Evidence digests kept per signal.
 *
 * A pair sharing a funder across 40 transactions does not become more true at
 * the 40th; five digests is enough for a reader to verify the claim and keeps
 * the response readable.
 */
const MAX_EVIDENCE = 5;

/**
 * Accumulates signals into canonical pairs.
 *
 * Group signals (a shared funder, a shared sponsor) expand to every pair among
 * the group's members, which is quadratic — bounded because the group is only
 * ever built from an intermediary that passed the popularity filter, so it has
 * at most `POPULARITY_LIMIT` members by construction.
 */
export class EdgeSet {
  private pairs = new Map<string, WalletEdge>();

  private static key(a: string, b: string): [string, string] {
    return a < b ? [a, b] : [b, a];
  }

  /** Record one signal between two distinct addresses. */
  add(
    type: SignalType,
    a: string,
    b: string,
    detail: string,
    digests: string[] = [],
    via?: string,
  ): void {
    if (a === b) return;
    const [wa, wb] = EdgeSet.key(a, b);
    const k = `${wa}|${wb}`;
    let edge = this.pairs.get(k);
    if (!edge) {
      edge = { wallet_a: wa, wallet_b: wb, signals: [], signal_types: [], weight: 0 };
      this.pairs.set(k, edge);
    }
    // One entry per (type, via): a pair sharing two different narrow funders is
    // two independent coincidences and deserves two evidence rows, but the same
    // funder seen twice is one fact observed twice.
    const existing = edge.signals.find((s) => s.type === type && s.via === via);
    if (existing) {
      for (const d of digests) {
        if (existing.digests.length < MAX_EVIDENCE && !existing.digests.includes(d)) {
          existing.digests.push(d);
        }
      }
      return;
    }
    edge.signals.push({ type, via, digests: digests.slice(0, MAX_EVIDENCE), detail });
    if (!edge.signal_types.includes(type)) {
      edge.signal_types.push(type);
      // Weight counts each distinct TYPE once. Two shared funders is stronger
      // evidence than one, but it is still one kind of evidence, and letting it
      // compound would let a single mechanism clear a threshold meant to
      // require independent corroboration.
      edge.weight = Number((edge.weight + SIGNAL_WEIGHTS[type]).toFixed(2));
    }
  }

  /**
   * Record a shared intermediary as an edge between every pair of its members.
   *
   * `members` must already have passed the popularity filter. Passing an
   * exchange's recipient list here is exactly the "cluster explosion" this
   * whole design exists to prevent.
   */
  addGroup(
    type: SignalType,
    via: string,
    members: string[],
    detail: string,
    digestFor: (member: string) => string[] = () => [],
  ): void {
    const unique = [...new Set(members)];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        this.add(
          type,
          unique[i],
          unique[j],
          detail,
          [...digestFor(unique[i]), ...digestFor(unique[j])],
          via,
        );
      }
    }
  }

  /**
   * Connect `members` to each `seed`, and the seeds to each other — but never
   * member to member.
   *
   * Union-find produces the *same components* as pairing everyone, because a
   * star through the seeds already connects every member transitively. What it
   * avoids is the output: a narrow sponsor with 50 members expands to 1,225
   * pairs under {@link addGroup}, none of which can merge on their own weight,
   * so the response fills with noise that buries the edges an analyst came for.
   * The investigation is about the seeds, so those are the hub.
   */
  addStar(
    type: SignalType,
    via: string,
    seeds: string[],
    members: string[],
    detail: string,
    digestFor: (member: string) => string[] = () => [],
  ): void {
    const uniqueSeeds = [...new Set(seeds)];
    const others = [...new Set(members)].filter((m) => !uniqueSeeds.includes(m));
    for (let i = 0; i < uniqueSeeds.length; i++) {
      for (let j = i + 1; j < uniqueSeeds.length; j++) {
        this.add(type, uniqueSeeds[i], uniqueSeeds[j], detail, [...digestFor(uniqueSeeds[i]), ...digestFor(uniqueSeeds[j])], via);
      }
      for (const m of others) {
        this.add(type, uniqueSeeds[i], m, detail, [...digestFor(uniqueSeeds[i]), ...digestFor(m)], via);
      }
    }
  }

  /** Strongest first, so a truncated read still shows the best evidence. */
  edges(): WalletEdge[] {
    return [...this.pairs.values()].sort(
      (x, y) => y.weight - x.weight || y.signal_types.length - x.signal_types.length,
    );
  }
}

export interface ClusterOptions {
  /**
   * Minimum summed weight for a pair to be eligible to merge.
   *
   * Default 1.0 admits a single `cofunded` or `funding_edge` — both of which
   * already cleared the popularity filter — while rejecting `sponsor` (0.7) or
   * `co_tx` (0.5) standing alone.
   */
  minWeight?: number;
  /**
   * Minimum distinct signal types on a pair.
   *
   * A batch pipeline over a whole-chain sybil population sets this to 2, where
   * the cost of a false merge is painting an honest wallet as an operator crew.
   * That tuning is wrong here and measurably so: against four addresses known
   * to share an owner, requiring two signal types merged none of them, because
   * ordinary personal alts share exactly one mechanism. This is an
   * investigator-facing tool with evidence attached to every edge, so the
   * default is 1 and the strict setting is available.
   */
  minSignalTypes?: number;
  /**
   * Refuse a merge that would exceed this size.
   *
   * A runaway component is worse than no answer: an investigator shown a
   * 4,000-member "same operator" cluster learns nothing and stops trusting the
   * tool. Real co-controlled sets are small.
   */
  maxClusterSize?: number;
}

export interface Cluster {
  members: string[];
  size: number;
  /** Signal types appearing on the edges that built this cluster. */
  signal_types: SignalType[];
  /** The weakest merge in the cluster — a chain is only as strong as this. */
  min_edge_weight: number;
  /** Distinct signal types on that weakest merge. */
  min_edge_signal_types: number;
  confidence: "high" | "medium" | "low";
}

export interface ClusterResult {
  clusters: Cluster[];
  /** Pairs that met the merge rule. */
  trusted_edges: WalletEdge[];
  /** Pairs observed but below the rule — reported, never silently dropped. */
  untrusted_edges: WalletEdge[];
  /** Merges refused because the component was already at max size. */
  size_capped: number;
}

/** Union-find with union-by-size, path compression and a hard size cap. */
class UnionFind {
  private parent: number[];
  private size: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.size = new Array(n).fill(1);
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    let cur = x;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  /** Returns false when the merge was refused for exceeding `maxSize`. */
  union(a: number, b: number, maxSize: number): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return true;
    if (this.size[ra] + this.size[rb] > maxSize) return false;
    const [big, small] = this.size[ra] >= this.size[rb] ? [ra, rb] : [rb, ra];
    this.parent[small] = big;
    this.size[big] = this.size[ra] + this.size[rb];
    return true;
  }
}

/**
 * Group edges into components under the merge rule.
 *
 * Singletons are omitted: an address linked to nobody is not a cluster, and
 * emitting one per seed buries the real answer.
 */
export function clusterEdges(edges: WalletEdge[], opts: ClusterOptions = {}): ClusterResult {
  const minWeight = opts.minWeight ?? 1.0;
  const minSignalTypes = opts.minSignalTypes ?? 1;
  const maxClusterSize = opts.maxClusterSize ?? 100;

  const trusted: WalletEdge[] = [];
  const untrusted: WalletEdge[] = [];
  for (const e of edges) {
    if (e.weight >= minWeight && e.signal_types.length >= minSignalTypes) trusted.push(e);
    else untrusted.push(e);
  }

  const idOf = new Map<string, number>();
  const addrOf: string[] = [];
  const intern = (a: string): number => {
    let id = idOf.get(a);
    if (id === undefined) {
      id = addrOf.length;
      idOf.set(a, id);
      addrOf.push(a);
    }
    return id;
  };
  for (const e of trusted) {
    intern(e.wallet_a);
    intern(e.wallet_b);
  }

  const uf = new UnionFind(addrOf.length);
  let sizeCapped = 0;
  for (const e of trusted) {
    if (!uf.union(idOf.get(e.wallet_a)!, idOf.get(e.wallet_b)!, maxClusterSize)) sizeCapped++;
  }

  // Roll each component up, carrying the weakest merge that built it — a
  // cluster assembled through one 1.0 edge and one 3.0 edge is only as
  // defensible as the 1.0.
  const groups = new Map<number, { members: Set<string>; types: Set<SignalType>; minW: number; minT: number }>();
  for (const a of addrOf) {
    const root = uf.find(idOf.get(a)!);
    if (!groups.has(root)) {
      groups.set(root, { members: new Set(), types: new Set(), minW: Infinity, minT: Infinity });
    }
    groups.get(root)!.members.add(a);
  }
  for (const e of trusted) {
    const root = uf.find(idOf.get(e.wallet_a)!);
    // Only fold an edge's strength in if it actually joined this component;
    // a size-capped merge left its endpoints apart.
    if (uf.find(idOf.get(e.wallet_b)!) !== root) continue;
    const g = groups.get(root)!;
    for (const t of e.signal_types) g.types.add(t);
    g.minW = Math.min(g.minW, e.weight);
    g.minT = Math.min(g.minT, e.signal_types.length);
  }

  const clusters: Cluster[] = [...groups.values()]
    .filter((g) => g.members.size > 1)
    .map((g) => ({
      members: [...g.members].sort(),
      size: g.members.size,
      signal_types: [...g.types],
      min_edge_weight: g.minW === Infinity ? 0 : g.minW,
      min_edge_signal_types: g.minT === Infinity ? 0 : g.minT,
      confidence: confidenceFor(g.minT, g.minW),
    }))
    .sort((a, b) => b.size - a.size);

  return { clusters, trusted_edges: trusted, untrusted_edges: untrusted, size_capped: sizeCapped };
}

/**
 * Confidence in the *inference*, from the weakest link that built the cluster.
 *
 * Independent corroboration is the only thing that separates high from medium:
 * two mechanisms agreeing is much harder to produce by coincidence than one
 * strong mechanism, however strong.
 */
function confidenceFor(minSignalTypes: number, minWeight: number): Cluster["confidence"] {
  if (minSignalTypes >= 2 && minWeight >= 1.5) return "high";
  if (minWeight >= 1.0) return "medium";
  return "low";
}
