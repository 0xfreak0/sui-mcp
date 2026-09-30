import { z } from "zod";
import { numArg, boolArg } from "./args.js";
import { getNetwork } from "../config.js";
import { gqlQuery } from "../clients/graphql.js";
import { saveKioskOwners, storeStatus } from "../utils/store.js";
import { capPayload, type ListCap } from "../utils/output-cap.js";
import {
  canonicalType,
  ownershipFrom,
  readSale,
  saleEventTypes,
  totalSales,
  type KioskOwnership,
  type NftSale,
} from "../utils/nft-sales.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Marketplace sales over a bounded window.
 *
 * ## Why a window and not "all time"
 *
 * `events` filters by event type only, with no collection filter, so a
 * collection's sales are found by reading a marketplace's sales and keeping
 * the ones whose `nft_id` belongs to it. All-time on a busy marketplace is
 * unbounded paging, which is the context-burn this server exists to avoid. A
 * window is bounded, states its own edges, and answers the question anyone
 * actually asks. The floor is one request per registered event type.
 *
 * ## Events page OLDEST first
 *
 * So "recent sales" is `afterCheckpoint`, never paging to the end: the first
 * pages of a collection's events are its earliest trades, not its latest.
 */

const SALES_QUERY = `
  query($filter: EventFilter, $first: Int, $after: String) {
    events(filter: $filter, first: $first, after: $after) {
      nodes {
        contents { type { repr } json }
        timestamp
        transaction { digest effects { checkpoint { sequenceNumber } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface SaleEventNode {
  contents?: { type?: { repr?: string }; json?: unknown };
  timestamp?: string | null;
  transaction?: { digest?: string; effects?: { checkpoint?: { sequenceNumber?: number | string } } };
}

interface SalesPage {
  events: { nodes: SaleEventNode[]; pageInfo: { hasNextPage: boolean; endCursor?: string } };
}

/**
 * Checkpoints per second, used only to turn an hours argument into a bound.
 *
 * The mainnet checkpoint rate drifts over time, so any window derived from it
 * is approximate. That is why the response reports
 * `from_checkpoint`/`to_checkpoint` and the timestamps of the oldest and
 * newest sale actually read, rather than echoing `hours` back as though it
 * were the window covered.
 */
const CHECKPOINTS_PER_SECOND = 4.5;

const CURRENT_CHECKPOINT = `{ checkpoint { sequenceNumber } }`;

/** Characters the default view's sale records may take; the rest are counted under `omitted`. */
const SALE_RECORDS_BUDGET = 20_000;

async function currentCheckpoint(): Promise<number | null> {
  const d = await gqlQuery<{ checkpoint?: { sequenceNumber?: number | string } }>(
    CURRENT_CHECKPOINT,
    {},
  );
  const n = Number(d.checkpoint?.sequenceNumber ?? 0);
  return n > 0 ? n : null;
}

export function registerNftSalesTools(server: McpServer) {
  server.tool(
    "get_nft_sales",
    "NFT marketplace sales over a recent window, with volume and per-marketplace totals. Reads TradePort, BlueMove and OriginByte sale events. Also records which wallet holds which kiosk, which is what makes get_top_holders able to name a real owner for a kiosk-held NFT.",
    {
      hours: numArg()
        .min(1)
        .max(168)
        .optional()
        .default(24)
        .describe("How far back to read, in hours (default 24, max 168)"),
      collection_type: z
        .string()
        .optional()
        .describe(
          "Keep only sales of this Move type. Most sale events name no collection; those count as unattributable_sales, so a low count does not show the collection did not trade.",
        ),
      max_pages: numArg()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(40)
        .describe("Request cap across all marketplaces (default 40, 50 events per request)"),
      include_sales: boolArg()
        .optional()
        .default(false)
        .describe(
          "Also return each sale with its checkpoint and time (default false, since a busy window has thousands of rows).",
        ),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("With include_sales: 'summary' (default) lists the newest sales that fit and counts the rest in `omitted`; 'full' lists every sale."),
    },
    async ({ hours, collection_type, max_pages, include_sales, detail }) => {
      const network = getNetwork();
      const out = (o: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(o) }],
      });

      const tip = await currentCheckpoint();
      if (tip === null) {
        return out({
          error:
            "The current checkpoint could not be read, so a window cannot be bounded. This is a failed lookup, not an absence of sales.",
        });
      }
      const from = Math.max(tip - Math.round(hours * 3600 * CHECKPOINTS_PER_SECOND), 0);

      const sales: Array<NftSale & { checkpoint: number; timestamp: string | null }> = [];
      const ownership = new Map<string, KioskOwnership>();
      const unreadable: Record<string, number> = {};
      let requests = 0;
      let truncated = false;
      // Min and max over every type, not first-seen and last-seen. Each type is
      // paged separately, so assigning once at the start and overwriting at the
      // end would report an "oldest" sale later than the "newest" one whenever
      // more than one marketplace traded in the window.
      let oldest: string | null = null;
      let newest: string | null = null;
      const wanted = collection_type ? canonicalType(collection_type) : undefined;
      // Sales the filter cannot judge, because their marketplace does not emit
      // the collection type. Most sales carry no nft_type at all, so a
      // filtered result that did not say this would read as "this collection
      // did not trade" when it means "cannot tell".
      let unattributable = 0;
      const unread: string[] = [];

      for (const eventType of saleEventTypes()) {
        let cursor: string | undefined;
        // A type never queried is absent from the totals, which looks exactly
        // like a marketplace with no sales.
        if (requests >= max_pages) {
          unread.push(eventType);
          // Also truncated: when the budget runs out exactly on a type
          // boundary, whole marketplaces are skipped, and the read must not
          // report truncated: false beside a caveat saying it is incomplete.
          truncated = true;
          continue;
        }
        for (;;) {
          if (requests >= max_pages) {
            truncated = true;
            break;
          }
          requests++;
          const data = await gqlQuery<SalesPage>(SALES_QUERY, {
            // Bounded above too: a sale landing while the pages are read is
            // past `to_checkpoint`, and counting it would report more sales
            // than the stated window holds.
            filter: { type: eventType, afterCheckpoint: from, beforeCheckpoint: tip + 1 },
            first: 50,
            after: cursor ?? undefined,
          });

          for (const node of data.events.nodes) {
            const repr = node.contents?.type?.repr;
            if (!repr) continue;
            const checkpoint = Number(
              node.transaction?.effects?.checkpoint?.sequenceNumber ?? 0,
            );
            const sale = readSale(repr, node.contents?.json);
            if (!sale) {
              // A known event type whose shape did not parse is a changed
              // contract, which must not read as "nothing traded".
              unreadable[repr] = (unreadable[repr] ?? 0) + 1;
              continue;
            }
            // Ownership is harvested BEFORE the collection filter: a kiosk
            // mapping is true whatever collection the NFT belonged to, and
            // throwing away the others would waste data already paid for.
            if (checkpoint > 0) {
              for (const o of ownershipFrom(sale, checkpoint)) {
                const prior = ownership.get(o.kiosk_id);
                if (!prior || o.checkpoint > prior.checkpoint) ownership.set(o.kiosk_id, o);
              }
            }
            if (wanted) {
              if (!sale.nft_type) {
                unattributable++;
                continue;
              }
              if (sale.nft_type !== wanted) continue;
            }
            if (node.timestamp) {
              if (!oldest || node.timestamp < oldest) oldest = node.timestamp;
              if (!newest || node.timestamp > newest) newest = node.timestamp;
            }
            sales.push({ ...sale, checkpoint, timestamp: node.timestamp ?? null });
          }

          if (!data.events.pageInfo.hasNextPage) break;
          cursor = data.events.pageInfo.endCursor ?? undefined;
          if (!cursor) {
            truncated = true;
            break;
          }
        }
      }

      const rows = [...ownership.values()];
      const persisted = storeStatus().enabled
        ? saveKioskOwners(
            network,
            rows.map((r) => ({ kiosk_id: r.kiosk_id, owner: r.owner, checkpoint: r.checkpoint })),
          )
        : 0;

      const totals = totalSales(sales);
      const payload = {
        network,
        // The REQUESTED window. What was covered is from_checkpoint to
        // to_checkpoint, and the sale timestamps below bound what was actually
        // seen — the checkpoint rate drifts, so the two are not the same claim.
        requested_hours: hours,
        from_checkpoint: from,
        to_checkpoint: tip,
        ...(oldest ? { oldest_sale: oldest, newest_sale: newest } : {}),
        ...(collection_type ? { collection_type } : {}),
        ...totals,
        volume_sui: (Number(totals.volume_mist) / 1e9).toFixed(4),
        kiosk_owners_learned: rows.length,
        kiosk_owners_stored: persisted,
        requests,
        truncated,
        ...(truncated || unread.length
          ? {
              caveat: `INCOMPLETE: the ${max_pages}-request cap was reached, so this covers only part of the window and the totals are a lower bound. Narrow 'hours' or raise 'max_pages'.`,
            }
          : {}),
        ...(wanted && unattributable
          ? {
              unattributable_sales: unattributable,
              unattributable_note: `${unattributable} sales in this window could not be tested against collection_type because their marketplace does not emit the collection type in the event. Most TradePort sales are in this group. A low or zero count here is not evidence that the collection did not trade.`,
            }
          : {}),
        ...(unread.length
          ? {
              // Event types, not marketplaces: TradePort alone has seven, so
              // naming these "marketplaces" would say TradePort went unread
              // when most of it was read.
              event_types_not_read: unread,
              unread_note:
                "The request budget ran out before these event types were queried at all, so any sales they carry are missing from the totals rather than absent from the chain. Raise max_pages.",
            }
          : {}),
        ...(Object.keys(unreadable).length ? { unreadable_events: unreadable } : {}),
        ...(storeStatus().enabled
          ? {}
          : {
              note: "Kiosk ownership was read but not stored: set SUI_STORE_PATH so get_top_holders can use it.",
            }),
        // Not `sales`: `...totals` already puts the sale count there, and
        // spreading the array over it would leave the count reported nowhere.
        ...(include_sales ? { sale_records: sales } : {}),
      };
      type SaleRow = (typeof sales)[number];
      const { payload: shown } = capPayload(
        "get_nft_sales",
        { hours, collection_type, max_pages, include_sales },
        payload,
        {
          sale_records: {
            budget: SALE_RECORDS_BUDGET,
            rank: (a: SaleRow, b: SaleRow) => b.checkpoint - a.checkpoint,
            brief: (r: SaleRow) => ({ nft_id: r.nft_id, checkpoint: r.checkpoint, timestamp: r.timestamp, marketplace: r.marketplace }),
          } satisfies ListCap<SaleRow>,
        },
        { full: detail === "full", next_call: { tool: "get_nft_sales", repeat_with: { detail: "full" } } },
      );
      // `truncated` already says whether the read covered the window; a capped
      // list is a second reason, and the spread above would hide it.
      return out(shown.omitted ? { ...shown, truncated: true } : shown);
    },
  );
}
