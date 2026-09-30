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
import { capPayload } from "../utils/output-cap.js";
import { errorResult } from "../utils/errors.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { depositRole } from "../utils/deposit-role.js";

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

/** The `source` of a label added or imported through this tool, this session or a stored earlier one. */
const ADDED_HERE: Record<string, true> = { session: true, stored: true };

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
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
    "Manage chain-qualified address labels for investigation and trace sinks. Actions list, lookup, add, remove, import a batch, or export in importable form. Added/imported labels persist with SUI_STORE_PATH; otherwise they last this session. Remove deletes their stored copy, but cannot remove the read-only SUI_LABELS_FILE or shipped labels. Precedence is local additions > override file > shipped disclosed labels > shipped inferred exchange deposits; export excludes inferred deposits. A label on one chain does not apply on another. List counts all categories/sources and shows local additions first within ~30k characters; omitted reports the rest and detail:'full' lists all.",
    {
      action: z
        .enum(["list", "lookup", "add", "remove", "import", "export"])
        .describe("What to do."),
      address: z
        .string()
        .optional()
        .describe(
          "Required for lookup/add/remove. Bare addresses use this call's network; CAIP-10 IDs label accounts on other chains.",
        ),
      label: z.string().optional().describe("Human-readable label (required for 'add')."),
      category: z
        .enum(CATEGORIES)
        .optional()
        .describe(
          "Required for add. cex, bridge, mixer and burn stop tracing; malicious labels alert but keep following the wallet.",
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
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe(
          "For list: summary (default) keeps local additions first within ~30k chars and counts omitted labels; full lists all.",
        ),
    },
    async ({ action, address, label, category, confidence, notes, labels: bulk, detail }) => {
      // A malformed reference is rejected here. Looked up as it was, it would
      // answer "no label", which reads as an address that was checked and is
      // clean.
      if (address !== undefined && (action === "lookup" || action === "add" || action === "remove")) {
        try {
          currentSuiAccount(address);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }
      switch (action) {
        case "list": {
          const labels = allLabels();
          const byCategory: Record<string, number> = {};
          const bySource: Record<string, number> = {};
          for (const l of labels) {
            byCategory[l.category] = (byCategory[l.category] ?? 0) + 1;
            bySource[l.source] = (bySource[l.source] ?? 0) + 1;
          }
          type Row = (typeof labels)[number];
          const { payload } = capPayload(
            "manage_labels",
            { action },
            { count: labels.length, by_category: byCategory, by_source: bySource, labels },
            {
              labels: {
                budget: 30_000,
                keepOrder: true,
                // Labels added here lead: they are this investigation's own
                // attributions, while the shipped and override sets are reference.
                rank: (a: Row, b: Row) => Number(!ADDED_HERE[a.source]) - Number(!ADDED_HERE[b.source]),
              },
            },
            { full: detail === "full", next_call: { tool: "manage_labels", repeat_with: { detail: "full" } } },
          );
          return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
        }

        case "lookup": {
          if (!address) return errorResult("'address' is required for lookup.");
          const found = getLabel(address);
          return jsonResult({
            address,
            // Which account this actually resolved to — the answer differs by
            // network for a bare address, and silently so without this.
            account: safeAccount(address),
            label: found,
            is_sink: found ? isSinkCategory(found.category) : false,
            deposit_address: depositRole(address),
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
            // Counted, not assumed from whether a store is configured: a
            // configured store's writes can all fail, and an import reported
            // as saved would then be gone at the next restart.
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
          // would re-file an Ethereum label as a zero-padded Sui address. Since
          // `bridge` and `cex` are sink categories, that phantom would silently
          // terminate later Sui traces at an address belonging to nobody.
          //
          // Inferred labels are left out: every machine ships them, and an
          // imported copy would become a session label, the top tier, without
          // the evidence that marks it inferred.
          const all = allLabels();
          const exported = all.filter((l) => l.source !== "inferred");
          return jsonResult({
            count: exported.length,
            inferred_not_exported: all.length - exported.length,
            labels: exported.map((l) => ({
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
