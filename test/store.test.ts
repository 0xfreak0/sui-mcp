import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  deleteLabel,
  getCachedFanout,
  initStore,
  loadLabels,
  resetStore,
  saveFanout,
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
  it.skipIf(!hasSqlite)("degrades to disabled instead of throwing on an unopenable path", () => {
    // A directory that does not exist: the server must keep running.
    process.env.SUI_STORE_PATH = join(dir, "no", "such", "dir", "store.db");
    resetStore();
    expect(() => initStore()).not.toThrow();
    const s = storeStatus();
    expect(s.enabled).toBe(false);
    expect(s.reason).toMatch(/could not open/);
    expect(loadLabels()).toEqual([]);
  });
});
