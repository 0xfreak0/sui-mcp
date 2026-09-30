import { z } from "zod";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { numArg, addressArg, boolArg } from "./args.js";
import { canonicalType } from "../utils/nft-sales.js";
import { MARKET_WINDOW_DAYS } from "../utils/nft-market.js";
import { capPayload, capRows, type ListCap } from "../utils/output-cap.js";
import { readerFor, valueObjects, valuePositions, type ValuedPosition, type ValuerResult } from "../utils/position-value.js";
import "../utils/valuers/index.js";
import { isFrameworkType, NFT_VALUER } from "../utils/valuers/nft.js";
import {
  discoverKiosks,
  listDirectNftsPage,
  readHeldCollections,
  scanKioskPage,
  type NftEntry,
} from "../utils/nft-holdings.js";
import { clampPageSize } from "../utils/pagination.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Cursor encoding for resumable list_nfts
// ---------------------------------------------------------------------------

interface ListNftsCursor {
  v: 1;
  // Kiosk IDs captured at first call. Stored on the cursor so subsequent
  // pages don't re-discover (which protects ordering if the wallet mints
  // a new kiosk mid-pagination).
  kiosks: string[];
  // Index of the kiosk currently being scanned. When >= kiosks.length we're
  // past the kiosk phase and into direct-owned.
  ki: number;
  // GraphQL cursor inside the current kiosk's dynamicFields connection.
  // null = start of that kiosk.
  kc: string | null;
  // GraphQL cursor for direct-owned objects pagination. Only consulted once
  // ki >= kiosks.length.
  dc: string | null;
  // Kiosks the wallet had in total. The cursor carries only the kiosks not
  // yet drained, so this keeps kiosk_count whole across pages.
  n?: number;
}

/** Drained kiosks are dropped from the cursor; `ki` then restarts at the first kept one. */
function encodeCursor(c: ListNftsCursor): string {
  const rest = { ...c, kiosks: c.kiosks.slice(c.ki), ki: 0, n: c.n ?? c.kiosks.length };
  return Buffer.from(JSON.stringify(rest)).toString("base64url");
}

function decodeCursor(s: string): ListNftsCursor {
  try {
    const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as ListNftsCursor;
    if (parsed.v !== 1 || !Array.isArray(parsed.kiosks) || typeof parsed.ki !== "number") {
      throw new Error("malformed cursor");
    }
    return parsed;
  } catch (err) {
    throw new Error(`invalid cursor: ${(err as Error).message}`);
  }
}

