import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient, createMockGraphql } from "../helpers/mock-grpc.js";
import type { ValuedPosition } from "../../src/utils/position-value.js";

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();
const fetchAftermathPrices = vi.fn();

vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../../src/tools/prices.js", () => ({ fetchAftermathPrices }));
// The real readers are replaced by the synthetic ones registered below.
vi.mock("../../src/utils/valuers/index.js", () => ({}));

// Imported after the mocks above, which the factories close over.
const { registerValuer } = await import("../../src/utils/position-value.js");
const { registerWorkflowTools } = await import("../../src/tools/workflow.js");

const tools = new Map<string, Function>();
registerWorkflowTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as never);

const W = `0x${"d".repeat(64)}`;
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const LST = `0x${"e".repeat(64)}::lst::LST`;

const position = (kind: ValuedPosition["kind"], usd: number | null, detail?: Record<string, unknown>): ValuedPosition => ({
  protocol: kind,
  kind,
  object_id: null,
  assets: [],
  usd_net: usd,
  method: "synthetic",
  tier: kind === "nft" ? "heuristic" : "price-provider",
  ...(usd === null ? { unpriced_reason: "no price" } : {}),
  ...(detail ? { detail } : {}),
});

let lstUsd: number | null = 4.2;
registerValuer({ name: "lst", value: async () => ({ positions: [position("lst", lstUsd, { receipt_coin_types: [LST] })], unread: [] }) });
registerValuer({ name: "stakes", value: async () => ({ positions: [position("staked_sui", 10), position("clmm", null)], unread: [] }) });
let nftRuns = 0;
registerValuer({
  name: "nft", value: async (ctx) => {
    nftRuns++;
    return ctx.nftMaxCollections === 1
      ? { positions: [position("nft", 50)], unread: [{ what: "nft", reason: "2 items not valued: past the 1 most-held collections." }] }
      : { positions: [position("nft", 50)], unread: [] };
  }
});
registerValuer({ name: "broken", value: async () => { throw new Error("service down"); } });
let bounded = false;
registerValuer({
  name: "bounded",
  value: async (ctx) => bounded
    ? { positions: [], unread: [{ what: "owned objects", reason: `only the first ${ctx.ownedMaxScan ?? 5_000} owned objects were scanned` }] }
    : { positions: [], unread: [] },
});

const overview = async (include_nfts = true, args: Record<string, unknown> = {}) =>
  JSON.parse((await tools.get("get_wallet_overview")!({ address: W, include_prices: true, include_nfts, ...args })).content[0].text);

