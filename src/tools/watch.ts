import { z } from "zod";
import { numArg } from "./args.js";
import { getNetwork } from "../config.js";
import { isSink } from "../utils/labels.js";
import {
  advanceWatch,
  listWatches,
  removeWatch,
  saveWatch,
  storeStatus,
} from "../utils/store.js";
import { currentCheckpoint, fetchDeltaDetail, fetchDeltas } from "../utils/watch-probe.js";
import {
  evaluate,
  flagLookalikes,
  normalizeWatchAddress,
  summarizePoll,
  type WatchEntry,
} from "../utils/watch.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const NO_STORE =
  "Watches need the local store, which is off by default. Set SUI_STORE_PATH to a writable file path and restart the server. Nothing was recorded.";

export function registerWatchTools(server: McpServer) {
  server.tool(
    "watch_addresses",
    "Add, remove or list addresses watched for new activity during an investigation. A watch records where it last looked, so poll_watch returns only what is new. Requires SUI_STORE_PATH.",
    {
      action: z
        .enum(["add", "remove", "list"])
        .describe("add, remove, or list the current watch set"),
      addresses: z
        .array(z.string())
        .optional()
        .describe("Addresses to add or remove (0x...)"),
      label: z
        .string()
        .optional()
        .describe("Optional label applied to the addresses being added, e.g. 'victim' or 'suspect'"),
      min_amount: z
        .string()
        .optional()
        .describe(
          'Only report coin movements at or above this, in RAW units of any coin (SUI has 9 decimals, so 0.5 SUI is "500000000"). Sinks and transactions that move no coin are reported regardless. Pass "0" to clear a floor set earlier; omitting it on a re-add keeps the existing one.',
        ),
    },
    async ({ action, addresses, label, min_amount }) => {
      const network = getNetwork();
      const out = (o: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }],
      });

      if (!storeStatus().enabled) return out({ error: NO_STORE });

      if (action === "list") {
        const watches = listWatches(network);
        return out({ network, watched: watches.length, watches });
      }

      if (!addresses?.length) {
        return out({ error: "addresses is required for add and remove." });
      }

      // Raw integer units only. "0.5", "1e9" and "1_000" all threw inside
      // BigInt and fell back to no floor at all, so a caller asking to see only
      // large movements got every movement and was told nothing.
      if (min_amount !== undefined && !/^\d+$/.test(min_amount.trim())) {
        return out({
          error: `min_amount must be a whole number of RAW coin units, not "${min_amount}". SUI has 9 decimals, so 0.5 SUI is "500000000".`,
        });
      }

      // Rejected here rather than at the delta query, where one bad address
      // returns no data for the whole batch of twenty.
      const rejected = addresses.filter((a) => normalizeWatchAddress(a) === null);
      // Deduplicated, so two spellings of one address are one watch and are
      // counted as one. `added: 2` beside `watched: 1` was the alternative.
      const valid = [
        ...new Set(
          addresses
            .map((a) => normalizeWatchAddress(a))
            .filter((a): a is string => a !== null),
        ),
      ];

      // REMOVE runs before this check. A malformed row can exist in the store —
      // written by an earlier build, or by hand — and poll_watch tells the
      // caller to remove it by name. Refusing the only call that can clear it
      // left that row unremovable except by editing the database.
      if (action === "remove") {
        const seen = new Set<string>();
        const removed: string[] = [];
        const notWatched: string[] = [];
        for (const raw of addresses) {
          const norm = normalizeWatchAddress(raw);
          const key = norm ?? raw;
          if (seen.has(key)) continue;
          seen.add(key);
          // A row written before normalization holds the address as typed, so
          // the raw form is tried too rather than calling a live watch
          // "not watched".
          const gone = (norm !== null && removeWatch(network, norm)) || removeWatch(network, raw);
          (gone ? removed : notWatched).push(raw);
        }
        return out({
          network,
          removed: removed.length,
          not_watched: notWatched,
          watched: listWatches(network).length,
        });
      }

      if (valid.length === 0) {
        return out({
          error: "No valid Sui addresses given. Expected 0x followed by up to 64 hex characters.",
          rejected,
        });
      }

      // A new watch starts from NOW. Seeding at zero would replay the wallet's
      // whole history into the caller's context on the first poll, which is
      // the cost this tool exists to avoid.
      const from = await currentCheckpoint();
      const added_at = Date.now();
      // An address already watched keeps its cursor (the ON CONFLICT clause
      // does not touch last_checkpoint), so reporting the current checkpoint for
      // it would promise a fresh start the next poll will not honour.
      const existing = new Map(
        listWatches(network).map((w) => [normalizeWatchAddress(w.address) ?? w.address, w.last_checkpoint]),
      );
      // saveWatch returns false when the write failed, and since that failure
      // is now swallowed to keep reads working, counting the input instead
      // would report addresses as watched that were never recorded.
      const saved = valid.filter((address) =>
        saveWatch(network, {
          address,
          ...(label ? { label } : {}),
          last_checkpoint: from,
          ...(min_amount ? { min_amount } : {}),
          added_at,
        }),
      );
      const notSaved = valid.filter((a) => !saved.includes(a));
      const readded = saved.filter((a) => existing.has(a));

      return out({
        network,
        added: saved.filter((a) => !existing.has(a)).length,
        from_checkpoint: from,
        ...(rejected.length ? { rejected } : {}),
        ...(readded.length
          ? {
              already_watched: readded.map((a) => ({
                address: a,
                from_checkpoint: existing.get(a)!,
              })),
              already_watched_note:
                "These were already watched and keep the cursor they had, so the next poll reports back to that checkpoint rather than starting now.",
            }
          : {}),
        ...(notSaved.length
          ? {
              not_saved: notSaved,
              warning: "These addresses could not be written to the store and are NOT being watched.",
            }
          : {}),
        watched: listWatches(network).length,
        note: "Watching from the current checkpoint forward — existing history is not reported. Call poll_watch to collect new activity.",
      });
    },
  );

  server.tool(
    "poll_watch",
    "Return what has happened to watched addresses since the last poll, and nothing else. Cheap to call repeatedly: an empty result is a few dozen tokens. Each hit names a digest and why it fired; read the ones that matter with get_transaction.",
    {
      max_per_address: numArg()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Cap on new transactions reported per address per poll (default 10)"),
    },
    async ({ max_per_address }) => {
      const network = getNetwork();
      const out = (o: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }],
      });

      if (!storeStatus().enabled) return out({ error: NO_STORE });

      const watches = listWatches(network);
      if (watches.length === 0) {
        return out({ watched: 0, hits: [], note: "Nothing is being watched. Add addresses with watch_addresses." });
      }

      // A row written before addresses were validated would take the whole
      // batch down with it, so it is skipped and named rather than polled.
      const unpollable = watches.filter((w) => normalizeWatchAddress(w.address) === null);
      const entries: WatchEntry[] = watches
        .filter((w) => normalizeWatchAddress(w.address) !== null)
        .map((w) => ({
          // Normalized, not just validated. Balance changes come back canonical
          // padded lowercase, so a row holding `0x2` would match none of its own
          // and read as its own counterparty with no amounts at all. The stored
          // spelling travels alongside because it is what keys the row.
          address: normalizeWatchAddress(w.address)!,
          ...(normalizeWatchAddress(w.address) !== w.address ? { store_key: w.address } : {}),
          last_checkpoint: w.last_checkpoint,
          ...(w.label ? { label: w.label } : {}),
          ...(w.min_amount ? { min_amount: w.min_amount } : {}),
          added_at: w.added_at,
        }));

      if (entries.length === 0) {
        return out({
          watched: watches.length,
          hits: [],
          unpollable: unpollable.map((w) => w.address),
          note: "Every watched address is malformed and cannot be queried. Remove them with watch_addresses.",
        });
      }

      const { deltas, requests: deltaRequests, saturated } = await fetchDeltas(entries, max_per_address);

      // Detail only for what actually moved. A quiet poll never reaches here.
      const movedDigests = [...deltas.values()].flat().map((t) => t.digest);
      const { detail, requests: detailRequests } = await fetchDeltaDetail(movedDigests);

      const saturatedSet = new Set(saturated);
      const hits = [];
      const stalled: string[] = [];
      const notAdvanced: string[] = [];
      for (const entry of entries) {
        const txs = (deltas.get(entry.address) ?? []).map((t) => {
          const d = detail.get(t.digest);
          return {
            ...t,
            balance_changes: d?.balance_changes ?? [],
            object_movements: d?.object_movements ?? [],
            balance_changes_truncated: d?.balance_changes_truncated,
            object_changes_truncated: d?.object_changes_truncated,
          };
        });
        if (txs.length === 0) continue;

        const result = evaluate(entry, txs, {
          isSink,
          saturated: saturatedSet.has(entry.address),
        });
        hits.push(...result.hits);
        if (result.stalled) stalled.push(entry.address);
        // Advance even when every hit was suppressed: the transaction has been
        // seen, and not advancing would re-read it on every poll forever. A
        // cursor that could not be written is named, because the alternative is
        // an agent on a poll loop counting the same activity every time.
        // Only when it actually moves. The UPDATE carries `last_checkpoint < ?`,
        // so re-asserting the current value legitimately changes no row and
        // would otherwise be reported as a failed write.
        if (result.last_checkpoint > entry.last_checkpoint) {
          if (!advanceWatch(network, entry.store_key ?? entry.address, result.last_checkpoint)) {
            notAdvanced.push(entry.address);
          }
        }
      }

      // Costs no request: every address is already in hand. A lookalike of a
      // watched address turning up as a NEW counterparty of that same wallet is
      // exactly the shape of address poisoning.
      const flagged = flagLookalikes(entries.map((e) => e.address), hits);

      const summary = summarizePoll(entries.length, flagged, deltaRequests + detailRequests, saturated);
      return out({
        ...summary,
        ...(unpollable.length ? { unpollable: unpollable.map((w) => w.address) } : {}),
        ...(stalled.length
          ? {
              stalled,
              stalled_note:
                "These addresses produced a full page inside a single checkpoint, so the cursor could not advance without dropping the rest of it. Raise max_per_address; polling again as-is returns the same page.",
            }
          : {}),
        ...(notAdvanced.length
          ? {
              cursor_not_advanced: notAdvanced,
              cursor_note:
                "The watch cursor could not be written for these addresses, so the next poll will report this activity again.",
            }
          : {}),
      });
    },
  );
}
