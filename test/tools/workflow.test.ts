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
    // Stakes are counted over gRPC and kiosks found through their keys over GraphQL.
    mockGqlQuery.mockImplementation(async (q: string) => {
      if (q.includes("kiosk::KioskOwnerCap")) throw new Error("GraphQL request failed with HTTP 503");
      return {
        address: {
          defaultNameRecord: null,
          balances: { nodes: [], pageInfo: { hasNextPage: false } },
        },
        transactions: { nodes: [] },
      };
    });
    mockSui.listOwnedObjects.mockRejectedValue(grpcError("UNAVAILABLE"));

    const data = JSON.parse((await tools.get("get_wallet_overview")!({ address: W })).content[0].text);
    expect(data.staked_sui_count).toBeNull();
    expect(data.staked_sui_unavailable).toMatch(/unknown/);
    expect(data.kiosk_count).toBeNull();
    expect(data.kiosk_unavailable).toMatch(/unknown/);
  });
});

describe("get_wallet_overview recent_transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSui.listOwnedObjects.mockResolvedValue({ objects: [] });
  });

  it("shows the 50 newest rows in order and links to older decoded history", async () => {
    mockGqlQuery.mockImplementation(async (q: string, variables: { txFirst?: number }) => {
      if (q.includes("sentAddress: $address")) return { transactions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
      return {
        address: { defaultNameRecord: null, balances: { nodes: [], pageInfo: { hasNextPage: false } } },
        transactions: {
          nodes: /\blast: \$txFirst/.test(q)
            ? Array.from({ length: variables.txFirst ?? 0 }, (_, n) => ({ digest: `tx${n + 3}`, effects: { status: "SUCCESS" } }))
            : [{ digest: "tx1", effects: { status: "SUCCESS" } }],
          pageInfo: { hasPreviousPage: true, startCursor: "earlier" },
        },
      };
    });

    const address = `0x${"a".repeat(64)}`;
    const result = await tools.get("get_wallet_overview")!({ address });
    const data = JSON.parse(result.content[0].text);
    expect(data.recent_transactions.map((t: { digest: string }) => t.digest)).toEqual(Array.from({ length: 50 }, (_, n) => `tx${52 - n}`));
    expect(data.recent_transactions_truncated).toBe(true);
    expect(data.recent_transactions_next_call).toEqual({
      tool: "get_transaction_history",
      args: { address, order: "newest", cursor: "earlier" },
    });
  });

  it("bounds package enrichment and offers the full scan when it stalls", async () => {
    let aborted = false;
    mockGqlQuery.mockImplementation(async (q: string, _variables: unknown, options?: { signal?: AbortSignal }) => {
      if (q.includes("sentAddress: $address")) {
        const { promise, reject } = Promise.withResolvers<unknown>();
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(options.signal?.reason);
        }, { once: true });
        return promise;
      }
      return {
        address: { defaultNameRecord: null, balances: { nodes: [], pageInfo: { hasNextPage: false } } },
        transactions: { nodes: [{ digest: "recent" }], pageInfo: { hasPreviousPage: false, startCursor: null } },
      };
    });

    const address = `0x${"a".repeat(64)}`;
    const response = tools.get("get_wallet_overview")!({ address });
    const data = JSON.parse((await response).content[0].text);
    expect(data.recent_transactions.map((t: { digest: string }) => t.digest)).toEqual(["recent"]);
    expect(data.package_activity).toBeNull();
    expect(data.package_activity_unavailable).toMatch(/exceeded 3000ms/);
    expect(data.package_activity_next_call).toEqual({ tool: "get_wallet_packages", args: { address } });
    expect(aborted).toBe(true);
    // The bound is a real 3-second timer; the default 5-second test timeout leaves too little room on a loaded runner.
  }, 15_000);
});
