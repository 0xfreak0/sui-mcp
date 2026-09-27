import { describe, it, expect } from "vitest";
import {
  custodyChanges,
  listObjectChanges,
  mutatedCapabilities,
  readGrpcObjectChanges,
  summarizeObjectChanges,
} from "../src/utils/object-flow.js";

/**
 * What `get_transaction` says when a transaction moved no coin.
 *
 * A transaction that runs zero commands and emits nothing still executes,
 * commits and writes an object, so `actions: []`, `token_flow: []` and
 * `protocols: []` must not be the whole report.
 *
 * These call `summarizeObjectChanges` and `custodyChanges` directly rather
 * than re-implementing the counting here, so a mutation of the production
 * code fails the suite.
 */

/** `sui.rpc.v2.ChangedObject.IdOperation` / `InputObjectState`. */
const ID_UNCHANGED = 1;
const ID_CREATED = 2;
const ID_DELETED = 3;
const INPUT_EXISTS = 2;

const OWNER_A = `0xaa${"1".repeat(62)}`;
const OWNER_B = `0xbb${"2".repeat(62)}`;

/** The shape `readGrpcObjectChanges` consumes, as gRPC delivers it. */
function change(over: Record<string, unknown> = {}) {
  return {
    objectId: `0xcc${"3".repeat(62)}`,
    objectType: "0xabc::art::Piece",
    idOperation: ID_UNCHANGED,
    inputState: INPUT_EXISTS,
    inputOwner: { kind: 1, address: OWNER_A },
    outputOwner: { kind: 1, address: OWNER_B },
    ...over,
  } as never;
}

describe("counting what a transaction touched", () => {
  it("counts a single change, which is the shape of an empty transaction", () => {
    expect(summarizeObjectChanges([change()])).toEqual({
      changed: 1,
      created: 0,
      deleted: 0,
    });
  });

  it("distinguishes created from deleted", () => {
    const s = summarizeObjectChanges([
      change({ idOperation: ID_CREATED }),
      change({ idOperation: ID_DELETED }),
      change({ idOperation: ID_DELETED }),
      change({ idOperation: ID_UNCHANGED }),
    ]);
    expect(s).toEqual({ changed: 4, created: 1, deleted: 2 });
  });

  it("reports zeroes rather than throwing on no changes", () => {
    expect(summarizeObjectChanges([])).toEqual({ changed: 0, created: 0, deleted: 0 });
  });

  /**
   * The counts deliberately do not single out the gas object: a transaction
   * whose gas is paid from a balance accumulator has no `effects.gasObject`.
   */
  it("says nothing about which object paid for the transaction", () => {
    expect(Object.keys(summarizeObjectChanges([change()])).sort()).toEqual([
      "changed",
      "created",
      "deleted",
    ]);
  });
});

/**
 * `object_transfers` lists each object that changed hands with both parties'
 * owner kind, so a Kiosk object on either side never reads as a wallet.
 */
describe("custody changes reach the payload", () => {
  it("reports an object that changed hands, with the owner KIND", () => {
    const moved = custodyChanges(readGrpcObjectChanges([change()]));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      kind: "transferred",
      from: { kind: "address", address: OWNER_A },
      to: { kind: "address", address: OWNER_B },
    });
  });

  /**
   * A bare address would read a kiosk id as a wallet. The kind is what
   * separates "someone received this" from "it moved between two kiosks".
   */
  it("keeps an object owner distinguishable from an address owner", () => {
    const kioskHeld = change({
      inputOwner: { kind: 2, address: OWNER_A },
      outputOwner: { kind: 2, address: OWNER_B },
    });
    const moved = custodyChanges(readGrpcObjectChanges([kioskHeld]));
    expect(moved[0]?.from?.kind).toBe("object");
    expect(moved[0]?.to?.kind).toBe("object");
  });

  /** A coin is already a balance change; reporting both double-counts it. */
  it("leaves coins out, since balance changes already cover them", () => {
    const coin = change({ objectType: "0x2::coin::Coin<0x2::sui::SUI>" });
    expect(custodyChanges(readGrpcObjectChanges([coin]))).toHaveLength(0);
  });

  /**
   * An object written to has not changed hands. This is why an empty
   * transaction yields no transfers and needs the COUNT to be legible instead.
   */
  it("leaves a mutation out, because it moved nobody", () => {
    const mutated = change({
      objectType: "0xabc::pool::Pool",
      inputOwner: { kind: 1, address: OWNER_A },
      outputOwner: { kind: 1, address: OWNER_A },
    });
    expect(custodyChanges(readGrpcObjectChanges([mutated]))).toHaveLength(0);
  });
});

/**
 * A privileged call can authorise itself by mutating a capability in place
 * (a nonce, a rate limit) without changing its owner. `custodyChanges` sees
 * nothing there, so `mutatedCapabilities` is what names the capability.
 */
