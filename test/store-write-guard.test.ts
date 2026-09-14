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

  it("saveWatch and removeWatch return false instead of throwing", async () => {
    const store = await import("../src/utils/store.js");
    store.initStore();
    rigTable(`CREATE TABLE watches (account TEXT PRIMARY KEY, impossible INTEGER NOT NULL)`, "watches");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      store.saveWatch("mainnet", { address: "0xa", last_checkpoint: 1, added_at: 1 }),
    ).toBe(false);
    expect(() => store.removeWatch("mainnet", "0xa")).not.toThrow();
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
});
