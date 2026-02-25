import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockGraphql } from "../helpers/mock-grpc.js";

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
        pageInfo: { hasNextPage: false, endCursor: null },
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
        pageInfo: { hasNextPage: false, endCursor: null },
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

  it("passes pagination cursor", async () => {
    mockGqlQuery.mockResolvedValue({
      events: {
        nodes: [
          {
            contents: { json: {} },
            sender: { address: "0x1" },
            transactionModule: { fullyQualifiedName: "0x2::coin::transfer" },
            timestamp: "2024-06-01T00:00:00Z",
            transaction: { digest: "TxB" },
          },
        ],
        pageInfo: { hasNextPage: true, endCursor: "cursor_abc" },
      },
    });

    const handler = tools.get("query_events")!;
    const result = await handler({
      event_type: undefined,
      sender: undefined,
      module: "0x2::coin",
      after_checkpoint: "100",
      before_checkpoint: undefined,
      limit: 1,
      after: undefined,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.has_next_page).toBe(true);
    expect(data.next_cursor).toBe("cursor_abc");
    // Verify the GraphQL call included the filter
    expect(mockGqlQuery).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        filter: expect.objectContaining({
          module: "0x2::coin",
          afterCheckpoint: 100,
        }),
      })
    );
  });
});
