import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import { GrpcTypes } from "@mysten/sui/grpc";
import { checkpointChain } from "../helpers/service-shapes.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockSui,
}));

vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: mockGqlQuery,
}));

const { registerMonitorTools } = await import("../../src/tools/monitor.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerMonitorTools(mockServer);

describe("check_activity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns error when neither address nor object_id provided", async () => {
    const handler = tools.get("check_activity")!;
    const result = await handler({
      address: undefined,
      object_id: undefined,
      since_checkpoint: undefined,
      since_timestamp: undefined,
      since_version: undefined,
      limit: undefined,
    });

    expect(result.isError).toBe(true);
  });

  it("object mode: detects version change", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: "0xobj",
          version: 50n,
          digest: "d1",
          objectType: "0xmod::Type",
          owner: { kind: GrpcTypes.Owner_OwnerKind.SHARED, version: 1n },
        },
      },
    });

    const handler = tools.get("check_activity")!;
    const result = await handler({
      address: undefined,
      object_id: "0xobj",
      since_checkpoint: undefined,
      since_timestamp: undefined,
      since_version: "40",
      limit: undefined,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.has_changed).toBe(true);
    expect(data.current_version).toBe("50");
    expect(data.since_version).toBe("40");
  });

  it("object mode: no change detected", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: "0xobj",
          version: 40n,
          digest: "d1",
          objectType: "0xmod::Type",
          owner: { kind: GrpcTypes.Owner_OwnerKind.SHARED, version: 1n },
        },
      },
    });

    const handler = tools.get("check_activity")!;
    const result = await handler({
      address: undefined,
      object_id: "0xobj",
      since_checkpoint: undefined,
      since_timestamp: undefined,
      since_version: "40",
      limit: undefined,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.has_changed).toBe(false);
  });

  it("address mode: returns new transactions", async () => {
    mockGqlQuery.mockResolvedValue({
      transactions: {
        nodes: [
          {
            digest: "Tx1",
            sender: { address: "0xsender" },
            effects: {
              status: "SUCCESS",
              timestamp: "2024-06-01T00:00:00Z",
              checkpoint: { sequenceNumber: 200 },
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
      },
    });

    const handler = tools.get("check_activity")!;
    const result = await handler({
      address: "0xwallet",
      object_id: undefined,
      since_checkpoint: 100,
      since_timestamp: undefined,
      since_version: undefined,
      limit: undefined,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.new_transaction_count).toBe(1);
    expect(data.latest_checkpoint).toBe(200);
    expect(data.transactions[0].digest).toBe("Tx1");
  });

  it("address mode: turns since_timestamp into the checkpoint filter", async () => {
    // Checkpoint `seq` is stamped at T0 + 250ms·seq; the baseline sits 100ms
    // past checkpoint 400,000, so the first checkpoint after it is 400,001.
    const T0 = Date.parse("2025-01-01T00:00:00Z");
    const chain = checkpointChain(1_000_000, (seq) => T0 + seq * 250);
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) =>
      chain(q, v) ?? {
        transactions: {
          nodes: [
            {
              digest: "NewTx",
              sender: { address: "0x1" },
              effects: {
                status: "SUCCESS",
                timestamp: new Date(T0 + 400_002 * 250).toISOString(),
                checkpoint: { sequenceNumber: 400_002 },
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: "c-new", hasPreviousPage: false, startCursor: "c-new" },
        },
      },
    );

    const handler = tools.get("check_activity")!;
    const result = await handler({
      address: "0xwallet",
      since_timestamp: new Date(T0 + 400_000 * 250 + 100).toISOString(),
    });
    const data = JSON.parse(result.content[0].text);

    const txCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("transactions("))!;
    expect(txCall[1].afterCheckpoint).toBe(400_000);
    expect(txCall[1].first).toBe(20);
    expect(data.after_checkpoint).toBe(400_000);
    expect(data.new_transaction_count).toBe(1);
    expect(data.transactions[0].digest).toBe("NewTx");
  });

  it("address mode: rejects an unparseable since_timestamp", async () => {
    const handler = tools.get("check_activity")!;
    const result = await handler({ address: "0xwallet", since_timestamp: "yesterday" });
    expect(result.isError).toBe(true);
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("address mode: continues from a cursor it returned", async () => {
    mockGqlQuery.mockResolvedValue({
      transactions: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null },
      },
    });
    const handler = tools.get("check_activity")!;
    const result = await handler({ address: "0xwallet", cursor: "c-new" });
    const data = JSON.parse(result.content[0].text);
    expect(mockGqlQuery.mock.calls[0][1].after).toBe("c-new");
    expect(data.mode).toBe("since");
    // Nothing new: the poll position stays where it was.
    expect(data.next_cursor).toBe("c-new");
  });

  it("address mode: without a baseline, returns the newest transactions", async () => {
    mockGqlQuery.mockResolvedValue({
      transactions: {
        nodes: [
          { digest: "Older", effects: { status: "SUCCESS", checkpoint: { sequenceNumber: 10 } } },
          { digest: "Newest", effects: { status: "SUCCESS", checkpoint: { sequenceNumber: 20 } } },
        ],
        pageInfo: { hasNextPage: false, endCursor: "c-newest", hasPreviousPage: true, startCursor: "c-older" },
      },
    });
    const handler = tools.get("check_activity")!;
    const result = await handler({ address: "0xwallet", limit: 2 });
    const data = JSON.parse(result.content[0].text);
    expect(mockGqlQuery.mock.calls[0][1].last).toBe(2);
    expect(data.mode).toBe("latest");
    expect(data.transactions.map((t: { digest: string }) => t.digest)).toEqual(["Newest", "Older"]);
    expect(data.next_cursor).toBe("c-newest");
  });

  it("object mode: has_changed is null without a baseline version", async () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: {
        object: {
          objectId: "0xobj",
          version: 50n,
          digest: "d1",
          objectType: "0xmod::Type",
          owner: { kind: GrpcTypes.Owner_OwnerKind.SHARED, version: 1n },
        },
      },
    });
    const handler = tools.get("check_activity")!;
    const result = await handler({ object_id: "0xobj" });
    const data = JSON.parse(result.content[0].text);
    expect(data.has_changed).toBeNull();
    expect(data.note).toMatch(/since_version/);
  });
});

describe("check_activity with both modes", () => {
  beforeEach(() => vi.clearAllMocks());

  // Both given ran object mode and dropped the address without a word.
  it("refuses an address and an object_id together, before any request", async () => {
    const result = await tools.get("check_activity")!({ address: `0x${"a".repeat(64)}`, object_id: `0x${"0".repeat(63)}6` });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatch(/not both/);
    expect(mockSui.ledgerService.getObject).not.toHaveBeenCalled();
  });
});
