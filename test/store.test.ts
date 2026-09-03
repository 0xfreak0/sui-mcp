import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  deleteFinding,
  deleteLabel,
  getCachedFanout,
  initStore,
  loadLabels,
  resetStore,
  listCases,
  loadFindings,
  FANOUT_METHOD_VERSION,
  saveFanout,
  saveFinding,
  saveLabel,
  storeStatus,
} from "../src/utils/store.js";

/** A complete measurement; tests override only the fields they care about. */
const fanout = (over: Record<string, unknown>) => ({
  recipient_count: 1,
  sender_count: 1,
  counterparty_count: 1,
  coin_type_count: 1,
  out_in_ratio: 1,
  flow_shape: "balanced",
  scanned_transactions: 1,
  truncated: 0,
  ...over,
}) as Parameters<typeof saveFanout>[0];

/**
 * A complete label row. The store persists what it is given without
 * normalizing, so tests supply the chain-qualified triple the way
 * `utils/labels.ts` would.
 */
const label = (over: Record<string, unknown>) => ({
  account: "sui:mainnet:0xabc",
  chain: "sui:mainnet",
  address: "0xabc",
  label: "X",
  category: "cex",
  confidence: null,
  notes: null,
  ...over,
}) as Parameters<typeof saveLabel>[0];

let dir: string;
let backup: string | undefined;

beforeEach(() => {
  backup = process.env.SUI_STORE_PATH;
  dir = mkdtempSync(join(tmpdir(), "sui-store-"));
  resetStore();
});

afterEach(() => {
  resetStore();
  if (backup === undefined) delete process.env.SUI_STORE_PATH;
  else process.env.SUI_STORE_PATH = backup;
  rmSync(dir, { recursive: true, force: true });
});

const enable = () => {
  process.env.SUI_STORE_PATH = join(dir, "store.db");
  resetStore();
  initStore();
};

/**
 * Is node:sqlite present on this runtime?
 *
 * The package requires Node >= 22.13, but the tests should still say something
 * true when run somewhere older rather than failing with a misleading
 * assertion. The "enabled" suite below is skipped there; the degradation suite
 * runs everywhere and is the behaviour that matters on an unsupported runtime.
 */
const hasSqlite = (() => {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

describe("store disabled (the default)", () => {
  beforeEach(() => {
    delete process.env.SUI_STORE_PATH;
    resetStore();
  });

  // The whole point: without SUI_STORE_PATH nothing touches disk and every
  // call is a no-op rather than an error.
  it("reports itself disabled with a reason", () => {
    const s = storeStatus();
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/SUI_STORE_PATH/);
  });

  it("makes every write a no-op that returns false", () => {
    expect(saveLabel(label({ label: "X" }))).toBe(false);
    expect(saveFanout(fanout({ account: "sui:mainnet:0xa", recipient_count: 5 }))).toBe(false);
    expect(deleteLabel("0xa")).toBe(false);
  });

  it("makes every read empty rather than throwing", () => {
    expect(loadLabels()).toEqual([]);
    expect(getCachedFanout("sui:mainnet:0xa")).toBeNull();
  });
});

describe.skipIf(!hasSqlite)("store enabled", () => {
  it("creates the database and reports its path", () => {
    enable();
    const s = storeStatus();
    expect(s.enabled).toBe(true);
    expect(s.path).toContain("store.db");
    expect(s.reason).toBeNull();
  });

  it("round-trips a label", () => {
    enable();
    saveLabel(
      label({
        label: "Binance hot wallet",
        confidence: "high",
        notes: "29k recipients",
      }),
    );
    const labels = loadLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      account: "sui:mainnet:0xabc",
      chain: "sui:mainnet",
      address: "0xabc",
      label: "Binance hot wallet",
      category: "cex",
    });
  });

  it("upserts rather than duplicating on the same address", () => {
    enable();
    saveLabel(label({ label: "First" }));
    saveLabel(label({ label: "Second" }));
    const labels = loadLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0].label).toBe("Second");
  });

  it("deletes a label", () => {
    enable();
    saveLabel(label({ label: "X" }));
    deleteLabel("sui:mainnet:0xabc");
    expect(loadLabels()).toEqual([]);
  });

  it("round-trips a fan-out measurement", () => {
    enable();
    saveFanout(fanout({ account: "sui:mainnet:0xhub", recipient_count: 29_180, counterparty_count: 29_180, truncated: 1 }));
    const r = getCachedFanout("sui:mainnet:0xhub");
    expect(r?.recipient_count).toBe(29_180);
    expect(r?.truncated).toBe(1);
    expect(r?.age_ms).toBeGreaterThanOrEqual(0);
  });

  it("honours the freshness window", () => {
    enable();
    saveFanout(fanout({ account: "sui:mainnet:0xhub", recipient_count: 5 }));
    // Just written, so a zero-tolerance window must still find it or miss it
    // deterministically — never return a stale reading as current.
    expect(getCachedFanout("sui:mainnet:0xhub", 60_000)).not.toBeNull();
    expect(getCachedFanout("sui:mainnet:0xhub", -1)).toBeNull();
  });

  it("returns null for an address never measured", () => {
    enable();
    expect(getCachedFanout("sui:mainnet:0xnope")).toBeNull();
  });

  it("persists across a reopen, which is the entire point", () => {
    enable();
    saveLabel(label({ label: "Kept", category: "bridge" }));
    resetStore();
    initStore();
    expect(loadLabels()[0]?.label).toBe("Kept");
  });
});

