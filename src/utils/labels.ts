import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import {
  deleteLabel as deleteStoredLabel,
  loadLabels as loadStoredLabels,
  saveLabel as saveStoredLabel,
} from "./store.js";

const require = createRequire(import.meta.url);

export type LabelCategory =
  | "cex"
  | "bridge"
  | "mixer"
  | "malicious"
  | "protocol"
  | "validator"
  | "defi"
  | "burn"
  | "other";

export type LabelConfidence = "high" | "medium" | "low";

export interface AddressLabel {
  label: string;
  category: LabelCategory;
  source: string;
  confidence?: LabelConfidence;
  notes?: string;
}

interface LabelsFile {
  labels?: Record<string, Partial<AddressLabel> & { label: string; category: LabelCategory }>;
}

/**
 * Categories that represent a terminal destination for funds. When a trace
 * reaches one of these, following further hops adds noise — the money has left
 * the traceable surface (an exchange takes custody, a bridge crosses chains, a
 * mixer breaks the link) or is gone (burn). Fund tracing stops here.
 */
const SINK_CATEGORIES: ReadonlySet<LabelCategory> = new Set<LabelCategory>([
  "cex",
  "bridge",
  "mixer",
  "malicious",
  "burn",
]);

export function isSinkCategory(category: LabelCategory): boolean {
  return SINK_CATEGORIES.has(category);
}

function normalize(address: string): string {
  return normalizeSuiAddress(address.trim().toLowerCase());
}

function coerceLabels(
  raw: LabelsFile | undefined,
  defaultSource: string,
): Map<string, AddressLabel> {
  const out = new Map<string, AddressLabel>();
  const entries = raw?.labels;
  if (!entries) return out;
  for (const [addr, value] of Object.entries(entries)) {
    if (!value || typeof value.label !== "string" || typeof value.category !== "string") continue;
    out.set(normalize(addr), {
      label: value.label,
      category: value.category,
      source: value.source ?? defaultSource,
      confidence: value.confidence,
      notes: value.notes,
    });
  }
  return out;
}

// Static, curated labels shipped in-repo (dist/data at runtime).
const staticLabels = coerceLabels(require("../data/labeled-addresses.json") as LabelsFile, "curated");

// Local override file (SUI_LABELS_FILE): case/org-maintained attribution that
// wins over the static set. Missing/unreadable/invalid file is non-fatal — it
// just means no overrides, which is the common case.
const overrideLabels: Map<string, AddressLabel> = (() => {
  const path = process.env.SUI_LABELS_FILE;
  if (!path) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LabelsFile;
    return coerceLabels(parsed, "override");
  } catch (err) {
    // Surface the problem without crashing the server.
    process.stderr.write(
      `[labels] could not load SUI_LABELS_FILE (${path}): ${(err as Error).message}\n`,
    );
    return new Map();
  }
})();

// Session labels added at runtime via manage_labels. Highest precedence.
//
// Seeded from the optional store when one is configured, so attribution
// established in a previous investigation is still there — labels decide where
// fund traces stop, and re-deriving them every session is both tedious and a
// correctness risk. Without SUI_STORE_PATH this stays in-memory exactly as
// before.
const sessionLabels = new Map<string, AddressLabel>();

for (const row of loadStoredLabels()) {
  sessionLabels.set(normalize(row.address), {
    label: row.label,
    category: row.category as LabelCategory,
    source: "stored",
    confidence: (row.confidence ?? undefined) as LabelConfidence | undefined,
    notes: row.notes ?? undefined,
  });
}

/** Look up a label for an address. Precedence: session > override > static. */
export function getLabel(address: string): AddressLabel | null {
  const key = normalize(address);
  return sessionLabels.get(key) ?? overrideLabels.get(key) ?? staticLabels.get(key) ?? null;
}

/** True if the address is a known fund sink (exchange, bridge, mixer, malicious, burn). */
export function isSink(address: string): boolean {
  const label = getLabel(address);
  return label ? isSinkCategory(label.category) : false;
}

/**
 * Add or replace a session label, persisting it when a store is configured.
 *
 * `persist` defaults to true so attribution survives by default once someone
 * has opted into a store; the flag exists for a caller that wants a label to
 * apply to this session only.
 */
export function addSessionLabel(
  address: string,
  input: { label: string; category: LabelCategory; confidence?: LabelConfidence; notes?: string },
  persist = true,
): AddressLabel & { persisted: boolean } {
  const stored: AddressLabel = {
    label: input.label,
    category: input.category,
    source: "session",
    confidence: input.confidence,
    notes: input.notes,
  };
  sessionLabels.set(normalize(address), stored);

  // Returns false when no store is configured, which is the default state.
  const persisted = persist
    ? saveStoredLabel({
        address: normalize(address),
        label: input.label,
        category: input.category,
        confidence: input.confidence ?? null,
        notes: input.notes ?? null,
      })
    : false;

  return { ...stored, persisted };
}

/** Remove a session label. Returns true if one existed. Does not affect static/override entries. */
export function removeSessionLabel(address: string): boolean {
  const key = normalize(address);
  // Remove from the store too, otherwise it reappears on the next start and
  // looks like the deletion silently failed.
  deleteStoredLabel(key);
  return sessionLabels.delete(key);
}

/**
 * Bulk-import labels, e.g. from a team's shared file.
 *
 * Skips malformed entries rather than failing the batch: a partial import with
 * a reported skip count is more useful than an all-or-nothing rejection of a
 * hand-maintained file.
 */
export function importLabels(
  entries: Array<{
    address: string;
    label: string;
    category: string;
    confidence?: string;
    notes?: string;
  }>,
  persist = true,
): { imported: number; skipped: string[] } {
  const skipped: string[] = [];
  let imported = 0;

  for (const e of entries) {
    if (!e?.address || !e.label || !isLabelCategory(e.category)) {
      skipped.push(e?.address ?? "(missing address)");
      continue;
    }
    addSessionLabel(
      e.address,
      {
        label: e.label,
        category: e.category,
        confidence: (e.confidence as LabelConfidence | undefined) ?? undefined,
        notes: e.notes,
      },
      persist,
    );
    imported++;
  }
  return { imported, skipped };
}

const LABEL_CATEGORIES: readonly string[] = [
  "cex", "bridge", "mixer", "malicious", "protocol", "validator", "defi", "burn", "other",
];

function isLabelCategory(c: unknown): c is LabelCategory {
  return typeof c === "string" && LABEL_CATEGORIES.includes(c);
}

/** All effective labels (static ∪ override ∪ session, with precedence applied). */
export function allLabels(): Array<{ address: string } & AddressLabel> {
  const merged = new Map<string, AddressLabel>();
  for (const [k, v] of staticLabels) merged.set(k, v);
  for (const [k, v] of overrideLabels) merged.set(k, v);
  for (const [k, v] of sessionLabels) merged.set(k, v);
  return [...merged.entries()].map(([address, label]) => ({ address, ...label }));
}
