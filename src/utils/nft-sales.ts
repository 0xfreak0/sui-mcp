/**
 * Reading a marketplace sale out of its event.
 *
 * Pure. The network half is `src/tools/nft-sales.ts`.
 *
 * ## Why the field names are a list rather than a constant
 *
 * Every marketplace names the same three things differently, and the names were
 * read off real mainnet events rather than guessed:
 *
 *   TradePort listings       nft_id, seller, buyer, price
 *   TradePort kiosk_listings nft_id, seller, seller_kiosk_id, buyer, buyer_kiosk_id, price
 *   TradePort simple listing nft_id, seller, buyer, price, maybe_seller_kiosk_id, maybe_buyer_kiosk_id
 *   BlueMove marketplace     item_id, amount, buyer            (no seller)
 *   OriginByte orderbook     nft, seller, seller_kiosk, buyer, buyer_kiosk, price
 *
 * So a sale is read by trying each known spelling. An unknown shape yields null
 * and is counted as unreadable rather than skipped silently, because "this
 * marketplace changed its event" and "nothing traded" must not look alike.
 *
 * ## The kiosk mapping is the valuable half
 *
 * `get_top_holders` attributes a kiosk-held NFT through the kiosk's own `owner`
 * field, which does not follow the `KioskOwnerCap` and disagrees with the real
 * holder 40% of the time. These events carry `buyer` beside `buyer_kiosk_id` in
 * the same record, which is a chain-derived statement that at this checkpoint
 * that wallet owned that kiosk. Measured on mainnet: 600 TradePort sale events
 * produced 185 distinct kiosk-to-wallet mappings, and one 24-hour window on a
 * single package produced 54.
 *
 * A mapping is a snapshot, not a permanent fact — a kiosk can be sold — so each
 * one carries the checkpoint it was observed at and a later observation wins.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface SaleEventEntry {
  type: string;
  marketplace: string;
  priced: boolean;
}

const registry: Map<string, SaleEventEntry> = new Map();
{
  const raw = require("../data/nft-sale-events.json") as { events: SaleEventEntry[] };
  for (const e of raw.events) registry.set(e.type, e);
}

/**
 * Canonical form of a Move type, so two spellings of one type compare equal.
 *
 * Marketplace events emit the defining address WITHOUT the `0x` prefix and
 * unpadded — a live BlueMove sale carries
 * `2dcd5252…::bluemove_launchpad::SUIS` — while every other surface in this
 * server, `nft-collections.json` included, uses the padded `0x` form. An exact
 * string compare between the two never matches, so a caller filtering by the
 * type they got from any other tool silently saw no sales.
 */
export function canonicalType(moveType: string): string {
  const parts = moveType.trim().split("::");
  if (parts.length < 3) return moveType.trim();
  const [addr, ...rest] = parts;
  try {
    return [normalizeSuiAddress(addr!.toLowerCase()), ...rest].join("::");
  } catch {
    return moveType.trim();
  }
}

/** Every sale event type this server knows how to read. */
export function saleEventTypes(): string[] {
  return [...registry.keys()];
}

export function marketplaceFor(eventType: string): string | undefined {
  return registry.get(eventType)?.marketplace;
}

/** One NFT changing hands, as read from a marketplace event. */
export interface NftSale {
  nft_id: string;
  nft_type?: string;
  buyer?: string;
  seller?: string;
  /** Raw MIST. Absent when the event records custody without an amount. */
  price?: string;
  buyer_kiosk_id?: string;
  seller_kiosk_id?: string;
  marketplace: string;
  event_type: string;
}

/** "At this checkpoint, this wallet held this kiosk." Chain-derived. */
export interface KioskOwnership {
  kiosk_id: string;
  owner: string;
  checkpoint: number;
}

const NFT_ID_FIELDS = ["nft_id", "item_id", "nft", "token_id"] as const;
const PRICE_FIELDS = ["price", "amount", "sale_price"] as const;
const BUYER_KIOSK_FIELDS = ["buyer_kiosk_id", "maybe_buyer_kiosk_id", "buyer_kiosk"] as const;
const SELLER_KIOSK_FIELDS = ["seller_kiosk_id", "maybe_seller_kiosk_id", "seller_kiosk"] as const;