describe.skipIf(!hasSqlite)("findings", () => {
  const base = { case_name: "case-a", title: "T", detail: null, confidence: null, addresses: [], evidence: [] };

  it("round-trips a finding with its arrays intact", () => {
    enable();
    saveFinding({
      ...base,
      title: "23 of 25 share a funder",
      detail: "Funded in three bursts.",
      confidence: "high",
      addresses: ["0xa", "0xb"],
      evidence: ["find_funding_sources depth=first_hop", "fan-out 1623"],
    });
    const [f] = loadFindings("case-a");
    expect(f.title).toBe("23 of 25 share a funder");
    expect(f.addresses).toEqual(["0xa", "0xb"]);
    expect(f.evidence).toHaveLength(2);
    expect(f.id).toBeGreaterThan(0);
  });

  it("keeps cases separate", () => {
    enable();
    saveFinding({ ...base, case_name: "case-a" });
    saveFinding({ ...base, case_name: "case-b" });
    expect(loadFindings("case-a")).toHaveLength(1);
    expect(loadFindings("case-b")).toHaveLength(1);
    expect(loadFindings()).toHaveLength(2);
  });

  it("lists cases with counts", () => {
    enable();
    saveFinding({ ...base, case_name: "case-a" });
    saveFinding({ ...base, case_name: "case-a" });
    saveFinding({ ...base, case_name: "case-b" });
    const cases = listCases();
    expect(cases.find((c) => c.case_name === "case-a")?.finding_count).toBe(2);
    expect(cases.find((c) => c.case_name === "case-b")?.finding_count).toBe(1);
  });

  it("deletes a finding, for retracting something wrong", () => {
    enable();
    const id = saveFinding({ ...base });
    deleteFinding(id!);
    expect(loadFindings("case-a")).toEqual([]);
  });

  // Findings accumulate rather than replace: two conclusions about the same
  // case are both real, unlike a label where the latest wins.
  it("appends rather than upserting", () => {
    enable();
    saveFinding({ ...base, title: "First" });
    saveFinding({ ...base, title: "Second" });
    expect(loadFindings("case-a").map((f) => f.title)).toEqual(["First", "Second"]);
  });

  it("survives a reopen", () => {
    enable();
    saveFinding({ ...base, title: "Kept" });
    resetStore();
    initStore();
    expect(loadFindings("case-a")[0]?.title).toBe("Kept");
  });
});

