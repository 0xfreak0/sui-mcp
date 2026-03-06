import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import { GrpcTypes } from "@mysten/sui/grpc";

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
        pageInfo: { hasNextPage: false, endCursor: null },
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

  it("address mode: filters by timestamp", async () => {
    mockGqlQuery.mockResolvedValue({
      transactions: {
        nodes: [
          {
            digest: "OldTx",
            sender: { address: "0x1" },
            effects: {
              status: "SUCCESS",
              timestamp: "2024-01-01T00:00:00Z",
              checkpoint: { sequenceNumber: 50 },
            },
          },
          {
            digest: "NewTx",
            sender: { address: "0x1" },
            effects: {
              status: "SUCCESS",
              timestamp: "2024-07-01T00:00:00Z",
              checkpoint: { sequenceNumber: 300 },
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const handler = tools.get("check_activity")!;
    const result = await handler({
      address: "0xwallet",
      object_id: undefined,
      since_checkpoint: undefined,
      since_timestamp: "2024-06-01T00:00:00Z",
      since_version: undefined,
      limit: undefined,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.new_transaction_count).toBe(1);
    expect(data.transactions[0].digest).toBe("NewTx");
  });
});
