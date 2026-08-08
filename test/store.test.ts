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
    expect(saveLabel({ address: "0xa", label: "X", category: "cex", confidence: null, notes: null })).toBe(false);
    expect(saveFanout({ address: "0xa", recipient_count: 5, truncated: 0 })).toBe(false);
    expect(deleteLabel("0xa")).toBe(false);
  });

  it("makes every read empty rather than throwing", () => {
    expect(loadLabels()).toEqual([]);
    expect(getCachedFanout("0xa")).toBeNull();
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
    saveLabel({
      address: "0xabc",
      label: "Binance hot wallet",
      category: "cex",
      confidence: "high",
      notes: "29k recipients",
    });
    const labels = loadLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      address: "0xabc",
      label: "Binance hot wallet",
      category: "cex",
    });
  });

  it("upserts rather than duplicating on the same address", () => {
    enable();
    const base = { address: "0xabc", category: "cex", confidence: null, notes: null };
    saveLabel({ ...base, label: "First" });
    saveLabel({ ...base, label: "Second" });
    const labels = loadLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0].label).toBe("Second");
  });

  it("deletes a label", () => {
    enable();
    saveLabel({ address: "0xabc", label: "X", category: "cex", confidence: null, notes: null });
    deleteLabel("0xabc");
    expect(loadLabels()).toEqual([]);
  });

  it("round-trips a fan-out measurement", () => {
    enable();
    saveFanout({ address: "0xhub", recipient_count: 29_180, truncated: 1 });
    const r = getCachedFanout("0xhub");
    expect(r?.recipient_count).toBe(29_180);
    expect(r?.truncated).toBe(1);
    expect(r?.age_ms).toBeGreaterThanOrEqual(0);
  });

  it("honours the freshness window", () => {
    enable();
    saveFanout({ address: "0xhub", recipient_count: 5, truncated: 0 });
    // Just written, so a zero-tolerance window must still find it or miss it
    // deterministically — never return a stale reading as current.
    expect(getCachedFanout("0xhub", 60_000)).not.toBeNull();
    expect(getCachedFanout("0xhub", -1)).toBeNull();
  });

  it("returns null for an address never measured", () => {
    enable();
    expect(getCachedFanout("0xnope")).toBeNull();
  });

  it("persists across a reopen, which is the entire point", () => {
    enable();
    saveLabel({ address: "0xabc", label: "Kept", category: "bridge", confidence: null, notes: null });
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
    expect(saveLabel({ address: "0xa", label: "X", category: "cex", confidence: null, notes: null })).toBe(false);
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
    saveLabel({ address: "0xa", label: "X", category: "cex", confidence: null, notes: null });
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
  const ADDR = "0xstale";

  /** Write a row the way an older version would have: no method version. */
  function writeLegacyRow(path: string) {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string) => any };
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE IF NOT EXISTS fanout (
      address TEXT PRIMARY KEY, recipient_count INTEGER NOT NULL,
      truncated INTEGER NOT NULL, measured_at INTEGER NOT NULL)`);
    raw.prepare(`INSERT INTO fanout VALUES (?, ?, ?, ?)`).run(ADDR, 1623, 0, Date.now());
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
    saveLabel({ address: "0xkeep", label: "Mine", category: "cex", confidence: null, notes: null });
    saveFinding({ case_name: "c", title: "t", detail: null, confidence: null, addresses: [], evidence: [] });
    resetStore();

    expect(loadLabels().find((l) => l.address === "0xkeep")?.label).toBe("Mine");
    expect(loadFindings("c")).toHaveLength(1);
  });

  it("serves a measurement taken by the current method", () => {
    process.env.SUI_STORE_PATH = join(dir, "current.db");
    resetStore();
    saveFanout({ address: ADDR, recipient_count: 792, truncated: 0 });
    resetStore();

    const cached = getCachedFanout(ADDR);
    expect(cached?.recipient_count).toBe(792);
    expect(cached?.method_version).toBe(FANOUT_METHOD_VERSION);
  });
});