describe("findings with the store off", () => {
  beforeEach(() => {
    delete process.env.SUI_STORE_PATH;
    resetStore();
  });

  it("returns null / empty instead of throwing", () => {
    expect(saveFinding({ case_name: "c", title: "T", detail: null, confidence: null, addresses: [], evidence: [] })).toBeNull();
    expect(loadFindings("c")).toEqual([]);
    expect(listCases()).toEqual([]);
  });
});

describe("unsupported runtime", () => {
  // The store must be an enhancement, never a requirement: on a Node without
  // node:sqlite the server has to keep working with persistence simply off.
  it.skipIf(hasSqlite)("degrades to disabled when node:sqlite is missing", () => {
    enable();
    const s = storeStatus();
    expect(s.enabled).toBe(false);
    expect(loadLabels()).toEqual([]);
    expect(saveLabel(label({ label: "X" }))).toBe(false);
  });
});

describe("store failure handling", () => {
  // Setting a path a few directories deep should just work — the alternative
  // is a silent disable over something we can create.
  it.skipIf(!hasSqlite)("creates missing parent directories", () => {
    process.env.SUI_STORE_PATH = join(dir, "nested", "deeper", "store.db");
    resetStore();
    initStore();
    expect(storeStatus().enabled).toBe(true);
    saveLabel(label({ label: "X" }));
    expect(loadLabels()).toHaveLength(1);
  });

  it.skipIf(!hasSqlite)("degrades to disabled instead of throwing on an unusable path", () => {
    // A path whose parent is a *file*, so it cannot be made into a directory.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    process.env.SUI_STORE_PATH = join(blocker, "store.db");
    resetStore();
    expect(() => initStore()).not.toThrow();
    expect(storeStatus().enabled).toBe(false);
    expect(loadLabels()).toEqual([]);
  });
});

/**
 * The fan-out cache is keyed on address alone, so it cannot tell that the
 * *definition* of the measurement changed underneath it. 1.5.0 fixed fan-out to
 * walk backwards through history and to count both directions, which means a
 * row written by 1.4.x answers a different question than the one being asked —
 * and the 7-day TTL would keep serving it for a week after the upgrade.
 */
