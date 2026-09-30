/**
 * NFTs, valued as estimates from their collection's market. The pricing rule
 * is `nft-market.ts` and its sources are `nft-market-read.ts`. Every value is
 * tier heuristic and says so.
 *
 * `value` walks the owner's kiosks and directly owned objects and returns one
 * position per collection held; `valueObject` values one item.
 *
 * The reader is a fallback. A type another reader handles is valued by that
 * reader, and `value` skips it, so no object is counted twice. Types defined
 * by the Move standard library, the Sui framework or Sui system (coins,
 * kiosks, caps, stakes, fields) are never NFTs here.
 */

import { canonicalType } from "../nft-sales.js";
import { readHeldCollections } from "../nft-holdings.js";
import { collectionMarkets, collectionPresence, type CollectionMarket, type CollectionPresence } from "../nft-market-read.js";
import { estimateUnit, MARKET_WINDOW_DAYS } from "../nft-market.js";
import {
  prepareReaders,
  readerFor,
  registerValuer,
  type ObjectToValue,
  type ValuationContext,
  type ValuedPosition,
  type ValuerResult,
} from "../position-value.js";
import type { PricePoint } from "../valuation.js";
import { priceCoinTypes, SUI_TYPE, valuationTime } from "./common.js";

export const NFT_VALUER = "nft";

/** Collections valued per owner, most-held first; the rest are reported as not valued. */
export const MAX_COLLECTIONS = 100;

const FRAMEWORK_TYPE = /^0x0{63}[123]::/;

/** A type the Move standard library, the Sui framework or Sui system defines. */
export function isFrameworkType(type: string): boolean {
  return FRAMEWORK_TYPE.test(canonicalType(type));
}

const mistToSui = (mist: string): number => Number(mist) / 1e9;

/**
 * One collection's holding as a position: `count` items at the estimated unit
 * value. `objectId` is set when the position is one item.
 */
export function nftPosition(
  market: CollectionMarket,
  count: number,
  objectId: string | null,
  asOfSec: number,
  sui: PricePoint | undefined,
): ValuedPosition {
  const est = estimateUnit(market.floor, market.last_sale, { asOfSec, floorRead: market.floor_read });
  const unitSui = est.unit_mist === null ? null : mistToSui(est.unit_mist);
  const unitUsd = unitSui !== null && sui ? unitSui * sui.price : null;
  const usd = unitUsd === null ? null : unitUsd * count;
  const window = `in the ${MARKET_WINDOW_DAYS} days before the valuation time`;
  const past = market.floor_read ? "" : " Listings are read at the current state only, so none count for a past time.";
  const basis =
    est.basis === "lower_of_floor_and_last_sale"
      ? `each item at the lower of the collection's lowest active listing and its last sale ${window}`
      : est.basis === "floor"
        ? `each item at the collection's lowest active listing, placed ${window}, with no counted sale in that window`
        : est.basis === "last_sale"
          ? `each item at the collection's last sale ${window}, with no active listing found`
          : `each item at the lower of the collection's lowest active listing and its last sale ${window}, and neither could be used`;
  const floorCounted = est.basis === "lower_of_floor_and_last_sale" || est.basis === "floor";
  const saleCounted = est.basis === "lower_of_floor_and_last_sale" || est.basis === "last_sale";
  const priced = sui ? `, converted from SUI at the ${sui.source} price at ${new Date(sui.publishTime * 1000).toISOString()}` : "";
  const position: ValuedPosition = {
    protocol: null,
    kind: "nft",
    object_id: objectId,
    assets: [{ coin_type: market.collection, amount: String(count), side: "item", usd }],
    usd_net: usd,
    method: `Estimate: ${basis}${priced}. Sales at zero, between one address or one kiosk, or where one side first funded the other are left out.${past}`,
    tier: "heuristic",
    detail: {
      estimate: true,
      collection: market.collection,
      count,
      unit_sui: unitSui,
      unit_usd: unitUsd,
      basis: est.basis,
      sui_usd: sui ? { price: sui.price, source: sui.source, at: new Date(sui.publishTime * 1000).toISOString(),
        price_offset_sec: sui.publishTime - asOfSec, ...(sui.market ? { market: sui.market } : {}) } : null,
      window_days: MARKET_WINDOW_DAYS,
      floor: market.floor
        ? {
            sui: mistToSui(market.floor.price_mist),
            listed_at: market.floor.listed_at,
            source: market.floor.source,
            ...(market.floor.listing_id ? { listing_id: market.floor.listing_id } : {}),
            ...(market.floor.nft_id ? { nft_id: market.floor.nft_id } : {}),
            counted: floorCounted,
          }
        : null,
      last_sale: market.last_sale
        ? {
            sui: mistToSui(market.last_sale.price_mist),
            at: market.last_sale.at,
            marketplace: market.last_sale.marketplace,
            digest: market.last_sale.digest,
            nft_id: market.last_sale.nft_id,
            counted: saleCounted,
          }
        : null,
      ...(market.wash_check ? { wash_check: market.wash_check } : {}),
      ...(market.excluded_sales.length
        ? {
            excluded_sales: market.excluded_sales.slice(0, 3).map((s) => ({ digest: s.digest, sui: mistToSui(s.price_mist), reason: s.reason })),
            excluded_sales_count: market.excluded_sales.length,
          }
        : {}),
      listings_seen: market.listings_seen,
      ...(market.sales_unattributed ? { sales_unattributed: market.sales_unattributed } : {}),
      ...(market.not_read.length ? { not_read: market.not_read } : {}),
    },
  };
  if (usd === null) {
    position.unpriced_reason = !market.has_market
      ? market.not_read.length
        ? `The collection's market could not be read: ${market.not_read.map((n) => `${n.what}: ${n.reason}`).join("; ")}.`
        : "No market this server reads: no transfer policy, orderbook, listing or sale was found for the collection."
      : est.unit_mist === null
        ? `${est.unpriced_reason![0].toUpperCase()}${est.unpriced_reason!.slice(1)}.`
        : "No SUI price for the valuation time.";
  }
  return position;
}

