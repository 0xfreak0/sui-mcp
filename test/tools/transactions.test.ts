import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();
const mockArchive = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({
  sui: mockSui,
  archive: mockArchive,
}));

vi.mock("../../src/clients/graphql.js", () => ({
  gqlQuery: mockGqlQuery,
}));

const { registerTransactionTools } = await import("../../src/tools/transactions.js");

const tools = new Map<string, Function>();
const mockServer = {
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as any;

registerTransactionTools(mockServer);

describe("get_transaction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns decoded transaction with protocol info", async () => {
    mockSui.ledgerService.getTransaction.mockResolvedValue({
      response: {
        transaction: {
          digest: "TxDigest123",
          timestamp: { seconds: 1700000000n, nanos: 0 },
          checkpoint: 50000n,
          transaction: {
            sender: "0xsender",
            kind: {
              data: {
                oneofKind: "programmableTransaction",
                programmableTransaction: {
                  commands: [
                    {
                      command: {
                        oneofKind: "moveCall",
                        moveCall: {
                          package: "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
                          module: "pool",
                          function: "swap_a2b",
                          typeArguments: [
                            "0x2::sui::SUI",
                            "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
          effects: {
            status: { success: true },
            gasUsed: {
              computationCost: 1000n,
              storageCost: 2000n,
              storageRebate: 500n,
              nonRefundableStorageFee: 100n,
            },
            epoch: 500n,
          },
          events: { events: [] },
          balanceChanges: [
            { address: "0xsender", coinType: "0x2::sui::SUI", amount: "-1000000000" },
            { address: "0xsender", coinType: "0xdba::usdc::USDC", amount: "500000" },
          ],
        },
      },
    });

    const handler = tools.get("get_transaction")!;
    const result = await handler({ digest: "TxDigest123" });
    const data = JSON.parse(result.content[0].text);

    expect(data.digest).toBe("TxDigest123");
    expect(data.sender).toBe("0xsender");
    expect(data.status).toBe("success");
    expect(data.protocols).toContain("Cetus");
    expect(data.actions[0]).toContain("Swap");
    expect(data.token_flow).toHaveLength(2);
    expect(data.gas.computation_cost).toBe("1000");
  });

  it("falls back to archive on fullnode error", async () => {
    mockSui.ledgerService.getTransaction.mockRejectedValue(new Error("not found"));
    mockArchive.ledgerService.getTransaction.mockResolvedValue({
      response: {
        transaction: {
          digest: "OldTx",
          transaction: { sender: "0xsender", kind: { data: { oneofKind: undefined } } },
          effects: { status: { success: true } },
          events: { events: [] },
          balanceChanges: [],
        },
      },
    });

    const handler = tools.get("get_transaction")!;
    const result = await handler({ digest: "OldTx" });
    const data = JSON.parse(result.content[0].text);

    expect(data.digest).toBe("OldTx");
    expect(mockArchive.ledgerService.getTransaction).toHaveBeenCalled();
  });
});

describe("query_transactions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns filtered transactions from GraphQL", async () => {
    mockGqlQuery.mockResolvedValue({
      transactions: {
        nodes: [
          {
            digest: "Tx1",
            sender: { address: "0xsender" },
            effects: {
              status: "SUCCESS",
              checkpoint: { sequenceNumber: 100 },
              timestamp: "2024-01-01T00:00:00Z",
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });

    const handler = tools.get("query_transactions")!;
    const result = await handler({
      sender: "0xsender",
      affected_address: undefined,
      affected_object: undefined,
      function: undefined,
      after_checkpoint: undefined,
      before_checkpoint: undefined,
      limit: 10,
      after: undefined,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0].digest).toBe("Tx1");
    expect(data.has_next_page).toBe(false);
  });

  it("rejects multiple exclusive filters", async () => {
    const handler = tools.get("query_transactions")!;
    const result = await handler({
      sender: undefined,
      affected_address: "0xaddr",
      affected_object: "0xobj",
      function: undefined,
      after_checkpoint: undefined,
      before_checkpoint: undefined,
      limit: undefined,
      after: undefined,
    });

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("Only one of");
  });
});