export function registerNftTools(server: McpServer) {
  server.tool(
    "list_nfts",
    "(Recommended for NFTs) List NFTs owned by a wallet, including kiosk-stored NFTs. Each row has an object id, `collection_ref` (zero-based index into this page's exact `collection_types`), kiosk and display metadata. `detail: 'full'` adds raw Move contents and valuation evidence. `est_usd` is a heuristic NFT estimate; other valued objects carry `value_usd` and a tier. `value: false` skips valuation. Pass `next_cursor` as `cursor` for the next page; its absence means the wallet is fully enumerated. Use list_nft_collections for a per-collection summary and wallet total.",
    {
      address: addressArg().describe("Owner wallet address (0x...)"),
      limit: numArg()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Most NFTs to return (default 50, max 1000)."),
      cursor: z
        .string()
        .optional()
        .describe("Opaque pagination token from a prior response's `next_cursor`. Omit on first call."),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("'summary' (default): display fields only, and `omitted` counts the NFTs whose raw contents were left out. 'full' adds each NFT's raw Move struct contents."),
      value: boolArg()
        .optional()
        .default(true)
        .describe("Estimate each NFT's value from its collection's market (default true). Costs a few requests per collection on the page."),
    },
    async ({ address, limit, cursor, detail, value }) => {
      const target = clampPageSize(limit);
      const buildResponse = async (state: ListNftsCursor, nfts: NftEntry[], done: boolean) =>
        nftPage(address, state, nfts, done, detail === "full", value === false ? null : await valueNfts(address, nfts));

      // Initialize state: either resume from cursor or discover kiosks fresh.
      let state: ListNftsCursor;
      if (cursor) {
        state = decodeCursor(cursor);
      } else {
        const kiosks = await discoverKiosks(address);
        state = { v: 1, kiosks, ki: 0, kc: null, dc: null };
      }

      const nfts: NftEntry[] = [];

      // Phase 1: walk kiosks. Each iteration either fills the current kiosk's
      // remaining items or advances to the next kiosk.
      while (state.ki < state.kiosks.length && nfts.length < target) {
        const remaining = target - nfts.length;
        const kioskId = state.kiosks[state.ki];
        try {
          const { items, nextInnerCursor } = await scanKioskPage(kioskId, state.kc, remaining, true);
          nfts.push(...items);
          if (nextInnerCursor) {
            // Hit the target mid-kiosk; pause here. The next call resumes
            // exactly where we left off.
            state.kc = nextInnerCursor;
            return buildResponse(state, nfts, /*done*/ false);
          }
          // Kiosk drained — advance to the next one.
          state.ki += 1;
          state.kc = null;
        } catch {
          // Kiosk fetch failed (e.g. destroyed mid-pagination). Skip it
          // rather than wedging the entire walk.
          state.ki += 1;
          state.kc = null;
        }
      }

      // The target can land exactly on a kiosk boundary: the kiosk just
      // scanned drains with no remainder, so `nextInnerCursor` above is null
      // while kiosks the walk has not reached still sit in `state.kiosks`.
      // Unvisited kiosks mean more remains, so the page is not done, and no
      // extra query is needed to know it.
      if (state.ki < state.kiosks.length) {
        return buildResponse(state, nfts, /*done*/ false);
      }

      // Phase 2: walk direct-owned objects. Only entered after every kiosk is
      // drained. We rely on `state.dc` to resume across calls.
      //
      // Runs even when the target is already met by kiosks alone: the target
      // can also land exactly where the kiosks end, so the wallet is declared
      // fully enumerated only after checking that no direct-owned object
      // follows. With no budget left, this probes for one item without
      // keeping it or moving `state.dc`, so a `limit`-sized page never grows
      // and the probed item is picked up cleanly on the next real page.
      const remaining = target - nfts.length;
      const probing = remaining <= 0;
      const { items, nextCursor: nextDc } = await listDirectNftsPage(
        address,
        state.dc,
        probing ? 1 : remaining,
        !probing,
      );
      const moreDirect = probing ? items.length > 0 || nextDc !== null : nextDc !== null;
      if (!probing) nfts.push(...items);
      if (moreDirect) {
        if (!probing) state.dc = nextDc;
        return buildResponse(state, nfts, /*done*/ false);
      }
      state.dc = null;

      // Both phases drained.
      return buildResponse(state, nfts, /*done*/ true);
    },
  );

  server.tool(
    "list_nft_collections",
    `Summary of the NFT collections a wallet holds: every kiosk plus directly owned objects, one row per collection type with its count. Each collection carries an estimated value (tier heuristic): per item, the lower of the collection's lowest active listing and its last sale in the ${MARKET_WINDOW_DAYS} days before now, or whichever of the two exists (a listing alone only if placed in that window), with zero-price sales, sales within one address or kiosk, and sales where one side first funded the other left out; unpriced otherwise. \`estimated_value\` totals every collection; the default view keeps every priced collection and caps the rest, and \`detail: 'full'\` returns all rows. \`value: false\` skips the valuation.`,
    {
      address: addressArg().describe("Owner wallet address (0x...)"),
      value: boolArg()
        .optional()
        .default(true)
        .describe("Estimate each collection's value from its market (default true). Costs a few requests per collection that has a market."),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("'summary' (default): priced collections plus the most-held others that fit, the rest counted under `omitted`. 'full': every collection."),
    },
    async ({ address, value, detail }) => {
      const held = await readHeldCollections(address);
      type Row = { collection: string; count: number; value?: Record<string, unknown> };
      const rows: Row[] = [...held.counts]
        .map(([collection, count]) => ({ collection, count }))
        .sort((a, b) => b.count - a.count);
      const totals = {
        total_collections: rows.length,
        total_nfts: rows.reduce((sum, c) => sum + c.count, 0),
        kiosk_count: held.kiosk_count,
        ...(held.kiosks_unread ? { kiosks_unread: held.kiosks_unread } : {}),
      };

      let estimated: Record<string, unknown> | null = null;
      if (value !== false) {
        const valued = await valuePositions({ owner: address }, [NFT_VALUER]);
        const byType = new Map(valued.positions.map((p) => [canonicalType(p.assets[0].coin_type), p]));
        let usd = 0;
        const priced = { collections: 0, nfts: 0 };
        const unpriced = { collections: 0, nfts: 0 };
        const notValued = { collections: 0, nfts: 0 };
        let suiUsd: unknown = null;
        for (const row of rows) {
          const p = byType.get(canonicalType(row.collection));
          if (!p) {
            const other = readerFor(row.collection);
            row.value =
              other && other !== NFT_VALUER
                ? { valued_by: other }
                : { not_valued: isFrameworkType(row.collection) ? "a Sui framework object, not an NFT" : "left out of the valuation: see estimated_value.unread" };
            notValued.collections++;
            notValued.nfts += row.count;
            continue;
          }
          row.value = collectionValue(p);
          suiUsd ??= p.detail?.sui_usd ?? null;
          const bucket = p.usd_net === null ? unpriced : priced;
          bucket.collections++;
          bucket.nfts += row.count;
          if (p.usd_net !== null) usd += p.usd_net;
        }
        estimated = {
          usd: Math.round(usd * 100) / 100,
          estimate: true,
          tier: "heuristic",
          priced_collections: priced.collections,
          priced_nfts: priced.nfts,
          unpriced_collections: unpriced.collections,
          unpriced_nfts: unpriced.nfts,
          ...(notValued.collections ? { not_valued_collections: notValued.collections, not_valued_nfts: notValued.nfts } : {}),
          method: NFT_ESTIMATE_METHOD,
          ...(suiUsd ? { sui_usd: suiUsd } : {}),
          ...(valued.unread.length ? { unread: valued.unread } : {}),
        };
      }

      const usdOf = (r: Row) => (typeof r.value?.usd === "number" ? r.value.usd : null);
      const { payload } = capPayload(
        "list_nft_collections",
        { address, value },
        { address, ...totals, ...(estimated ? { estimated_value: estimated } : {}), collections: rows },
        {
          collections: {
            budget: 12_000,
            keep: (r: Row) => usdOf(r) !== null,
            rank: (a: Row, b: Row) => (usdOf(b) ?? -1) - (usdOf(a) ?? -1) || b.count - a.count,
            usd: usdOf,
            brief: (r: Row) => ({ collection: r.collection, count: r.count }),
          } satisfies ListCap<Row>,
        },
        { full: detail === "full", next_call: { tool: "list_nft_collections", repeat_with: { detail: "full" } } },
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
    },
  );
}

/** How every NFT estimate here is made, stated once per response. */
const NFT_ESTIMATE_METHOD = `Per item, the lower of the collection's lowest active listing and its last sale in the ${MARKET_WINDOW_DAYS} days before now, or whichever of the two exists; a listing prices an item alone only if placed or repriced in that window, and an item with neither is unpriced. Sales at zero, within one address or one kiosk, or where one side first funded the other are left out. Listings are read from the TradePort orderbook, TradePort kiosk listings, OriginByte orderbooks and kiosk listings; BlueMove listings and TradePort's older non-kiosk listings are not read.`;

type PageValuation = ValuerResult & { unhandled: string[] };

/** Value one page's NFTs, each by the reader that handles its type. A failed valuation leaves the page listed. */
async function valueNfts(owner: string, nfts: NftEntry[]): Promise<PageValuation> {
  try {
    return await valueObjects(
      nfts.map((n) => ({
        object_id: n.object_id,
        type: n.type,
        json: n.content && typeof n.content === "object" ? (n.content as Record<string, unknown>) : null,
      })),
      // One memo for the page, so its NFTs share one market read and its prices are asked once.
      { owner, memo: new Map() },
    );
  } catch (err) {
    return { positions: [], unread: [{ what: "valuation", reason: err instanceof Error ? err.message : String(err) }], unhandled: [] };
  }
}

/** A collection's valuation facts from its position, without the method it shares with every other row. */
function collectionValue(p: ValuedPosition): Record<string, unknown> {
  const d = p.detail ?? {};
  return {
    usd: p.usd_net,
    unit_sui: d.unit_sui,
    unit_usd: d.unit_usd,
    basis: d.basis,
    floor: d.floor,
    last_sale: d.last_sale,
    ...(d.excluded_sales_count ? { excluded_sales: d.excluded_sales, excluded_sales_count: d.excluded_sales_count } : {}),
    ...(d.wash_check ? { wash_check: d.wash_check } : {}),
    ...(p.unpriced_reason ? { unpriced: p.unpriced_reason } : {}),
  };
}

/**
 * One page of list_nfts. Each `collection_ref` indexes the page's exact
 * struct types. Fields with no value are left out. The summary leaves out raw contents and
 * each collection's valuation evidence, and counts both under `omitted` with
 * the call that returns them.
 */
function nftPage(
  address: string,
  state: ListNftsCursor,
  nfts: NftEntry[],
  done: boolean,
  full: boolean,
  valuation: PageValuation | null,
) {
  const withContent = nfts.filter((n) => n.content !== null).length;
  const byObject = new Map((valuation?.positions ?? []).filter((p) => p.object_id).map((p) => [normalizeSuiAddress(p.object_id!), p]));
  const rowValue = (n: NftEntry) => {
    const p = byObject.get(normalizeSuiAddress(n.object_id));
    if (!p) return {};
    // An estimate states four significant figures; more would claim a precision it does not have.
    if (p.kind === "nft") return { est_usd: p.usd_net === null ? null : Number(p.usd_net.toPrecision(4)) };
    return { value_usd: p.usd_net, valued_as: p.kind, ...(p.protocol ? { protocol: p.protocol } : {}), tier: p.tier };
  };
  const collectionRefs = new Map<string, number>();
  for (const n of nfts) {
    if (!collectionRefs.has(n.collection)) collectionRefs.set(n.collection, collectionRefs.size);
  }
  const rows = nfts.map((n) => ({
    object_id: n.object_id,
    collection_ref: collectionRefs.get(n.collection)!,
    ...(n.kiosk_id ? { kiosk_id: n.kiosk_id } : {}),
    ...(n.name !== null ? { name: n.name } : {}),
    ...(n.description !== null ? { description: n.description } : {}),
    ...(n.image_url !== null ? { image_url: n.image_url } : {}),
    ...rowValue(n),
    ...(full && n.content !== null ? { content: n.content } : {}),
  }));
  const page = valuation ? pageValuation(address, nfts, byObject, valuation, full, collectionRefs) : null;
  const omitted = {
    ...(!full && withContent ? { content: { count: withContent } } : {}),
    ...(page?.omitted ?? {}),
  };
  const payload = {
    ...(Object.keys(omitted).length
      ? { truncated: true, omitted: { ...omitted, next_call: { tool: "list_nfts", repeat_with: { detail: "full" } } } }
      : {}),
    address,
    collection_types: [...collectionRefs.keys()],
    ...(page ? { valuation: page.valuation } : {}),
    nfts: rows,
    page_size: nfts.length,
    kiosk_count: state.n ?? state.kiosks.length,
    ...(done ? {} : { next_cursor: encodeCursor(state) }),
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Characters the summary view's per-collection estimates may take. */
const PAGE_ESTIMATES_BUDGET = 3_000;

/**
 * The page's value: its total over the items with a value, how many have
 * none, and each NFT collection's estimate once rather than on every row.
 * The summary view lists priced collections by their unit value and basis,
 * most page value first within {@link PAGE_ESTIMATES_BUDGET}; the evidence
 * (floor, last sale, wash check, why a collection is unpriced) is in the full
 * view and in list_nft_collections.
 */
function pageValuation(
  address: string,
  nfts: NftEntry[],
  byObject: Map<string, ValuedPosition>,
  valuation: PageValuation,
  full: boolean,
  collectionRefs: Map<string, number>,
) {
  let usd = 0;
  let priced = 0;
  let unpriced = 0;
  const collections = new Map<string, { position: ValuedPosition; page_usd: number | null }>();
  for (const n of nfts) {
    const p = byObject.get(normalizeSuiAddress(n.object_id));
    if (!p) continue;
    if (p.usd_net === null) unpriced++;
    else {
      usd += p.usd_net;
      priced++;
    }
    if (p.kind !== "nft") continue;
    const seen = collections.get(n.collection);
    if (!seen) collections.set(n.collection, { position: p, page_usd: p.usd_net });
    else if (seen.page_usd !== null && p.usd_net !== null) seen.page_usd += p.usd_net;
  }
  const reasons = new Map<string, number>();
  for (const u of valuation.unread) reasons.set(u.reason, (reasons.get(u.reason) ?? 0) + 1);
  const all = [...collections];
  const pricedCollections = all.filter(([, c]) => c.page_usd !== null);
  let estimates: Array<Record<string, unknown>>;
  let omitted: Record<string, unknown> | null = null;
  if (full) {
    estimates = all.map(([collection, c]) => {
      const { usd: _one, ...facts } = collectionValue(c.position);
      return { collection_ref: collectionRefs.get(collection)!, ...facts };
    });
  } else {
    type Brief = { collection_ref: number; unit_sui: unknown; basis: unknown; page_usd: number };
    const briefs: Brief[] = pricedCollections.map(([collection, c]) => ({
      collection_ref: collectionRefs.get(collection)!,
      unit_sui: c.position.detail?.unit_sui,
      basis: c.position.detail?.basis,
      page_usd: Number(c.page_usd!.toPrecision(4)),
    }));
    const capped = capRows(briefs, {
      budget: PAGE_ESTIMATES_BUDGET,
      rank: (a, b) => b.page_usd - a.page_usd,
      usd: (b) => b.page_usd,
      brief: (b) => ({ collection_ref: b.collection_ref, page_usd: b.page_usd }),
    });
    estimates = capped.rows;
    if (all.length > 0) {
      omitted = {
        valuation_evidence: {
          collections: all.length,
          ...(capped.omitted ? { priced_collections_not_listed: capped.omitted } : {}),
          next_call: { tool: "list_nft_collections", args: { address } },
        },
      };
    }
  }
  return {
    valuation: {
      usd: Math.round(usd * 100) / 100,
      priced,
      unpriced,
      not_valued: nfts.length - priced - unpriced,
      nft_estimates: {
        tier: "heuristic",
        method: NFT_ESTIMATE_METHOD,
        ...(full ? {} : { unpriced_collections: all.length - pricedCollections.length }),
        collections: estimates,
      },
      ...(reasons.size ? { unread: [...reasons].map(([reason, count]) => ({ reason, count })) } : {}),
    },
    omitted,
  };
}