describe("fan-out cache invalidation across method changes", () => {
  const ADDR = "sui:mainnet:0xstale";

  /** Write a row the way an older version would have: no method version. */
  function writeLegacyRow(path: string) {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string) => any };
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE IF NOT EXISTS fanout (
      address TEXT PRIMARY KEY, recipient_count INTEGER NOT NULL,
      truncated INTEGER NOT NULL, measured_at INTEGER NOT NULL)`);
    raw.prepare(`INSERT INTO fanout VALUES (?, ?, ?, ?)`).run("0xstale", 1623, 0, Date.now());
    raw.close();
  }

  it("discards measurements taken by an older method", () => {
    const path = join(dir, "legacy.db");
    writeLegacyRow(path);

    process.env.SUI_STORE_PATH = path;
    resetStore();
    // Fresh, well within the 7-day TTL — age is not what rejects it.
    expect(getCachedFanout(ADDR)).toBeNull();
  });

  it("keeps labels and findings, which are user data rather than cache", () => {
    const path = join(dir, "legacy2.db");
    writeLegacyRow(path);

    process.env.SUI_STORE_PATH = path;
    resetStore();
    saveLabel(label({ account: "sui:mainnet:0xkeep", address: "0xkeep", label: "Mine" }));
    saveFinding({ case_name: "c", title: "t", detail: null, confidence: null, addresses: [], evidence: [] });
    resetStore();

    expect(loadLabels().find((l) => l.account === "sui:mainnet:0xkeep")?.label).toBe("Mine");
    expect(loadFindings("c")).toHaveLength(1);
  });

  it("serves a measurement taken by the current method", () => {
    process.env.SUI_STORE_PATH = join(dir, "current.db");
    resetStore();
    saveFanout(fanout({ account: ADDR, recipient_count: 792 }));
    resetStore();

    const cached = getCachedFanout(ADDR);
    expect(cached?.recipient_count).toBe(792);
    expect(cached?.method_version).toBe(FANOUT_METHOD_VERSION);
  });
});

/**
 * The cache used to persist only recipient_count, so a cache hit returned -1
 * for sender_count/coin_type_count and "unknown" for flow_shape. That silently
 * disabled the 1.5.0 headline feature on exactly the documented path:
 * find_funding_sources populates the cache, so the follow-up fan-out call on a
 * shared funder was always a cache hit.
 */
describe("fan-out cache round-trips the full measurement", () => {
  it("restores the in/out split, coin diversity and flow shape", () => {
    process.env.SUI_STORE_PATH = join(dir, "full.db");
    resetStore();

    saveFanout({
      account: "sui:mainnet:0xfull",
      recipient_count: 431,
      sender_count: 44,
      counterparty_count: 440,
      coin_type_count: 7,
      out_in_ratio: 9.78,
      flow_shape: "disperser",
      scanned_transactions: 600,
      truncated: 1,
    });
    resetStore();

    const c = getCachedFanout("sui:mainnet:0xfull");
    expect(c?.recipient_count).toBe(431);
    expect(c?.sender_count).toBe(44);
    expect(c?.counterparty_count).toBe(440);
    expect(c?.coin_type_count).toBe(7);
    expect(c?.out_in_ratio).toBeCloseTo(9.78);
    expect(c?.flow_shape).toBe("disperser");
    expect(c?.scanned_transactions).toBe(600);
    expect(c?.truncated).toBe(1);
  });

  // null is the honest value for "nothing was received", and must not come
  // back as 0 — which would read as a measured ratio of zero.
  it("keeps a null out_in_ratio null rather than zero", () => {
    process.env.SUI_STORE_PATH = join(dir, "nullratio.db");
    resetStore();
    saveFanout({
      account: "sui:mainnet:0xnull",
      recipient_count: 3,
      sender_count: 0,
      counterparty_count: 3,
      coin_type_count: 1,
      out_in_ratio: null,
      flow_shape: "unknown",
      scanned_transactions: 3,
      truncated: 0,
    });
    resetStore();
    const c = getCachedFanout("sui:mainnet:0xnull");
    expect(c?.out_in_ratio).toBeNull();
    expect(c?.flow_shape).toBe("unknown");
  });

  // The exact state a half-finished migration leaves behind: the stamp says
  // current, the columns say otherwise. Checking only the stamp would never
  // recover, and every write would fail for as long as the store existed.
  it("repairs a store stamped current but still holding the old columns", () => {
    const path = join(dir, "halfmigrated.db");
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string) => any };
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE fanout (address TEXT PRIMARY KEY, recipient_count INTEGER NOT NULL,
      truncated INTEGER NOT NULL, measured_at INTEGER NOT NULL)`);
    raw.exec(`PRAGMA user_version = ${FANOUT_METHOD_VERSION}`);
    raw.close();

    process.env.SUI_STORE_PATH = path;
    resetStore();
    expect(saveFanout(fanout({ account: "sui:mainnet:0xrepaired", flow_shape: "disperser" }))).toBe(true);
    expect(getCachedFanout("sui:mainnet:0xrepaired")?.flow_shape).toBe("disperser");
  });

  it("discards rows written before the fields existed", () => {
    const path = join(dir, "v1.db");
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string) => any };
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE fanout (address TEXT PRIMARY KEY, recipient_count INTEGER NOT NULL,
      truncated INTEGER NOT NULL, measured_at INTEGER NOT NULL)`);
    raw.exec(`PRAGMA user_version = 1`);
    raw.prepare(`INSERT INTO fanout VALUES (?,?,?,?)`).run("0xold", 431, 0, Date.now());
    raw.close();

    process.env.SUI_STORE_PATH = path;
    resetStore();
    expect(getCachedFanout("sui:mainnet:0xold")).toBeNull();

    // The table must actually be rebuilt, not just emptied: CREATE TABLE IF NOT
    // EXISTS leaves an old table's columns in place, so a write would fail with
    // "no column named sender_count". Only a pre-existing store hits this, which
    // is why a fresh temp DB per test never caught it.
    expect(saveFanout(fanout({ account: "sui:mainnet:0xnew", flow_shape: "collector" }))).toBe(true);
    expect(getCachedFanout("sui:mainnet:0xnew")?.flow_shape).toBe("collector");
  });
});

describe.skipIf(!hasSqlite)("legacy store migration", () => {
  const LEGACY_ADDR = "0xaaa";
  /**
   * Write a store in the pre-chain-qualified shape: labels keyed on a bare
   * `address`, findings holding bare addresses. This is what any existing
   * user's store looks like, and it holds attribution they established by
   * hand — losing it on upgrade would be a data-loss bug, not an
   * inconvenience.
   */
  function writeLegacyStore(path: string): void {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (p: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...a: unknown[]): unknown };
        close(): void;
      };
    };
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE labels (
        address TEXT PRIMARY KEY, label TEXT NOT NULL, category TEXT NOT NULL,
        confidence TEXT, notes TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, case_name TEXT NOT NULL,
        title TEXT NOT NULL, detail TEXT, confidence TEXT,
        addresses TEXT, evidence TEXT, created_at INTEGER NOT NULL
      );
    `);
    legacy
      .prepare(`INSERT INTO labels VALUES (?, ?, ?, ?, ?, ?)`)
      .run(LEGACY_ADDR, "Attacker #1", "malicious", "high", "hand-attributed", 1_700_000_000_000);
    legacy
      .prepare(`INSERT INTO findings (case_name, title, detail, confidence, addresses, evidence, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "legacy-case",
        "Shared funder",
        null,
        "high",
        JSON.stringify([LEGACY_ADDR, "0xbbb"]),
        JSON.stringify(["find_funding_sources depth=first_hop"]),
        1_700_000_000_000,
      );
    legacy.close();
  }

  it("carries legacy labels forward as sui:mainnet accounts", () => {
    const path = join(dir, "legacy.db");
    writeLegacyStore(path);

    process.env.SUI_STORE_PATH = path;
    resetStore();
    initStore();

    const labels = loadLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      account: `sui:mainnet:${LEGACY_ADDR}`,
      chain: "sui:mainnet",
      address: LEGACY_ADDR,
      label: "Attacker #1",
      category: "malicious",
      confidence: "high",
    });
    // The timestamp is part of the record, not something the migration
    // may reset — an "updated" label nobody updated is a false audit trail.
    expect(labels[0].updated_at).toBe(1_700_000_000_000);
  });

  it("qualifies bare addresses inside legacy findings", () => {
    const path = join(dir, "legacy.db");
    writeLegacyStore(path);

    process.env.SUI_STORE_PATH = path;
    resetStore();
    initStore();

    const [f] = loadFindings("legacy-case");
    expect(f.addresses).toEqual([`sui:mainnet:${LEGACY_ADDR}`, "sui:mainnet:0xbbb"]);
    // Evidence is prose and must be left exactly as written.
    expect(f.evidence).toEqual(["find_funding_sources depth=first_hop"]);
  });

  it("is idempotent — reopening an already-migrated store changes nothing", () => {
    const path = join(dir, "legacy.db");
    writeLegacyStore(path);

    process.env.SUI_STORE_PATH = path;
    resetStore();
    initStore();
    const first = loadLabels();
    const firstFindings = loadFindings("legacy-case");

    resetStore();
    initStore();
    expect(loadLabels()).toEqual(first);
    // Double-qualification (sui:mainnet:sui:mainnet:0xaaa) is the specific
    // failure this guards.
    expect(loadFindings("legacy-case")[0].addresses).toEqual(firstFindings[0].addresses);
  });
});
