/**
 * Optional local store, off unless `SUI_STORE_PATH` is set.
 *
 * Two things in this server are worth remembering between sessions:
 *
 *   - **Address labels.** `manage_labels` says outright that session labels are
 *     in-memory and you should hand-edit a JSON file to keep them. Labels also
 *     decide where fund traces stop, so re-deriving attribution every session is
 *     both tedious and a correctness risk.
 *   - **Fan-out measurements.** A trace costs ~3 queries; measuring one hub's
 *     fan-out costs up to 20 paginated ones, and the answer is stable — an
 *     exchange does not stop being an exchange.
 *
 * Deliberately NOT cached: traces themselves. A trace is a function of labels,
 * so a cached trace silently disagrees with a fresh one the moment a label
 * changes — the failure would be an out-of-date conclusion that looks current.
 *
 * Uses `node:sqlite`, built into Node since v22.5, so this adds no dependency,
 * no native build, and nothing for a supply-chain scanner to flag. It is still
 * marked release-candidate upstream, which is why every entry point here
 * degrades to "no store" rather than throwing: on a runtime without it, the
 * server behaves exactly as it did before.
 *
 * Off by default on purpose. An investigation database records who you
 * investigated, and that should not appear on disk because someone ran npx.
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface FanoutRecord {
  /** Canonical CAIP-10 account id, e.g. `sui:mainnet:0x…`. */
  account: string;
  recipient_count: number;
  sender_count: number;
  counterparty_count: number;
  coin_type_count: number;
  out_in_ratio: number | null;
  flow_shape: string;
  sponsored_address_count: number;
  sponsored_transaction_count: number;
  sponsor_shape: string;
  scanned_transactions: number;
  truncated: number;
  measured_at: number;
  /** Which measurement method produced this row. See FANOUT_METHOD_VERSION. */
  method_version?: number;
}

export interface StoredLabel {
  /**
   * Canonical CAIP-10 account id and primary key, e.g. `sui:mainnet:0x…`.
   *
   * The key is chain-qualified because the same address string on two chains
   * — or on Sui mainnet and Sui testnet — is two unrelated entities, and a
   * label decides where a fund trace stops. Keying on the bare address would
   * let attribution established on one chain silently terminate a trace on
   * another.
   */
  account: string;
  /** CAIP-2 chain, split out of `account` so labels can be listed per chain. */
  chain: string;
  /** Chain-native address, normalized under that chain's rules. */
  address: string;
  label: string;
  category: string;
  confidence: string | null;
  notes: string | null;
  updated_at: number;
}

