import { describe, it, expect } from "vitest";
import {
  estimateUnit,
  fundingExclusion,
  lowestListing,
  lowestOriginByteAsk,
  orderbookIndexPrice,
  MARKET_WINDOW_DAYS,
  saleExclusion,
  salesByTransaction,
  typeNameString,
  type MarketListing,
  type MarketSale,
} from "../src/utils/nft-market.js";

const NOW = Date.parse("2026-09-27T00:00:00Z") / 1000;
const daysAgo = (d: number) => new Date((NOW - d * 86_400) * 1000).toISOString();
const SUI = (n: number) => String(BigInt(Math.round(n * 1e9)));

const listing = (sui: number, extra: Partial<MarketListing> = {}): MarketListing => ({
  source: "TradePort orderbook",
  price_mist: SUI(sui),
  listed_at: daysAgo(1),
  ...extra,
});

const sale = (sui: number, extra: Partial<MarketSale> = {}): MarketSale => ({
  marketplace: "TradePort",
  price_mist: SUI(sui),
  at: daysAgo(2),
  checkpoint: 100,
  digest: "D1",
  nft_id: "0x1",
  buyer: "0xb",
  seller: "0xc",
  ...extra,
});

describe("an item's estimated value", () => {
  it("is the lower of the floor and the last sale", () => {
    expect(estimateUnit(listing(102), sale(93.6), { asOfSec: NOW, floorRead: true })).toMatchObject({
      unit_mist: SUI(93.6),
      basis: "lower_of_floor_and_last_sale",
    });
    expect(estimateUnit(listing(76), sale(90), { asOfSec: NOW, floorRead: true }).unit_mist).toBe(SUI(76));
  });

  it("uses whichever of the two exists", () => {
    expect(estimateUnit(listing(5), null, { asOfSec: NOW, floorRead: true })).toMatchObject({ unit_mist: SUI(5), basis: "floor" });
    expect(estimateUnit(null, sale(3), { asOfSec: NOW, floorRead: true })).toMatchObject({ unit_mist: SUI(3), basis: "last_sale" });
  });

  it("does not count a sale older than the window, and says it was stale", () => {
    const old = sale(1, { at: daysAgo(MARKET_WINDOW_DAYS + 1) });
    const withFloor = estimateUnit(listing(5), old, { asOfSec: NOW, floorRead: true });
    expect(withFloor).toMatchObject({ unit_mist: SUI(5), basis: "floor", sale_stale: true });
    const alone = estimateUnit(null, old, { asOfSec: NOW, floorRead: true });
    expect(alone.unit_mist).toBeNull();
    expect(alone.sale_stale).toBe(true);
    expect(alone.unpriced_reason).toContain(`${MARKET_WINDOW_DAYS}-day`);
  });

  it("counts a sale inside the window", () => {
    const recent = sale(1, { at: daysAgo(MARKET_WINDOW_DAYS - 1) });
    expect(estimateUnit(null, recent, { asOfSec: NOW, floorRead: true }).unit_mist).toBe(SUI(1));
  });

  it("is unpriced with neither, and says listings were not read for a past time", () => {
    const now = estimateUnit(null, null, { asOfSec: NOW, floorRead: true });
    expect(now.unit_mist).toBeNull();
    expect(now.basis).toBeNull();
    const past = estimateUnit(null, null, { asOfSec: NOW, floorRead: false });
    expect(past.unpriced_reason).not.toBe(now.unpriced_reason);
  });

  it("measures the window from the valuation time, not from now", () => {
    const asOf = NOW - 100 * 86_400;
    const thenRecent = sale(2, { at: new Date((asOf - 86_400) * 1000).toISOString() });
    expect(estimateUnit(null, thenRecent, { asOfSec: asOf, floorRead: false }).unit_mist).toBe(SUI(2));
  });

  it("does not price an item from a listing that has sat unbought past the window", () => {
    const old = listing(100, { listed_at: daysAgo(MARKET_WINDOW_DAYS + 20) });
    const e = estimateUnit(old, null, { asOfSec: NOW, floorRead: true });
    expect(e.unit_mist).toBeNull();
    expect(e.floor_stale).toBe(true);
    expect(e.unpriced_reason).toContain(`${MARKET_WINDOW_DAYS}-day`);
  });

  it("does not price an item from a listing with no recorded time alone", () => {
    const e = estimateUnit(listing(2, { listed_at: null }), null, { asOfSec: NOW, floorRead: true });
    expect(e.unit_mist).toBeNull();
    expect(e.floor_stale).toBe(true);
  });

  it("still lets an old live listing cap a counted sale, since anyone can buy at it", () => {
    const old = listing(3, { listed_at: null });
    expect(estimateUnit(old, sale(4), { asOfSec: NOW, floorRead: true })).toMatchObject({
      unit_mist: SUI(3),
      basis: "lower_of_floor_and_last_sale",
    });
  });
});

