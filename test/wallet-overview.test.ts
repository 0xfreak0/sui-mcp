import { describe, it, expect, vi } from "vitest";
import { createMockClient, createMockGraphql } from "./helpers/mock-grpc.js";
import { gqlPage } from "./helpers/service-shapes.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerWorkflowTools } = await import("../src/tools/workflow.js");
const tools = new Map<string, Function>();
registerWorkflowTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as unknown as Parameters<typeof registerWorkflowTools>[0]); // only `tool` is called during registration

describe("wallet overview holdings", () => {
  /**
   * 0xa727…0be6 on mainnet holds 704,848 SUI with no coin object: the whole
   * balance sits in its address balance, so list_owned_objects shows no coin.
   */
  it("splits each holding into coin objects and address balance", async () => {
    const WALLET = "0xa727cd9023836d0ac8435918ece422bc0b6a90c3086a5eea0c65a497402e0be6";
    mockGqlQuery.mockResolvedValue({
      address: {
        defaultNameRecord: null,
        balances: gqlPage([
          {
            coinType: { repr: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI" },
            totalBalance: "704848146271530",
            coinBalance: "0",
            addressBalance: "704848146271530",
          },
        ]),
      },
      transactions: gqlPage([]),
    });
    mockSui.listOwnedObjects.mockResolvedValue({ objects: [], hasNextPage: false, cursor: null });

    const j = JSON.parse((await tools.get("get_wallet_overview")!({ address: WALLET })).content[0].text);

    expect(j.holdings[0]).toMatchObject({
      balance: "704848146271530",
      coin_balance: "0",
      address_balance: "704848146271530",
    });
  });
});
