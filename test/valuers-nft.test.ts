import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CollectionMarket } from "../src/utils/nft-market-read.js";
import type { PricePoint } from "../src/utils/valuation.js";

/**
 * The nft reader: an item's USD estimate from its collection's market, what
 * it calls an NFT, and that it never values an object another reader values.
 * Markets, holdings and the SUI price are mocked; every id is synthetic.
 */

const pad = (hex: string) => `0x${hex.padStart(64, "0")}`;
const COLLECTION = `${pad("c0ffee")}::nft::Item`;
const LP_TYPE = `${pad("1b")}::pool::Position`;
const PROTOCOL_OBJECT = `${pad("2c")}::vault::Receipt`;
const OWNER = pad("0a");
const NOW = Math.floor(Date.now() / 1000);

const markets = new Map<string, CollectionMarket>();
const displays = new Set<string>();
const marketReads = vi.fn();
const presenceReads = vi.fn();
vi.mock("../src/utils/nft-market-read.js", () => ({
  collectionMarkets: async (types: string[]) => {
    marketReads(types);
    return new Map(types.map((t) => [t, markets.get(t) ?? emptyMarket(t)]));
  },
  collectionPresence: async (types: string[]) => {
    presenceReads(types);
    return new Map(
      types.map((t) => [
        t,
        { policies: markets.get(t)?.has_market ? [pad("a1")] : [], orderbooks: [], tradeport_field: null, display: displays.has(t), unread: [] },
      ]),
    );
  },
}));

const held = new Map<string, number>();
vi.mock("../src/utils/nft-holdings.js", () => ({
  readHeldCollections: async () => ({ counts: held, direct: new Map<string, number>(), kiosk_count: 1, kiosks_unread: 0 }),
}));

const suiPoint: PricePoint = { price: 2, publishTime: NOW, source: "defillama" };
vi.mock("../src/utils/valuers/common.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  priceCoinTypes: async () => ({ points: new Map([[`${pad("2")}::sui::SUI`, suiPoint]]), unpriced: [] }),
}));

vi.mock("../src/clients/graphql.js", () => ({
  gqlQuery: async (q: string) => {
    throw new Error(`unexpected query: ${q.slice(0, 60)}`);
  },
}));

function emptyMarket(collection: string): CollectionMarket {
  return {
    collection,
    floor: null,
    floor_read: true,
    listings_seen: {},
    last_sale: null,
    excluded_sales: [],
    wash_check: null,
    sales_unattributed: 0,
    has_market: false,
    not_read: [],
  };
}

const { nftPosition, isFrameworkType, MAX_COLLECTIONS } = await import("../src/utils/valuers/nft.js");
const { registerValuer, valueObjects, valuePositions } = await import("../src/utils/position-value.js");

const priced = (floorSui: number, saleSui: number): CollectionMarket => ({
  ...emptyMarket(COLLECTION),
  has_market: true,
  floor: { source: "TradePort orderbook", price_mist: String(floorSui * 1e9), listed_at: new Date().toISOString() },
  last_sale: {
    marketplace: "TradePort",
    price_mist: String(saleSui * 1e9),
    at: new Date().toISOString(),
    checkpoint: 1,
    digest: "D",
    nft_id: pad("n1"),
  },
});

beforeEach(() => {
  markets.clear();
  held.clear();
  displays.clear();
  marketReads.mockClear();
  presenceReads.mockClear();
});

describe("an NFT position", () => {
  it("prices every item at the unit estimate in SUI times the SUI price, as a heuristic estimate", () => {
    const p = nftPosition(priced(3, 2), 5, null, NOW, suiPoint);
    expect(p.kind).toBe("nft");
    expect(p.tier).toBe("heuristic");
    expect(p.assets).toEqual([{ coin_type: COLLECTION, amount: "5", side: "item", usd: 20 }]);
    expect(p.usd_net).toBe(20);
    expect(p.detail).toMatchObject({ estimate: true, unit_sui: 2, unit_usd: 4, basis: "lower_of_floor_and_last_sale" });
  });

  it("is unpriced with no market, and a market that could not be read says so apart", () => {
    const none = nftPosition(emptyMarket(COLLECTION), 1, null, NOW, suiPoint);
    const failed = nftPosition({ ...emptyMarket(COLLECTION), not_read: [{ what: "sales", reason: "timeout" }] }, 1, null, NOW, suiPoint);
    expect(none.usd_net).toBeNull();
    expect(failed.usd_net).toBeNull();
    expect(none.unpriced_reason).toBeTruthy();
    expect(failed.unpriced_reason).toContain("timeout");
  });

  it("is unpriced without a SUI price even when the collection has one", () => {
    const p = nftPosition(priced(3, 2), 1, null, NOW, undefined);
    expect(p.usd_net).toBeNull();
    expect(p.detail).toMatchObject({ unit_sui: 2, unit_usd: null });
    expect(p.unpriced_reason).toBeTruthy();
  });
});

