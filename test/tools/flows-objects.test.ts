import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient } from "../helpers/mock-grpc.js";
import { gqlPage } from "../helpers/service-shapes.js";

/**
 * summarize_address_flows counts valued objects that entered or left the
 * address: in its totals and with the counterparty they went to.
 */

const mockSui = createMockClient();
const batchGetTransactions = vi.fn();
(mockSui.ledgerService as Record<string, unknown>).batchGetTransactions = batchGetTransactions;
const mockGqlQuery = vi.fn();
const mockPriceRead = vi.hoisted(() => vi.fn());
vi.mock("../../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../../src/utils/valuation.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  priceUsdAtTime: mockPriceRead,
  prefetchCoinScale: async () => undefined,
}));
vi.mock("../../src/utils/price-providers.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  pythApiKey: () => null,
  fetchDefiLlamaHistory: async (requests: Map<string, number[]>) => new Map([...requests].map(([coin, times]) => [
    coin, new Map(times.filter((at) => at !== Date.parse("2025-09-01") / 1000).map((at) => [at, {
      price: at < Date.parse("2025-06-01") / 1000 ? 4 : 2, at, source: "defillama",
    }])),
  ])),
}));
vi.mock("../../src/utils/identity.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  describeAddresses: async (addrs: string[]) => new Map(addrs.map((a) => [a, { address: a, kind: "wallet" as const }])),
  fetchKinds: async (addrs: string[]) => new Map(addrs.map((a) => [a, { kind: "wallet" as const }])),
  identityNote: () => undefined,
}));
// The real readers are replaced by the synthetic one registered below, and
// object states come back as read.
vi.mock("../../src/utils/valuers/index.js", () => ({}));
vi.mock("../../src/utils/valuers/common.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prefetchCheckpoints: async () => undefined,
  readObjectVersions: async (keys: Array<{ object_id: string; version: string }>) =>
    new Map(keys.map((k) => [`${k.object_id}@${k.version}`, { object_id: k.object_id, version: k.version, type: "", json: {}, current: false }])),
}));

// Imported after the mocks above, which the factories close over.
const { registerValuer } = await import("../../src/utils/position-value.js");
const { registerFlowTools } = await import("../../src/tools/flows.js");