describe("get_wallet_overview positions", () => {
  beforeEach(() => {
    lstUsd = 4.2;
    bounded = false;
    mockGqlQuery.mockResolvedValue({
      address: {
        defaultNameRecord: null,
        balances: {
          nodes: [
            { coinType: { repr: SUI }, totalBalance: "2000000000", coinBalance: "2000000000", addressBalance: "0" },
            { coinType: { repr: LST }, totalBalance: "1000000000", coinBalance: "1000000000", addressBalance: "0" },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
      transactions: { nodes: [] },
    });
    mockSui.listOwnedObjects.mockResolvedValue({ objects: [] });
    mockSui.stateService.getCoinInfo.mockResolvedValue({ response: { metadata: { decimals: 9, symbol: "X" } } });
    fetchAftermathPrices.mockResolvedValue({ [SUI]: { price: 3, priceChange24HoursPercentage: 0 }, [LST]: { price: 4, priceChange24HoursPercentage: 0 } });
  });

  it("totals coins and DeFi positions, counting a coin a position values once", async () => {
    const data = await overview();
    expect(data.coins_value_usd).toBe(6);
    expect(data.positions_value_usd).toBe(14.2);
    expect(data.total_value_usd).toBe(20.2);
    expect(data.holdings.find((h: { coin_type: string }) => h.coin_type === LST).value_counted_in).toBe("positions");
  });

  it("excludes an unpriced coin without claiming a complete portfolio total", async () => {
    const UNPRICED = `0x${"a".repeat(64)}::dust::DUST`;
    const query = mockGqlQuery.getMockImplementation();
    mockGqlQuery.mockImplementation(async (...args: Parameters<NonNullable<typeof query>>) => {
      const response = structuredClone(await query!(...args));
      if (response?.address?.balances?.nodes) {
        response.address.balances.nodes.push({
          coinType: { repr: UNPRICED },
          totalBalance: "9000000000",
          coinBalance: "9000000000",
          addressBalance: "0",
        });
      }
      return response;
    });
    const data = await overview();
    expect(data.coins_value_usd).toBe(6);
    expect(data.total_value_usd).toBe(20.2);
    expect(data.unpriced_holdings).toBe(1);
    expect(data.holdings.find((h: { coin_type: string }) => h.coin_type === UNPRICED).value_usd).toBeNull();
    expect(data.total_value_note).toContain("Treat this as a floor");
  });

  it("keeps NFT estimates out of the total", async () => {
    const data = await overview();
    expect(data.nft_estimate_usd).toBe(50);
    expect(data.positions.count).toBe(3);
    expect(data.total_value_usd).toBe(20.2);
  });

  it("walks NFTs only when asked", async () => {
    nftRuns = 0;
    const data = await overview(false);
    expect(nftRuns).toBe(0);
    expect(data.nft_estimate_usd).toBeUndefined();
    expect(data.nfts_not_valued.next_call.tool).toBe("list_nft_collections");
    expect(data.total_value_usd).toBe(20.2);
  });

  it("counts an unpriced position apart and states an unread reader", async () => {
    const data = await overview();
    expect(data.positions.unpriced).toBe(1);
    expect(data.unread.map((u: { what: string }) => u.what)).toEqual(["broken"]);
    expect(data.total_value_note).toBeTruthy();
  });

  it("counts the coin with the coins when the position backed by it has no price", async () => {
    lstUsd = null;
    const data = await overview();
    expect(data.coins_value_usd).toBe(10);
    expect(data.holdings.find((h: { coin_type: string }) => h.coin_type === LST).value_counted_in).toBeUndefined();
  });

  it("reads every page of balances and ranks the holdings by value", async () => {
    const LATE = `0x${"f".repeat(64)}::late::LATE`;
    // One page is the first coin types in type order; a coin sorting later is on the next.
    mockGqlQuery.mockImplementation(async (_q: string, v: { after?: string }) => {
      const node = (repr: string, amount: string) => ({ coinType: { repr }, totalBalance: amount, coinBalance: amount, addressBalance: "0" });
      if (v?.after === "page-2") {
        return { address: { balances: { nodes: [node(LATE, "5000000000")], pageInfo: { hasNextPage: false, endCursor: null } } } };
      }
      return {
        address: { defaultNameRecord: null, balances: { nodes: [node(SUI, "2000000000")], pageInfo: { hasNextPage: true, endCursor: "page-2" } } },
        transactions: { nodes: [] },
      };
    });
    fetchAftermathPrices.mockResolvedValue({ [SUI]: { price: 3, priceChange24HoursPercentage: 0 }, [LATE]: { price: 100, priceChange24HoursPercentage: 0 } });
    const data = await overview(false);
    expect(data.holdings_truncated).toBe(false);
    expect(data.holdings.map((h: { coin_type: string }) => h.coin_type)).toEqual([LATE, SUI]);
    expect(data.coins_value_usd).toBe(506);
  });

  it("continues after twenty balance pages without calling the slice a whole portfolio", async () => {
    mockGqlQuery.mockImplementation(async (_q: string, v: { balanceAfter?: string; after?: string }) => {
      const after = v?.after ?? v?.balanceAfter;
      const index = after ? Number(after.slice(1)) : 0;
      const coin = `0x${(index + 1).toString(16).padStart(64, "0")}::coin::COIN`;
      const balances = {
        nodes: [{ coinType: { repr: coin }, totalBalance: "1000000000", coinBalance: "1000000000", addressBalance: "0" }],
        pageInfo: { hasNextPage: index < 20, endCursor: index < 20 ? `c${index + 1}` : null },
      };
      return v?.after ? { address: { balances } } : {
        address: { defaultNameRecord: null, balances },
        transactions: { nodes: [] },
      };
});
    const first = JSON.parse((await tools.get("get_wallet_overview")!({
      address: W, include_prices: false,
    })).content[0].text);
    expect(first.holdings_count).toBe(20);
    expect(first.holdings_truncated).toBe(true);
    expect(first.holdings_next_call.args.balance_cursor).toBe("c20");
    const next = JSON.parse((await tools.get("get_wallet_overview")!({
      ...first.holdings_next_call.args, include_prices: false,
    })).content[0].text);
    expect(next.holdings_count).toBe(1);
    expect(next.holdings_truncated).toBe(true);
    expect(next.holdings_next_call).toBeUndefined();
  });
  it("offers a raised valuation scan call without discarding the balance block", async () => {
    bounded = true;
    const first = await overview(false);
    expect(first.owned_scan_next_call).toEqual({
      tool: "get_wallet_overview",
      args: { address: W, include_prices: true, include_nfts: false, owned_max_scan: 10_000 },
    });
    const raised = await overview(false, { owned_max_scan: 10_000 });
    expect(raised.unread).toContainEqual({ what: "owned objects", reason: "only the first 10000 owned objects were scanned" });
    expect(raised.owned_scan_next_call.args.owned_max_scan).toBe(20_000);
  });
  it("offers a raised NFT collection valuation call with the same balance block", async () => {
    const first = await overview(true, { nft_max_collections: 1 });
    expect(first.nft_scan_next_call).toEqual({
      tool: "get_wallet_overview",
      args: { address: W, include_prices: true, include_nfts: true, nft_max_collections: 2 },
    });
    const next = await overview(true, first.nft_scan_next_call.args);
    expect(next.nft_scan_next_call).toBeUndefined();
  });
});
