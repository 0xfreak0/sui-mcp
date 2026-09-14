import { z } from "zod";
import { numArg, boolArg } from "./args.js";
import { getNetwork } from "../config.js";
import { gqlQuery } from "../clients/graphql.js";
import { saveKioskOwners, storeStatus } from "../utils/store.js";
import {
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
 * Measured on mainnet, one TradePort package over a full 24 hours: 5 requests,
 * 214 sales, 5,126 SUI, and 54 kiosk-to-wallet mappings.
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

/** Checkpoints per second on mainnet, measured. Used only to turn hours into a bound. */
const CHECKPOINTS_PER_SECOND = 4.25;

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
    "NFT marketplace sales over a recent window, with volume and per-marketplace totals. Optionally filtered to one collection. Reads TradePort, BlueMove and OriginByte sale events. Also records which wallet holds which kiosk, which is what makes get_top_holders able to name a real owner for a kiosk-held NFT.",
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
          "Keep only sales of this Move type. Matched against the event's nft_type where the marketplace reports one.",
        ),
      max_pages: numArg()
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
      let oldest: string | null = null;
      let newest: string | null = null;

      for (const eventType of saleEventTypes()) {
        let cursor: string | undefined;
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
            if (collection_type && sale.nft_type !== collection_type) continue;
            if (node.timestamp) {
              if (!oldest) oldest = node.timestamp;
              newest = node.timestamp;
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
        if (requests >= max_pages) {
          truncated = true;
          break;
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
        window_hours: hours,
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
        ...(truncated
          ? {
              caveat: `INCOMPLETE: the ${max_pages}-request cap was reached, so this covers only part of the window and the totals are a lower bound. Narrow 'hours' or raise 'max_pages'.`,
            }
          : {}),
        ...(Object.keys(unreadable).length ? { unreadable_events: unreadable } : {}),
        ...(storeStatus().enabled
          ? {}
          : {
              note: "Kiosk ownership was read but not stored: set SUI_STORE_PATH so get_top_holders can use it.",
            }),
        ...(include_sales ? { sales } : {}),
      });
    },
  );
}
