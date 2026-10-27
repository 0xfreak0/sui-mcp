import { describe, expect, it } from "vitest";
import { launchCatalogLists, launchListRows, launchPaymentReadsCanAdvance, launchFirstFundingCanAdvance, LAUNCH_PARENT_LISTS, nextLaunchPageBudget } from "../src/utils/launch-pages.js";
import { capPayload, pageAt } from "../src/utils/output-cap.js";
import { subjectPaymentsCanAdvance } from "../src/utils/subject-payments.js";

describe("full launch result pagination", () => {
  it("returns every buyer and cluster scalar record separately from its nested evidence", () => {
    const result = {
      discovered_buyers: Array.from({ length: 23 }, (_, index) => ({ address: `0x${index}`, status: index ? "unclustered" : "core", reconciliation: { status: "reconciled" }, sales: [{ digest: `sale-${index}` }] })),
      clusters: [{ members: ["0x0"], status: "core", edges: [{ score: 6 }] }],
      destinations: [{ address: "0xdd", affiliation: "none", sweeps: [{ digest: "sweep" }] }]
    };
    const paths = new Set([...result.discovered_buyers.map((_, index) => `discovered_buyers.${index}.sales`), "clusters.0.edges", "destinations.0.sweeps"]);
    for (const parent of LAUNCH_PARENT_LISTS) {
      const rows = launchListRows(result, parent, paths)!;
      const read: unknown[] = [];
      for (let offset: number | null = 0; offset !== null;) {
        const page = pageAt(rows, offset, 200);
        expect(page.rows.length).toBeGreaterThan(0);
        read.push(...page.rows);
        offset = page.next;
      }
      expect(read).toEqual(rows);
    }
    expect(launchListRows(result, "discovered_buyers", paths)?.[0]).toEqual({ address: "0x0", status: "core", reconciliation: { status: "reconciled" } });
    expect(launchListRows(result, "discovered_buyers.0.sales", paths)).toEqual([{ digest: "sale-0" }]);
    expect(launchListRows(result, "clusters", paths)?.[0]).toEqual({ members: ["0x0"], status: "core" });
  });
  it("caps each buyer's original child paths before the ranked buyer parent", () => {
    const buyers = [
      { address: "0xa1", status: "unclustered", sales: [{ digest: "a1" }, { digest: "a2" }] },
      { address: "0xb2", status: "core", sales: [{ digest: "b1" }, { digest: "b2" }] },
    ];
    const caps: Record<string, { budget: number; rank?: (a: never, b: never) => number }> = {
      "discovered_buyers.0.sales": { budget: 0 },
      "discovered_buyers.1.sales": { budget: 0 },
      discovered_buyers: {
        budget: 0, rank: (a, b) =>
          Number((b as typeof buyers[number]).status === "core") - Number((a as typeof buyers[number]).status === "core")
      },
    };
    const { payload } = capPayload("analyze_launch", {}, { discovered_buyers: buyers }, caps, {
      full: false, next_call: { tool: "analyze_launch", args: { detail: "full" } },
    });
    const shown = payload.discovered_buyers as typeof buyers;
    expect(shown).toEqual([{ address: "0xb2", status: "core", sales: [{ digest: "b1" }] }]);
    expect(Object.keys((payload.omitted as { lists: Record<string, unknown> }).lists)).toEqual([
      "discovered_buyers.0.sales", "discovered_buyers.1.sales", "discovered_buyers",
    ]);
    expect(buyers.map(row => row.sales.length)).toEqual([2, 2]);
  });
  it("caps long scored-edge digest lists before the parent edge and pages every omitted digest", () => {
    const digests = Array.from({ length: 120 }, (_, index) => `transaction-${String(index).padStart(3, "0")}`);
    const edge = {
      a: "0xa101", b: "0xb202", score: 6,
      signals: [{ type: "direct", digests, directions: [{ digests: [...digests] }] }]
    };
    const result = { clusters: [{ edges: [edge] }] };
    const nested = "clusters.0.edges.0.signals.0";
    const caps = {
      [`${nested}.directions.0.digests`]: { budget: 110 },
      [`${nested}.digests`]: { budget: 110 },
      "clusters.0.edges": { budget: 500 },
    };
    const { payload } = capPayload("analyze_launch", {}, result, caps, {
      full: false, next_call: { tool: "analyze_launch", args: { detail: "full" } },
    });
    const shown = (payload.clusters as typeof result.clusters)[0].edges[0].signals[0].digests;
    expect(shown.length).toBeLessThan(digests.length);
    expect((payload.omitted as { lists: Record<string, { count: number }> }).lists[`${nested}.digests`].count).toBe(digests.length - shown.length);
    const paths = new Set(Object.keys(caps));
    const retrieved: string[] = [];
    const rows = launchListRows(result, `${nested}.digests`, paths)! as string[];
    for (let at: number | null = 0; at !== null;) {
      const page = pageAt(rows, at, 110);
      retrieved.push(...page.rows as string[]);
      at = page.next;
    }
    expect(retrieved).toEqual(digests);
    expect(launchCatalogLists(result, paths, paths)).toEqual(expect.arrayContaining([
      { path: `${nested}.digests`, count: 120 },
      { path: `${nested}.directions.0.digests`, count: 120 },
    ]));
  });
  it("pages every list descriptor without losing the parent records", () => {
    const buyers = Array.from({ length: 80 }, (_, index) => ({ address: `0x${index}`, status: "unclustered", sales: [{ digest: `s${index}` }] }));
    const result = { discovered_buyers: buyers, clusters: [], destinations: [] };
    const children = new Set(buyers.map((_, index) => `discovered_buyers.${index}.sales`));
    const descriptors = launchCatalogLists(result, [...children, ...LAUNCH_PARENT_LISTS], children);
    const seen: typeof descriptors = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page = pageAt(descriptors, offset, 350);
      expect(page.rows.length).toBeGreaterThan(0);
      seen.push(...page.rows as typeof descriptors);
      offset = page.next;
    }
    expect(seen).toEqual(descriptors);
    expect(descriptors.find(row => row.path === "discovered_buyers")).toEqual({ path: "discovered_buyers", count: 80 });
    expect(launchListRows(result, "discovered_buyers", children)?.[79]).toEqual({ address: "0x79", status: "unclustered" });
  });
  it("keeps every destination status while paging long per-destination read coverage", () => {
    const destinations = Array.from({ length: 19 }, (_, index) => ({
      address: `0x${String(index).padStart(4, "0")}`,
      creator_prior_complete: true,
      creator_prior_transactions_read: index + 1,
      classification_complete: true,
    }));
    const result = {
      destination_index: destinations.map(({ address }) => ({ address, affiliation: "none" })),
      coverage: { complete: true, destinations }
    };
    const path = "coverage.destinations";
    const { payload } = capPayload("analyze_launch", {}, result, { [path]: { budget: 200 } }, {
      full: false, next_call: { tool: "analyze_launch", args: { detail: "full" } },
    });
    expect(payload.destination_index).toHaveLength(19);
    expect((payload.coverage as { complete: boolean }).complete).toBe(true);
    expect((payload.coverage as { destinations: unknown[] }).destinations.length).toBeLessThan(19);
    expect(launchCatalogLists(result, [path], new Set([path]))).toEqual([{ path, count: 19 }]);
    const rows = launchListRows(result, path, new Set([path]))!;
    const retrieved: unknown[] = [];
    for (let at: number | null = 0; at !== null;) {
      const page = pageAt(rows, at, 200);
      retrieved.push(...page.rows);
      at = page.next;
    }
    expect(retrieved).toEqual(destinations);
  });
  it("does not repeat a stopped read or its maximum continuation budget", () => {
    expect(nextLaunchPageBudget(20, true)).toBe(40);
    expect(nextLaunchPageBudget(900, true)).toBe(1000);
    expect(nextLaunchPageBudget(1000, true)).toBeNull();
    expect(nextLaunchPageBudget(20, false)).toBeNull();
  });
  it("does not advertise a larger page count once the first-funding read caps at 1,000", () => {
    expect(launchFirstFundingCanAdvance(99, true, false)).toBe(true);
    expect(launchFirstFundingCanAdvance(100, true, true)).toBe(false);
    expect(launchFirstFundingCanAdvance(150, false, true)).toBe(false);
    expect(nextLaunchPageBudget(100, launchFirstFundingCanAdvance(100, true, false))).toBeNull();
    expect(nextLaunchPageBudget(100, launchFirstFundingCanAdvance(100, true, false) || launchPaymentReadsCanAdvance(true, []))).toBe(200);
  });
  it("continues only budget-stopped subject and creator payment reads", () => {
    expect(subjectPaymentsCanAdvance(true, "next", 20, 20, false)).toBe(true);
    expect(subjectPaymentsCanAdvance(true, "next", 19, 20, false)).toBe(false);
    expect(subjectPaymentsCanAdvance(true, "next", 20, 20, true)).toBe(false);
    expect(subjectPaymentsCanAdvance(true, null, 20, 20, false)).toBe(false);
    expect(launchPaymentReadsCanAdvance(true, [{ canAdvance: false }])).toBe(true);
    expect(launchPaymentReadsCanAdvance(false, [{ canAdvance: true }])).toBe(true);
    expect(launchPaymentReadsCanAdvance(false, [{ canAdvance: false }])).toBe(false);
    expect(nextLaunchPageBudget(20, launchPaymentReadsCanAdvance(false, [{ canAdvance: true }]))).toBe(40);
});
});
