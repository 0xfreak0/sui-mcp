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
  address: string;
  recipient_count: number;
  truncated: number;
  measured_at: number;
  /** Which measurement method produced this row. See FANOUT_METHOD_VERSION. */
  method_version?: number;
}

export interface StoredLabel {
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
 */
export const FANOUT_METHOD_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS labels (
  address     TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  category    TEXT NOT NULL,
  confidence  TEXT,
  notes       TEXT,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fanout (
  address         TEXT PRIMARY KEY,
  recipient_count INTEGER NOT NULL,
  truncated       INTEGER NOT NULL,
  measured_at     INTEGER NOT NULL
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
CREATE INDEX IF NOT EXISTS findings_case ON findings(case_name);
`;

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
  if ((row?.user_version ?? 0) >= FANOUT_METHOD_VERSION) return;
  opened.exec(`DELETE FROM fanout`);
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
    migrateFanoutCache(opened);
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
    `INSERT INTO labels (address, label, category, confidence, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       label=excluded.label, category=excluded.category,
       confidence=excluded.confidence, notes=excluded.notes,
       updated_at=excluded.updated_at`,
  ).run(l.address, l.label, l.category, l.confidence, l.notes, Date.now());
  return true;
}

export function loadLabels(): StoredLabel[] {
  initStore();
  if (!db) return [];
  return db.prepare(`SELECT * FROM labels`).all() as unknown as StoredLabel[];
}

export function deleteLabel(address: string): boolean {
  initStore();
  if (!db) return false;
  db.prepare(`DELETE FROM labels WHERE address = ?`).run(address);
  return true;
}

export function saveFanout(r: Omit<FanoutRecord, "measured_at">): boolean {
  initStore();
  if (!db) return false;
  db.prepare(
    `INSERT INTO fanout (address, recipient_count, truncated, measured_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       recipient_count=excluded.recipient_count,
       truncated=excluded.truncated,
       measured_at=excluded.measured_at`,
  ).run(r.address, r.recipient_count, r.truncated, Date.now());
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
  address: string,
  maxAgeMs = 7 * 24 * 3600 * 1000,
): (FanoutRecord & { age_ms: number }) | null {
  initStore();
  if (!db) return null;
  const row = db.prepare(`SELECT * FROM fanout WHERE address = ?`).get(address) as
    | FanoutRecord
    | undefined;
  if (!row) return null;
  const age = Date.now() - row.measured_at;
  return age <= maxAgeMs ? { ...row, age_ms: age, method_version: FANOUT_METHOD_VERSION } : null;
}
