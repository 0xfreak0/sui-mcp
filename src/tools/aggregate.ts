import { z } from "zod";
import { boolArg, numArg, addressArg, timePointArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import {
  aggregateEvents,
  readNumericPath,
  suggestValueFields,
  type AggregatableEvent,
} from "../utils/aggregate.js";
import { describeWindow, resolveWindow } from "../utils/checkpoint-time.js";
import { fetchPackageVersions, resolveEventTypeFilter, versionScopeNote } from "../utils/package-versions.js";
import { readAttackTransactions } from "../utils/attack-read.js";
import { participantPnl } from "../utils/participant-pnl.js";
import { coinValuer, roundUsd } from "../utils/address-flows.js";
import { priceUsdAtTime } from "../utils/valuation.js";
import { getLabel } from "../utils/labels.js";
import { lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const PAGE_QUERY = `query ($filter: EventFilter, $first: Int, $after: String) {
  events(filter: $filter, first: $first, after: $after) {
    nodes {
      contents { type { repr } json }
      sender { address }
      timestamp
      transaction { digest }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface EventPage {
  events: {
    nodes: Array<{
      contents?: { type?: { repr: string }; json: unknown };
      sender?: { address: string };
      timestamp?: string;
      transaction?: { digest?: string } | null;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

/** GraphQL caps a page at 50, so a big window is a lot of round trips. */
const PAGE_SIZE = 50;
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_PNL_TRANSACTIONS = 500;
/** P&L rows listed per sender. The row says how many more digests there are. */
const PNL_DIGESTS = 5;

export function registerAggregateTools(server: McpServer) {
  server.tool(
    "aggregate_events",
    "(Analytics) Rank addresses or event types by activity across a time window — the 'who were the top wallets on this protocol today' question — in one call instead of paginating thousands of events yourself. " +
      "Filter by event type, module or sender, bound by ISO timestamps or checkpoints, and group by sender or event type. " +
      "Call it WITHOUT value_field first: it returns counts plus a sample event and the numeric fields available, so you can see what the protocol emits (many carry their own USD valuation) and then re-run naming that field. " +
      "With group_pnl it also ranks the senders of the matched transactions by what their own balances did in them, per coin and in USD, and flags PTBs where the filtered package was one leg of several. " +
      "Always check `truncated` — a partial scan produces a confidently wrong ranking.",
    {
      event_type: z
        .string()
        .optional()
        .describe(
          "Filter by the event STRUCT's type: the package that DEFINES the event, which is often not the package you called. Accepts 0x..., 0x...::module, or 0x...::module::EventName. Any version's ID of the defining package works: the filter is rewritten to the version that defined the type, and `event_type_resolution` reports it.",
        ),
      module: z
        .string()
        .optional()
        .describe(
          "Filter by the EMITTING package/module — the one whose function ran. Usually what you want when you know a protocol's package ID. Accepts 0x... or 0x...::module.",
        ),
      sender: addressArg().optional().describe("Only events sent by this address."),
      from: timePointArg()
        .optional()
        .describe("Window start: ISO 8601 timestamp (2026-08-07T00:00:00Z) or a checkpoint number."),
      to: timePointArg()
        .optional()
        .describe("Window end: ISO 8601 timestamp, 'now', or a checkpoint number."),
      group_by: z
        .enum(["sender", "event_type"])
        .optional()
        .describe("What to rank (default 'sender')."),
      value_field: z
        .string()
        .optional()
        .describe(
          "Dotted path into the event JSON to sum, e.g. 'deposit_value'. Omit to get counts plus field suggestions.",
        ),
      value_scale: numArg()
        .positive()
        .optional()
        .describe("Divisor for the summed value, e.g. 100 when a protocol reports USD cents."),
      top: numArg().int().min(1).max(200).optional().describe("Groups to return (default 20)."),
      sort_order: z
        .enum(["desc", "asc"])
        .optional()
        .describe(
          "'desc' (default) returns the largest — whales. 'asc' returns the smallest, which is where coordinated dust activity lives: a swarm of wallets each doing one tiny action is invisible in a top-N view.",
        ),
      max_events: numArg()
        .int()
        .min(50)
        .max(50_000)
        .optional()
        .describe(`Scan budget (default ${DEFAULT_MAX_EVENTS}). Raise for busy protocols, or narrow the window.`),
      group_pnl: boolArg()
        .optional()
        .describe(
          "Also rank the senders of the matched transactions by profit: for each distinct transaction behind the events, sum its sender's own balance changes per coin (gas included), value them in USD at the median transaction time, and flag PTBs where the filtered package is one leg of several. Answers 'who else profited in this window'.",
        ),
      pnl_max_transactions: numArg()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe(`Distinct transactions read for group_pnl, oldest first (default ${DEFAULT_PNL_TRANSACTIONS}). Check pnl.truncated.`),
    },
    async ({
      event_type,
      module,
      sender,
      from,
      to,
      group_by,
      value_field,
      value_scale,
      top,
      sort_order,
      max_events,
      group_pnl,
      pnl_max_transactions,
    }) => {
      try {
        if (!event_type && !module && !sender) {
          return errorResult(
            "Provide at least one of event_type, module or sender. Aggregating every event on the chain is not a bounded query.",
          );
        }

        // Both edges resolved to the checkpoints stamped inside the window.
        const window = await resolveWindow(from, to);
        // An event carries the package version that DEFINED its struct; a type
        // written with an upgraded ID would silently match nothing.
        const typeFilter = event_type ? await resolveEventTypeFilter(event_type) : null;
        const moduleScope = module ? await versionScopeNote(module, "module") : null;

        const filter: Record<string, unknown> = {};
        if (typeFilter) filter.type = typeFilter.filter;
        if (module) filter.module = module;
        if (sender) filter.sender = sender;
        if (window.after?.checkpoint != null) filter.afterCheckpoint = window.after.checkpoint;
        if (window.before?.checkpoint != null) filter.beforeCheckpoint = window.before.checkpoint;

        const budget = max_events ?? DEFAULT_MAX_EVENTS;
        const events: AggregatableEvent[] = [];
        let cursor: string | undefined;
        let hasNext = true;
        let pages = 0;
        // One sample per event type, not just the first event seen. A protocol
        // emits bookkeeping events (reward refreshes, rate updates) far more
        // often than user actions, so a single sample almost always describes
        // the wrong thing and suggests fields nobody wants to sum.
        const samplesByType = new Map<string, unknown>();
        const countsByType = new Map<string, number>();
        // Distinct transactions behind the events, oldest first, for group_pnl.
        const txDigests = new Set<string>();

        while (hasNext && events.length < budget) {
          const page: EventPage = await gqlQuery(PAGE_QUERY, {
            filter,
            first: Math.min(PAGE_SIZE, budget - events.length),
            after: cursor,
          });
          pages++;

          for (const n of page.events.nodes) {
            const t = n.contents?.type?.repr;
            if (t) {
              countsByType.set(t, (countsByType.get(t) ?? 0) + 1);
              if (!samplesByType.has(t) && n.contents?.json) samplesByType.set(t, n.contents.json);
            }
            if (n.transaction?.digest) txDigests.add(n.transaction.digest);
            events.push({
              sender: n.sender?.address ?? null,
              type: n.contents?.type?.repr ?? null,
              data: n.contents?.json,
            });
          }

          hasNext = page.events.pageInfo.hasNextPage;
          cursor = page.events.pageInfo.endCursor;
          // A claimed next page with no cursor would re-read page one and
          // double-count those events in the ranking.
          if (!cursor) break;
          if (!cursor) break;
        }

        // A path no event carries sums to 0 for every group, and a ranking of
        // zeros reads as a measured one.
        if (value_field && events.length > 0 && events.every((e) => readNumericPath(e.data, value_field) === null)) {
          const fields = [...new Set([...samplesByType.values()].flatMap((d) => suggestValueFields(d)))];
          return errorResult(
            `value_field ${JSON.stringify(value_field.slice(0, 80))} is not a number in any of the ${events.length} events scanned. ` +
              (fields.length ? `Numeric fields they carry: ${fields.slice(0, 20).join(", ")}.` : "They carry no numeric fields."),
          );
        }

        const result = aggregateEvents(events, {
          groupBy: group_by ?? "sender",
          valueField: value_field,
          valueScale: value_scale,
          top,
          sortOrder: sort_order,
        });

        // Truncation is surfaced loudly: a ranking built from a partial scan
        // looks exactly like a complete one, and that is how a wrong answer
        // gets believed.
        const truncated = hasNext && events.length >= budget;

        const pnl = group_pnl
          ? await senderPnl([...txDigests], {
              packages: [typeFilter?.filter, module].filter((f): f is string => !!f).map((f) => f.split("::")[0]),
              max: pnl_max_transactions ?? DEFAULT_PNL_TRANSACTIONS,
              top: top ?? 20,
              sortOrder: sort_order ?? "desc",
              eventsTruncated: truncated,
            })
          : null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  filter: {
                    ...(event_type ? { event_type } : {}),
                    ...(module ? { module } : {}),
                    ...(sender ? { sender } : {}),
                  },
                  window: describeWindow(from, to, window),
                  ...(typeFilter?.resolution ? { event_type_resolution: typeFilter.resolution } : {}),
                  ...(moduleScope ? { module_scope: moduleScope } : {}),
                  group_by: group_by ?? "sender",
                  events_scanned: events.length,
                  pages_fetched: pages,
                  truncated,
                  ...(truncated
                    ? {
                        truncation_warning:
                          `Hit the ${budget}-event budget with more available. This ranking is INCOMPLETE — ` +
                          "narrow from/to or raise max_events before drawing conclusions.",
                      }
                    : {}),
                  ...(events.length === 0
                    ? {
                        no_results_hint:
                          "No events matched. `event_type` filters on the struct's DEFINING package, which for many " +
                          "protocols differs from the package you call — try `module` with the same address instead. " +
                          "Also check the window: bounds are checkpoints, and GraphQL retains only recent history.",
                      }
                    : {}),
                  distinct_keys: result.distinct_keys,
                  sort_order: sort_order ?? "desc",
                  // Computed over every group, not the returned page: a top-20
                  // view says nothing about the shape of the other 900.
                  distribution: result.distribution,
                  ...(result.ungrouped_count
                    ? { ungrouped_events: result.ungrouped_count }
                    : {}),
                  ...(value_field
                    ? { value_field, value_scale: value_scale ?? 1 }
                    : {
                        // Discovery, per event type — this is what replaces a
                        // per-protocol schema registry. Ordered by frequency so
                        // the noisy bookkeeping events are visible as such.
                        event_types: [...countsByType.entries()]
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 15)
                          .map(([type, count]) => ({
                            type,
                            count,
                            numeric_fields: suggestValueFields(samplesByType.get(type)),
                            sample: samplesByType.get(type),
                          })),
                        hint:
                          "Pick the event type that represents the action you care about (user actions are " +
                          "usually rarer than bookkeeping events), then re-run with event_type set to it and " +
                          "value_field set to one of its numeric_fields.",
                      }),
                  groups: result.groups,
                  ...(pnl ? { pnl } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

/**
 * Rank the senders of `digests` by what their own balances did in them.
 *
 * Read over gRPC with archive fallback, so every balance change and call is
 * there however large the PTB and however old the window.
 */
async function senderPnl(
  digests: string[],
  opts: { packages: string[]; max: number; top: number; sortOrder: "asc" | "desc"; eventsTruncated: boolean },
) {
  const wanted = digests.slice(0, opts.max);
  const [read, lineages] = await Promise.all([
    readAttackTransactions(wanted),
    Promise.all(opts.packages.map(async (p) => [p, ...((await fetchPackageVersions(p).catch(() => null)) ?? []).map((v) => v.address)])),
  ]);
  const lineage = opts.packages.length ? new Set(lineages.flat()) : null;
  const rows = participantPnl(
    read.txs.map((t) => ({ digest: t.digest, sender: t.sender, balanceChanges: t.balanceChanges, calls: t.calls })),
    lineage,
  );

  const times = read.txs.map((t) => t.timestampMs).filter((t): t is number => t !== null).sort((a, b) => a - b);
  const atSec = times.length ? Math.floor(times[Math.floor(times.length / 2)] / 1000) : undefined;
  const coins = new Set(rows.flatMap((r) => [...r.net.keys()]));
  const prices = await priceUsdAtTime([...coins], atSec);
  const v = coinValuer(prices);
  const others = new Set(rows.flatMap((r) => [...r.otherPackages]));
  if (others.size) await prefetchProtocolNames(others).catch(() => {});

  const ranked = rows
    .map((r) => {
      let gained = 0;
      let lost = 0;
      for (const [coin, raw] of r.net) {
        const usd = v.usd(coin, raw);
        if (usd === null) continue;
        if (usd > 0) gained += usd;
        else lost -= usd;
      }
      return { r, net: gained - lost, gained, lost };
    })
    .sort((a, b) => (opts.sortOrder === "asc" ? a.net - b.net : b.net - a.net));

  return {
    transactions_matched: digests.length,
    transactions_read: read.txs.length,
    ...(digests.length > wanted.length
      ? {
          truncated: true,
          truncation_warning: `Read the oldest ${wanted.length} of ${digests.length} transactions. Raise pnl_max_transactions or narrow the window before ranking anyone.`,
        }
      : {}),
    ...(opts.eventsTruncated ? { events_truncated: "The event scan hit its budget, so transactions after it are not in this ranking." } : {}),
    ...(read.missing.length ? { missing_transactions: read.missing } : {}),
    usd_basis: atSec
      ? {
          at: new Date(atSec * 1000).toISOString(),
          meaning: "Each coin priced once, at the median transaction time (DefiLlama, or Pyth for verified coins when PYTH_API_KEY is set). Coins with no price are listed and left out of usd_net.",
        }
      : null,
    ...(prices.unpriced.length ? { unpriced_coins: prices.unpriced.map((u) => ({ coin_type: u.coin_type, code: u.code })) } : {}),
    meaning:
      "Each sender's own balance changes summed over the matched transactions, gas included. A transaction marked multi-leg also called packages outside the filtered one, so its P&L may have been made there.",
    senders: ranked.slice(0, opts.top).map(({ r, net, gained, lost }) => {
      const label = getLabel(r.sender);
      return {
        sender: r.sender,
        ...(label ? { label: label.label, label_category: label.category } : {}),
        transactions: r.digests.length,
        usd_net: roundUsd(net),
        usd_gained: roundUsd(gained),
        usd_lost: roundUsd(lost),
        net: v.amounts(r.net),
        ...(r.multiLeg.length
          ? {
              multi_leg_transactions: r.multiLeg.length,
              other_packages: [...r.otherPackages].map((p) => ({
                package: p,
                ...(lookupProtocolDisplay(p) ? { protocol: lookupProtocolDisplay(p)!.name } : {}),
              })),
            }
          : {}),
        digests: r.digests.slice(0, PNL_DIGESTS),
        ...(r.digests.length > PNL_DIGESTS ? { more_digests: r.digests.length - PNL_DIGESTS } : {}),
      };
    }),
    ...(ranked.length > opts.top ? { senders_not_shown: ranked.length - opts.top } : {}),
  };
}