describe("what the nft reader values", () => {
  it("leaves framework objects alone, however their address is written", () => {
    expect(isFrameworkType("0x2::coin::Coin<0x2::sui::SUI>")).toBe(true);
    expect(isFrameworkType(`${pad("3")}::staking_pool::StakedSui`)).toBe(true);
    expect(isFrameworkType(`${pad("2")}::kiosk::Kiosk`)).toBe(true);
    expect(isFrameworkType(COLLECTION)).toBe(false);
  });

  it("does not call an object with no Display and no market an NFT, and reads no market for it", async () => {
    const r = await valueObjects([{ object_id: pad("f1"), type: PROTOCOL_OBJECT, json: null }], { owner: OWNER });
    expect(r.positions).toEqual([]);
    expect(r.unread).toEqual([expect.objectContaining({ what: pad("f1") })]);
    expect(marketReads).not.toHaveBeenCalled();
  });

  it("leaves a pool receipt with a Display unread instead of calling it an NFT", async () => {
    displays.add(COLLECTION);
    const json = { id: pad("f4"), pool_id: pad("900d"), xTokenBalance: "39346972191", name: "Receipt" };
    const r = await valueObjects([{ object_id: pad("f4"), type: COLLECTION, json }], { owner: OWNER });
    expect(r.positions).toEqual([]);
    expect(r.unread).toEqual([expect.objectContaining({ what: pad("f4") })]);
    expect(marketReads).not.toHaveBeenCalled();
  });

  it("values an item with a Display and no market as an unpriced NFT", async () => {
    displays.add(COLLECTION);
    const r = await valueObjects([{ object_id: pad("f2"), type: COLLECTION, json: null }], { owner: OWNER });
    expect(r.positions).toEqual([expect.objectContaining({ kind: "nft", object_id: pad("f2"), usd_net: null })]);
  });

  it("values one item of a priced collection by itself", async () => {
    markets.set(COLLECTION, priced(3, 2));
    const r = await valueObjects([{ object_id: pad("f3"), type: COLLECTION, json: null }], { owner: OWNER });
    expect(r.positions).toEqual([expect.objectContaining({ object_id: pad("f3"), usd_net: 4 })]);
  });

  it("values the items of one call together: one presence read and one market read for every collection", async () => {
    const SECOND = `${pad("5ec0")}::nft::Second`;
    markets.set(COLLECTION, priced(3, 2));
    markets.set(SECOND, { ...priced(1, 1), collection: SECOND });
    const r = await valueObjects(
      [
        { object_id: pad("g1"), type: COLLECTION, json: null },
        { object_id: pad("g2"), type: SECOND, json: null },
        { object_id: pad("g3"), type: COLLECTION, json: null },
      ],
      { owner: OWNER, memo: new Map() },
    );
    expect(r.positions.map((p) => [p.object_id, p.usd_net])).toEqual(
      expect.arrayContaining([
        [pad("g1"), 4],
        [pad("g2"), 2],
        [pad("g3"), 4],
      ]),
    );
    expect(presenceReads).toHaveBeenCalledTimes(1);
    expect(marketReads).toHaveBeenCalledTimes(1);
    expect(new Set(marketReads.mock.calls[0][0])).toEqual(new Set([COLLECTION, SECOND]));
  });

  it("values at most MAX_COLLECTIONS collections in one call, the most-held first, and says which items it left out", async () => {
    const singles = Array.from({ length: MAX_COLLECTIONS }, (_, i) => `${pad((0x7000 + i).toString(16))}::nft::One`);
    for (const t of [COLLECTION, ...singles]) displays.add(t);
    const objs = [
      ...singles.map((type, i) => ({ object_id: pad((0x9000 + i).toString(16)), type, json: null })),
      { object_id: pad("h1"), type: COLLECTION, json: null },
      { object_id: pad("h2"), type: COLLECTION, json: null },
    ];
    const r = await valueObjects(objs, { owner: OWNER, memo: new Map() });
    expect(marketReads).toHaveBeenCalledTimes(1);
    expect(marketReads.mock.calls[0][0]).toHaveLength(MAX_COLLECTIONS);
    expect(marketReads.mock.calls[0][0]).toContain(COLLECTION);
    const left = objs[MAX_COLLECTIONS - 1].object_id;
    expect(r.positions.some((p) => p.object_id === left)).toBe(false);
    expect(r.unread.map((u) => u.what)).toEqual([left]);
    expect(r.positions).toHaveLength(MAX_COLLECTIONS + 1);
  });

  it("skips a collection another reader values, so a wallet total never counts it twice", async () => {
    registerValuer({
      name: "test_lp",
      handles: (type) => type === LP_TYPE,
      value: async () => ({ positions: [], unread: [] }),
      valueObject: async () => ({ positions: [], unread: [] }),
    });
    held.set(COLLECTION, 2);
    held.set(LP_TYPE, 1);
    held.set("0x2::coin::Coin<0x2::sui::SUI>", 1);
    markets.set(COLLECTION, priced(3, 2));
    const r = await valuePositions({ owner: OWNER }, ["nft"]);
    expect(r.positions.map((p) => p.assets[0].coin_type)).toEqual([COLLECTION]);
    expect(r.positions[0].usd_net).toBe(8);
  });

  it("values no holdings for a past time rather than today's holdings at old prices", async () => {
    held.set(COLLECTION, 2);
    const r = await valuePositions({ owner: OWNER, atCheckpoint: "100" }, ["nft"]);
    expect(r.positions).toEqual([]);
    expect(r.unread).toHaveLength(1);
  });
});
