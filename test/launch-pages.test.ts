import { describe, expect, it } from "vitest";
import { launchCatalogLists, launchListRows, LAUNCH_PARENT_LISTS, nextLaunchPageBudget } from "../src/utils/launch-pages.js";
import { pageAt } from "../src/utils/output-cap.js";

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
  it("does not repeat a stopped read or its maximum continuation budget", () => {
    expect(nextLaunchPageBudget(20, true)).toBe(40);
    expect(nextLaunchPageBudget(900, true)).toBe(1000);
    expect(nextLaunchPageBudget(1000, true)).toBeNull();
    expect(nextLaunchPageBudget(20, false)).toBeNull();
  });
});
