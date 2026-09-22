import { describe, it, expect } from "vitest";
import {
  custodyChanges,
  readGrpcObjectChanges,
  summarizeObjectChanges,
} from "../src/utils/object-flow.js";

/**
 * What `get_transaction` says when a transaction moved no coin.
 *
 * A real mainnet transaction, `F7xprc5y7Lmk…`, ran zero commands and emitted
 * nothing. The tool reported `actions: []`, `token_flow: []`, `protocols: []`
 * and stopped there, which reads as "nothing happened". It had in fact
 * executed, committed and written an object, and it was one of hundreds fired
 * by a market-making bot managing a pool of gas coins.
 *
 * These call `summarizeObjectChanges` and `custodyChanges` directly. A first
 * version re-implemented the counting inside this file, and every mutation of
 * the production code — swapping created for deleted, dropping the gas split,
 * hardcoding the command count — left the whole suite green.
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
   * The counts deliberately do not single out the gas object. An earlier
   * version did, on the premise that every transaction writes its own gas coin.
   * Measured on mainnet, 88% of sampled programmable transactions have no
   * `effects.gasObject` at all, because gas is paid from a balance accumulator.
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
 * `object_transfers` must not be a field that never fires. Verified against
 * mainnet on a TradePort sale: one `popkins_nft::Popkins` transferred, and both
 * parties were Kiosk objects rather than wallets.
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
   * A bare address made a kiosk id read as a wallet. The kind is what separates
   * "someone received this" from "it moved between two kiosks".
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