const STAKE_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000003::staking_pool::StakedSui";
registerValuer({
  name: "synthetic_stake",
  value: async () => ({ positions: [], unread: [] }),
  handles: (type) => type === STAKE_TYPE,
  valueObject: async (obj) => ({
    positions: [{ protocol: "Sui staking", kind: "staked_sui", object_id: obj.object_id, assets: [], usd_net: 250, method: "synthetic", tier: "price-provider" }],
    unread: [],
  }),
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers = new Map<string, Handler>();
registerFlowTools({ tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as never);

const V = `0x${"a1".repeat(32)}`;
const C = `0x${"c1".repeat(32)}`;
const S1 = `0x${"51".repeat(32)}`;
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

beforeEach(() => {
  mockPriceRead.mockImplementation(async (types: string[]) => ({
    points: new Map(), unpriced: types.map((t) => ({ coin_type: t, code: "not_listed", reason: "No price." })),
  }));
  mockGqlQuery.mockImplementation(async (query: string) => {
    if (!String(query).includes("transactions(filter")) return {};
    return {
      transactions: {
        nodes: [
          {
            digest: DIGEST,
            sender: { address: V },
            gasInput: { gasSponsor: { address: V } },
            kind: { commands: gqlPage([{ __typename: "TransferObjectsCommand" }]) },
            effects: {
              status: "SUCCESS",
              timestamp: "2024-08-10T00:16:00Z",
              checkpoint: { sequenceNumber: 1000 },
              gasEffects: { gasSummary: { computationCost: "1000", storageCost: "0", storageRebate: "0" } },
              balanceChanges: gqlPage([{ coinType: { repr: SUI }, amount: "-1000", owner: { address: V } }]),
              events: gqlPage([]),
            },
          },
        ],
        pageInfo: { hasPreviousPage: false, startCursor: null },
      },
    };
  });
  batchGetTransactions.mockReset();
  batchGetTransactions.mockResolvedValue({
    response: {
      transactions: [
        {
          result: {
            oneofKind: "transaction",
            transaction: {
              digest: DIGEST,
              checkpoint: 1000n,
              effects: {
                changedObjects: [
                  {
                    objectId: S1,
                    objectType: STAKE_TYPE,
                    inputState: 2,
                    outputState: 2,
                    inputVersion: 7n,
                    outputVersion: 8n,
                    idOperation: 0,
                    inputOwner: { kind: 1, address: V },
                    outputOwner: { kind: 1, address: C },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  });
});

describe("summarize_address_flows objects", () => {
  it("counts a valued object sent out in the totals and with its recipient", async () => {
    const d = JSON.parse((await handlers.get("summarize_address_flows")!({ address: V })).content[0].text);

    expect(d.totals_usd.out).toBe(250);
    expect(d.totals_usd.net).toBe(-250);
    expect(d.objects).toEqual([expect.objectContaining({ object_id: S1, direction: "out", counterparty: C, usd: 250 })]);
    const recipient = d.top_recipients.find((r: { address: string }) => r.address === C);
    expect(recipient.usd).toBe(250);
    expect(recipient.objects).toHaveLength(1);
  });

  it("counts a position that arrived through a Move call in a transaction someone else signed", async () => {
    // The collector's view: the victim V signed, no TransferObjects command.
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (!String(query).includes("transactions(filter")) return {};
      return {
        transactions: {
          nodes: [
            {
              digest: DIGEST,
              sender: { address: V },
              gasInput: { gasSponsor: { address: V } },
              kind: { commands: gqlPage([{ __typename: "MoveCallCommand" }]) },
              effects: {
                status: "SUCCESS",
                timestamp: "2024-08-10T00:16:00Z",
                checkpoint: { sequenceNumber: 1000 },
                gasEffects: { gasSummary: { computationCost: "1000", storageCost: "0", storageRebate: "0" } },
                balanceChanges: gqlPage([{ coinType: { repr: SUI }, amount: "-1000", owner: { address: V } }]),
                events: gqlPage([]),
              },
            },
          ],
          pageInfo: { hasPreviousPage: false, startCursor: null },
        },
      };
    });
    const d = JSON.parse((await handlers.get("summarize_address_flows")!({ address: C })).content[0].text);

    expect(d.totals_usd.objects_in).toBe(250);
    expect(d.objects).toEqual([expect.objectContaining({ object_id: S1, direction: "in", counterparty: V })]);
  });

  it("marks the totals partial when a transaction's objects could not be read", async () => {
    batchGetTransactions.mockResolvedValue({ response: { transactions: [{ result: { oneofKind: "error" } }] } });
    (mockSui.ledgerService.getTransaction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("not found"));
    const d = JSON.parse((await handlers.get("summarize_address_flows")!({ address: V })).content[0].text);

    expect(d.totals_usd.objects_partial).toBe(true);
    expect(d.objects_transactions_unread).toEqual([DIGEST]);
  });

  it("leaves objects out when the summary is narrowed to one coin", async () => {
    const d = JSON.parse((await handlers.get("summarize_address_flows")!({ address: V, coin_type: SUI })).content[0].text);

    expect(d.objects).toBeUndefined();
    expect(batchGetTransactions).not.toHaveBeenCalled();
  });

  it("values inflows, recipients and totals at their own day across months", async () => {
    const times = ["2025-01-01T12:00:00Z", "2025-07-01T12:00:00Z", "2025-09-01T12:00:00Z"];
    mockGqlQuery.mockResolvedValue({
      transactions: {
        nodes: times.map((timestamp, i) => ({
          digest: `synthetic-${i}`, sender: { address: V },
          kind: { commands: gqlPage([]) },
          effects: {
            status: "SUCCESS", timestamp, checkpoint: { sequenceNumber: 1000 + i },
            gasEffects: { gasSummary: { computationCost: "0", storageCost: "0", storageRebate: "0" } },
            balanceChanges: gqlPage([
              { coinType: { repr: SUI }, amount: "-10000000000", owner: { address: V } },
              { coinType: { repr: SUI }, amount: "10000000000", owner: { address: C } },
            ]), events: gqlPage([]),
          },
        })).reverse(),
        pageInfo: { hasPreviousPage: false, startCursor: null },
      },
    });
    const d = JSON.parse((await handlers.get("summarize_address_flows")!({ address: V, coin_type: SUI })).content[0].text);
    expect(d.totals_usd).toMatchObject({ out: 60, net: -60, partial: true, approximate: true });
    expect(d.coins[0]).toMatchObject({
      out: 30, usd: { in: 0, out: 60, net: -60 },
      priced_raw: { in: "0", out: "20000000000" }, unpriced_raw: { in: "0", out: "10000000000" },
    });
    expect(d.top_recipients[0]).toMatchObject({ address: C, usd: 60, coins: [{ amount: 30, usd: 60 }] });
    expect(d.usd_basis).toMatchObject({ method: "daily_utc", priced_coin_days: 2, partial: true });
  });

  it("formats headline and unattributed amounts with provider decimals", async () => {
    const coin = `0x${"ad".repeat(32)}::coin::SIX`;
    mockPriceRead.mockImplementation(async (types: string[], at: number) => ({
      points: new Map(types.map((c) => [c, { price: 2, decimals: 6, publishTime: at, source: "defillama" }])),
      unpriced: [],
    }));
    mockGqlQuery.mockResolvedValue({ transactions: {
      nodes: [-1, 2].map((amount, i) => ({
        digest: `scale-fixture-${i}`, sender: { address: V }, kind: { commands: gqlPage([]) },
        effects: {
          status: "SUCCESS", timestamp: "2025-02-01T12:00:00Z", checkpoint: { sequenceNumber: 1000 + i },
          gasEffects: { gasSummary: { computationCost: "0", storageCost: "0", storageRebate: "0" } },
          balanceChanges: gqlPage([
            { coinType: { repr: coin }, amount: String(amount * 1_000_000), owner: { address: V } },
            ...(amount < 0 ? [{ coinType: { repr: coin }, amount: "1000000", owner: { address: C } }] : []),
          ]), events: gqlPage([]),
        },
      })), pageInfo: { hasPreviousPage: false, startCursor: null },
    } });
    const d = JSON.parse((await handlers.get("summarize_address_flows")!({ address: V, coin_type: coin })).content[0].text);
    expect(d.coins[0]).toMatchObject({ in: 2, out: 1, net: 1, usd: { in: 4, out: 2, net: 2 } });
    expect(d.top_recipients[0].coins[0]).toMatchObject({ amount: 1, usd: 2 });
    expect(d.unattributed_inflows[0]).toMatchObject({ amount: 2, usd: 4 });
  });
});
