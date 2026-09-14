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
          "Only report coin movements at or above this, in RAW units of any coin. Sinks and transactions that move no coin are reported regardless.",
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

      // Rejected here rather than at the delta query, where one bad address
      // returns no data for the whole batch of twenty.
      const rejected = addresses.filter((a) => normalizeWatchAddress(a) === null);
      const valid = addresses
        .map((a) => normalizeWatchAddress(a))
        .filter((a): a is string => a !== null);

      if (valid.length === 0) {
        return out({
          error: "No valid Sui addresses given. Expected 0x followed by up to 64 hex characters.",
          rejected,
        });
      }

      if (action === "remove") {
        // Rows added before normalization hold the address as it was typed, so
        // the raw form is tried too rather than reporting a real watch as
        // "not watched".
        const removed = addresses.filter((raw) => {
          const norm = normalizeWatchAddress(raw);
          return (norm !== null && removeWatch(network, norm)) || removeWatch(network, raw);
        });
        return out({
          network,
          removed: removed.length,
          not_watched: addresses.filter((a) => !removed.includes(a) && !rejected.includes(a)),
          ...(rejected.length ? { rejected } : {}),
          watched: listWatches(network).length,
        });
      }

      // A new watch starts from NOW. Seeding at zero would replay the wallet's
      // whole history into the caller's context on the first poll, which is
      // the cost this tool exists to avoid.
      const from = await currentCheckpoint();
      const added_at = Date.now();
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

      return out({
        network,
        added: saved.length,
        from_checkpoint: from,
        ...(rejected.length ? { rejected } : {}),
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
          address: w.address,
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

      const hits = [];
      for (const entry of entries) {
        const txs = (deltas.get(entry.address) ?? []).map((t) => {
          const d = detail.get(t.digest);
          return {
            ...t,
            balance_changes: d?.balance_changes ?? [],
            object_movements: d?.object_movements ?? [],
          };
        });
        if (txs.length === 0) continue;

        const result = evaluate(entry, txs, { isSink });
        hits.push(...result.hits);
        // Advance even when every hit was suppressed: the transaction has been
        // seen, and not advancing would re-read it on every poll forever.
        advanceWatch(network, entry.address, result.last_checkpoint);
      }

      // Costs no request: every address is already in hand. A lookalike of a
      // watched address turning up as a NEW counterparty of that same wallet is
      // exactly the shape of address poisoning.
      const flagged = flagLookalikes(entries.map((e) => e.address), hits);

      const summary = summarizePoll(entries.length, flagged, deltaRequests + detailRequests, saturated);
      return out(
        unpollable.length
          ? { ...summary, unpollable: unpollable.map((w) => w.address) }
          : summary,
      );
    },
  );
}
