import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SuiGrpcClient } from "@mysten/sui/grpc";

const { getObject, getTransaction } = vi.hoisted(() => ({
  getObject: vi.fn(),
  getTransaction: vi.fn(),
}));
const client = { ledgerService: { getObject, getTransaction } } as unknown as SuiGrpcClient;
vi.mock("../src/clients/grpc.js", () => ({ sui: client, archive: client }));

const { resolvePublisher } = await import("../src/utils/publisher.js");

beforeEach(() => {
  getObject.mockReset();
  getTransaction.mockReset();
});

const pkgWithTx = (digest: string) =>
  getObject.mockResolvedValue({ response: { object: { previousTransaction: digest } } });

describe("resolvePublisher", () => {
  it("attributes a package to the sender of its creating transaction", async () => {
    pkgWithTx("Dig3st");
    getTransaction.mockResolvedValue({
      response: {
        transaction: {
          transaction: { sender: "0xdeployer" },
          timestamp: { seconds: 1778062527n, nanos: 0 },
        },
      },
    });
    const r = await resolvePublisher("0xpkg");
    expect(r).toMatchObject({
      package_id: "0xpkg",
      publisher: "0xdeployer",
      publish_tx: "Dig3st",
    });
    expect(r.published_at).toMatch(/^2026-/);
    expect(r.unresolved).toBeUndefined();
  });

  /**
   * "Could not look" and "nobody published it" are opposite conclusions. An
   * absent publisher with no reason attached reads as the second.
   */
  it("says why it failed when the publish transaction cannot be read", async () => {
    pkgWithTx("Pruned");
    getTransaction.mockRejectedValue(new Error("NOT_FOUND"));
    const r = await resolvePublisher("0xpkg");
    expect(r.publisher).toBeNull();
    expect(r.publish_tx).toBe("Pruned");
    expect(r.unresolved).toMatch(/pruned/i);
  });

  it("says why it failed when the package itself cannot be read", async () => {
    getObject.mockRejectedValue(new Error("NOT_FOUND"));
    const r = await resolvePublisher("0xpkg");
    expect(r.unresolved).toMatch(/not evidence/i);
    expect(r.publish_tx).toBeNull();
  });

  it("handles a package with no creating transaction", async () => {
    getObject.mockResolvedValue({ response: { object: {} } });
    const r = await resolvePublisher("0xpkg");
    expect(r.publisher).toBeNull();
    expect(r.unresolved).toMatch(/no creating transaction/i);
  });

  it("flags a transaction that came back without a sender", async () => {
    pkgWithTx("Dig3st");
    getTransaction.mockResolvedValue({ response: { transaction: { transaction: {} } } });
    const r = await resolvePublisher("0xpkg");
    expect(r.publisher).toBeNull();
    expect(r.unresolved).toMatch(/no sender/i);
  });

  /** Enrichment on top of package analysis; it must never fail its caller. */
  it("never throws", async () => {
    getObject.mockRejectedValue(new Error("boom"));
    await expect(resolvePublisher("0xpkg")).resolves.toBeTruthy();
  });

  it("reports the package id it actually attributed", async () => {
    pkgWithTx("Dig3st");
    getTransaction.mockResolvedValue({
      response: { transaction: { transaction: { sender: "0xd" } } },
    });
    // Callers pass the lineage root; echoing it back keeps "publisher" and
    // "upgrader" distinguishable in the response.
    expect((await resolvePublisher("0xroot")).package_id).toBe("0xroot");
  });
});

describe("resolvePublisher — system packages", () => {
  /**
   * Framework packages keep their ID and bump their version, so the object's
   * creating transaction is the most recent protocol upgrade. Every other
   * package is immutable, which is what makes that field mean "published by".
   */
  it("does not report a framework upgrade as a publish", async () => {
    getObject.mockResolvedValue({ response: { object: { previousTransaction: "Upgr4de" } } });
    getTransaction.mockResolvedValue({
      response: {
        transaction: {
          transaction: { sender: "0x".padEnd(66, "0") },
          timestamp: { seconds: 1787000000n, nanos: 0 },
        },
      },
    });
    const r = await resolvePublisher("0x2");
    expect(r.system_package).toBe(true);
    expect(r.unresolved).toMatch(/upgrades in place/i);
  });

  it("leaves an ordinary publisher unflagged", async () => {
    getObject.mockResolvedValue({ response: { object: { previousTransaction: "D" } } });
    getTransaction.mockResolvedValue({
      response: { transaction: { transaction: { sender: "0xabc" } } },
    });
    const r = await resolvePublisher("0xpkg");
    expect(r.system_package).toBeUndefined();
    expect(r.unresolved).toBeUndefined();
  });
});