describe("the floor", () => {
  it("is the cheapest listing, and a listing at zero is not an ask", () => {
    const f = lowestListing([listing(9), listing(0), listing(4, { source: "OriginByte orderbook" }), listing(7)]);
    expect(f?.price_mist).toBe(SUI(4));
    expect(f?.source).toBe("OriginByte orderbook");
  });

  it("is null with no priced listing", () => {
    expect(lowestListing([listing(0)])).toBeNull();
    expect(lowestListing([])).toBeNull();
  });
});

describe("sales that do not count", () => {
  it("leaves out a sale at zero", () => {
    expect(saleExclusion(sale(0))).not.toBeNull();
  });

  it("leaves out a sale between one address, whatever its padding", () => {
    expect(saleExclusion(sale(1, { buyer: "0xab", seller: `0x${"0".repeat(62)}ab` }))).not.toBeNull();
  });

  it("leaves out a sale from and into the same kiosk", () => {
    expect(saleExclusion(sale(1, { buyer_kiosk_id: "0xk", seller_kiosk_id: "0xk" }))).not.toBeNull();
  });

  it("keeps an ordinary sale", () => {
    expect(saleExclusion(sale(1, { buyer_kiosk_id: "0xk1", seller_kiosk_id: "0xk2" }))).toBeNull();
  });

  it("leaves out a sale where one side first funded the other, in either direction", () => {
    const s = sale(1, { buyer: "0xb", seller: "0xc" });
    expect(fundingExclusion(s, { buyer: "0xc", seller: "0xf" })).not.toBeNull();
    expect(fundingExclusion(s, { buyer: "0xf", seller: "0xb" })).not.toBeNull();
    expect(fundingExclusion(s, { buyer: "0xf", seller: "0xf" })).toBeNull();
    expect(fundingExclusion(s, { buyer: null, seller: undefined })).toBeNull();
  });
});

describe("sales grouped by transaction", () => {
  it("puts the newest transaction first and a sweep's cheapest item first", () => {
    const groups = salesByTransaction([
      sale(3, { digest: "OLD", checkpoint: 10 }),
      sale(2.3, { digest: "NEW", checkpoint: 20, nft_id: "0xa" }),
      sale(1.75, { digest: "NEW", checkpoint: 20, nft_id: "0xb" }),
      sale(1.8, { digest: "NEW", checkpoint: 20, nft_id: "0xc" }),
    ]);
    expect(groups.map((g) => g[0].digest)).toEqual(["NEW", "OLD"]);
    expect(groups[0].map((s) => s.price_mist)).toEqual([SUI(1.75), SUI(1.8), SUI(2.3)]);
  });
});

describe("marketplace encodings", () => {
  it("reads the price out of a TradePort orderbook index", () => {
    // Read off mainnet: a 102 SUI listing.
    expect(orderbookIndexPrice("170141185342037127250061568547884215135")).toBe(102_000_000_000n);
    expect(orderbookIndexPrice("not a number")).toBeNull();
  });

  it("writes a type the way type_name does", () => {
    expect(typeNameString("0x2::coin::Coin<0x2::sui::SUI>")).toBe(
      `${"0".repeat(63)}2::coin::Coin<${"0".repeat(63)}2::sui::SUI>`,
    );
    expect(typeNameString("0xa::m::Pair<0xb::x::X, 0xc::y::Y>")).toBe(
      `${"0".repeat(63)}a::m::Pair<${"0".repeat(63)}b::x::X,${"0".repeat(63)}c::y::Y>`,
    );
  });

  it("finds the lowest OriginByte ask among price levels that still hold asks", () => {
    const asks = {
      r: "0",
      i: [],
      o: [
        { k: "7880000000", v: [{ price: "7880000000", nft_id: "0xn1", owner: "0xo1", kiosk_id: "0xk1" }], p: "1" },
        { k: "1000000000", v: [], p: "1" },
        { k: "2279000000", v: [{ price: "2279000000", nft_id: "0xn2", owner: "0xo2", kiosk_id: "0xk2" }], p: "1" },
      ],
    };
    expect(lowestOriginByteAsk(asks)).toEqual({ price_mist: "2279000000", nft_id: "0xn2", owner: "0xo2", kiosk_id: "0xk2" });
    expect(lowestOriginByteAsk({ o: [] })).toBeNull();
    expect(lowestOriginByteAsk(null)).toBeNull();
  });
});