/** A field's value only if it is a non-empty string. The json blob is untyped. */
function str(json: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = json[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Read a sale from one event's decoded fields.
 *
 * Returns null when the type is not a known sale event, or when the record
 * carries no NFT id — without one the row cannot be joined to anything and is
 * not worth reporting as a sale.
 */
export function readSale(eventType: string, json: unknown): NftSale | null {
  const entry = registry.get(eventType);
  if (!entry) return null;
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const j = json as Record<string, unknown>;

  const nft_id = str(j, NFT_ID_FIELDS);
  if (!nft_id) return null;

  const price = str(j, PRICE_FIELDS);
  return {
    nft_id,
    ...(str(j, ["nft_type"]) ? { nft_type: canonicalType(str(j, ["nft_type"])!) } : {}),
    ...(str(j, ["buyer"]) ? { buyer: str(j, ["buyer"]) } : {}),
    ...(str(j, ["seller"]) ? { seller: str(j, ["seller"]) } : {}),
    // Only from an event that carries an amount. A claim event has a buyer and
    // no price, and counting it as a zero-value sale would drag an average down
    // with trades that were never priced.
    ...(entry.priced && price ? { price } : {}),
    ...(str(j, BUYER_KIOSK_FIELDS) ? { buyer_kiosk_id: str(j, BUYER_KIOSK_FIELDS) } : {}),
    ...(str(j, SELLER_KIOSK_FIELDS) ? { seller_kiosk_id: str(j, SELLER_KIOSK_FIELDS) } : {}),
    marketplace: entry.marketplace,
    event_type: eventType,
  };
}

/**
 * The kiosk ownership a sale states outright.
 *
 * Both legs count. The buyer's kiosk is where the NFT landed, and the seller's
 * is where it came from — the seller held that kiosk at this checkpoint just as
 * surely, and dropping it halves the yield for nothing.
 */
export function ownershipFrom(sale: NftSale, checkpoint: number): KioskOwnership[] {
  const out: KioskOwnership[] = [];
  if (sale.buyer_kiosk_id && sale.buyer) {
    out.push({ kiosk_id: sale.buyer_kiosk_id, owner: sale.buyer, checkpoint });
  }
  if (sale.seller_kiosk_id && sale.seller) {
    out.push({ kiosk_id: sale.seller_kiosk_id, owner: sale.seller, checkpoint });
  }
  return out;
}

export interface SaleTotals {
  sales: number;
  /** Sales carrying an amount. Volume is a claim about these, not about `sales`. */
  priced_sales: number;
  volume_mist: string;
  by_marketplace: Record<string, { sales: number; volume_mist: string }>;
}

/**
 * Total a set of sales.
 *
 * `volume_mist` is a sum over `priced_sales` only, and both counts are reported
 * so a reader can see the denominator rather than dividing volume by a sale
 * count that includes unpriced custody events.
 */
export function totalSales(sales: NftSale[]): SaleTotals {
  let volume = 0n;
  let priced = 0;
  const by: Record<string, { sales: number; volume: bigint }> = {};

  for (const s of sales) {
    const slot = (by[s.marketplace] ??= { sales: 0, volume: 0n });
    slot.sales++;
    if (s.price === undefined) continue;
    let v: bigint;
    try {
      v = BigInt(s.price);
    } catch {
      // A malformed amount costs this sale its contribution, never the total.
      continue;
    }
    if (v < 0n) continue;
    volume += v;
    slot.volume += v;
    priced++;
  }

  return {
    sales: sales.length,
    priced_sales: priced,
    volume_mist: volume.toString(),
    by_marketplace: Object.fromEntries(
      Object.entries(by).map(([k, v]) => [k, { sales: v.sales, volume_mist: v.volume.toString() }]),
    ),
  };
}
