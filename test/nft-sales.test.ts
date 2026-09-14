import { describe, it, expect } from "vitest";
import {
  ownershipFrom,
  readSale,
  saleEventTypes,
  totalSales,
} from "../src/utils/nft-sales.js";

/**
 * Field names were read off real mainnet events, not guessed. Each shape below
 * is quoted from one, so a marketplace renaming a field fails here rather than
 * silently reporting that nothing traded.
 */
const TRADEPORT_SIMPLE =
  "0xff2251ea99230ed1cbe3a347a209352711c6723fcdcd9286e16636e65bb55cab::tradeport_listings::BuySimpleListingEvent";
const TRADEPORT_KIOSK =
  "0xec175e537be9e48f75fa6929291de6454d2502f1091feb22c0d26a22821bbf28::kiosk_listings::BuyEvent";
const TRADEPORT_CLAIM =
  "0xc94af80a10796ad0732cca33b38a858f712256da0763a65bafb2a63cf3e6a0d0::kiosk_biddings::ClaimWithPurchaseCapEvent";
const BLUEMOVE =
  "0xd5dd28cc24009752905689b2ba2bf90bfc8de4549b9123f93519bb8ba9bf9981::marketplace::BuyEvent";
const ORIGINBYTE =
  "0x4e0629fa51a62b0c1d7c7b9fc89237ec5b6f630d7798ad3f06d820afb93a995a::orderbook::TradeFilledEvent";

describe("reading a sale out of its event", () => {
  it("reads the TradePort simple-listing shape", () => {
    const s = readSale(TRADEPORT_SIMPLE, {
      type: "1",
      nft_id: "0xnft",
      price: "10000000000",
      seller: "0xsell",
      buyer: "0xbuy",
      maybe_seller_kiosk_id: "0xsk",
      maybe_buyer_kiosk_id: "0xbk",
    });
    expect(s).toMatchObject({
      nft_id: "0xnft",
      buyer: "0xbuy",
      seller: "0xsell",
      price: "10000000000",
      buyer_kiosk_id: "0xbk",
      seller_kiosk_id: "0xsk",
      marketplace: "TradePort",
    });
  });

  it("reads the kiosk-listing shape, which names the kiosks differently", () => {
    const s = readSale(TRADEPORT_KIOSK, {
      listing_id: "0xl",
      seller: "0xsell",
      seller_kiosk_id: "0xsk",
      buyer: "0xbuy",
      buyer_kiosk_id: "0xbk",
      nft_id: "0xnft",
      price: "5",
    });
    expect(s?.buyer_kiosk_id).toBe("0xbk");
    expect(s?.seller_kiosk_id).toBe("0xsk");
  });

  it("reads BlueMove, which has no seller and calls the id item_id", () => {
    const s = readSale(BLUEMOVE, {
      item_id: "0xnft",
      amount: "42",
      buyer: "0xbuy",
      nft_type: "0xc::m::T",
    });
    expect(s).toMatchObject({ nft_id: "0xnft", price: "42", buyer: "0xbuy", marketplace: "BlueMove" });
    expect(s?.seller).toBeUndefined();
  });

  it("reads OriginByte, which calls the id nft and the kiosks *_kiosk", () => {
    const s = readSale(ORIGINBYTE, {
      nft: "0xnft",
      buyer: "0xbuy",
      buyer_kiosk: "0xbk",
      seller: "0xsell",
      seller_kiosk: "0xsk",
      price: "7",
    });
    expect(s).toMatchObject({ nft_id: "0xnft", buyer_kiosk_id: "0xbk", seller_kiosk_id: "0xsk" });
  });

  /**
   * A claim records custody with no amount. Counting it as a zero-value sale
   * would drag an average down with trades that were never priced.
   */
  it("gives an unpriced custody event no price", () => {
    const s = readSale(TRADEPORT_CLAIM, {
      nft_id: "0xnft",
      buyer: "0xbuy",
      buyer_kiosk_id: "0xbk",
    });
    expect(s?.price).toBeUndefined();
    expect(s?.buyer_kiosk_id).toBe("0xbk");
  });

  it("refuses an event type it does not know", () => {
    expect(readSale("0xabc::other::Thing", { nft_id: "0xnft" })).toBeNull();
  });

  it("refuses a record with no NFT id, which cannot be joined to anything", () => {
    expect(readSale(TRADEPORT_SIMPLE, { price: "1", buyer: "0xb" })).toBeNull();
  });

  it("ignores a non-string field rather than carrying it through", () => {
    const s = readSale(TRADEPORT_SIMPLE, { nft_id: "0xnft", price: 5, buyer: { a: 1 } });
    expect(s?.price).toBeUndefined();
    expect(s?.buyer).toBeUndefined();
  });

  it("every registered type is a full Move type", () => {
    for (const t of saleEventTypes()) expect(t.split("::")).toHaveLength(3);
  });
});

/**
 * The point of the whole path: a sale states outright which wallet held which
 * kiosk, which the kiosk's own field gets wrong 40% of the time.
 */
describe("kiosk ownership stated by a sale", () => {
  it("takes both legs, because the seller held its kiosk just as surely", () => {
    const s = readSale(TRADEPORT_KIOSK, {
      nft_id: "0xnft",
      seller: "0xsell",
      seller_kiosk_id: "0xsk",
      buyer: "0xbuy",
      buyer_kiosk_id: "0xbk",
      price: "5",
    })!;
    expect(ownershipFrom(s, 100)).toEqual([
      { kiosk_id: "0xbk", owner: "0xbuy", checkpoint: 100 },
      { kiosk_id: "0xsk", owner: "0xsell", checkpoint: 100 },
    ]);
  });

  it("yields nothing from a kiosk with no matching party", () => {
    const s = readSale(BLUEMOVE, { item_id: "0xnft", amount: "1", buyer: "0xbuy" })!;
    expect(ownershipFrom(s, 100)).toEqual([]);
  });
});

describe("totalling sales", () => {
  const sale = (price: string | undefined, marketplace: string) => ({
    nft_id: "0xn",
    marketplace,
    event_type: "t",
    ...(price === undefined ? {} : { price }),
  });

  it("counts priced sales separately, so volume has a visible denominator", () => {
    const t = totalSales([
      sale("100", "TradePort"),
      sale(undefined, "TradePort"),
      sale("50", "BlueMove"),
    ]);
    expect(t.sales).toBe(3);
    expect(t.priced_sales).toBe(2);
    expect(t.volume_mist).toBe("150");
    expect(t.by_marketplace.TradePort).toEqual({ sales: 2, volume_mist: "100" });
  });

  it("a malformed amount costs its own sale, never the total", () => {
    const t = totalSales([sale("abc", "TradePort"), sale("10", "TradePort")]);
    expect(t.volume_mist).toBe("10");
    expect(t.priced_sales).toBe(1);
  });

  it("handles amounts past Number.MAX_SAFE_INTEGER", () => {
    const big = "9007199254740993";
    expect(totalSales([sale(big, "X"), sale(big, "X")]).volume_mist).toBe("18014398509481986");
  });
});
