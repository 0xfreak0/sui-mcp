import { z } from "zod";
import { numArg, boolArg } from "./args.js";
import { getNetwork } from "../config.js";
import { gqlQuery } from "../clients/graphql.js";
import { saveKioskOwners, storeStatus } from "../utils/store.js";
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
 * `events` has no collection filter — only an event type — so a collection's
 * sales are found by reading a marketplace's sales and keeping the ones whose
 * `nft_id` belongs to it. All-time on a busy marketplace is unbounded paging,
 * which is the context-burn this server exists to avoid. A window is bounded,
 * states its own edges, and answers the question anyone actually asks.
 *
 * Measured on mainnet, a 24-hour window across every registered event type: 13
 * requests, 237 sales, 5,982 SUI, and 249 kiosk-to-wallet mappings. The floor
 * is one request per registered type.
 *
 * ## Events page OLDEST first
 *
 * So "recent sales" is `afterCheckpoint`, never paging to the end. Getting this
 * wrong reported a collection's volume as a fraction of the real figure, twice,
 * because the first pages were its earliest trades rather than its latest.
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
 * Mainnet measured 4.50 in September 2026, against 4.25 earlier in the year, so
 * this drifts and any window derived from it is approximate. That is why the
 * response reports `from_checkpoint`/`to_checkpoint` and the timestamps of the
 * oldest and newest sale actually read, rather than echoing `hours` back as
 * though it were the window covered.
 */
const CHECKPOINTS_PER_SECOND = 4.5;

const CURRENT_CHECKPOINT = `{ checkpoint { sequenceNumber } }`;

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
          "Keep only sales of this Move type. Most marketplaces do not name the collection in the sale event, and those sales are reported as unattributable_sales rather than filtered out silently — a low count here is not evidence the collection did not trade.",
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
          "Return every individual sale as well as the totals. Off by default because a busy window is thousands of rows.",
        ),
    },
    async ({ hours, collection_type, max_pages, include_sales }) => {
      const network = getNetwork();
      const out = (o: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }],
      });

      const tip = await currentCheckpoint();
      if (tip === null) {
        return out({
          error:
            "The current checkpoint could not be read, so a window cannot be bounded. This is a failed lookup, not an absence of sales.",
        });
      }
      const from = Math.max(tip - Math.round(hours * 3600 * CHECKPOINTS_PER_SECOND), 0);

      const sales: NftSale[] = [];
      const ownership = new Map<string, KioskOwnership>();
      const unreadable: Record<string, number> = {};
      let requests = 0;
      let truncated = false;
      // Min and max over every type, not first-seen and last-seen. Each type is
      // paged separately, so assigning once at the start and overwriting at the
      // end reported an "oldest" sale later than the "newest" one whenever more
      // than one marketplace traded in the window.
      let oldest: string | null = null;
      let newest: string | null = null;
      const wanted = collection_type ? canonicalType(collection_type) : undefined;
      // Sales the filter cannot judge, because their marketplace does not emit
      // the collection type. Measured on mainnet: 70 of 73 sales carry no
      // nft_type at all, so a filtered result that did not say this reads as
      // "this collection did not trade" when it means "cannot tell".
      let unattributable = 0;
      const unread: string[] = [];

      for (const eventType of saleEventTypes()) {
        let cursor: string | undefined;
        // A type never queried is absent from the totals, which looks exactly
        // like a marketplace with no sales.
        if (requests >= max_pages) {
          unread.push(eventType);
          // Also truncated. Removing the old outer break stopped this being set
          // when the budget ran out exactly on a type boundary, so a read that
          // skipped whole marketplaces reported truncated: false beside a
          // caveat saying it was incomplete.
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
            filter: { type: eventType, afterCheckpoint: from },
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
            sales.push(sale);
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
      return out({
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
              // Event types, not marketplaces: TradePort alone has six, so
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
        // NOT `sales`: `...totals` already puts the sale COUNT there, and
        // spreading the array over it left the count reported nowhere.
        ...(include_sales ? { sale_records: sales } : {}),
      });
    },
  );
}
