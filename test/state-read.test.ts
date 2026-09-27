import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * readObjectStates chooses its candidates from the effects, reads them at
 * both versions and reads each type's coin layout. The gRPC client is a stub
 * so a failed read and a retry can be staged.
 */
const { getDatatype, batchGetObjects } = vi.hoisted(() => ({ getDatatype: vi.fn(), batchGetObjects: vi.fn() }));
vi.mock("../src/clients/grpc.js", () => ({
  sui: { movePackageService: { getDatatype }, ledgerService: { batchGetObjects } },
  archive: { movePackageService: { getDatatype }, ledgerService: { batchGetObjects } },
}));
vi.mock("../src/config.js", async (orig) => ({ ...(await orig<object>()), getNetworkConfig: () => ({ archive: null }) }));

import { coinLayout, readObjectStates } from "../src/utils/state-read.js";

const SIG_DATATYPE = 10;
const SIG_TYPE_PARAMETER = 11;
const BALANCE = "0x0000000000000000000000000000000000000000000000000000000000000002::balance::Balance";
const balanceField = (name: string) => ({ name, type: { type: SIG_DATATYPE, typeName: BALANCE, typeParameterInstantiation: [{ type: SIG_TYPE_PARAMETER, typeParameter: 0, typeParameterInstantiation: [] }] } });
const structField = (name: string, typeName: string) => ({ name, type: { type: SIG_DATATYPE, typeName, typeParameterInstantiation: [] } });
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

beforeEach(() => {
  getDatatype.mockReset();
  batchGetObjects.mockReset();
});

describe("coinLayout", () => {
  it("retries a type whose read failed instead of caching the failure", async () => {
    const type = `0x${"d1".repeat(32)}::pool::Pool<${SUI}>`;
    getDatatype.mockRejectedValueOnce(new Error("UNAVAILABLE")).mockResolvedValue({ response: { datatype: { fields: [balanceField("reserve")] } } });
    expect(await coinLayout(type)).toBeNull();
    expect(await coinLayout(type)).toEqual({ layout: { balances: { reserve: SUI }, supplies: {} }, complete: true });
  });

  it("marks a layout incomplete when a nested struct could not be read, and reads it again next time", async () => {
    const outer = `0x${"d2".repeat(32)}::vault::Vault`;
    const inner = `0x${"d2".repeat(32)}::vault::Reserve`;
    let innerFails = true;
    getDatatype.mockImplementation(async ({ name }: { name: string }) => {
      if (name === "Vault") return { response: { datatype: { fields: [structField("reserve", inner)] } } };
      if (innerFails) throw new Error("UNAVAILABLE");
      return { response: { datatype: { fields: [{ name: "coins", type: { type: SIG_DATATYPE, typeName: BALANCE, typeParameterInstantiation: [{ type: SIG_DATATYPE, typeName: "0x2::sui::SUI", typeParameterInstantiation: [] }] } }] } } };
    });
    expect((await coinLayout(outer))?.complete).toBe(false);
    innerFails = false;
    expect(await coinLayout(outer)).toEqual({ layout: { balances: { "reserve.coins": SUI }, supplies: {} }, complete: true });
  });
});

describe("readObjectStates", () => {
  it("reads a pool another object owns, and lists every candidate it does not read", async () => {
    const CHILD = `0x${"e1".repeat(32)}`;
    const FIELD = `0x${"e2".repeat(32)}`;
    const childType = `0x${"e3".repeat(32)}::lp_pool::LiquidityPool`;
    const fieldType = `0x2::dynamic_field::Field<u64, 0x${"e3".repeat(32)}::lp_pool::Unreadable>`;
    getDatatype.mockImplementation(async ({ name }: { name: string }) => {
      if (name === "LiquidityPool") return { response: { datatype: { fields: [structField("info", "0x1::string::String")] } } };
      throw new Error("UNAVAILABLE");
    });
    batchGetObjects.mockImplementation(async ({ requests }: { requests: Array<{ objectId: string; version: bigint }> }) => ({
      response: { objects: requests.map((r) => ({ result: { oneofKind: "object", object: { objectId: r.objectId, version: r.version, json: undefined } } })) },
    }));
    const snap = await readObjectStates({
      objects: [
        { objectId: CHILD, objectType: childType, shared: false, parent: `0x${"7a".repeat(32)}`, inputVersion: "1", outputVersion: "2" },
        { objectId: FIELD, objectType: fieldType, shared: false, parent: CHILD, inputVersion: "1", outputVersion: "2" },
      ],
    });
    expect(snap.objects.map((o) => [o.objectId, o.role])).toEqual([[CHILD, "child"]]);
    expect(snap.skipped).toEqual([expect.objectContaining({ object_id: FIELD, role: "holding" })]);
    expect(snap.layout_unread).toContain(fieldType);
  });
});
