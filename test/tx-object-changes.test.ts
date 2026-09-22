import { describe, it, expect } from "vitest";
import { custodyChanges, readGrpcObjectChanges } from "../src/utils/object-flow.js";

/**
 * What `get_transaction` says when a transaction moved no coin.
 *
 * A real mainnet transaction, `F7xprc5y7Lmk…`, ran zero commands and emitted
 * nothing. The tool reported `actions: []`, `token_flow: []`, `protocols: []`
 * and stopped there, which reads as "nothing happened". It had in fact
 * executed, committed, and written an object — and it was one of hundreds fired
 * by a market-making bot managing a pool of gas coins.
 *
 * Two readings had to be separated, and these pin both:
 *
 * - An empty `actions` covered three causes: no commands, commands that would
 *   not decode, and a transaction kind that could not be read at all. The last
 *   is "could not look" and must never render as the first.
 * - The gas object is counted apart from the rest. Every transaction writes its
 *   own gas coin, so `changed: 1` means nothing until you know whether that one
 *   object WAS the gas coin.
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

/**
 * The summary the tool builds. Kept in step with `transactions.ts` deliberately
 * — the point under test is the gas/non-gas split, and a test that recomputed
 * the split from its own copy would pass against a tool that dropped it.
 */
function summarize(changes: Array<Record<string, unknown>>, gasObjectId: string | null) {
  return {
    changed: changes.length,
    non_gas_changed: changes.filter((c) => c.objectId !== gasObjectId).length,
    created: changes.filter((c) => c.idOperation === ID_CREATED).length,
    deleted: changes.filter((c) => c.idOperation === ID_DELETED).length,
  };
}

describe("separating the gas object from everything else", () => {
  const GAS = `0xdd${"4".repeat(62)}`;

  /**
   * The real case. One changed object, and it is the coin that paid — so the
   * transaction's only effect is that it happened.
   */
  it("reports a gas-only transaction as touching nothing else", () => {
    const s = summarize([{ objectId: GAS, idOperation: ID_UNCHANGED }], GAS);
    expect(s).toEqual({ changed: 1, non_gas_changed: 0, created: 0, deleted: 0 });
  });

  it("counts a real object apart from the gas coin", () => {
    const s = summarize(
      [
        { objectId: GAS, idOperation: ID_UNCHANGED },
        { objectId: "0xnft", idOperation: ID_CREATED },
      ],
      GAS,
    );
    expect(s).toEqual({ changed: 2, non_gas_changed: 1, created: 1, deleted: 0 });
  });

  /**
   * With no gas object id, nothing may be silently attributed to it — better to
   * over-report the non-gas count than to claim an object was "just gas".
   */
  it("treats every object as non-gas when the gas object is unknown", () => {
    const s = summarize([{ objectId: GAS, idOperation: ID_UNCHANGED }], null);
    expect(s.non_gas_changed).toBe(1);
  });

  it("counts creations and deletions", () => {
    const s = summarize(
      [
        { objectId: "0x1", idOperation: ID_CREATED },
        { objectId: "0x2", idOperation: ID_DELETED },
        { objectId: "0x3", idOperation: ID_UNCHANGED },
      ],
      GAS,
    );
    expect(s).toMatchObject({ changed: 3, created: 1, deleted: 1 });
  });
});

/**
 * `object_transfers` must not be a field that never fires. Verified against
 * mainnet on a TradePort sale: one `popkins_nft::Popkins` transferred, named
 * with both parties.
 */
describe("custody changes reach the payload", () => {
  it("reports an object that changed hands", () => {
    const moved = custodyChanges(readGrpcObjectChanges([change()]));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      kind: "transferred",
      from: { address: OWNER_A },
      to: { address: OWNER_B },
    });
  });

  /** A coin is already a balance change; reporting both double-counts it. */
  it("leaves coins out, since balance changes already cover them", () => {
    const coin = change({ objectType: "0x2::coin::Coin<0x2::sui::SUI>" });
    expect(custodyChanges(readGrpcObjectChanges([coin]))).toHaveLength(0);
  });

  /**
   * An object written to has not changed hands. This is why a gas-only
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