interface StatementLike {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

let db: DatabaseLike | null = null;
let initialised = false;
let unavailableReason: string | null = null;

/**
 * Bumped whenever a change to how fan-out is measured makes older cached rows
 * answer a different question than the one being asked.
 *
 * The cache is keyed on address alone, so nothing in a row records *how* it was
 * taken; without this, an upgrade keeps serving the previous method's numbers
 * until they age out. 1 marks the 1.5.0 measurement — backwards through
 * history, both directions counted. Only the fan-out cache is discarded on a
 * bump; labels and findings are user data and are never touched.
 *
 * 3 marks the move to chain-qualified account keys: rows keyed on a bare
 * address cannot say which chain they measured, so they are discarded rather
 * than assumed to be Sui mainnet. Unlike labels, that costs only a
 * re-measurement.
 *
 * 4 marks a gas sponsor's SUI change no longer counting as a payment, which
 * lowered the recipient count of every sponsored sweep by one.
 */
export const FANOUT_METHOD_VERSION = 4;

/**
 * Stamp for cached first-funder answers.
 *
 * Bump whenever the rules in `pickFundingTx` change what counts as funding —
 * the dust floors, the unpriced-coin rule, or how the funder is chosen. A row
 * written under the old rules is a different measurement wearing the same key.
 */
export const FUNDING_METHOD_VERSION = 1;

/**
 * Stamped into every cached transaction, and checked on read.
 *
 * A cached transaction's CHAIN data cannot go stale — a finalized transaction
 * is immutable — but the DERIVED fields stored alongside it can. Object
 * movements are computed at fetch time, so a row written by an earlier build
 * carries that build's classification: matched by name suffix rather than in
 * full, filtered to address-to-address, cut at 50 changes with no truncation
 * flag. Reading it back is not a cache hit, it is a result from code that has
 * since been found wrong.
 *
 * Bump this whenever the shape or the meaning of anything derived in
 * `fetchTx` changes. Same reasoning as FUNDING_METHOD_VERSION, which exists
 * because the answer depends on the dust floors that produced it.
 */
export const TX_METHOD_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS labels (
  -- Canonical CAIP-10. The chain and address columns are its two halves,
  -- stored alongside so a per-chain listing is an index scan rather than a
  -- string split over every row. All three are written from one parsed
  -- value, so they cannot disagree.
  account     TEXT PRIMARY KEY,
  chain       TEXT NOT NULL,
  address     TEXT NOT NULL,
  label       TEXT NOT NULL,
  category    TEXT NOT NULL,
  confidence  TEXT,
  notes       TEXT,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fanout (
  account              TEXT PRIMARY KEY,
  recipient_count      INTEGER NOT NULL,
  sender_count         INTEGER NOT NULL,
  counterparty_count   INTEGER NOT NULL,
  coin_type_count      INTEGER NOT NULL,
  -- Nullable on purpose: null means nothing was received, so no ratio exists.
  -- Storing 0 would read as a measured ratio of zero.
  out_in_ratio         REAL,
  flow_shape           TEXT NOT NULL,
  -- Sponsorship is measured on the same scan but answers a different question,
  -- so it is stored rather than recomputed: a cache hit that reported 0 here
  -- would be claiming "not a sponsor" from data it never read.
  sponsored_address_count     INTEGER NOT NULL,
  sponsored_transaction_count INTEGER NOT NULL,
  sponsor_shape        TEXT NOT NULL,
  scanned_transactions INTEGER NOT NULL,
  truncated            INTEGER NOT NULL,
  measured_at          INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  -- Keyed network:digest. A finalized transaction is immutable — sender, balance
  -- changes, commands, timestamp and checkpoint never change once it lands —
  -- so this needs no TTL and cannot go stale. That is the whole reason it is
  -- safe to cache here while a trace *conclusion* is not: a conclusion is
  -- derived from labels and from how far the chain has grown, both of which
  -- move.
  key         TEXT PRIMARY KEY,
  network     TEXT NOT NULL,
  digest      TEXT NOT NULL,
  -- The fetched hop as JSON. Verified round-trippable: protobuf commands keep
  -- their oneofKind discriminator, and the BigInt-bearing fields (timestamp,
  -- checkpoint) are already normalised to a string and a number before this.
  payload     TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS first_funders (
  -- Which inflow made this account exist, chain-qualified like every other key.
  --
  -- Immutable in the same sense the transaction cache is: a wallet's FIRST
  -- funding is fixed the moment it happens and no later activity can change
  -- it. So there is no TTL. What can change is the answer for an address that
  -- had no qualifying funding yet, which is exactly why only positives are
  -- ever written here -- caching "no funder found" would freeze a wallet as
  -- unfunded forever.
  account         TEXT PRIMARY KEY,
  funder_account  TEXT NOT NULL,
  digest          TEXT NOT NULL,
  -- The dust floors and price rules that produced this answer. A row computed
  -- under different rules is not the same measurement, so it is ignored rather
  -- than trusted.
  method_version  INTEGER NOT NULL,
  computed_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_name   TEXT NOT NULL,
  title       TEXT NOT NULL,
  detail      TEXT,
  confidence  TEXT,
  -- chain-derived | indexer-attested | heuristic. NULL for a finding recorded
  -- before the tier was asked for: unknown, never defaulted after the fact.
  evidence_tier TEXT,
  -- JSON arrays. Kept as text rather than join tables: a finding is a
  -- write-once note, and querying inside it is not a use case.
  addresses   TEXT,
  evidence    TEXT,
  digests     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watches (
  -- Chain-qualified, like every other key here, so a watch on one network
  -- cannot report movement from another.
  account         TEXT PRIMARY KEY,
  network         TEXT NOT NULL,
  address         TEXT NOT NULL,
  label           TEXT,
  -- Highest checkpoint already reported. afterCheckpoint is EXCLUSIVE, so
  -- this is asked for directly and yields the delta with no overlap.
  --
  -- Seeded with the chain's current checkpoint when the watch is created, not
  -- with zero: a new watch means "tell me what happens NEXT", and starting at
  -- zero would replay the wallet's entire history into the agent's context on
  -- the first poll, which is the failure this whole design exists to avoid.
  last_checkpoint INTEGER NOT NULL,
  -- Raw units of any coin. Filters value movements only; a sink or a coinless
  -- transaction fires regardless of size.
  min_amount      TEXT,
  added_at        INTEGER NOT NULL
);

-- Who held a kiosk, as stated by a marketplace sale event.
--
-- A kiosk's own owner field does not follow the KioskOwnerCap and disagrees
-- with the real holder 40% of the time, so a holder scan cannot trust it. A
-- sale event names the buyer and the buyer's kiosk in one record, which is a
-- chain-derived statement of ownership at that checkpoint.
--
-- Snapshot, not a permanent fact: a kiosk can change hands, so the checkpoint
-- is stored and a later observation wins. Network-keyed like everything else.
CREATE TABLE IF NOT EXISTS kiosk_owners (
  account         TEXT PRIMARY KEY,
  network         TEXT NOT NULL,
  kiosk_id        TEXT NOT NULL,
  owner           TEXT NOT NULL,
  checkpoint      INTEGER NOT NULL,
  observed_at     INTEGER NOT NULL
);
`;

/**
 * Indexes, kept out of {@link SCHEMA} and created only after migrations run.
 *
 * A legacy store still has the pre-1.7.0 `labels` table when SCHEMA is first
 * exec'd, and indexing a column that table does not have yet fails the whole
 * statement — which `initStore` catches as "could not open", silently
 * disabling persistence for a user whose store was merely out of date.
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS labels_chain ON labels(chain);
CREATE INDEX IF NOT EXISTS findings_case ON findings(case_name);
CREATE INDEX IF NOT EXISTS transactions_network ON transactions(network);
CREATE INDEX IF NOT EXISTS kiosk_owners_network ON kiosk_owners(network);
`;

/**
 * The chain every pre-1.7.0 record is assumed to belong to.
 *
 * Legacy rows carry a bare address and no way to recover which chain it was
 * on. The server was Sui-only when they were written and mainnet is the
 * default network, so mainnet is the only defensible backfill — but it *is* an
 * assumption, and a label written while querying testnet will come across
 * mislabeled as mainnet. That is documented rather than guessed at more
 * cleverly: there is no evidence in the row to do better with.
 */
const LEGACY_CHAIN = "sui:mainnet";

/**
 * Re-key labels from a bare address onto a chain-qualified account id.
 *
 * Unlike the fan-out cache, this migrates rather than discards. Labels are
 * hand-established attribution — someone did the work of proving an address is
 * an exchange — and they decide where fund traces stop, so dropping them would
 * both lose evidence and silently change every future trace.
 *
 * Detection is by column list, not a version stamp, for the reason
 * {@link migrateFanoutCache} gives: a stamp that was bumped before a migration
 * finished describes a store that does not exist. The column list is the
 * ground truth, and it makes the migration idempotent for free.
 */
function migrateLabelsToAccounts(opened: DatabaseLike): void {
  const columns = new Set(
    (opened.prepare(`PRAGMA table_info(labels)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  // Already chain-qualified, or freshly created by SCHEMA.
  if (columns.has("account")) return;
  // No labels table at all: nothing to carry forward.
  if (!columns.has("address")) return;

  // Atomic, because the rows being moved are the ones this migration exists
  // to preserve. Without the transaction, a crash between the rename and the
  // insert leaves an empty `labels` table beside an orphaned `labels_legacy`,
  // and the next open — seeing an `account` column — would skip the migration
  // and report the attribution as simply gone.
  opened.exec(`BEGIN IMMEDIATE`);
  try {
    // `CREATE TABLE IF NOT EXISTS` will not reshape an existing table, so the
    // old one is renamed out of the way and the canonical SCHEMA re-run.
    opened.exec(`ALTER TABLE labels RENAME TO labels_legacy`);
    opened.exec(SCHEMA);
    // LEGACY_CHAIN is a module constant, not caller input; it is interpolated
    // only because it is not a bound value.
    opened.exec(
      `INSERT INTO labels (account, chain, address, label, category, confidence, notes, updated_at)
       SELECT '${LEGACY_CHAIN}:' || address, '${LEGACY_CHAIN}', address,
              label, category, confidence, notes, updated_at
       FROM labels_legacy`,
    );
    opened.exec(`DROP TABLE labels_legacy`);
    opened.exec(`COMMIT`);
  } catch (err) {
    // Roll back to the legacy shape and let initStore disable the store with a
    // reason. A store that still holds every label but is switched off is
    // recoverable; one that silently lost them is not.
    opened.exec(`ROLLBACK`);
    throw err;
  }
}

/**
 * Qualify bare addresses recorded inside legacy findings.
 *
 * A finding's `addresses` is a JSON array of strings, so this cannot be done
 * in SQL. It is idempotent by construction rather than by a version stamp: a
 * CAIP-10 id always contains a colon and no chain's bare address format does,
 * so an already-qualified entry is recognisable and left alone. That is what
 * stops a second open producing `sui:mainnet:sui:mainnet:0x…`.
 *
 * Only `addresses` is touched. `evidence` is prose the investigator wrote and
 * is never rewritten.
 */
function migrateFindingAddresses(opened: DatabaseLike): void {
  const rows = opened.prepare(`SELECT id, addresses FROM findings`).all() as Array<{
    id: number;
    addresses: string | null;
  }>;

  const update = opened.prepare(`UPDATE findings SET addresses = ? WHERE id = ?`);
  for (const row of rows) {
    if (!row.addresses) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.addresses);
    } catch {
      // Unparseable JSON predates this migration and is not made worse by
      // leaving it; `parseList` already degrades to an empty array.
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    let changed = false;
    const qualified = parsed.map((entry) => {
      const value = String(entry);
      if (value.includes(":")) return value;
      changed = true;
      return `${LEGACY_CHAIN}:${value}`;
    });
    if (changed) update.run(JSON.stringify(qualified), row.id);
  }
}

/**
 * Add the `evidence_tier` and `digests` columns to a findings table created
 * before they existed.
 *
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table's columns alone, so
 * without this every save into an older store fails on the missing column.
 * Detected by column list, like the labels migration, so it is idempotent.
 * Existing rows keep a NULL tier: the investigator never stated one, and
 * back-filling `heuristic` would put words in their mouth.
 */
function migrateFindingColumns(opened: DatabaseLike): void {
  const columns = new Set(
    (opened.prepare(`PRAGMA table_info(findings)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has("evidence_tier")) opened.exec(`ALTER TABLE findings ADD COLUMN evidence_tier TEXT`);
  if (!columns.has("digests")) opened.exec(`ALTER TABLE findings ADD COLUMN digests TEXT`);
}

/**
 * Discard fan-out rows measured by an earlier method.
 *
 * `PRAGMA user_version` is a SQLite integer that lives in the file header — it
 * survives reopening and costs nothing to read, which is what makes it the
 * right place for this. A store written before versioning reads as 0, so the
 * first 1.5.0 open clears the cache exactly once and every later open is a
 * no-op. Discarding is safe because fan-out is derived data: the worst case is
 * one re-measurement.
 */
function migrateFanoutCache(opened: DatabaseLike): void {
  const row = opened.prepare(`PRAGMA user_version`).get() as
    | { user_version?: number }
    | undefined;
  // The version stamp says whether the *method* changed; the column list says
  // whether the table can actually hold what we now write. Both are checked,
  // because trusting the stamp alone is not safe: a migration that bumped the
  // version and then failed mid-way leaves a store whose stamp claims migrated
  // while the old columns remain, and it would never self-correct.
  const columns = new Set(
    (opened.prepare(`PRAGMA table_info(fanout)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  const shapeOk = [
    "account",
    "sender_count",
    "counterparty_count",
    "coin_type_count",
    "flow_shape",
    "sponsored_address_count",
    "sponsor_shape",
  ].every((c) => columns.has(c));
  if ((row?.user_version ?? 0) >= FANOUT_METHOD_VERSION && shapeOk) return;

  // DROP, not DELETE. `CREATE TABLE IF NOT EXISTS` leaves an existing table's
  // columns untouched, so a version that adds columns would keep the old shape
  // and every write would fail with "table fanout has no column named
  // sender_count". Dropping and re-running the schema is what actually
  // migrates. Safe because fan-out is derived: the cost is one re-measurement.
  opened.exec(`DROP TABLE IF EXISTS fanout`);
  opened.exec(SCHEMA);
  // Not parameterised: PRAGMA does not accept bound values, and the operand is
  // a module constant rather than anything a caller supplies.
  opened.exec(`PRAGMA user_version = ${FANOUT_METHOD_VERSION}`);
}

/**
 * Open the store if configured. Idempotent, and never throws: a store that
 * can't open must not take the server down with it.
 */
export function initStore(): void {
  if (initialised) return;
  initialised = true;

  const path = process.env.SUI_STORE_PATH?.trim();
  if (!path) {
    unavailableReason = "SUI_STORE_PATH is not set";
    return;
  }

  try {
    // `createRequire` is imported statically (node:module always exists), but
    // node:sqlite is resolved through it lazily: on Node < 22.5 that throws,
    // and this must degrade rather than take the server down. A bare `require`
    // would not work here at all — the build output is ESM.
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as {
      DatabaseSync: new (p: string) => DatabaseLike;
    };

    // Create the parent directory. Someone who sets SUI_STORE_PATH to
    // ~/.local/share/sui-mcp/store.db means "keep a store there", and failing
    // because the directory is one level short would be a silent disable over
    // something we can just do. Only the parent — never the file.
    const parent = dirname(path);
    if (parent && parent !== "." && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }

    const opened = new DatabaseSync(path);
    opened.exec(SCHEMA);
    // Order matters: labels are rebuilt from the legacy table before anything
    // reads them, and the fan-out cache is re-keyed last because it is the
    // only one that discards rather than migrates.
    migrateLabelsToAccounts(opened);
    migrateFindingAddresses(opened);
    migrateFindingColumns(opened);
    migrateFanoutCache(opened);
    // Only now is every table in its final shape.
    opened.exec(INDEXES);
    db = opened;
    unavailableReason = null;
  } catch (err) {
    db = null;
    unavailableReason = `could not open ${path}: ${(err as Error).message}`;
    process.stderr.write(`[store] persistence disabled — ${unavailableReason}\n`);
  }
}

export function storeStatus(): { enabled: boolean; path: string | null; reason: string | null } {
  initStore();
  return {
    enabled: db !== null,
    path: db ? (process.env.SUI_STORE_PATH ?? null) : null,
    reason: unavailableReason,
  };
}

/** Test seam: drop the handle so the next call re-reads the environment. */
export function resetStore(): void {
  try {
    db?.close();
  } catch {
    /* closing a broken handle is not worth reporting */
  }
  db = null;
  initialised = false;
  unavailableReason = null;
}


/**
 * Run a store write, returning `fallback` if it throws.
 *
 * **For caches and cursors only.** The rule is that a failed write must not
 * fail the READ that produced it: the measurement already succeeded and the
 * caller is entitled to it, persisted or not. A fan-out write failing with
 * "NOT NULL constraint failed: fanout.sponsored_address_count" took down
 * `get_address_fanout` entirely rather than returning the fan-out it had just
 * measured, which is the shape this exists to prevent.
 *
 * It is therefore the WRONG wrapper for a writer whose write is the whole
 * point. `saveFinding` and `deleteFinding` record the investigator's own
 * conclusions, and a swallowed failure there means `save_finding` reports
 * `saved: true` over evidence that was never stored. Those throw on purpose —
 * see the note on `saveFinding`.
 *
 * The handle is passed in rather than read from the module binding so the body
 * needs no null check and no local shadow to keep TypeScript's narrowing.
 *
 * Failures go to stderr, never stdout — stdout is the MCP transport.
 */
function tryWrite<T>(what: string, fallback: T, fn: (db: DatabaseLike) => T): T {
  if (!db) return fallback;
  const handle = db;
  try {
    return fn(handle);
  } catch (err) {
    console.error(`[store] ${what} failed, continuing without persistence: ${(err as Error).message}`);
    return fallback;
  }
}

export function saveLabel(l: Omit<StoredLabel, "updated_at">): boolean {
  initStore();
  return tryWrite("saveLabel", false, (db) => {
    db.prepare(
      `INSERT INTO labels (account, chain, address, label, category, confidence, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET
         chain=excluded.chain, address=excluded.address,
         label=excluded.label, category=excluded.category,
         confidence=excluded.confidence, notes=excluded.notes,
         updated_at=excluded.updated_at`,
    ).run(l.account, l.chain, l.address, l.label, l.category, l.confidence, l.notes, Date.now());
    return true;
  });
}

export function loadLabels(): StoredLabel[] {
  initStore();
  if (!db) return [];
  return db.prepare(`SELECT * FROM labels`).all() as unknown as StoredLabel[];
}

/** Delete by canonical CAIP-10 account id. */
export function deleteLabel(account: string): boolean {
  initStore();
  return tryWrite("deleteLabel", false, (db) => {
    db.prepare(`DELETE FROM labels WHERE account = ?`).run(account);
    return true;
  });
}

export function saveFanout(r: Omit<FanoutRecord, "measured_at">): boolean {
  initStore();
  return tryWrite("saveFanout", false, (db) => {
    db.prepare(
      `INSERT INTO fanout (account, recipient_count, sender_count, counterparty_count,
                           coin_type_count, out_in_ratio, flow_shape,
                           sponsored_address_count, sponsored_transaction_count, sponsor_shape,
                           scanned_transactions, truncated, measured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET
         recipient_count=excluded.recipient_count,
         sender_count=excluded.sender_count,
         counterparty_count=excluded.counterparty_count,
         coin_type_count=excluded.coin_type_count,
         out_in_ratio=excluded.out_in_ratio,
         flow_shape=excluded.flow_shape,
         sponsored_address_count=excluded.sponsored_address_count,
         sponsored_transaction_count=excluded.sponsored_transaction_count,
         sponsor_shape=excluded.sponsor_shape,
         scanned_transactions=excluded.scanned_transactions,
         truncated=excluded.truncated,
         measured_at=excluded.measured_at`,
    ).run(
      r.account,
      r.recipient_count,
      r.sender_count,
      r.counterparty_count,
      r.coin_type_count,
      r.out_in_ratio,
      r.flow_shape,
      r.sponsored_address_count,
      r.sponsored_transaction_count,
      r.sponsor_shape,
      r.scanned_transactions,
      r.truncated,
      Date.now(),
    );
    return true;
  });
}

/**
 * How a finding is known, in the forensics skill's three tiers:
 * `chain-derived` is read from Sui itself, `indexer-attested` is a third
 * party's assertion, `heuristic` is an inference from patterns.
 */
export const EVIDENCE_TIERS = ["chain-derived", "indexer-attested", "heuristic"] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

export interface Finding {
  id?: number;
  case_name: string;
  title: string;
  detail: string | null;
  confidence: string | null;
  /** Null only for a finding recorded before the tier was asked for. */
  evidence_tier: EvidenceTier | null;
  /** Addresses the finding is about. */
  addresses: string[];
  /** How it was established — tool calls, digests, counts. */
  evidence: string[];
  /** Transaction digests the finding rests on, so each can be re-read. */
  digests: string[];
  created_at?: number;
}

interface FindingRow {
  id: number;
  case_name: string;
  title: string;
  detail: string | null;
  confidence: string | null;
  evidence_tier: string | null;
  addresses: string | null;
  evidence: string | null;
  digests: string | null;
  created_at: number;
}

const parseList = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

const rowToFinding = (r: FindingRow): Finding => ({
  id: r.id,
  case_name: r.case_name,
  title: r.title,
  detail: r.detail,
  confidence: r.confidence,
  evidence_tier: (EVIDENCE_TIERS as readonly string[]).includes(r.evidence_tier ?? "")
    ? (r.evidence_tier as EvidenceTier)
    : null,
  addresses: parseList(r.addresses),
  evidence: parseList(r.evidence),
  digests: parseList(r.digests),
  created_at: r.created_at,
});

/**
 * Record a finding. Returns its id, or null when the store is off.
 *
 * Deliberately NOT wrapped in `tryWrite`. Every other writer here is a cache
 * or a cursor, where the read already succeeded and persistence is a bonus.
 * This one IS the operation: `save_finding` reports `saved: true`, and a
 * swallowed failure would make that a claim about evidence the store never
 * took. A write that fails must surface.
 */
export function saveFinding(f: Omit<Finding, "id" | "created_at">): number | null {
  initStore();
  if (!db) return null;
  db.prepare(
    `INSERT INTO findings (case_name, title, detail, confidence, evidence_tier, addresses, evidence, digests, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    f.case_name,
    f.title,
    f.detail ?? null,
    f.confidence ?? null,
    f.evidence_tier ?? null,
    JSON.stringify(f.addresses ?? []),
    JSON.stringify(f.evidence ?? []),
    JSON.stringify(f.digests ?? []),
    Date.now(),
  );
  const row = db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number };
  return row.id;
}

/** Findings for one case, oldest first, or every case when name is omitted. */
export function loadFindings(caseName?: string): Finding[] {
  initStore();
  if (!db) return [];
  const rows = caseName
    ? db.prepare(`SELECT * FROM findings WHERE case_name = ? ORDER BY created_at ASC`).all(caseName)
    : db.prepare(`SELECT * FROM findings ORDER BY case_name, created_at ASC`).all();
  return (rows as unknown as FindingRow[]).map(rowToFinding);
}

/** Distinct case names with their finding counts, most recent first. */
export function listCases(): Array<{ case_name: string; finding_count: number; last_updated: number }> {
  initStore();
  if (!db) return [];
  return db
    .prepare(
      `SELECT case_name, COUNT(*) AS finding_count, MAX(created_at) AS last_updated
       FROM findings GROUP BY case_name ORDER BY last_updated DESC`,
    )
    .all() as unknown as Array<{ case_name: string; finding_count: number; last_updated: number }>;
}

/**
 * Delete a finding. False when no row had that id.
 *
 * Unguarded for the same reason as `saveFinding`: this is the operation, not a
 * cache side effect. The `changes` check matters just as much — returning true
 * unconditionally told an investigator retracting a wrong conclusion with a
 * mistyped id that it was gone, while it stayed in `export_case`.
 */
export function deleteFinding(id: number): boolean {
  initStore();
  if (!db) return false;
  const r = db.prepare(`DELETE FROM findings WHERE id = ?`).run(id) as { changes?: number };
  return (r.changes ?? 0) > 0;
}

/**
 * A cached fan-out, if it is fresher than `maxAgeMs`.
 *
 * Default 7 days: hub-vs-narrow is a stable property, and a stale reading is
 * only misleading if an address changes category, which takes far longer than
 * a week. A truncated measurement is still returned — it was a lower bound when
 * taken and remains one — with its age so callers can re-measure if it matters.
 */
export function getCachedFanout(
  account: string,
  maxAgeMs = 7 * 24 * 3600 * 1000,
): (FanoutRecord & { age_ms: number }) | null {
  initStore();
  if (!db) return null;
  const row = db.prepare(`SELECT * FROM fanout WHERE account = ?`).get(account) as
    | FanoutRecord
    | undefined;
  if (!row) return null;
  const age = Date.now() - row.measured_at;
  return age <= maxAgeMs ? { ...row, age_ms: age, method_version: FANOUT_METHOD_VERSION } : null;
}


/* ------------------------------------------------------------------ *
 * First-funder cache
 * ------------------------------------------------------------------ */

/**
 * Remember which account first funded `account`.
 *
 * Positives only, by contract: see the table comment. Callers pass
 * chain-qualified accounts so a mainnet and a testnet answer for the same
 * address string cannot collide.
 */
export function saveFirstFunder(account: string, funderAccount: string, digest: string): boolean {
  initStore();
  return tryWrite("saveFirstFunder", false, (db) => {
    db.prepare(
      `INSERT INTO first_funders (account, funder_account, digest, method_version, computed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET
         funder_account=excluded.funder_account,
         digest=excluded.digest,
         method_version=excluded.method_version,
         computed_at=excluded.computed_at`,
    ).run(account, funderAccount, digest, FUNDING_METHOD_VERSION, Date.now());
    return true;
  });
}

/** A cached first funder, or null. Rows from older rules are ignored, not trusted. */
export function getCachedFirstFunder(
  account: string,
): { funder_account: string; digest: string } | null {
  initStore();
  if (!db) return null;
  const row = db
    .prepare(`SELECT funder_account, digest, method_version FROM first_funders WHERE account = ?`)
    .get(account) as { funder_account?: string; digest?: string; method_version?: number } | undefined;
  if (!row?.funder_account || !row.digest) return null;
  if (row.method_version !== FUNDING_METHOD_VERSION) return null;
  return { funder_account: row.funder_account, digest: row.digest };
}

/* ------------------------------------------------------------------ *
 * Transaction cache
 * ------------------------------------------------------------------ */

/**
 * Remember a fetched transaction.
 *
 * Immutable by nature, so there is no TTL and no invalidation path to get
 * wrong. Network-keyed like every other cache here: the same digest cannot
 * occur on two networks, but keying on it costs nothing and keeps the rule
 * uniform.
 */
export function saveTransaction(network: string, digest: string, payload: unknown): boolean {
  initStore();
  if (!db) return false;
  let text: string;
  try {
    text = JSON.stringify({ v: TX_METHOD_VERSION, payload });
  } catch {
    // A payload that will not serialise is not worth failing a trace over.
    return false;
  }
  // The catch above covers an unserialisable payload, which is a DIFFERENT
  // failure from the write itself throwing. Guarding one was mistaken for
  // guarding both.
  return tryWrite("saveTransaction", false, (db) => {
    db.prepare(
      `INSERT INTO transactions (key, network, digest, payload, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`,
    ).run(`${network}:${digest}`, network, digest, text, Date.now());
    return true;
  });
}

/** A previously fetched transaction, or null. Never throws on bad stored JSON. */
export function getCachedTransaction<T>(network: string, digest: string): T | null {
  initStore();
  if (!db) return null;
  const row = db.prepare(`SELECT payload FROM transactions WHERE key = ?`).get(`${network}:${digest}`) as
    | { payload?: string }
    | undefined;
  if (!row?.payload) return null;
  try {
    const parsed = JSON.parse(row.payload) as { v?: number; payload?: T };
    // An unstamped row predates versioning, and a stale stamp was written by
    // code whose derived fields have since changed. Both are misses, not hits.
    if (parsed?.v !== TX_METHOD_VERSION) return null;
    return (parsed.payload ?? null) as T | null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Watches                                                             */
/* ------------------------------------------------------------------ */

/**
 * Record kiosk ownership observed in a sale. Returns how many rows were kept.
 *
 * A later checkpoint wins, because a kiosk can be sold; an older observation
 * arriving after a newer one is discarded rather than overwriting it, which is
 * what the checkpoint comparison in the ON CONFLICT clause is for. Paging a
 * sale window oldest-first makes that the common case, not a rare one.
 */
export function saveKioskOwners(
  network: string,
  rows: Array<{ kiosk_id: string; owner: string; checkpoint: number }>,
): number {
  initStore();
  if (rows.length === 0) return 0;
  return tryWrite("saveKioskOwners", 0, (db) => {
    const stmt = db.prepare(
      `INSERT INTO kiosk_owners (account, network, kiosk_id, owner, checkpoint, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET
         owner = excluded.owner,
         checkpoint = excluded.checkpoint,
         observed_at = excluded.observed_at
       WHERE excluded.checkpoint > kiosk_owners.checkpoint`,
    );
    const now = Date.now();
    let kept = 0;
    for (const r of rows) {
      // `changes`, not one per statement. The ON CONFLICT clause rejects an
      // observation no newer than the stored one, so counting attempts reported
      // every row as written on a repeat run that wrote nothing at all.
      const res = stmt.run(
        `${network}:${r.kiosk_id}`,
        network,
        r.kiosk_id,
        r.owner,
        r.checkpoint,
        now,
      ) as { changes?: number };
      kept += (res.changes ?? 0) > 0 ? 1 : 0;
    }
    return kept;
  });
}

/**
 * How many kiosk owners are known, and how recent the newest is.
 *
 * Feeds the holder cache key. A cached ranking resolved its kiosks against the
 * table as it stood at the time, so without this a caller who ran
 * `get_nft_sales` — which the holder caveat tells them to do — got the same
 * unresolved answer back for 24 hours, and the instruction did nothing.
 */
export function kioskOwnerVersion(network: string): string {
  initStore();
  if (!db) return "0:0:0";
  try {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(MAX(checkpoint), 0) AS hi,
                COALESCE(MAX(observed_at), 0) AS seen
         FROM kiosk_owners WHERE network = ?`,
      )
      .get(network) as { n?: number; hi?: number; seen?: number } | undefined;
    // observed_at is what makes this move. Raising one existing row's
    // checkpoint to a value below the table's maximum changes neither the count
    // nor the maximum, so a version built from those two alone kept serving the
    // stale ranking this key exists to invalidate — verified against a real
    // store. observed_at is written on every accepted update.
    return `${r?.n ?? 0}:${r?.hi ?? 0}:${r?.seen ?? 0}`;
  } catch {
    return "0:0:0";
  }
}

/** Known kiosk owners for the given kiosk ids, as a kiosk -> owner map. */
export function loadKioskOwners(network: string, kioskIds: string[]): Map<string, string> {
  initStore();
  const out = new Map<string, string>();
  if (!db || kioskIds.length === 0) return out;
  const handle = db;
  try {
    // Chunked, because SQLite caps bound parameters and a holder scan can carry
    // thousands of kiosks.
    for (let i = 0; i < kioskIds.length; i += 400) {
      const chunk = kioskIds.slice(i, i + 400);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = handle
        .prepare(`SELECT kiosk_id, owner FROM kiosk_owners WHERE account IN (${placeholders})`)
        .all(...chunk.map((k) => `${network}:${k}`)) as unknown as Array<{
        kiosk_id: string;
        owner: string;
      }>;
      for (const r of rows) out.set(r.kiosk_id, r.owner);
    }
  } catch {
    // A lookup that cannot run leaves every holder attributed the way it was
    // before, which is the documented weaker answer rather than no answer.
    return out;
  }
  return out;
}

export interface StoredWatch {
  address: string;
  label?: string;
  last_checkpoint: number;
  min_amount?: string;
  added_at: number;
}

/** Add or replace a watch. Returns false when no store is configured. */
export function saveWatch(network: string, w: StoredWatch): boolean {
  initStore();
  return tryWrite("saveWatch", false, (db) => {
    db.prepare(
      `INSERT INTO watches (account, network, address, label, last_checkpoint, min_amount, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET
         label = COALESCE(excluded.label, watches.label),
         min_amount = COALESCE(excluded.min_amount, watches.min_amount)`,
    ).run(
      `${network}:${w.address}`,
      network,
      w.address,
      w.label ?? null,
      w.last_checkpoint,
      w.min_amount ?? null,
      w.added_at,
    );
    return true;
  });
}

export function listWatches(network: string): StoredWatch[] {
  initStore();
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT address, label, last_checkpoint, min_amount, added_at
       FROM watches WHERE network = ? ORDER BY added_at`,
    )
    .all(network) as Array<{
    address: string;
    label: string | null;
    last_checkpoint: number;
    min_amount: string | null;
    added_at: number;
  }>;
  return rows.map((r) => ({
    address: r.address,
    ...(r.label ? { label: r.label } : {}),
    last_checkpoint: r.last_checkpoint,
    ...(r.min_amount ? { min_amount: r.min_amount } : {}),
    added_at: r.added_at,
  }));
}

export function removeWatch(network: string, address: string): boolean {
  initStore();
  return tryWrite("removeWatch", false, (db) => {
    const r = db.prepare(`DELETE FROM watches WHERE account = ?`).run(`${network}:${address}`) as {
      changes?: number;
    };
    return (r.changes ?? 0) > 0;
  });
}

/**
 * Advance a watch's high-water mark.
 *
 * Called even when triggers suppressed every hit: a filtered transaction has
 * still been seen, and leaving the cursor behind would re-read it on every
 * poll forever.
 */
/**
 * Advance a watch's high-water mark. False when it could not be written.
 *
 * Fail-soft, because throwing would discard the hits the poll already computed
 * and those are the answer the caller asked for. But the caller must be able to
 * SEE that it failed: a cursor that silently did not move makes every later
 * poll re-report the same activity as new, and an agent polling in a loop
 * counts it every time.
 */
export function advanceWatch(network: string, address: string, checkpoint: number): boolean {
  initStore();
  return tryWrite("advanceWatch", false, (db) => {
    // `changes`, not a bare true. tryWrite only notices a THROW, so a statement
    // that matched no row reported a cursor advance that never happened — and
    // the caller's own "cursor did not move" warning could not see it.
    const r = db.prepare(
      `UPDATE watches SET last_checkpoint = ? WHERE account = ? AND last_checkpoint < ?`,
    ).run(checkpoint, `${network}:${address}`, checkpoint) as { changes?: number };
    return (r.changes ?? 0) > 0;
  });
}
