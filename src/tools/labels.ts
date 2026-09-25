import { z } from "zod";
import {
  addSessionLabel,
  allLabels,
  importLabels,
  getLabel,
  isSinkCategory,
  removeSessionLabel,
  type LabelCategory,
} from "../utils/labels.js";
import { currentSuiAccount } from "../utils/chain-id.js";
import { storeStatus } from "../utils/store.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const CATEGORIES = [
  "cex",
  "bridge",
  "mixer",
  "malicious",
  "protocol",
  "validator",
  "defi",
  "burn",
  "other",
] as const;

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * The canonical account id a reference resolves to, or null if it is not a
 * valid address on any known chain. Reporting is never worth failing a call
 * over, so this reports nothing rather than throwing.
 */
function safeAccount(reference: string): string | null {
  try {
    return currentSuiAccount(reference);
  } catch {
    return null;
  }
}

export function registerLabelTools(server: McpServer) {
  server.tool(
    "manage_labels",
    "Manage the address-label registry used for incident investigation and fund tracing. " +
      "Labels attribute addresses (exchanges, bridges, mixers, malicious wallets, protocols, etc.) " +
      "so traces are readable and stop at known sinks. Actions: 'list' all labels, 'lookup' one " +
      "address, 'add' or 'remove' one label, 'import' a batch, and 'export' every label in the " +
      "shape 'import' accepts, to move a set between machines. Labels added or imported here are " +
      "saved to the local store when SUI_STORE_PATH is set and last only for the session " +
      "otherwise; 'remove' deletes the stored copy too. Only those labels can be removed: the " +
      "override file (SUI_LABELS_FILE) and the shipped set are read-only here. Precedence: labels " +
      "added here > override file > shipped set. Labels are chain-qualified: a label added while " +
      "querying one chain does not apply on another.",
    {
      action: z
        .enum(["list", "lookup", "add", "remove", "import", "export"])
        .describe("What to do."),
      address: z
        .string()
        .optional()
        .describe(
          "Address to lookup/add/remove (required for those actions). A bare address refers to " +
            "the network this call targets; a CAIP-10 id ('eip155:1:0x…') labels an account on " +
            "another chain — useful for recording where funds landed after a bridge hop.",
        ),
      label: z.string().optional().describe("Human-readable label (required for 'add')."),
      category: z
        .enum(CATEGORIES)
        .optional()
        .describe(
          "Label category (required for 'add'). Sink categories (cex, bridge, mixer, malicious, burn) terminate fund tracing.",
        ),
      confidence: z
        .enum(["high", "medium", "low"])
        .optional()
        .describe("Attribution confidence for 'add' (default: medium)."),
      notes: z.string().optional().describe("Optional context for 'add'."),
      labels: z
        .array(
          z.object({
            address: z.string(),
            label: z.string(),
            category: z.string(),
            confidence: z.string().optional(),
            notes: z.string().optional(),
          }),
        )
        .optional()
        .describe(
          "Labels to bulk-import (for 'import'). Malformed entries are skipped and reported rather than failing the batch.",
        ),
    },
    async ({ action, address, label, category, confidence, notes, labels: bulk }) => {
      switch (action) {
        case "list": {
          const labels = allLabels();
          return jsonResult({ count: labels.length, labels });
        }

        case "lookup": {
          if (!address) return jsonResult({ error: "'address' is required for lookup." });
          const found = getLabel(address);
          return jsonResult({
            address,
            // Which account this actually resolved to — the answer differs by
            // network for a bare address, and silently so without this.
            account: safeAccount(address),
            label: found,
            is_sink: found ? isSinkCategory(found.category) : false,
          });
        }

        case "add": {
          if (!address || !label || !category) {
            return errorResult("'address', 'label', and 'category' are required for add.");
          }
          let stored;
          try {
            stored = addSessionLabel(address, {
              label,
              category: category as LabelCategory,
              confidence: confidence ?? "medium",
              notes,
            });
          } catch (err) {
            return errorResult((err as Error).message);
          }
          return jsonResult({
            added: { address, account: safeAccount(address), ...stored },
            is_sink: isSinkCategory(stored.category),
            note: stored.persisted
              ? "Saved to the local store — it will be here next session."
              : storeStatus().enabled
                ? "IN MEMORY ONLY: the store is configured but this write failed, so the label is gone at the end of this session. See the server's stderr."
                : "In-memory for this session only. Set SUI_STORE_PATH to persist labels across restarts.",
          });
        }

        case "import": {
          if (!bulk?.length) {
            return errorResult("'labels' array is required for import.");
          }
          const { imported, skipped, persisted } = importLabels(bulk);
          return jsonResult({
            imported,
            skipped_count: skipped.length,
            ...(skipped.length ? { skipped } : {}),
            // Counted, not assumed from whether a store is configured. A
            // configured store whose writes all fail reported the whole import
            // as saved, and the set was gone at the next restart.
            persisted,
            note: !storeStatus().enabled
              ? "In-memory only — set SUI_STORE_PATH to keep these across restarts."
              : persisted === imported
                ? "Saved to the local store."
                : `IN MEMORY ONLY for ${imported - persisted} of ${imported}: the store is configured but those writes failed. See the server's stderr.`,
          });
        }

        case "export": {
          // Emits the same shape `import` accepts, so a team can round-trip a
          // labels file between machines without hand-editing.
          //
          // The exported address is the CAIP-10 account, never the bare
          // chain-native one. `import` resolves a bare address against
          // whichever network the importing call runs on, so exporting bare
          // used to re-file an Ethereum label as a zero-padded Sui address —
          // and since `bridge` and `cex` are sink categories, that phantom
          // would silently terminate later Sui traces at an address belonging
          // to nobody.
          const all = allLabels();
          return jsonResult({
            count: all.length,
            labels: all.map((l) => ({
              address: l.account,
              label: l.label,
              category: l.category,
              ...(l.confidence ? { confidence: l.confidence } : {}),
              ...(l.notes ? { notes: l.notes } : {}),
            })),
          });
        }

        case "remove": {
          if (!address) return errorResult("'address' is required for remove.");
          const { removed, persisted_removal } = removeSessionLabel(address);
          const stillStored = storeStatus().enabled && !persisted_removal && removed;
          return jsonResult({
            address,
            removed,
            note: stillStored
              ? "Removed for this session, but the stored row could not be deleted, so it comes back at the next start. A sink label that returns keeps terminating traces."
              : removed
                ? "Session label removed."
                : "No session label for that address (static/override labels cannot be removed here).",
          });
        }
      }
    },
  );
}