describe("mutatedCapabilities — the capability a call used, not just what changed hands", () => {
  it("reports a capability mutated in place, unlike custodyChanges", () => {
    const cap = change({
      objectId: `0xca${"9".repeat(62)}`,
      objectType: "0xabc::vault::OperatorCap",
      inputOwner: { kind: 1, address: OWNER_A },
      outputOwner: { kind: 1, address: OWNER_A },
    });
    expect(custodyChanges(readGrpcObjectChanges([cap]))).toHaveLength(0);
    const mutated = mutatedCapabilities([cap]);
    expect(mutated).toHaveLength(1);
    expect(mutated[0]).toMatchObject({
      object_id: `0xca${"9".repeat(62)}`,
      kind: "mutated",
      category: "capability",
      from: { kind: "address", address: OWNER_A },
      to: { kind: "address", address: OWNER_A },
    });
  });

  it("leaves out a mutated object that is not a capability", () => {
    const pool = change({
      objectType: "0xabc::pool::Pool",
      inputOwner: { kind: 1, address: OWNER_A },
      outputOwner: { kind: 1, address: OWNER_A },
    });
    expect(mutatedCapabilities([pool])).toHaveLength(0);
  });

  it("leaves out a capability that was TRANSFERRED rather than mutated", () => {
    const transferredCap = change({
      objectType: "0xabc::vault::OperatorCap",
      inputOwner: { kind: 1, address: OWNER_A },
      outputOwner: { kind: 1, address: OWNER_B },
    });
    expect(mutatedCapabilities([transferredCap])).toHaveLength(0);
  });

  it("leaves out a mutated coin, which categorize excludes before kind is even checked", () => {
    const coin = change({
      objectType: "0x2::coin::Coin<0x2::sui::SUI>",
      inputOwner: { kind: 1, address: OWNER_A },
      outputOwner: { kind: 1, address: OWNER_A },
    });
    expect(mutatedCapabilities([coin])).toHaveLength(0);
  });

  /**
   * `categorize` sorts `0x2::kiosk::KioskOwnerCap` into `"kiosk"` before the
   * Cap-suffix test ever runs. A kiosk `take`/`list`/`withdraw` authorises
   * itself with the owner's `&KioskOwnerCap` the same way an OperatorCap
   * does (`borrow_val`/`return_val` bump its version with the owner
   * unchanged), so a mutated KioskOwnerCap is reported too.
   */
  it("includes a mutated KioskOwnerCap, which categorize sorts as kiosk, not capability", () => {
    const kioskCap = change({
      objectId: `0xcb${"7".repeat(62)}`,
      objectType: "0x2::kiosk::KioskOwnerCap",
      inputOwner: { kind: 1, address: OWNER_A },
      outputOwner: { kind: 1, address: OWNER_A },
    });
    const mutated = mutatedCapabilities([kioskCap]);
    expect(mutated).toHaveLength(1);
    expect(mutated[0]).toMatchObject({
      object_id: `0xcb${"7".repeat(62)}`,
      kind: "mutated",
      category: "kiosk",
    });
  });

  /** The Kiosk object itself is not a capability and authorises nothing. */
  it("still leaves out a mutated Kiosk object, unlike its KioskOwnerCap", () => {
    const kiosk = change({
      objectType: "0x2::kiosk::Kiosk",
      inputOwner: { kind: 1, address: OWNER_A },
      outputOwner: { kind: 1, address: OWNER_A },
    });
    expect(mutatedCapabilities([kiosk])).toHaveLength(0);
  });
});

describe("listObjectChanges: every changed object's id, grouped by what happened to it", () => {
  const INPUT_DOES_NOT_EXIST = 1;
  const OUTPUT_DOES_NOT_EXIST = 1;
  const OUTPUT_OBJECT_WRITE = 2;
  const OUTPUT_ACCUMULATOR_WRITE = 4;
  const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  const changes = [
    change({ objectId: id(1), idOperation: ID_CREATED, inputState: INPUT_DOES_NOT_EXIST, outputState: OUTPUT_OBJECT_WRITE, outputVersion: 20n }),
    change({ objectId: id(2), outputState: OUTPUT_OBJECT_WRITE, inputVersion: 10n, outputVersion: 20n }),
    change({ objectId: id(3), outputState: OUTPUT_DOES_NOT_EXIST, inputVersion: 11n, outputVersion: 20n }),
    change({ objectId: id(4), inputState: INPUT_DOES_NOT_EXIST, outputState: OUTPUT_OBJECT_WRITE, outputVersion: 20n }),
    change({ objectId: id(5), idOperation: ID_DELETED, outputState: OUTPUT_DOES_NOT_EXIST, inputVersion: 12n, outputVersion: 20n }),
    change({ objectId: id(6), outputState: OUTPUT_ACCUMULATOR_WRITE, accumulatorWrite: { address: OWNER_A } }),
  ];

  it("names created, mutated, wrapped, unwrapped and deleted objects with the version each ended or was read at", () => {
    const byKind = listObjectChanges(changes);
    const ids = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v!.map((o) => [o.object_id, o.version])]));
    expect(ids).toEqual({
      created: [[id(1), "20"]],
      mutated: [[id(2), "20"]],
      wrapped: [[id(3), "11"]],
      unwrapped: [[id(4), "20"]],
      deleted: [[id(5), "12"]],
    });
  });

  it("partitions exactly what summarizeObjectChanges counts", () => {
    const byKind = listObjectChanges(changes);
    const summary = summarizeObjectChanges(changes);
    expect(Object.values(byKind).flat()).toHaveLength(summary.changed);
    expect(byKind.created).toHaveLength(summary.created);
    expect(byKind.deleted).toHaveLength(summary.deleted);
  });
});
