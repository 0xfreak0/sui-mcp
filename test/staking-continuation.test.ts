import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStakingContinuation, saveStakingContinuation } from "../src/utils/staking-continuation.js";
import { resetStore } from "../src/utils/store.js";
import { DatabaseSync } from "node:sqlite";

let dir: string;
const previousStore = process.env.SUI_STORE_PATH;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "staking-continuation-"));
  process.env.SUI_STORE_PATH = join(dir, "store.db");
  resetStore();
});
afterEach(() => {
  resetStore();
  if (previousStore === undefined) delete process.env.SUI_STORE_PATH;
  else process.env.SUI_STORE_PATH = previousStore;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const positions = Array.from({ length: 100 }, (_, i) => ({
  object_id: `0x${i.toString(16).padStart(64, "0")}`, version: i + 1,
  pool_id: `0x${"c".repeat(64)}`, principal_mist: String(1000 + i), stake_activation_epoch: "10",
}));
const state = { address: `0x${"a".repeat(64)}`, direction: "reverse", checkpoint: 100,
  anchor: 1000, calls: 3, progress: { phase: "transactions", cursor: "tx-page", offset: 2, change_cursor: "change-page" }, positions };

describe("staking continuation capabilities", () => {
  it("keeps small states off disk and large states resumable across server restarts", async () => {
    const small = saveStakingContinuation({ ...state, positions: positions.slice(0, 1) });
    expect(small.storage).toBe("argument");
    expect(loadStakingContinuation(small.token)).toEqual({ ...state, positions: positions.slice(0, 1) });
    const large = saveStakingContinuation(state);
    expect(large.storage).toBe("local_store");
    expect(large.token.length).toBeLessThan(128);
    resetStore();
    // A fresh module instance models a restarted server's new inline key.
    vi.resetModules();
    const restarted = await import("../src/utils/staking-continuation.js");
    const restartedStore = await import("../src/utils/store.js");
    try {
      expect(restarted.loadStakingContinuation(large.token)).toEqual(state);
      expect(() => restarted.loadStakingContinuation(small.token)).toThrow(/another server session/);
    } finally { restartedStore.resetStore(); }
  });

  it("does not trust altered stored handles, stored ciphertext or expired stored state", () => {
    const saved = saveStakingContinuation(state);
    const parts = saved.token.split(".");
    const altered = [...parts];
    altered[3] = `${altered[3][0] === "A" ? "B" : "A"}${altered[3].slice(1)}`;
    expect(() => loadStakingContinuation(altered.join("."))).toThrow(/tampered/);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1000 + 1);
    expect(() => loadStakingContinuation(saved.token)).toThrow(/lifetime has expired/);
    clock.mockRestore();
    // The database is a persistence boundary too: ciphertext must authenticate.
    const db = new DatabaseSync(process.env.SUI_STORE_PATH!);
    db.prepare("UPDATE results SET payload = ? WHERE id = ?").run(JSON.stringify({ sealed: "A".repeat(100) }), parts[2]);
    db.close();
    expect(() => loadStakingContinuation(saved.token)).toThrow(/tampered/);
  });

  it("requires an opted-in writable store instead of silently discarding large replay state", () => {
    delete process.env.SUI_STORE_PATH;
    resetStore();
    expect(() => saveStakingContinuation(state)).toThrow(/SUI_STORE_PATH/);
    const small = saveStakingContinuation({ positions: [] });
    expect(loadStakingContinuation(small.token)).toEqual({ positions: [] });
  });
});
