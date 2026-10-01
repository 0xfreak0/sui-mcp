import { describe, expect, it, vi } from "vitest";
import { readAttackTransactions } from "../src/utils/attack-read.js";

const { fullnodeBatch, archiveBatch } = vi.hoisted(() => ({ fullnodeBatch: vi.fn(), archiveBatch: vi.fn() }));
vi.mock("../src/clients/grpc.js", () => ({
  sui: { ledgerService: { batchGetTransactions: fullnodeBatch } },
  archive: { ledgerService: { batchGetTransactions: archiveBatch } },
}));

const tx = (digest: string) => ({ digest, transaction: { sender: "0x1" }, effects: { status: { success: true } } });
const response = (digests: string[]) => ({ response: { transactions: digests.map((digest) => ({ result: { oneofKind: "transaction", transaction: tx(digest) } })) } });

describe("incident transaction batches", () => {
  it("reads independent 25-digest pages concurrently and returns every row in requested order", async () => {
    const digests = Array.from({ length: 125 }, (_, i) => `digest-${i}`);
    const gate = Promise.withResolvers<void>();
    let inFlight = 0;
    let peak = 0;
    fullnodeBatch.mockImplementation(async ({ digests: batch }: { digests: string[] }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate.promise;
      inFlight--;
      return response(batch);
    });
    const pending = readAttackTransactions(digests);
    await Promise.resolve();
    gate.resolve();
    const read = await pending;
    expect(peak).toBe(4);
    expect(fullnodeBatch).toHaveBeenCalledTimes(5);
    expect(read.txs.map((item) => item.digest)).toEqual(digests);
    expect(read.missing).toEqual([]);
  });
  it("fills pruned positions from archive without losing or reordering a transaction", async () => {
    fullnodeBatch.mockImplementation(async ({ digests: batch }: { digests: string[] }) => ({
      response: { transactions: batch.map((digest) => ({
        result: Number(digest.slice(7)) % 2 ? { oneofKind: "error" } : { oneofKind: "transaction", transaction: tx(digest) },
      })) },
    }));
    archiveBatch.mockImplementation(async ({ digests: batch }: { digests: string[] }) => response(batch));
    const digests = Array.from({ length: 125 }, (_, i) => `digest-${i}`);
    const read = await readAttackTransactions(digests);
    expect(read.txs.map((item) => item.digest)).toEqual(digests);
    expect(read.served_by_archive).toBe(62);
    expect(read.missing).toEqual([]);
    expect(archiveBatch).toHaveBeenCalledTimes(3);
  });
});