async function valueHoldings(ctx: ValuationContext): Promise<ValuerResult> {
  if (ctx.atCheckpoint !== undefined || ctx.atTime !== undefined) {
    return {
      positions: [],
      unread: [{ what: NFT_VALUER, reason: "NFT holdings are read at the latest state only, so none are valued for a past time." }],
    };
  }
  const held = await readHeldCollections(ctx.owner);
  const unread: ValuerResult["unread"] = [];
  if (held.kiosks_unread > 0) {
    unread.push({ what: NFT_VALUER, reason: `${held.kiosks_unread} kiosk(s) could not be read, so their items are not valued.` });
  }
  // A directly owned object of a type another fallback reader takes (one
  // whose fields hold coins) is valued by that reader's own walk; the same
  // type held in a kiosk is an item here.
  await prepareReaders([...held.direct.keys()]);
  const types = [...held.counts]
    .filter(([type]) => !isFrameworkType(type) && readerFor(type, true) === null)
    .map(([type, count]): [string, number] => [type, readerFor(type) === NFT_VALUER ? count : count - (held.direct.get(type) ?? 0)])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const valued = types.slice(0, MAX_COLLECTIONS);
  if (types.length > valued.length) {
    const rest = types.slice(MAX_COLLECTIONS);
    unread.push({
      what: NFT_VALUER,
      reason: `${rest.length} collection(s) holding ${rest.reduce((s, [, n]) => s + n, 0)} item(s) not valued: past the ${MAX_COLLECTIONS} most-held collections.`,
    });
  }
  if (valued.length === 0) return { positions: [], unread };
  const asOfSec = Math.floor(Date.now() / 1000);
  const [markets, prices] = await Promise.all([
    collectionMarkets(valued.map(([type]) => type), { asOfSec }),
    priceCoinTypes([SUI_TYPE], ctx),
  ]);
  const sui = prices.points.get(SUI_TYPE);
  return {
    positions: valued.map(([type, count]) => nftPosition(markets.get(canonicalType(type))!, count, null, asOfSec, sui)),
    unread,
  };
}

/** What one batch of item valuations read, shared by every item in it. */
interface BatchRead {
  presence: Map<string, CollectionPresence>;
  markets: Map<string, CollectionMarket>;
  /** Types past {@link MAX_COLLECTIONS} in the batch, left unvalued. */
  capped: Set<string>;
  /** Types in the batch, for the note on the capped ones. */
  types: number;
  asOfSec: number;
  sui: PricePoint | undefined;
}

interface ItemBatch {
  /** Items per type, filled while the batch is open. */
  counts: Map<string, number>;
  read: Promise<BatchRead>;
}

/** Open batches per call scope (the call's memo, else its context) and valuation time. */
const openBatches = new WeakMap<object, Map<string, ItemBatch>>();

/**
 * The batch an item valuation joins. `valueObjects` starts every object's
 * valuation in one synchronous loop, so each item joins before the read
 * begins on the next timer turn. The whole batch then shares one presence
 * read and one market read, and so one first-funder budget, as a wallet's
 * holdings do in `value`.
 */
