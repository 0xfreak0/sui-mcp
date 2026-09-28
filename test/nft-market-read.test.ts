import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Reading one collection's market from mocked chain data: which listing is
 * the floor, which sale is the last one that counts, and what a past
 * valuation time leaves out. Every id is synthetic.
 */

const mockGql = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: (...a: unknown[]) => mockGql(...a) }));

const funders: Record<string, string> = {};
vi.mock("../src/utils/edge-probe.js", () => ({
  Budget: class {
    take() {
      return true;
    }
    charge() {}
  },
  firstFunderOf: async (address: string) => ({ funder: funders[address] ?? null, digest: null, pricesUnavailable: false, originUnread: [] }),
}));

const { collectionMarkets, clearMarketCache } = await import("../src/utils/nft-market-read.js");

const pad = (hex: string) => `0x${hex.padStart(64, "0")}`;
const COLLECTION = `${pad("c0ffee")}::nft::Item`;
const OTHER = `${pad("beef")}::nft::Other`;
const POLICY = pad("a1");
const FIELD = pad("a2");
const VECTOR = pad("a3");
const GONE_LISTING = pad("b1");
const LIVE_LISTING = pad("b2");
const BUYER_WASH = pad("e1");
const SELLER_WASH = pad("e2");
const BUYER = pad("e3");
const SIGNER = pad("e4");
const SIMPLE_BUY = "0xff2251ea99230ed1cbe3a347a209352711c6723fcdcd9286e16636e65bb55cab::tradeport_listings::BuySimpleListingEvent";
const BID_MATCH = "0x53134eb544c5a0b5085e99efaf7eab13b28ad123de35d61f941f8c8c40b72033::tradeport_biddings::MatchSingleBidEvent";

const NOW = Date.parse("2026-09-27T00:00:00Z") / 1000;
const iso = (daysBack: number) => new Date((NOW - daysBack * 86_400) * 1000).toISOString();
const mist = (sui: number) => String(BigInt(Math.round(sui * 1e9)));
/** A TradePort orderbook index: top bit, price, sequence. */
const index = (sui: number, seq: number) => ((1n << 127n) | (BigInt(mist(sui)) << 64n) | BigInt(seq)).toString();

const tx = (digest: string, checkpoint: number, daysBack: number, signer: string, events: Array<[string, Record<string, unknown>]>) => ({
  digest,
  sender: { address: signer },
  effects: {
    timestamp: iso(daysBack),
    checkpoint: { sequenceNumber: checkpoint },
    events: { nodes: events.map(([type, json]) => ({ contents: { type: { repr: type }, json } })) },
  },
});

/** Sales through the policy: a wash sale newest, a bid match, and a sale of another collection. */
const SALE_TXS = [
  tx("MID", 150, 3, SIGNER, [[BID_MATCH, { nft_id: pad("n2"), nft_type: COLLECTION.slice(2), buyer: BUYER, price: mist(4.5) }]]),
  tx("OTHER", 160, 2.5, BUYER, [[SIMPLE_BUY, { nft_id: pad("n3"), buyer: BUYER, seller: SIGNER, price: mist(1) }]]),
  tx("NEW", 200, 1, BUYER_WASH, [[SIMPLE_BUY, { nft_id: pad("n1"), buyer: BUYER_WASH, seller: SELLER_WASH, price: mist(4) }]]),
];

const transactionFilters: unknown[] = [];

function mockChain() {
  mockGql.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
    if (query.includes("p0: objects")) {
      return { p0: { nodes: [{ address: POLICY }] }, o0: { nodes: [] }, d0: { nodes: [] }, t0: { multiGetDynamicFields: [{ address: FIELD }] } };
    }
    if (query.includes("t0: address")) {
      return { t0: { multiGetDynamicFields: [{ address: FIELD, value: { json: { id: VECTOR, depth: 0, root_id: "1", length: "2" } } }] } };
    }
    if (query.includes("s0: address")) {
      return { s0: { dynamicField: { value: { json: { keys: [index(5, 1), index(6, 2)], vals: [GONE_LISTING, LIVE_LISTING] } } } } };
    }
    if (query.includes("multiGetObjects") && query.includes("previousTransaction")) {
      return {
        multiGetObjects: [
          null,
          {
            address: LIVE_LISTING,
            asMoveObject: { contents: { json: { price: mist(6), nft_id: pad("n9"), seller: SIGNER } } },
            previousTransaction: { effects: { timestamp: iso(4) } },
          },
        ],
      };
    }
    if (query.includes("k0: objects")) {
      return {
        k0: {
          nodes: [{ address: pad("c1"), asMoveObject: { contents: { json: { price: mist(8), nft_id: pad("n8") } } }, previousTransaction: { effects: { timestamp: iso(40) } } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        l0: { nodes: [] },
      };
    }
    if (query.includes("transactions(")) {
      transactionFilters.push(...Object.entries(vars).filter(([k]) => k.startsWith("f")).map(([, v]) => v));
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(vars).filter((k) => k.startsWith("f"))) {
        const i = k.slice(1);
        const object = (vars[k] as { affectedObject: string }).affectedObject;
        out[`x${i}`] = { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: object === POLICY ? SALE_TXS : [] };
      }
      return out;
    }
    if (query.includes("multiGetObjects")) {
      const types: Record<string, string> = { [pad("n1")]: COLLECTION, [pad("n3")]: OTHER };
      return {
        multiGetObjects: (vars.keys as Array<{ address: string }>).map(({ address }) =>
          types[address] ? { address, asMoveObject: { contents: { type: { repr: types[address] } } } } : null,
        ),
      };
    }
    throw new Error(`unexpected query: ${query.slice(0, 80)}`);
  });
}

