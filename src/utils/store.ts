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
 */
export const FANOUT_METHOD_VERSION = 3;

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
CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_name   TEXT NOT NULL,
  title       TEXT NOT NULL,
  detail      TEXT,
  confidence  TEXT,
  -- JSON arrays. Kept as text rather than join tables: a finding is a
  -- write-once note, and querying inside it is not a use case.
  addresses   TEXT,
  evidence    TEXT,
  created_at  INTEGER NOT NULL
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

export function saveLabel(l: Omit<StoredLabel, "updated_at">): boolean {
  initStore();
  if (!db) return false;
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
}

export function loadLabels(): StoredLabel[] {
  initStore();
  if (!db) return [];
  return db.prepare(`SELECT * FROM labels`).all() as unknown as StoredLabel[];
}

/** Delete by canonical CAIP-10 account id. */
export function deleteLabel(account: string): boolean {
  initStore();
  if (!db) return false;
  db.prepare(`DELETE FROM labels WHERE account = ?`).run(account);
  return true;
}

export function saveFanout(r: Omit<FanoutRecord, "measured_at">): boolean {
  initStore();
  if (!db) return false;
  db.prepare(
    `INSERT INTO fanout (account, recipient_count, sender_count, counterparty_count,
                         coin_type_count, out_in_ratio, flow_shape,
                         scanned_transactions, truncated, measured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account) DO UPDATE SET
       recipient_count=excluded.recipient_count,
       sender_count=excluded.sender_count,
       counterparty_count=excluded.counterparty_count,
       coin_type_count=excluded.coin_type_count,
       out_in_ratio=excluded.out_in_ratio,
       flow_shape=excluded.flow_shape,
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
    r.scanned_transactions,
    r.truncated,
    Date.now(),
  );
  return true;
}

export interface Finding {
  id?: number;
  case_name: string;
  title: string;
  detail: string | null;
  confidence: string | null;
  /** Addresses the finding is about. */
  addresses: string[];
  /** How it was established — tool calls, digests, counts. */
  evidence: string[];
  created_at?: number;
}

interface FindingRow {
  id: number;
  case_name: string;
  title: string;
  detail: string | null;
  confidence: string | null;
  addresses: string | null;
  evidence: string | null;
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
  addresses: parseList(r.addresses),
  evidence: parseList(r.evidence),
  created_at: r.created_at,
});

/** Record a finding. Returns its id, or null when the store is off. */
export function saveFinding(f: Omit<Finding, "id" | "created_at">): number | null {
  initStore();
  if (!db) return null;
  db.prepare(
    `INSERT INTO findings (case_name, title, detail, confidence, addresses, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    f.case_name,
    f.title,
    f.detail ?? null,
    f.confidence ?? null,
    JSON.stringify(f.addresses ?? []),
    JSON.stringify(f.evidence ?? []),
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

export function deleteFinding(id: number): boolean {
  initStore();
  if (!db) return false;
  db.prepare(`DELETE FROM findings WHERE id = ?`).run(id);
  return true;
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
    text = JSON.stringify(payload);
  } catch {
    // A payload that will not serialise is not worth failing a trace over.
    return false;
  }
  db.prepare(
    `INSERT INTO transactions (key, network, digest, payload, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at`,
  ).run(`${network}:${digest}`, network, digest, text, Date.now());
  return true;
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
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}
