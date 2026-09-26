import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockGraphql } from "../helpers/mock-grpc.js";
import { checkpointChain } from "../helpers/service-shapes.js";

const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: {},
  archive: {},
}));

vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: mockGqlQuery,
}));

const { registerEventTools } = await import("../../src/tools/events.js");
const { RELOCATE_EVENT_MODULE_CHECKPOINT } = await import("../../src/utils/package-versions.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerEventTools(mockServer);

describe("query_events", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns filtered events", async () => {
    mockGqlQuery.mockResolvedValue({
      events: {
        nodes: [
          {
            contents: { json: { amount: "1000" } },
            sender: { address: "0xsender" },
            transactionModule: { fullyQualifiedName: "0x2::coin::mint" },
            timestamp: "2024-01-01T00:00:00Z",
            transaction: { digest: "TxA" },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
      },
    });

    const handler = tools.get("query_events")!;
    const result = await handler({
      event_type: "0x2::coin::CoinCreated",
      sender: undefined,
      module: undefined,
      after_checkpoint: undefined,
      before_checkpoint: undefined,
      limit: 10,
      after: undefined,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.events).toHaveLength(1);
    expect(data.events[0].sender).toBe("0xsender");
    expect(data.events[0].tx_digest).toBe("TxA");
    expect(data.events[0].data.amount).toBe("1000");
  });

  it("handles empty results", async () => {
    mockGqlQuery.mockResolvedValue({
      events: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
      },
    });

    const handler = tools.get("query_events")!;
    const result = await handler({
      event_type: undefined,
      sender: "0xnonexistent",
      module: undefined,
      after_checkpoint: undefined,
      before_checkpoint: undefined,
      limit: undefined,
      after: undefined,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.events).toHaveLength(0);
    expect(data.has_next_page).toBe(false);
  });

  it("pages newest first by default and hands back the older page's cursor", async () => {
    mockGqlQuery.mockImplementation(async (q: string) =>
      q.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: "0x2", version: 1 }], pageInfo: { hasNextPage: false } } }
        : {
            events: {
              nodes: [
                { contents: { json: {} }, timestamp: "2024-06-01T00:00:00Z", transaction: { digest: "Older" } },
                { contents: { json: {} }, timestamp: "2024-06-02T00:00:00Z", transaction: { digest: "Newer" } },
              ],
              pageInfo: { hasNextPage: false, endCursor: "end", hasPreviousPage: true, startCursor: "cursor_abc" },
            },
          },
    );

    const handler = tools.get("query_events")!;
    const result = await handler({ module: "0x2::coin", after_checkpoint: "100", limit: 2 });
    const data = JSON.parse(result.content[0].text);

    expect(data.order).toBe("newest");
    expect(data.events.map((e: { tx_digest: string }) => e.tx_digest)).toEqual(["Newer", "Older"]);
    expect(data.newest_shown).toBe("2024-06-02T00:00:00Z");
    expect(data.has_next_page).toBe(true);
    expect(data.next_cursor).toBe("cursor_abc");
    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events("))!;
    expect(eventsCall[1]).toMatchObject({
      filter: { module: "0x2::coin", afterCheckpoint: 100 },
      last: 2,
    });
  });

  it("puts ISO bounds into the filter as the checkpoints stamped inside them", async () => {
    const T0 = Date.parse("2025-01-01T00:00:00Z");
    const chain = checkpointChain(1_000_000, (seq) => T0 + seq * 250);
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) =>
      chain(q, v) ?? {
        events: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
        },
      },
    );

    const handler = tools.get("query_events")!;
    const result = await handler({
      sender: "0x1",
      after_checkpoint: new Date(T0 + 400_000 * 250 + 100).toISOString(),
      before_checkpoint: 400_500,
    });
    const data = JSON.parse(result.content[0].text);

    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events("))!;
    expect(eventsCall[1].filter).toMatchObject({ afterCheckpoint: 400_000, beforeCheckpoint: 400_500 });
    expect(data.window).toMatchObject({ after_checkpoint: 400_000, before_checkpoint: 400_500 });
  });

  /**
   * An event carries the package version that DEFINED its struct. DeepBook
   * margin's LiquidationEvent was defined at the original ID, so a filter
   * written with the latest version's ID matched nothing.
   */
  it("rewrites an event type written with an upgraded package to its defining package", async () => {
    const LATEST = "0x55ee8099674e46266df2bf0ffed9569e1511aa269f2a9b8c63a2c72f16404e72";
    const ORIGINAL = "0x97d9473771b01f77b0940c589484184b49f6444627ec121314fae6a6d36fb86b";
    mockGqlQuery.mockImplementation(async (q: string) =>
      q.includes("typeOrigins")
        ? {
            package: {
              typeOrigins: [
                { module: "margin_manager", struct: "LiquidationEvent", definingId: ORIGINAL },
                { module: "margin_manager", struct: "NewThing", definingId: LATEST },
              ],
            },
          }
        : {
            events: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
            },
          },
    );

    const handler = tools.get("query_events")!;
    const result = await handler({ event_type: `${LATEST}::margin_manager::LiquidationEvent` });
    const data = JSON.parse(result.content[0].text);

    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events("))!;
    expect(eventsCall[1].filter.type).toBe(`${ORIGINAL}::margin_manager::LiquidationEvent`);
    expect(data.event_type_resolution.queried).toBe(`${ORIGINAL}::margin_manager::LiquidationEvent`);
  });

  /**
   * A framework package upgraded in place (0x2) shares one address across
   * every version, so the requested id already equals the original and no
   * rewrite is produced. Its `packageVersions` rows share one address with
   * different version numbers, and count as one lineage ID.
   */
  it("reports no module_scope for a framework package upgraded in place", async () => {
    const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
    mockGqlQuery.mockImplementation(async (q: string) =>
      q.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: P2, version: 1 }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { events: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } } },
    );

    const handler = tools.get("query_events")!;
    const result = await handler({ module: `${P2}::kiosk`, sender: "0xdrainer", limit: 50 });
    const data = JSON.parse(result.content[0].text);

    expect(data.module_scope).toBeUndefined();
    expect(result.content[0].text).not.toMatch(/version 1 only/);
    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events("))!;
    expect(eventsCall[1].filter.module).toBe(`${P2}::kiosk`);
  });

  /**
   * Turbos v9's `swap_router` is a pure router module with no event structs
   * of its own. Before the relocate_event_module cutover (mainnet checkpoint
   * 69,982,635, 2024-10-17) its events carried `transactionModule` v1,
   * because Sui anchored a module's runtime identity to the package's
   * original id, so over a pre-cutover window a filter written with v9's id
   * matches nothing and is rewritten to v1.
   */
  it("rewrites a module filter to the package's original id for a window entirely before the cutover", async () => {
    const V1 = `0x${"1".repeat(64)}`;
    const V9 = `0x${"9".repeat(64)}`;
    const CUT = RELOCATE_EVENT_MODULE_CHECKPOINT.mainnet;
    mockGqlQuery.mockImplementation(async (q: string) =>
      q.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { events: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } } },
    );

    const handler = tools.get("query_events")!;
    const result = await handler({ module: `${V9}::swap_router`, after_checkpoint: CUT - 2000, before_checkpoint: CUT - 1000, limit: 50 });
    const data = JSON.parse(result.content[0].text);

    expect(data.module_scope?.queried).toBe(`${V1}::swap_router`);
    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events("))!;
    expect(eventsCall[1].filter.module).toBe(`${V1}::swap_router`);
  });

  /**
   * From the cutover checkpoint on, `relocate_event_module` makes the
   * opposite true: events carry the id of the version actually called, so a
   * window that never reaches back before the cutover must query the
   * requested id unrewritten. Rewritten to the original id, it would scan
   * zero events.
   */
  it("queries the requested id unrewritten for a window entirely at or after the cutover", async () => {
    const V1 = `0x${"1".repeat(64)}`;
    const V9 = `0x${"9".repeat(64)}`;
    const CUT = RELOCATE_EVENT_MODULE_CHECKPOINT.mainnet;
    mockGqlQuery.mockImplementation(async (q: string) =>
      q.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : {
            events: {
              nodes: [{ contents: { json: {} }, sender: { address: "0xseller" }, timestamp: "2025-01-01T00:00:00Z", transaction: { digest: "PostTx" } }],
              pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
            },
          },
    );

    const handler = tools.get("query_events")!;
    const result = await handler({ module: `${V9}::swap_router`, after_checkpoint: CUT + 1000, before_checkpoint: CUT + 2000, limit: 50 });
    const data = JSON.parse(result.content[0].text);

    expect(data.events.map((e: { tx_digest: string }) => e.tx_digest)).toEqual(["PostTx"]);
    expect(data.module_scope?.queried).toBe(`${V9}::swap_router`);
    expect(data.module_scope?.note).toMatch(/mainnet checkpoint 69982635/);
    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events("))!;
    expect(eventsCall[1].filter.module).toBe(`${V9}::swap_router`);
  });

  /**
   * A window spanning the cutover has to query both ids and merge: the
   * original id for the slice before it, the requested id for the slice at
   * or after it. The two are disjoint by checkpoint, so newest-first reads
   * the requested-id slice first, then continues into the original-id slice
   * once it is exhausted, across a page boundary via the composite cursor.
   */
  it("splits a window spanning the cutover into two segments and merges them, paging across the boundary", async () => {
    const V1 = `0x${"1".repeat(64)}`;
    const V9 = `0x${"9".repeat(64)}`;
    const CUT = RELOCATE_EVENT_MODULE_CHECKPOINT.mainnet;
    const postEvent = { contents: { json: {} }, sender: { address: "0xseller" }, timestamp: "2025-01-01T00:00:00Z", transaction: { digest: "PostTx" } };
    // Raw GraphQL `last`/`before` order is ascending (oldest first);
    // `orderedPage` reverses it for newest-first display.
    const preEvents = [
      { contents: { json: {} }, sender: { address: "0xb" }, timestamp: "2024-09-26T06:00:00Z", transaction: { digest: "PreTx1" } },
      { contents: { json: {} }, sender: { address: "0xa" }, timestamp: "2024-09-26T08:00:00Z", transaction: { digest: "PreTx2" } },
    ];
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => {
      if (q.includes("packageVersions")) {
        return { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      const filter = v.filter as { module: string };
      if (filter.module === `${V9}::swap_router`) {
        return { events: { nodes: [postEvent], pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } } };
      }
      return { events: { nodes: preEvents, pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } } };
    });

    const handler = tools.get("query_events")!;
    const result = await handler({ module: `${V9}::swap_router`, after_checkpoint: CUT - 2000, before_checkpoint: CUT + 1000, limit: 3 });
    const data = JSON.parse(result.content[0].text);

    expect(data.module_scope?.note).toMatch(/spans the cutover/);
    expect(data.events.map((e: { tx_digest: string }) => e.tx_digest)).toEqual(["PostTx", "PreTx2", "PreTx1"]);
    expect(data.has_next_page).toBe(false);
    const eventsCalls = mockGqlQuery.mock.calls.filter(([q]) => String(q).includes("events("));
    expect(eventsCalls).toHaveLength(2);
    expect(eventsCalls[0][1].filter).toMatchObject({ module: `${V9}::swap_router`, afterCheckpoint: CUT - 1, beforeCheckpoint: CUT + 1000 });
    expect(eventsCalls[1][1].filter).toMatchObject({ module: `${V1}::swap_router`, afterCheckpoint: CUT - 2000, beforeCheckpoint: CUT });
  });

  it("resumes a spanning-window merge on the next page with a composite cursor", async () => {
    const V1 = `0x${"1".repeat(64)}`;
    const V9 = `0x${"9".repeat(64)}`;
    const CUT = RELOCATE_EVENT_MODULE_CHECKPOINT.mainnet;
    const postEvent = { contents: { json: {} }, sender: { address: "0xseller" }, timestamp: "2025-01-01T00:00:00Z", transaction: { digest: "PostTx" } };
    const preEvent = { contents: { json: {} }, sender: { address: "0xa" }, timestamp: "2024-09-26T08:00:00Z", transaction: { digest: "PreTx" } };
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => {
      if (q.includes("packageVersions")) {
        return { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      const filter = v.filter as { module: string };
      if (filter.module === `${V9}::swap_router`) {
        return { events: { nodes: [postEvent], pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } } };
      }
      return { events: { nodes: [preEvent], pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } } };
    });

    const handler = tools.get("query_events")!;
    const first = await handler({ module: `${V9}::swap_router`, after_checkpoint: CUT - 2000, before_checkpoint: CUT + 1000, limit: 1 });
    const firstData = JSON.parse(first.content[0].text);
    expect(firstData.events.map((e: { tx_digest: string }) => e.tx_digest)).toEqual(["PostTx"]);
    expect(firstData.has_next_page).toBe(true);
    expect(typeof firstData.next_cursor).toBe("string");

    vi.clearAllMocks();
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => {
      if (q.includes("packageVersions")) {
        return { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      const filter = v.filter as { module: string };
      return filter.module === `${V9}::swap_router`
        ? { events: { nodes: [postEvent], pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } } }
        : { events: { nodes: [preEvent], pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } } };
    });
    const second = await handler({
      module: `${V9}::swap_router`,
      after_checkpoint: CUT - 2000,
      before_checkpoint: CUT + 1000,
      limit: 1,
      cursor: firstData.next_cursor,
    });
    const secondData = JSON.parse(second.content[0].text);
    expect(secondData.events.map((e: { tx_digest: string }) => e.tx_digest)).toEqual(["PreTx"]);
    expect(secondData.has_next_page).toBe(false);
    // The resumed page must go straight to the pre-cutover (original-id)
    // segment, never re-querying the already-exhausted requested-id one.
    const eventsCalls = mockGqlQuery.mock.calls.filter(([q]) => String(q).includes("events("));
    expect(eventsCalls).toHaveLength(1);
    expect(eventsCalls[0][1].filter.module).toBe(`${V1}::swap_router`);
  });
});