beforeEach(() => {
  mockGql.mockReset();
  clearMarketCache();
  transactionFilters.length = 0;
  for (const k of Object.keys(funders)) delete funders[k];
  funders[BUYER_WASH] = SELLER_WASH;
  mockChain();
});

describe("a collection's market at the latest state", () => {
  it("takes the cheapest live orderbook listing, skipping one whose listing is gone", async () => {
    const m = (await collectionMarkets([COLLECTION], { asOfSec: NOW })).get(COLLECTION)!;
    expect(m.floor).toMatchObject({ source: "TradePort orderbook", price_mist: mist(6), listing_id: LIVE_LISTING, listed_at: iso(4) });
    expect(m.floor_read).toBe(true);
    expect(m.has_market).toBe(true);
  });

  it("leaves out a sale where the seller first funded the buyer, and uses the next one", async () => {
    const m = (await collectionMarkets([COLLECTION], { asOfSec: NOW })).get(COLLECTION)!;
    expect(m.excluded_sales).toEqual([expect.objectContaining({ digest: "NEW", price_mist: mist(4) })]);
    expect(m.last_sale).toMatchObject({ digest: "MID", price_mist: mist(4.5), buyer: BUYER });
  });

  it("takes the signer as the seller when the sale event names none", async () => {
    const m = (await collectionMarkets([COLLECTION], { asOfSec: NOW })).get(COLLECTION)!;
    expect(m.last_sale).toMatchObject({ seller: SIGNER, seller_is_signer: true });
  });

  it("does not count a sale of another collection found through the same transactions", async () => {
    delete funders[BUYER_WASH];
    const m = (await collectionMarkets([COLLECTION], { asOfSec: NOW })).get(COLLECTION)!;
    // The wash sale now counts, and the OTHER collection's newer, cheaper sale never did.
    expect(m.last_sale?.digest).toBe("NEW");
    expect(m.excluded_sales).toEqual([]);
  });

  it("shares one read between concurrent callers of the same collection", async () => {
    await Promise.all([collectionMarkets([COLLECTION], { asOfSec: NOW }), collectionMarkets([COLLECTION], { asOfSec: NOW })]);
    expect(mockGql.mock.calls.filter(([q]) => String(q).includes("p0: objects"))).toHaveLength(1);
  });
});

describe("a collection's market for a past time", () => {
  it("reads no listings, bounds the transactions, and drops sales after the valuation time", async () => {
    const asOf = NOW - 2 * 86_400;
    const m = (await collectionMarkets([COLLECTION], { asOfSec: asOf, historical: true, atCheckpoint: 170 })).get(COLLECTION)!;
    expect(m.floor).toBeNull();
    expect(m.floor_read).toBe(false);
    expect(mockGql.mock.calls.some(([q]) => String(q).includes("s0: address") || String(q).includes("k0: objects"))).toBe(false);
    expect(transactionFilters).toContainEqual({ affectedObject: POLICY, beforeCheckpoint: 171 });
    expect(m.last_sale?.digest).toBe("MID");
  });
});

describe("reads a scan repeats", () => {
  it("asks which objects settle a collection once, whatever checkpoints it is valued at", async () => {
    await collectionMarkets([COLLECTION], { asOfSec: NOW - 2 * 86_400, historical: true, atCheckpoint: 170 });
    await collectionMarkets([COLLECTION], { asOfSec: NOW - 86_400, historical: true, atCheckpoint: 190 });
    expect(mockGql.mock.calls.filter(([q]) => String(q).includes("p0: objects"))).toHaveLength(1);
    expect(transactionFilters).toContainEqual({ affectedObject: POLICY, beforeCheckpoint: 191 });
  });
});

describe("a collection with no market", () => {
  it("says so, and a failed read is reported rather than read as no market", async () => {
    mockGql.mockImplementation(async (query: string) => {
      if (query.includes("p0: objects")) return { p0: { nodes: [] }, o0: { nodes: [] }, d0: { nodes: [] }, t0: { multiGetDynamicFields: [null] } };
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    });
    const none = (await collectionMarkets([COLLECTION], { asOfSec: NOW })).get(COLLECTION)!;
    expect(none.has_market).toBe(false);
    expect(none.not_read).toEqual([]);

    clearMarketCache();
    mockGql.mockRejectedValue(new Error("service unavailable"));
    const failed = (await collectionMarkets([COLLECTION], { asOfSec: NOW })).get(COLLECTION)!;
    expect(failed.has_market).toBe(false);
    expect(failed.not_read.length).toBeGreaterThan(0);
  });
});
