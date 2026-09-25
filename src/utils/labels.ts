import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  currentSuiChain,
  formatAccountId,
  namespaceOf,
  normalizeAddressForChain,
  parseAccountId,
  type AccountId,
} from "./chain-id.js";
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

/**
 * How a shipped label is known, so a report can say what the claim rests on.
 *
 * - `proof-of-reserves-listed`: the exchange published the address in its own
 *   proof-of-reserves wallet list. A listing, not a verified ownership proof.
 * - `official-docs`: the protocol's own deployment documentation names it.
 * - `victim-postmortem`: the exploited protocol's own incident report names it
 *   as the attacker's.
 */
export type LabelEvidence = "proof-of-reserves-listed" | "official-docs" | "victim-postmortem";

export interface AddressLabel {
  label: string;
  category: LabelCategory;
  source: string;
  confidence?: LabelConfidence;
  notes?: string;
  /** Who the label says controls the address, e.g. "Binance". */
  entity?: string;
  evidence?: LabelEvidence | string;
  /** First-party document the label was taken from. */
  source_url?: string;
  /** Date (YYYY-MM-DD) the source document was read. */
  retrieved_at?: string;
}

/** Where a label comes from. Every field is absent for a label with no document behind it. */
export interface LabelProvenance {
  entity?: string;
  evidence?: string;
  source_url?: string;
  retrieved_at?: string;
}

