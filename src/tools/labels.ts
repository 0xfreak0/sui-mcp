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
import { storeStatus } from "../utils/store.js";
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

export function registerLabelTools(server: McpServer) {
  server.tool(
    "manage_labels",
    "Manage the address-label registry used for incident investigation and fund tracing. " +
      "Labels attribute addresses (exchanges, bridges, mixers, malicious wallets, protocols, etc.) " +
      "so traces are readable and stop at known sinks. Precedence: session (added here) > local " +
      "override file (SUI_LABELS_FILE) > shipped static set. 'add'/'remove' affect only the current " +
      "session (in-memory, not persisted). Actions: 'list' all labels, 'lookup' one address, 'add' " +
      "or 'remove' a session label.",
    {
      action: z
        .enum(["list", "lookup", "add", "remove", "import", "export"])
        .describe("What to do."),
      address: z
        .string()
        .optional()
        .describe("Address to lookup/add/remove (required for those actions)."),
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
            label: found,
            is_sink: found ? isSinkCategory(found.category) : false,
          });
        }

        case "add": {
          if (!address || !label || !category) {
            return jsonResult({ error: "'address', 'label', and 'category' are required for add." });
          }
          const stored = addSessionLabel(address, {
            label,
            category: category as LabelCategory,
            confidence: confidence ?? "medium",
            notes,
          });
          return jsonResult({
            added: { address, ...stored },
            is_sink: isSinkCategory(stored.category),
            note: stored.persisted
              ? "Saved to the local store — it will be here next session."
              : "In-memory for this session only. Set SUI_STORE_PATH to persist labels across restarts.",
          });
        }

        case "import": {
          if (!bulk?.length) {
            return jsonResult({ error: "'labels' array is required for import." });
          }
          const { imported, skipped } = importLabels(bulk);
          return jsonResult({
            imported,
            skipped_count: skipped.length,
            ...(skipped.length ? { skipped } : {}),
            note: storeStatus().enabled
              ? "Saved to the local store."
              : "In-memory only — set SUI_STORE_PATH to keep these across restarts.",
          });
        }

        case "export": {
          // Emits the same shape `import` accepts, so a team can round-trip a
          // labels file between machines without hand-editing.
          const all = allLabels();
          return jsonResult({
            count: all.length,
            labels: all.map((l) => ({
              address: l.address,
              label: l.label,
              category: l.category,
              ...(l.confidence ? { confidence: l.confidence } : {}),
              ...(l.notes ? { notes: l.notes } : {}),
            })),
          });
        }

        case "remove": {
          if (!address) return jsonResult({ error: "'address' is required for remove." });
          const removed = removeSessionLabel(address);
          return jsonResult({
            address,
            removed,
            note: removed
              ? "Session label removed."
              : "No session label for that address (static/override labels cannot be removed here).",
          });
        }
      }
    },
  );
}
