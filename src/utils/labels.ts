import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { normalizeSuiAddress } from "@mysten/sui/utils";

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

// Session labels added at runtime via manage_labels. In-memory only — they last
// for the life of the process. Highest precedence.
const sessionLabels = new Map<string, AddressLabel>();

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

/** Add or replace a session label (runtime, in-memory). Returns the stored label. */
export function addSessionLabel(
  address: string,
  input: { label: string; category: LabelCategory; confidence?: LabelConfidence; notes?: string },
): AddressLabel {
  const stored: AddressLabel = {
    label: input.label,
    category: input.category,
    source: "session",
    confidence: input.confidence,
    notes: input.notes,
  };
  sessionLabels.set(normalize(address), stored);
  return stored;
}

/** Remove a session label. Returns true if one existed. Does not affect static/override entries. */
export function removeSessionLabel(address: string): boolean {
  return sessionLabels.delete(normalize(address));
}

/** All effective labels (static ∪ override ∪ session, with precedence applied). */
export function allLabels(): Array<{ address: string } & AddressLabel> {
  const merged = new Map<string, AddressLabel>();
  for (const [k, v] of staticLabels) merged.set(k, v);
  for (const [k, v] of overrideLabels) merged.set(k, v);
  for (const [k, v] of sessionLabels) merged.set(k, v);
  return [...merged.entries()].map(([address, label]) => ({ address, ...label }));
}
