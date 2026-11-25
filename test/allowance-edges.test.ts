/**
 * Native allowances as wallet-clustering edges: funder to spender, read from
 * the Allowance objects and the funder's AllowanceCaps, with spenders named by
 * many funders excluded as services. Object shapes are GraphQL's, as in
 * test/allowance.test.ts and mainnet's Allowance objects.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { addAllowanceEdges, clusterEdges, EdgeSet, APP_ALLOWANCE_WEIGHT, SIGNAL_WEIGHTS } = await import("../src/utils/wallet-edges.js");
const { readAllowanceLinks } = await import("../src/utils/edge-probe.js");
const { resetAllowanceScanCache } = await import("../src/utils/allowance.js");

const ADDR2 = `0x${"0".repeat(63)}2`;
const SUI_ALLOWANCE = `${ADDR2}::allowance::Allowance<${ADDR2}::balance::Balance<${ADDR2}::sui::SUI>>`;
const SUI = `${ADDR2}::sui::SUI`;
const FUNDER = `0x${"f1".repeat(32)}`;
const SPENDER = `0x${"5e".repeat(32)}`;
const APP_SPENDER = `0x${"5a".repeat(32)}`;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (prefix: string, n: number) => `0x${prefix}${n.toString(16).padStart(64 - prefix.length, "0")}`;

const link = (over: Partial<Parameters<typeof addAllowanceEdges>[1][number]> = {}) => ({
  allowance_id: id(1),
  cap_id: id(2),
  funder: FUNDER,
  spender: SPENDER,
  app: null,
  coin_type: SUI,
  status: "active",
  ...over,
});

describe("addAllowanceEdges", () => {
  it("links funder and spender at the signer-path weight, with the allowance and cap as evidence", () => {
    const set = new EdgeSet();
    const r = addAllowanceEdges(set, [link()], () => ({ funders: 1, complete: true }));
    expect(r).toEqual({ excluded: [], linked: 1 });
    const [edge] = set.edges();
    expect(edge.signal_types).toEqual(["allowance"]);
    expect(edge.weight).toBe(SIGNAL_WEIGHTS.allowance);
    expect(edge.signals[0].object_ids).toEqual([id(1), id(2)]);
    expect(edge.signals[0].digests).toEqual([]);
    expect(edge.signals[0].detail).toMatch(/not ownership/);
  });

  it("names every allowance between one pair in one evidence row", () => {
    const set = new EdgeSet();
    const r = addAllowanceEdges(
      set,
      [link(), link({ allowance_id: id(3), cap_id: id(4), app: "0xa235::blink::SwapFunding", status: "expired" })],
      () => ({ funders: 1, complete: true }),
    );
    expect(r.linked).toBe(1);
    const [edge] = set.edges();
    expect(edge.signals).toHaveLength(1);
    expect(edge.signals[0].object_ids).toEqual([id(1), id(2), id(3), id(4)]);
    expect(edge.signals[0].detail).toMatch(/2 allowance\(s\)/);
    // One signer-path allowance is enough for the full weight.
    expect(edge.weight).toBe(SIGNAL_WEIGHTS.allowance);
  });

  it("weights an app-bound allowance below the merge floor", () => {
    const set = new EdgeSet();
    addAllowanceEdges(set, [link({ spender: APP_SPENDER, app: "0xa235::blink::SourceSwapFunding" })], () => ({ funders: 2, complete: true }));
    const edges = set.edges();
    expect(edges[0].weight).toBe(APP_ALLOWANCE_WEIGHT);
    expect(clusterEdges(edges).clusters).toEqual([]);
  });

  it("excludes a spender named by more funders than the limit, and never links funder to funder", () => {
    const set = new EdgeSet();
    const funders = Array.from({ length: 6 }, (_, i) => addr("f", i));
    const links = funders.map((f, i) => link({ funder: f, allowance_id: id(10 + i), cap_id: null }));
    const r = addAllowanceEdges(set, links, () => ({ funders: 6, complete: true }));
    expect(set.edges()).toEqual([]);
    expect(r.excluded).toEqual([{ address: SPENDER, funders: 6, reach_complete: true, reason: "service" }]);
  });

  it("counts the funders it was given when the scan reports fewer", () => {
    const set = new EdgeSet();
    const links = Array.from({ length: 6 }, (_, i) => link({ funder: addr("f", i), allowance_id: id(10 + i) }));
    const r = addAllowanceEdges(set, links, () => ({ funders: 0, complete: true }));
    expect(r.excluded[0]).toMatchObject({ funders: 6, reason: "service" });
  });

  it("treats a spender whose funder count was not read to the end as unmeasured, not narrow", () => {
    const set = new EdgeSet();
    const r = addAllowanceEdges(set, [link()], () => ({ funders: 1, complete: false }));
    expect(set.edges()).toEqual([]);
    expect(r.excluded).toEqual([{ address: SPENDER, funders: 1, reach_complete: false, reason: "unmeasured" }]);
  });

  it("merges a signer-path link on its own and keeps the cluster heuristic", () => {
    const set = new EdgeSet();
    addAllowanceEdges(set, [link()], () => ({ funders: 1, complete: true }));
    const { clusters } = clusterEdges(set.edges());
    expect(clusters).toHaveLength(1);
    expect(clusters[0].evidence_tier).toBe("heuristic");
  });
});

describe("readAllowanceLinks", () => {
  /** Allowance JSON as GraphQL renders it. */
  const json = (funder: string, spender: string, app: string | null = null) => ({
    id: id(1),
    current_spend: "0",
    settings: { funder, spender, app, lifetime_cap: "1000", start_timestamp_ms: null, expiration_timestamp_ms: null, rate_limit: null, name: "bot" },
  });
  const node = (allowanceId: string, funder: string, spender: string) => ({
    address: allowanceId,
    asMoveObject: { contents: { type: { repr: SUI_ALLOWANCE }, json: json(funder, spender) } },
  });
  let scan: Array<ReturnType<typeof node>> = [];
  let scanFails = false;
  let capsFail = false;

  beforeEach(() => {
    resetAllowanceScanCache();
    mockGqlQuery.mockReset();
    scanFails = false;
    capsFail = false;
    scan = [node(id(1), FUNDER, SPENDER), node(id(3), addr("e", 1), FUNDER)];
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown> = {}) => {
      if (query.includes("AllowanceCap")) {
        if (capsFail) throw new Error("429 Too Many Requests");
        const nodes = vars.a === FUNDER ? [{ address: id(2), contents: { type: { repr: "cap" }, json: { allowance: id(1) } } }] : [];
        return { address: { objects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } };
      }
      if (query.includes("multiGetObjects")) {
        const keys = (vars.keys as Array<{ address: string }>).map((k) => k.address);
        return { multiGetObjects: scan.filter((n) => keys.includes(n.address)) };
      }
      if (query.includes("objects(filter")) {
        if (scanFails) throw new Error("timeout");
        return { objects: { nodes: scan, pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      throw new Error(`unexpected query ${query.slice(0, 40)}`);
    });
  });

  it("reads the seed's caps as funder and the scan as spender, with each spender's funder count", async () => {
    const r = await readAllowanceLinks([FUNDER]);
    expect(r.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ allowance_id: id(1), cap_id: id(2), funder: FUNDER, spender: SPENDER }),
        expect.objectContaining({ allowance_id: id(3), cap_id: null, funder: addr("e", 1), spender: FUNDER }),
      ]),
    );
    expect(r.reach.get(SPENDER)).toEqual({ funders: 1, complete: true });
    expect(r.spender_scan?.status).toBe("complete");
    expect(r.funder_reads_incomplete).toEqual([]);
  });

  it("reports a failed cap read and a failed scan instead of reading them as no allowance", async () => {
    capsFail = true;
    scanFails = true;
    const r = await readAllowanceLinks([FUNDER]);
    expect(r.links).toEqual([]);
    expect(r.funder_reads_incomplete).toEqual([{ address: FUNDER, status: "failed", error: expect.stringContaining("429") }]);
    expect(r.spender_scan?.status).toBe("failed");
  });

  it("leaves a spender unmeasured when the scan failed after its caps were read", async () => {
    scanFails = true;
    const r = await readAllowanceLinks([FUNDER]);
    expect(r.links.map((l) => l.allowance_id)).toEqual([id(1)]);
    expect(r.reach.get(SPENDER)).toEqual({ funders: 0, complete: false });
    const set = new EdgeSet();
    expect(addAllowanceEdges(set, r.links, (s) => r.reach.get(s)).excluded[0].reason).toBe("unmeasured");
  });
});