function joinBatch(type: string, ctx: ValuationContext): Promise<BatchRead> {
  const scope = ctx.memo ?? ctx;
  const key = ctx.atCheckpoint !== undefined ? `cp:${ctx.atCheckpoint}` : ctx.atTime !== undefined ? `t:${ctx.atTime}` : "latest";
  let open = openBatches.get(scope);
  if (!open) openBatches.set(scope, (open = new Map()));
  let batch = open.get(key);
  if (!batch) {
    const counts = new Map<string, number>();
    const opened = open;
    const read = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
      opened.delete(key);
      return readBatch(counts, ctx);
    });
    batch = { counts, read };
    open.set(key, batch);
  }
  batch.counts.set(type, (batch.counts.get(type) ?? 0) + 1);
  return batch.read;
}

const isItemType = (p: CollectionPresence): boolean =>
  p.policies.length > 0 || p.orderbooks.length > 0 || p.tradeport_field !== null || p.display || p.unread.length > 0;

async function readBatch(counts: Map<string, number>, ctx: ValuationContext): Promise<BatchRead> {
  const ranked = [...counts].sort((a, b) => b[1] - a[1]).map(([type]) => type);
  const kept = ranked.slice(0, MAX_COLLECTIONS);
  const capped = new Set(ranked.slice(MAX_COLLECTIONS));
  // Presence does not depend on the valuation time, so a scan over many
  // transactions asks once per type, and a type that is no NFT stops here.
  const presence = await collectionPresence(kept);
  const items = kept.filter((t) => isItemType(presence.get(t)!));
  const historical = ctx.atCheckpoint !== undefined || ctx.atTime !== undefined;
  const asOfSec = (items.length > 0 ? await valuationTime(ctx) : undefined) ?? Math.floor(Date.now() / 1000);
  const markets =
    items.length > 0
      ? await collectionMarkets(items, { asOfSec, historical, ...(ctx.atCheckpoint !== undefined ? { atCheckpoint: Number(ctx.atCheckpoint) } : {}) })
      : new Map<string, CollectionMarket>();
  const priced = [...markets.values()].some((m) => m.floor || m.last_sale);
  const sui = priced ? (await priceCoinTypes([SUI_TYPE], ctx)).points.get(SUI_TYPE) : undefined;
  return { presence, markets, capped, types: ranked.length, asOfSec, sui };
}

/**
 * A claim on a pool or vault rather than a collectible: its JSON names the
 * pool (`pool_id`, `vault_id`, `pool`, `vault`) and holds a share balance.
 * Its worth is that share of the pool, which no market for the type prices.
 */
export function receiptOf(json: Record<string, unknown> | null): { pool: string; field: string } | null {
  if (!json) return null;
  const pool = ["pool_id", "vault_id", "pool", "vault"].map((k) => json[k]).find((v): v is string => typeof v === "string" && /^0x[0-9a-f]{1,64}$/i.test(v));
  if (!pool) return null;
  const field = Object.keys(json).find((k) => /balance|share|xtoken|lp_amount|lp_token/i.test(k) && /^\d+$/.test(String(json[k])) && String(json[k]) !== "0");
  return field ? { pool, field } : null;
}

async function valueItem(obj: ObjectToValue, ctx: ValuationContext): Promise<ValuerResult> {
  const receipt = receiptOf(obj.json);
  if (receipt) {
    return {
      positions: [],
      unread: [
        {
          what: obj.object_id,
          reason: `Not valued: a receipt on pool ${receipt.pool} holding ${receipt.field} ${String(obj.json![receipt.field])}; no reader values that pool's shares, and it is not an NFT.`,
        },
      ],
    };
  }
  const type = canonicalType(obj.type);
  const batch = await joinBatch(type, ctx);
  if (batch.capped.has(type)) {
    return {
      positions: [],
      unread: [
        {
          what: obj.object_id,
          reason: `Not valued: ${batch.capped.size} of the ${batch.types} collections valued together are past the ${MAX_COLLECTIONS} with the most items, and this item's is one of them.`,
        },
      ],
    };
  }
  if (!isItemType(batch.presence.get(type)!)) {
    return {
      positions: [],
      unread: [{ what: obj.object_id, reason: "Not valued as an NFT: its type has no Display, transfer policy, orderbook or TradePort listing." }],
    };
  }
  return { positions: [nftPosition(batch.markets.get(type)!, 1, obj.object_id, batch.asOfSec, batch.sui)], unread: [] };
}

registerValuer({
  name: NFT_VALUER,
  fallback: true,
  handles: (type) => !isFrameworkType(type),
  value: valueHoldings,
  valueObject: valueItem,
});