/** The provenance fields of a label, or undefined when it has none. */
export function labelProvenance(label: AddressLabel): LabelProvenance | undefined {
  const out = {
    ...(label.entity ? { entity: label.entity } : {}),
    ...(label.evidence ? { evidence: label.evidence } : {}),
    ...(label.source_url ? { source_url: label.source_url } : {}),
    ...(label.retrieved_at ? { retrieved_at: label.retrieved_at } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * One-line rendering of a label with its provenance, for stop reasons and
 * summaries: "Binance reserve wallet [cex; Binance; proof-of-reserves-listed: https://…]".
 */
export function describeLabel(label: AddressLabel): string {
  const parts = [label.category, label.entity, label.evidence && label.source_url ? `${label.evidence}: ${label.source_url}` : label.evidence];
  return `${label.label} [${parts.filter(Boolean).join("; ")}]`;
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

/**
 * Resolve a reference — bare address or CAIP-10 — against the current call's
 * Sui network.
 */
function toAccount(reference: string): AccountId {
  return parseAccountId(reference, currentSuiChain());
}

/** Canonical CAIP-10 key for a reference. */
function key(reference: string): string {
  return formatAccountId(toAccount(reference));
}

/**
 * File-sourced labels, split by how specifically they are scoped.
 *
 * A curated entry keyed by a bare address is knowledge about an *entity*
 * ("this is the burn address", "this is a Binance hot wallet") and is not
 * network-specific, so it applies on every Sui network — which is also what
 * this server did before chain qualification existed, and losing it would
 * silently strip attribution from every testnet investigation. An entry keyed
 * by an explicit CAIP-10 id is a claim about one chain and matches only there.
 */
interface FileLabels {
  /** Keyed by canonical CAIP-10: matches exactly one chain. */
  byAccount: Map<string, AddressLabel>;
  /** Keyed by normalized Sui address: matches any Sui network. */
  bySuiAddress: Map<string, AddressLabel>;
}

function coerceLabels(raw: LabelsFile | undefined, defaultSource: string): FileLabels {
  const out: FileLabels = { byAccount: new Map(), bySuiAddress: new Map() };
  const entries = raw?.labels;
  if (!entries) return out;

  for (const [addr, value] of Object.entries(entries)) {
    if (!value || typeof value.label !== "string" || typeof value.category !== "string") continue;
    const label: AddressLabel = {
      label: value.label,
      category: value.category,
      source: value.source ?? defaultSource,
      confidence: value.confidence,
      notes: value.notes,
      ...(typeof value.entity === "string" ? { entity: value.entity } : {}),
      ...(typeof value.evidence === "string" ? { evidence: value.evidence } : {}),
      ...(typeof value.source_url === "string" ? { source_url: value.source_url } : {}),
      ...(typeof value.retrieved_at === "string" ? { retrieved_at: value.retrieved_at } : {}),
    };

    try {
      if (addr.includes(":")) {
        const account = parseAccountId(addr, SUI_ANY_PLACEHOLDER);
        out.byAccount.set(formatAccountId(account), label);
      } else {
        out.bySuiAddress.set(normalizeAddressForChain(SUI_ANY_PLACEHOLDER, addr), label);
      }
    } catch (err) {
      // One malformed key must not cost the whole curated set.
      process.stderr.write(`[labels] skipping '${addr}': ${(err as Error).message}\n`);
    }
  }
  return out;
}

/**
 * Chain used only to normalize bare curated keys.
 *
 * Every Sui network shares one address format, so any of them normalizes a
 * bare key identically — this picks one rather than meaning "mainnet".
 */
const SUI_ANY_PLACEHOLDER = "sui:mainnet";

// Static labels shipped in-repo (dist/data at runtime). Two files, one set:
// `disclosed-labels.json` is generated by scripts/sync-disclosed-labels.mjs from
// first-party documents and carries each entry's source; `labeled-addresses.json`
// holds the few hand-curated entries that need no document (the zero address).
// The hand-curated file wins on a collision.
const disclosedFile = require("../data/disclosed-labels.json") as LabelsFile & {
  generated_at?: string;
  sources?: Array<{ id: string; entity: string; evidence: string; source_url: string; retrieved_at: string; count: number; stale?: boolean }>;
};
const staticLabels: FileLabels = (() => {
  const disclosed = coerceLabels(disclosedFile, "disclosed");
  const curated = coerceLabels(require("../data/labeled-addresses.json") as LabelsFile, "curated");
  return {
    byAccount: new Map([...disclosed.byAccount, ...curated.byAccount]),
    bySuiAddress: new Map([...disclosed.bySuiAddress, ...curated.bySuiAddress]),
  };
})();

/**
 * What the shipped disclosed set covers, per source document. A screening
 * result is only as good as this list, so it is reported beside every result.
 */
export function disclosedLabelSources() {
  return {
    generated_at: disclosedFile.generated_at ?? null,
    sources: (disclosedFile.sources ?? []).map((s) => ({
      entity: s.entity,
      evidence: s.evidence,
      count: s.count,
      source_url: s.source_url,
      retrieved_at: s.retrieved_at,
      ...(s.stale ? { stale: true } : {}),
    })),
  };
}

// Local override file (SUI_LABELS_FILE): case/org-maintained attribution that
// wins over the static set. Missing/unreadable/invalid file is non-fatal — it
// just means no overrides, which is the common case.
const overrideLabels: FileLabels = (() => {
  const path = process.env.SUI_LABELS_FILE;
  if (!path) return { byAccount: new Map(), bySuiAddress: new Map() };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LabelsFile;
    return coerceLabels(parsed, "override");
  } catch (err) {
    // Surface the problem without crashing the server.
    process.stderr.write(
      `[labels] could not load SUI_LABELS_FILE (${path}): ${(err as Error).message}\n`,
    );
    return { byAccount: new Map(), bySuiAddress: new Map() };
  }
})();

/**
 * Session labels added at runtime via manage_labels. Highest precedence.
 *
 * Keyed by canonical CAIP-10, unlike the file-sourced sets: a label added
 * during an investigation is a claim about one account on one chain, and
 * leaking it across chains would terminate traces that should have continued.
 *
 * Seeded from the optional store when one is configured, so attribution
 * established in a previous investigation is still there — labels decide where
 * fund traces stop, and re-deriving them every session is both tedious and a
 * correctness risk. Without SUI_STORE_PATH this stays in-memory exactly as
 * before.
 */
const sessionLabels = new Map<string, AddressLabel>();

for (const row of loadStoredLabels()) {
  sessionLabels.set(row.account, {
    label: row.label,
    category: row.category as LabelCategory,
    source: "stored",
    confidence: (row.confidence ?? undefined) as LabelConfidence | undefined,
    notes: row.notes ?? undefined,
  });
}

/** Look up in one file-sourced set, honouring both scopes. */
function fromFile(set: FileLabels, account: AccountId): AddressLabel | undefined {
  const exact = set.byAccount.get(formatAccountId(account));
  if (exact) return exact;
  // Bare curated entries are Sui-wide; they must not match an EVM or Solana
  // account that happens to share the string.
  return namespaceOf(account.chain) === "sui" ? set.bySuiAddress.get(account.address) : undefined;
}

/**
 * Look up a label. Precedence: session > override > static.
 *
 * Accepts a bare address (resolved against the current call's Sui network) or
 * a CAIP-10 id for any known chain.
 *
 * Returns null rather than throwing on an unparseable reference. This is
 * called from inside trace loops on addresses that came off-chain, and an
 * investigation should not abort because one counterparty string was
 * malformed — "no label" is the correct, safe answer for something we cannot
 * even identify.
 */
export function getLabel(address: string): AddressLabel | null {
  let account: AccountId;
  try {
    account = toAccount(address);
  } catch {
    return null;
  }
  return (
    sessionLabels.get(formatAccountId(account)) ??
    fromFile(overrideLabels, account) ??
    fromFile(staticLabels, account) ??
    null
  );
}

/**
 * True if the address carries a sink category (exchange, bridge, mixer, malicious,
 * burn). Tracing does not stop at `malicious`: that label marks the wallet being
 * followed. watch_addresses still reports reaching one.
 */
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
  // Throws on an unparseable address, unlike getLabel: this is a caller
  // asserting an identity, and silently storing it under a mangled key would
  // produce a label that never matches anything.
  const account = toAccount(address);
  sessionLabels.set(formatAccountId(account), stored);

  // Returns false when no store is configured, which is the default state.
  const persisted = persist
    ? saveStoredLabel({
        account: formatAccountId(account),
        chain: account.chain,
        address: account.address,
        label: input.label,
        category: input.category,
        confidence: input.confidence ?? null,
        notes: input.notes ?? null,
      })
    : false;

  return { ...stored, persisted };
}

/**
 * Remove a session label.
 *
 * `removed` is the session state; `persisted_removal` says whether the store
 * agreed. The two can differ, and the difference matters more than it looks: a
 * store delete that fails leaves the row to be seeded back at the next start,
 * so a `cex` label the investigator believes they retracted silently keeps
 * terminating every trace that reaches it. Reporting only the session result
 * called that a clean removal.
 */
export function removeSessionLabel(address: string): {
  removed: boolean;
  persisted_removal: boolean;
} {
  let account: string;
  try {
    account = key(address);
  } catch {
    return { removed: false, persisted_removal: false };
  }
  const persisted_removal = deleteStoredLabel(account);
  return { removed: sessionLabels.delete(account), persisted_removal };
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
): { imported: number; skipped: string[]; persisted: number } {
  const skipped: string[] = [];
  let imported = 0;

  // Counted separately: "the store took it" is a different claim from "the
  // label is in force this session", and reporting the second as the first told
  // a team their imported attribution file was saved when none of it was.
  let persisted = 0;

  for (const e of entries) {
    if (!e?.address || !e.label || !isLabelCategory(e.category)) {
      skipped.push(e?.address ?? "(missing address)");
      continue;
    }
    // addSessionLabel throws on an address it cannot parse, and a whitespace
    // string passes the truthiness check above. Letting that escape aborted the
    // batch partway, after rows were already written, against a documented
    // skip-and-continue contract.
    try {
      const r = addSessionLabel(
        e.address,
        {
          label: e.label,
          category: e.category,
          confidence: (e.confidence as LabelConfidence | undefined) ?? undefined,
          notes: e.notes,
        },
        persist,
      );
      if (r.persisted) persisted++;
      imported++;
    } catch {
      skipped.push(e.address);
    }
  }
  return { imported, skipped, persisted };
}

const LABEL_CATEGORIES: readonly string[] = [
  "cex", "bridge", "mixer", "malicious", "protocol", "validator", "defi", "burn", "other",
];

function isLabelCategory(c: unknown): c is LabelCategory {
  return typeof c === "string" && LABEL_CATEGORIES.includes(c);
}

/**
 * All effective labels (static ∪ override ∪ session, with precedence applied).
 *
 * Sui-wide file entries are reported against the current call's network, since
 * that is the chain the caller is asking about. An entry scoped to an explicit
 * chain is reported on that chain regardless.
 */
export function allLabels(): Array<{ account: string; chain: string; address: string } & AddressLabel> {
  const chain = currentSuiChain();
  const merged = new Map<string, { chain: string; address: string } & AddressLabel>();

  const addFile = (set: FileLabels) => {
    for (const [address, v] of set.bySuiAddress) {
      merged.set(formatAccountId({ chain, address }), { chain, address, ...v });
    }
    for (const [account, v] of set.byAccount) {
      const parsed = parseAccountId(account, chain);
      merged.set(account, { chain: parsed.chain, address: parsed.address, ...v });
    }
  };

  addFile(staticLabels);
  addFile(overrideLabels);
  for (const [account, v] of sessionLabels) {
    const parsed = parseAccountId(account, chain);
    merged.set(account, { chain: parsed.chain, address: parsed.address, ...v });
  }

  return [...merged.entries()].map(([account, label]) => ({ account, ...label }));
}
