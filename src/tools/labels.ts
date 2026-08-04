import { z } from "zod";
import {
  addSessionLabel,
  allLabels,
  getLabel,
  isSinkCategory,
  removeSessionLabel,
  type LabelCategory,
} from "../utils/labels.js";
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
      action: z.enum(["list", "lookup", "add", "remove"]).describe("What to do."),
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
    },
    async ({ action, address, label, category, confidence, notes }) => {
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
            note: "Session label (in-memory). Add it to your SUI_LABELS_FILE to persist across restarts.",
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
