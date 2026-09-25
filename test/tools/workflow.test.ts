import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import { grpcError } from "../helpers/service-shapes.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerWorkflowTools } = await import("../../src/tools/workflow.js");

const tools = new Map<string, Function>();
registerWorkflowTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as never);

const W = `0x${"1".repeat(64)}`;

describe("get_wallet_overview when a read fails", () => {
  beforeEach(() => vi.clearAllMocks());

  // `holdings: []` with no transactions is exactly what a real unused address
  // returns, so a failed read must not produce it.
  it("returns an error, not an empty wallet, when the balances read fails", async () => {
    mockGqlQuery.mockRejectedValue(new Error("GraphQL request to graphql.mainnet.sui.io failed with HTTP 404"));
    mockSui.listOwnedObjects.mockResolvedValue({ objects: [], cursor: null });

    const res = await tools.get("get_wallet_overview")!({ address: W });
    expect(res.isError).toBe(true);
    const { error } = JSON.parse(res.content[0].text);
    expect(error).toMatch(/Could not read the balances/);
    expect(error).toMatch(/not evidence the wallet is empty/);
  });

  it("reports a failed staked or kiosk read as unknown rather than zero", async () => {
    mockGqlQuery.mockResolvedValue({
      address: {
        defaultNameRecord: null,
        balances: { nodes: [], pageInfo: { hasNextPage: false } },
      },
      transactions: { nodes: [] },
    });
    mockSui.listOwnedObjects.mockRejectedValue(grpcError("UNAVAILABLE"));

    const data = JSON.parse((await tools.get("get_wallet_overview")!({ address: W })).content[0].text);
    expect(data.staked_sui_count).toBeNull();
    expect(data.staked_sui_unavailable).toMatch(/unknown/);
    expect(data.kiosk_count).toBeNull();
    expect(data.kiosk_unavailable).toMatch(/unknown/);
  });
});
