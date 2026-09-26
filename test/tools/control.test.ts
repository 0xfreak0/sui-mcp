import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockGraphql } from "../helpers/mock-grpc.js";

const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: mockGqlQuery,
}));

const { registerControlTools } = await import("../../src/tools/control.js");
const { RELOCATE_EVENT_MODULE_CHECKPOINT } = await import("../../src/utils/package-versions.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerControlTools(mockServer);

describe("sample_control_addresses", () => {
  beforeEach(() => vi.clearAllMocks());

  const V1 = `0x${"1".repeat(64)}`;
  const V9 = `0x${"9".repeat(64)}`;
  const CUT = RELOCATE_EVENT_MODULE_CHECKPOINT.mainnet;

  /**
   * A router module like Turbos v9's `{v9}::swap_router` has no event
   * structs of its own. Before the relocate_event_module cutover (mainnet
   * checkpoint 69,982,635, 2024-10-17) Sui anchored a module's runtime
   * identity to the package's original id for the life of the lineage, so
   * over a pre-cutover window a module filter written with the called
   * version's id scans zero events; rewritten to the original id it draws
   * the real population.
   */
  it("rewrites a module filter to the package's original id for a window entirely before the cutover", async () => {
    mockGqlQuery.mockImplementation(async (q: string) =>
      q.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : {
            events: {
              nodes: [
                { sender: { address: "0xa" } },
                { sender: { address: "0xb" } },
                { sender: { address: "0xc" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
    );

    const handler = tools.get("sample_control_addresses")!;
    const result = await handler({ module: `${V9}::swap_router`, from: CUT - 2000, to: CUT - 1000, size: 2, seed: 1 });
    const data = JSON.parse(result.content[0].text);

    expect(data.module_scope?.queried).toBe(`${V1}::swap_router`);
    expect(data.population_size).toBe(3);
    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events("))!;
    expect(eventsCall[1].filter.module).toBe(`${V1}::swap_router`);
  });

  it("queries the requested id unrewritten for a window entirely at or after the cutover", async () => {
    mockGqlQuery.mockImplementation(async (q: string) =>
      q.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { events: { nodes: [{ sender: { address: "0xd" } }], pageInfo: { hasNextPage: false, endCursor: null } } },
    );

    const handler = tools.get("sample_control_addresses")!;
    const result = await handler({ module: `${V9}::swap_router`, from: CUT + 1000, to: CUT + 2000, size: 1, seed: 1 });
    const data = JSON.parse(result.content[0].text);

    expect(data.module_scope?.queried).toBe(`${V9}::swap_router`);
    expect(data.population_size).toBe(1);
    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events("))!;
    expect(eventsCall[1].filter.module).toBe(`${V9}::swap_router`);
  });

  /** An original-id population after the cutover holds v1's callers only, so the warning names the other versions' ids. */
  it("names the other versions when an original-id population after the cutover is undersampled", async () => {
    mockGqlQuery.mockImplementation(async (q: string) =>
      q.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { events: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    );

    const handler = tools.get("sample_control_addresses")!;
    const result = await handler({ module: `${V1}::swap_router`, from: CUT + 1000, to: CUT + 2000, size: 5, seed: 1 });
    const data = JSON.parse(result.content[0].text);

    expect(data.module_scope?.other_version_ids).toEqual([V9]);
    expect(data.warning).toMatch(/module_scope\.other_version_ids/);
  });

  /**
   * A control population drawn over a window spanning the cutover draws
   * from both ids: rewriting only to the original id would exclude every
   * post-cutover caller.
   */
  it("draws the population from both segments when the window spans the cutover", async () => {
    mockGqlQuery.mockImplementation(async (q: string, v?: { filter?: { module?: string } }) => {
      if (q.includes("packageVersions")) {
        return { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      if (v?.filter?.module === `${V9}::swap_router`) {
        return { events: { nodes: [{ sender: { address: "0xpost" } }], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      return {
        events: {
          nodes: [{ sender: { address: "0xpre1" } }, { sender: { address: "0xpre2" } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    });

    const handler = tools.get("sample_control_addresses")!;
    const result = await handler({ module: `${V9}::swap_router`, from: CUT - 2000, to: CUT + 1000, size: 3, seed: 1 });
    const data = JSON.parse(result.content[0].text);

    expect(data.module_scope?.note).toMatch(/spans the cutover/);
    expect(data.events_scanned).toBe(3);
    expect(data.population_truncated).toBe(false);
    const eventsCalls = mockGqlQuery.mock.calls.filter(([q]) => String(q).includes("events("));
    expect(eventsCalls).toHaveLength(2);
  });

  it("reports no module_scope for a framework package upgraded in place", async () => {
    const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
    mockGqlQuery.mockImplementation(async (q: string) =>
      q.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: P2, version: 1 }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { events: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    );

    const handler = tools.get("sample_control_addresses")!;
    const result = await handler({ module: `${P2}::kiosk`, size: 5 });
    const data = JSON.parse(result.content[0].text);

    expect(data.module_scope).toBeUndefined();
    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events("))!;
    expect(eventsCall[1].filter.module).toBe(`${P2}::kiosk`);
  });
});
