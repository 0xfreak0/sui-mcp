import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerWorkflowTools } = await import("../../src/tools/workflow.js");

const tools = new Map<string, Function>();
registerWorkflowTools({
  tool: (name: string, _d: string, _s: unknown, handler: Function) => {
    tools.set(name, handler);
  },
} as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockSui.listOwnedObjects.mockResolvedValue({ objects: [] });
});

describe("get_wallet_overview recent_transactions", () => {
  it("lists the five most recent transactions, newest first", async () => {
    // The service answers `first` with the address's oldest transactions and
    // `last` with its newest, each page ascending.
    const page = (days: number[]) =>
      days.map((d) => ({ digest: `day${d}`, effects: { status: "SUCCESS", timestamp: `2025-11-${String(d).padStart(2, "0")}T00:00:00Z` } }));
    mockGqlQuery.mockImplementation(async (q: string) => ({
      address: { defaultNameRecord: null, balances: { nodes: [], pageInfo: { hasNextPage: false } } },
      transactions: { nodes: /\blast: \$txFirst/.test(q) ? page([20, 21, 22, 23, 24]) : page([1, 2, 3, 4, 5]) },
    }));

    const result = await tools.get("get_wallet_overview")!({ address: `0x${"a".repeat(64)}` });
    const data = JSON.parse(result.content[0].text);

    expect(data.recent_transactions.map((t: { digest: string }) => t.digest)).toEqual([
      "day24",
      "day23",
      "day22",
      "day21",
      "day20",
    ]);
  });
});
