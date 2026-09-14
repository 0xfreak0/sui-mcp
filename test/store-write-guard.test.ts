import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A store write that fails must not fail the read that produced it.
 *
 * This was not hypothetical: an older server process writing into a database a
 * newer build had migrated failed with "NOT NULL constraint failed:
 * fanout.sponsored_address_count", and that took down `get_address_fanout`
 * entirely rather than returning the fan-out it had just measured. The store is
 * a cache beside a read-only server; losing a cache entry is not worth losing
 * the answer.
 */

let dir: string;
let path: string;

beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "sui-store-guard-"));
  path = join(dir, "store.db");
  process.env.SUI_STORE_PATH = path;
});

afterEach(() => {
  delete process.env.SUI_STORE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

/** Replace a table with one the current writer cannot satisfy. */
function rigTable(sql: string, drop: string) {
  const db = new DatabaseSync(path);
  db.exec(`DROP TABLE IF EXISTS ${drop}`);
  db.exec(sql);
  db.close();
}

describe("store writes fail soft", () => {
  it("saveFanout returns false instead of throwing", async () => {
    const store = await import("../src/utils/store.js");
    store.initStore();
    rigTable(
      `CREATE TABLE fanout (account TEXT PRIMARY KEY, impossible INTEGER NOT NULL)`,
      "fanout",
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      store.saveFanout({
        account: "sui:mainnet:0xa",
        recipient_count: 1,
        sender_count: 1,
        counterparty_count: 1,
        coin_type_count: 1,
        out_in_ratio: 1,
        flow_shape: "balanced",
        sponsored_address_count: 0,
        sponsored_transaction_count: 0,
        sponsor_shape: "not_a_sponsor",
        scanned_transactions: 10,
        truncated: 0,
      }),
    ).not.toThrow();
    expect(store.saveFanout as unknown).toBeTypeOf("function");
    // The failure is reported, not swallowed in silence.
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/saveFanout failed/);
    err.mockRestore();
  });

  it("saveWatch returns false instead of throwing", async () => {
    const store = await import("../src/utils/store.js");
    store.initStore();
    rigTable(`CREATE TABLE watches (account TEXT PRIMARY KEY, impossible INTEGER NOT NULL)`, "watches");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      store.saveWatch("mainnet", { address: "0xa", last_checkpoint: 1, added_at: 1 }),
    ).toBe(false);
    err.mockRestore();
  });

  /**
   * A DELETE naming only `account` succeeds against a rigged NOT NULL table, so
   * rigging the schema cannot make `removeWatch` fail and a test built that way
   * passes with or without the guard. A trigger is what actually makes the
   * statement throw.
   */
  it("removeWatch returns false instead of throwing", async () => {
    const store = await import("../src/utils/store.js");
    store.initStore();
    // The row must exist: a BEFORE DELETE trigger fires per matched row, so
    // without one the DELETE succeeds trivially and proves nothing.
    store.saveWatch("mainnet", { address: "0xa", last_checkpoint: 1, added_at: 1 });
    const raw = new DatabaseSync(path);
    raw.exec(
      `CREATE TRIGGER block_watch_delete BEFORE DELETE ON watches
       BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    raw.close();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(store.removeWatch("mainnet", "0xa")).toBe(false);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/removeWatch failed/);
    err.mockRestore();
  });

  it("deleteLabel returns false instead of throwing", async () => {
    const store = await import("../src/utils/store.js");
    store.initStore();
    store.saveLabel({
      account: "sui:mainnet:0xa",
      chain: "sui:mainnet",
      address: "0xa",
      label: "x",
      category: "cex",
      confidence: "high",
      notes: null,
    } as never);
    const raw = new DatabaseSync(path);
    raw.exec(
      `CREATE TRIGGER block_label_delete BEFORE DELETE ON labels
       BEGIN SELECT RAISE(ABORT, 'blocked'); END`,
    );
    raw.close();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(store.deleteLabel("sui:mainnet:0xa")).toBe(false);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/deleteLabel failed/);
    err.mockRestore();
  });

  it("saveLabel returns false instead of throwing", async () => {
    const store = await import("../src/utils/store.js");
    store.initStore();
    rigTable(`CREATE TABLE labels (account TEXT PRIMARY KEY, impossible INTEGER NOT NULL)`, "labels");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      store.saveLabel({
        account: "sui:mainnet:0xa",
        chain: "sui:mainnet",
        address: "0xa",
        label: "x",
        category: "cex",
        confidence: "high",
      } as never),
    ).toBe(false);
    err.mockRestore();
  });

  /** Failures go to stderr. stdout is the MCP transport and must stay clean. */
  it("never writes to stdout", async () => {
    const store = await import("../src/utils/store.js");
    store.initStore();
    rigTable(`CREATE TABLE fanout (account TEXT PRIMARY KEY, impossible INTEGER NOT NULL)`, "fanout");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    store.saveFanout({
      account: "sui:mainnet:0xb",
      recipient_count: 1, sender_count: 1, counterparty_count: 1, coin_type_count: 1,
      out_in_ratio: 1, flow_shape: "balanced", sponsored_address_count: 0,
      sponsored_transaction_count: 0, sponsor_shape: "not_a_sponsor",
      scanned_transactions: 10, truncated: 0,
    });
    expect(out).not.toHaveBeenCalled();
    out.mockRestore();
    err.mockRestore();
  });
  it("saveFirstFunder returns false instead of throwing", async () => {
    const store = await import("../src/utils/store.js");
    store.initStore();
    rigTable(
      `CREATE TABLE first_funders (account TEXT PRIMARY KEY, impossible INTEGER NOT NULL)`,
      "first_funders",
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(store.saveFirstFunder("sui:mainnet:0xa", "sui:mainnet:0xb", "d")).toBe(false);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/saveFirstFunder failed/);
    err.mockRestore();
  });

  /**
   * The existing try/catch in `saveTransaction` covers a payload that will not
   * serialise, which is a different failure from the write itself throwing.
   * Guarding one was mistaken for guarding both.
   */
  it("saveTransaction returns false when the write itself fails", async () => {
    const store = await import("../src/utils/store.js");
    store.initStore();
    rigTable(
      `CREATE TABLE transactions (key TEXT PRIMARY KEY, impossible INTEGER NOT NULL)`,
      "transactions",
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(store.saveTransaction("mainnet", "digest", { a: 1 })).toBe(false);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/saveTransaction failed/);
    err.mockRestore();
  });

  /**
   * A cursor that cannot advance re-reports the same transactions next poll.
   * Throwing instead would discard the hits the poll already computed, which
   * are the answer the caller asked for.
   */
  it("advanceWatch does not throw when the cursor write fails", async () => {
    const store = await import("../src/utils/store.js");
    store.initStore();
    rigTable(`CREATE TABLE watches (account TEXT PRIMARY KEY, impossible INTEGER NOT NULL)`, "watches");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => store.advanceWatch("mainnet", "0xa", 99)).not.toThrow();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/advanceWatch failed/);
    err.mockRestore();
  });

  /**
   * Findings are the investigator's own record, not a cache, so this one is
   * deliberately NOT guarded: `save_finding` reports `saved: true`, and
   * swallowing the failure would make that a claim about evidence the store
   * never took.
   */
  it("saveFinding still throws, because the write IS the operation", async () => {
    const store = await import("../src/utils/store.js");
    store.initStore();
    rigTable(`CREATE TABLE findings (id INTEGER PRIMARY KEY, impossible INTEGER NOT NULL)`, "findings");
    expect(() =>
      store.saveFinding({
        case_name: "c",
        title: "t",
        detail: null,
        confidence: null,
        addresses: [],
        evidence: [],
      }),
    ).toThrow();
  });
});
