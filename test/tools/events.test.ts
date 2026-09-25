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
});
