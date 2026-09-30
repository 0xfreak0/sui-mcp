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
import { fetchPackageVersions, resolveEventTypeFilter, resolveModuleEventFilter } from "../utils/package-versions.js";
import { readAttackTransactions } from "../utils/attack-read.js";
import { participantPnl } from "../utils/participant-pnl.js";
import { roundUsd } from "../utils/address-flows.js";
import { prefetchCoinScale } from "../utils/valuation.js";
import { WindowAmounts, windowPrices } from "../utils/window-prices.js";
import { getLabel } from "../utils/labels.js";
import { lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";
import { capPayload, type ListCap } from "../utils/output-cap.js";
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
/** Independent of matching-event count; empty reads spend this budget too. */
const DEFAULT_MAX_READS = 200;
const DEFAULT_PNL_TRANSACTIONS = 500;
/** P&L rows listed per sender. The row says how many more digests there are. */
const PNL_DIGESTS = 5;

export function registerAggregateTools(server: McpServer) {
  server.tool(
    "aggregate_events",
    "(Incident investigation) Rank addresses or event types by activity across a time window, answering 'who were the top wallets on this protocol today', in one call instead of paginating thousands of events yourself. " +
      "Filter by event type, module or sender, bound by ISO timestamps or checkpoints, and group by sender or event type. " +
      "Call it WITHOUT value_field first: it returns counts plus a sample event and the numeric fields available, so you can see what the protocol emits (many carry their own USD valuation) and then re-run naming that field. " +
      "With group_pnl it also ranks the senders of the matched transactions by what their own balances did in them, per coin and in USD, and flags PTBs where the filtered package was one leg of several. " +
      "Always check `truncated`: a partial scan cannot establish the full-window ranking. The scan stops at max_events or max_reads, including empty reads; `scan.stop_reason` distinguishes the budgets and `scan.next_call` continues with aggregate_events itself. Pass its opaque cursor with the same filters and network. Each call ranks a disjoint event slice, not a cumulative window; a resumed ranking remains truncated even at exhaustion. Per-key event counts and value_sum add only when every group was retained in every slice (`scan.groups_complete`), subject to value rounding. Top-N rankings, distinct_keys, distribution and group_pnl are not additive.",
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
          "Filter by the emitting module. Before the relocate_event_module cutover (mainnet checkpoint 69,982,635 on 2024-10-17, testnet 118,397,835 on 2024-10-09, devnet at genesis), events carry the package's ORIGINAL id regardless of the version called; from the cutover on they carry the id of the version actually called. The filter is queried at whichever id (or both, merged) your window needs, and `module_scope` reports how. From the cutover on, any one id (the original included) matches calls through that version only, and `module_scope.other_version_ids` lists the lineage's other ids. Accepts 0x... or 0x...::module.",
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
          "'desc' (default) returns the largest: whales. 'asc' returns the smallest, which is where coordinated dust activity lives: a swarm of wallets each doing one tiny action is invisible in a top-N view.",
        ),
      max_events: numArg()
        .int()
        .min(50)
        .max(50_000)
        .optional()
        .describe(`Scan budget (default ${DEFAULT_MAX_EVENTS}). Raise for busy protocols, or narrow the window.`),
      max_reads: numArg()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe(`Event-connection read budget across all segments (default ${DEFAULT_MAX_READS}). Short or empty reads count too. A read-budget stop is truncated and scan.next_call continues the unread event slice.`),
      cursor: z.string()
        .optional()
        .describe("Opaque next_cursor from a previous aggregate_events call. Keep the same filters and network. Reads the next disjoint event slice; counts are not cumulative and the ranking remains truncated for the original window."),
      group_pnl: boolArg()
        .optional()
        .describe(
          "Rank senders by their own balance-change P&L, gas included, using daily historical quotes. Multi-leg PTBs may include gains from other packages.",
        ),
      pnl_max_transactions: numArg()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe(`Distinct transactions read for group_pnl, oldest first (default ${DEFAULT_PNL_TRANSACTIONS}). Check pnl.truncated.`),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("'summary' (default) caps P&L coin and missing-price lists, with omissions and continuation. 'full' returns every row. Totals cover all rows."),
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
      max_reads,
      cursor,
      group_pnl,
      pnl_max_transactions,
      detail,
    }) => {
      try {
        if (!event_type && !module && !sender) {
          return errorResult(
            "Provide at least one of event_type, module or sender. Aggregating every event on the chain is not a bounded query.",
          );
        }

        // Both edges resolved to the checkpoints stamped inside the window.
        const window = await resolveWindow(from, to);
        // An event carries the package version that defined its struct; a type
        // or module written with an upgraded ID would silently match nothing.
        const typeFilter = event_type ? await resolveEventTypeFilter(event_type) : null;
        const moduleFilter = module
          ? await resolveModuleEventFilter(module, window.after?.checkpoint ?? null, window.before?.checkpoint ?? null)
          : null;

        // One segment when the window sits on one side of the
        // relocate_event_module cutover (or there is no module filter); two
        // when it spans the cutover, queried and merged in turn.
        const segments: Array<{ module?: string; afterCheckpoint: number | null; beforeCheckpoint: number | null }> =
          moduleFilter
            ? moduleFilter.segments.map((s) => ({
                module: s.filter,
                afterCheckpoint: s.afterCheckpoint,
                beforeCheckpoint: s.beforeCheckpoint,
              }))
            : [{ afterCheckpoint: window.after?.checkpoint ?? null, beforeCheckpoint: window.before?.checkpoint ?? null }];

        const budget = max_events ?? DEFAULT_MAX_EVENTS;
        const readBudget = max_reads ?? DEFAULT_MAX_READS;
        const bar = cursor?.indexOf("|") ?? -1;
        let segIdx = cursor ? Number(cursor.slice(0, bar)) : 0;
        let innerCursor = cursor ? cursor.slice(bar + 1) || undefined : undefined;
        if (cursor && (bar < 1 || !Number.isInteger(segIdx) || segIdx < 0 || segIdx >= segments.length)) {
          return errorResult("cursor is not an aggregate_events continuation for this window. Keep the same filters and pass next_cursor from the previous call.");
        }
        const events: AggregatableEvent[] = [];
        let pages = 0;
        let cursorUnavailable = false;
        // One sample per event type, not just the first event seen. A protocol
        // emits bookkeeping events (reward refreshes, rate updates) far more
        // often than user actions, so a single sample almost always describes
        // the wrong thing and suggests fields nobody wants to sum.
        const samplesByType = new Map<string, unknown>();
        const countsByType = new Map<string, number>();
        // Distinct transactions behind the events, oldest first, for group_pnl.
        const txDigests = new Set<string>();

        while (segIdx < segments.length && events.length < budget && pages < readBudget) {
          const seg = segments[segIdx];
          const filter: Record<string, unknown> = {};
          if (typeFilter) filter.type = typeFilter.filter;
          if (seg.module) filter.module = seg.module;
          if (sender) filter.sender = sender;
          if (seg.afterCheckpoint != null) filter.afterCheckpoint = seg.afterCheckpoint;
          if (seg.beforeCheckpoint != null) filter.beforeCheckpoint = seg.beforeCheckpoint;

          const page: EventPage = await gqlQuery(PAGE_QUERY, {
            filter,
            first: Math.min(PAGE_SIZE, budget - events.length),
            after: innerCursor,
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

          if (!page.events.pageInfo.hasNextPage) {
            segIdx += 1;
            innerCursor = undefined;
            continue;
          }
          innerCursor = page.events.pageInfo.endCursor;
          // A claimed next page without its boundary cannot be resumed
          // without re-reading and double-counting events.
          if (!innerCursor) {
            cursorUnavailable = true;
            break;
          }
        }
        const hasNextPage = segIdx < segments.length;
        const nextCursor = hasNextPage && !cursorUnavailable ? `${segIdx}|${innerCursor ?? ""}` : null;
        const stopReason = !hasNextPage ? "exhausted" : cursorUnavailable ? "cursor_unavailable"
          : events.length >= budget ? "event_budget" : "read_budget";
        // A resumed call ranks only its unread slice, even when it reaches
        // the end. It never supplies the full original window's ranking.
        const truncated = hasNextPage || !!cursor;

        // Only a complete window can establish that no event carries the
        // field. Partial and resumed slices report missing_value_count.
        if (!truncated && value_field && events.length > 0 && events.every((e) => readNumericPath(e.data, value_field) === null)) {
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

        const pnl = group_pnl
          ? await senderPnl([...txDigests], {
              packages: [typeFilter?.filter, module].filter((f): f is string => !!f).map((f) => f.split("::")[0]),
              max: pnl_max_transactions ?? DEFAULT_PNL_TRANSACTIONS,
              top: top ?? 20,
              sortOrder: sort_order ?? "desc",
              eventsTruncated: truncated,
            })
          : null;

        const payload = {
          filter: {
            ...(event_type ? { event_type } : {}),
            ...(module ? { module } : {}),
            ...(sender ? { sender } : {}),
          },
          window: describeWindow(from, to, window),
          ...(typeFilter?.resolution ? { event_type_resolution: typeFilter.resolution } : {}),
          ...(moduleFilter?.resolution ? { module_scope: moduleFilter.resolution } : {}),
          group_by: group_by ?? "sender",
          events_scanned: events.length,
          pages_fetched: pages,
          truncated,
          has_next_page: hasNextPage,
          next_cursor: nextCursor,
          ...(truncated
            ? {
                truncation_warning: hasNextPage
                  ? `The scan stopped at ${stopReason}. This ranking covers only the events read in this call, not the full window.`
                  : "This resumed ranking covers only the remaining event slice, not the full window.",
                scan: {
                  reads: pages,
                  stop_reason: stopReason,
                  start_cursor: cursor ?? null,
                  groups_complete: result.groups.length === result.distinct_keys,
                  note: "The service reads a bounded range per request and can return fewer events than asked, or none, while more remain. Continuations read disjoint event slices with the same filters and network; cursors do not expose checkpoint coverage. Per-key event counts and value_sum add only when every group was retained in every slice (groups_complete), subject to value rounding. Top-N rankings, distinct_keys, distribution and group_pnl are not additive.",
                  ...(nextCursor
                    ? {
                        next_call: {
                          tool: "aggregate_events",
                          repeat_with: {
                            cursor: nextCursor,
                            ...(window.after?.checkpoint != null ? { from: String(window.after.checkpoint) } : {}),
                            ...(window.before?.checkpoint != null ? { to: String(window.before.checkpoint) } : {}),
                          },
                        },
                      }
                    : {}),
                },
              }
            : {}),
          ...(events.length === 0
            ? {
                no_results_hint: [
                  truncated ? "No matching events were found in this scan slice; the full window has not been ranked." : "No events matched.",
                  ...(event_type
                    ? [
                        "`event_type` filters on the struct's DEFINING package, which for many protocols differs from the package you call, so try `module` with the same address instead.",
                      ]
                    : []),
                  ...(moduleFilter?.resolution?.other_version_ids
                    ? [
                        "From the relocate_event_module cutover on, a `module` filter matches calls through one package version only; query the ids in module_scope.other_version_ids for the rest.",
                      ]
                    : []),
                  "Also check the window: bounds are checkpoints, and GraphQL retains only recent history.",
                ].join(" "),
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
          ...(pnl
            ? {
                pnl: {
                  ...pnl,
                  ...(moduleFilter?.resolution?.other_version_ids
                    ? {
                        scope_note:
                          "Only transactions whose events the filter matched are read. Calls through the lineage's other versions (module_scope.other_version_ids) emit under those ids and are not in this P&L, so a sender whose payout ran through another version shows its costs here without the payout. Re-run with module set to each other id, or read the sender with summarize_address_flows.",
                      }
                    : {}),
                },
              }
            : {}),
        };

        // Each P&L sender's coins and the unpriced list fit their budgets,
        // largest USD first; totals are computed over every coin above.
        type Coin = { usd: number | null };
        const coinCap: ListCap<Coin> = {
          budget: 1_500,
          rank: (a, b) => Math.abs(b.usd ?? -1) - Math.abs(a.usd ?? -1),
          usd: (c) => (c.usd === null ? null : Math.abs(c.usd)),
        };
        const { payload: out } = capPayload(
          "aggregate_events",
          { event_type, module, sender, from, to, group_by, value_field, value_scale, top, sort_order, max_events, max_reads, cursor, group_pnl, pnl_max_transactions },
          payload,
          {
            ...Object.fromEntries((pnl?.senders ?? []).map((_, i) => [`pnl.senders.${i}.net`, coinCap])),
            "pnl.usd_basis.missing_coin_days": { budget: 3_000, keepOrder: true },
          },
          { full: detail === "full", next_call: { tool: "aggregate_events", repeat_with: { detail: "full" } } },
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
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

  const timed = read.txs.map((tx) => ({
    at: tx.timestampMs === null ? null : tx.timestampMs / 1000,
    row: participantPnl([tx], lineage)[0],
  })).filter((entry) => entry.row !== undefined);
  const coins = new Set(timed.flatMap(({ row }) => [...row.net.keys()]));
  const [prices] = await Promise.all([
    windowPrices(timed.map(({ at, row }) => ({ at, coins: row.net.keys() }))),
    prefetchCoinScale(coins),
  ]);
  const bySender = new Map<string, WindowAmounts>();
  for (const { at, row } of timed) {
    const amounts = bySender.get(row.sender) ?? new WindowAmounts(prices);
    amounts.addMap(row.net, at);
    bySender.set(row.sender, amounts);
  }
  const others = new Set(rows.flatMap((r) => [...r.otherPackages]));
  if (others.size) await prefetchProtocolNames(others).catch(() => {});

  const ranked = rows
    .map((r) => {
      let gained = 0;
      let lost = 0;
      for (const [coin] of bySender.get(r.sender)!.values) {
        const usd = bySender.get(r.sender)!.usd(coin);
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
    usd_basis: prices.basis,
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
        coin_count: bySender.get(r.sender)!.values.size,
        net: bySender.get(r.sender)!.amounts(),
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
