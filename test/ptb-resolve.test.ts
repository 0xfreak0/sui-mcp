import { describe, it, expect, vi, beforeEach } from "vitest";
import { Transaction, Inputs } from "@mysten/sui/transactions";
import { createMockClient } from "./helpers/mock-grpc.js";

const mockSui = createMockClient();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));

const { resolvePtb, selectCommands, executedObjects } = await import("../src/utils/ptb-resolve.js");

const PKG = `0x${"ab".repeat(32)}`;
const POOL = `0x${"cd".repeat(32)}`;

type Body = Record<string, unknown>;
const sig = (reference: string | null, body: Body) => ({ reference, body });
const u = (kind: string): Body => ({ $kind: kind });
const datatype = (typeName: string, typeParameters: Body[] = []): Body => ({ $kind: "datatype", datatype: { typeName, typeParameters } });

/** getMoveFunction answering from a table of `module::function` signatures; anything else is unreadable. */
function signatures(table: Record<string, { parameters: unknown[]; returns: unknown[] }>) {
  mockSui.getMoveFunction.mockImplementation(async ({ moduleName, name }: { moduleName: string; name: string }) => {
    const f = table[`${moduleName}::${name}`];
    if (!f) throw new Error("function not found");
    return { function: { name, parameters: f.parameters, returns: f.returns } };
  });
}

describe("resolvePtb pure values", () => {
  beforeEach(() => vi.clearAllMocks());

  it("decodes each pure argument as the type the called function declares, after type-argument substitution", async () => {
    signatures({
      "m::typed": {
        parameters: [
          sig(null, { $kind: "vector", vector: { $kind: "typeParameter", index: 0 } }),
          sig(null, datatype("0x0000000000000000000000000000000000000000000000000000000000000001::option::Option", [u("u64")])),
          sig(null, datatype("0x0000000000000000000000000000000000000000000000000000000000000001::string::String")),
          sig(null, { $kind: "vector", vector: u("u8") }),
          sig(null, u("bool")),
          sig("mutable", datatype("0x0000000000000000000000000000000000000000000000000000000000000002::tx_context::TxContext")),
        ],
        returns: [],
      },
    });
    const tx = new Transaction();
    tx.moveCall({
      target: `${PKG}::m::typed`,
      typeArguments: ["u64"],
      arguments: [
        tx.pure.vector("u64", [1, 2]),
        tx.pure.option("u64", null),
        tx.pure.string("hi"),
        tx.pure.vector("u8", [1, 2, 255]),
        tx.pure.bool(true),
      ],
    });
    const { commands, inputs } = await resolvePtb(tx.getData());
    const args = commands[0].arguments as Body[];
    expect(args.map((a) => [a.value_type, a.value])).toEqual([
      ["vector<u64>", ["1", "2"]],
      ["0x0000000000000000000000000000000000000000000000000000000000000001::option::Option<u64>", null],
      ["0x0000000000000000000000000000000000000000000000000000000000000001::string::String", "hi"],
      ["vector<u8>", "0x0102ff"],
      ["bool", true],
    ]);
    expect(inputs[0]).toEqual({ type: "Pure", value_type: "vector<u64>", value: ["1", "2"] });
  });

  it("keeps bytes that are not exactly one value of the declared type", async () => {
    signatures({ "m::wide": { parameters: [sig(null, u("u128"))], returns: [] } });
    const tx = new Transaction();
    // Eight bytes: a u64, which a u128 parameter cannot read without running short.
    tx.moveCall({ target: `${PKG}::m::wide`, arguments: [tx.pure.u64(7)] });
    const { commands, inputs } = await resolvePtb(tx.getData());
    const arg = (commands[0].arguments as Body[])[0];
    expect(arg.value).toBeUndefined();
    expect(arg.bytes).toBe(Buffer.from([7, 0, 0, 0, 0, 0, 0, 0]).toString("base64"));
    expect(inputs[0].value).toBeUndefined();
  });

  it("reports an address-typed value under `address`, and a 32-byte pure of an unread signature as possible", async () => {
    signatures({ "m::pay": { parameters: [sig(null, u("address"))], returns: [] } });
    const recipient = `0x${"11".repeat(32)}`;
    const tx = new Transaction();
    tx.moveCall({ target: `${PKG}::m::pay`, arguments: [tx.pure.address(recipient)] });
    tx.moveCall({ target: `${PKG}::m::unknown`, arguments: [tx.pure.address(recipient)] });
    const { commands, inputs, signatures_unavailable } = await resolvePtb(tx.getData());
    expect((commands[0].arguments as Body[])[0]).toMatchObject({ value_type: "address", address: recipient });
    expect((commands[1].arguments as Body[])[0]).toMatchObject({ address: recipient });
    expect((commands[1].arguments as Body[])[0].value_type).toBeUndefined();
    expect(inputs[1]).toMatchObject({ type: "Pure", possible_address: recipient });
    expect(signatures_unavailable).toEqual([`${PKG}::m::unknown`]);
  });

  it("decodes SplitCoins amounts as u64 with no signature to read", async () => {
    const tx = new Transaction();
    tx.splitCoins(tx.gas, [tx.pure.u64(200_000_000)]);
    const { commands } = await resolvePtb(tx.getData());
    expect(commands[0]).toMatchObject({
      index: 0,
      type: "SplitCoins",
      coin: { type: "GasCoin" },
      amounts: [{ type: "Input", index: 0, value_type: "u64", value: "200000000" }],
    });
    expect(mockSui.getMoveFunction).not.toHaveBeenCalled();
  });

  it("gives an integer with its top bit set its two's-complement reading, and leaves others alone", async () => {
    signatures({ "m::fee": { parameters: [sig(null, u("u256")), sig(null, u("u64")), sig(null, u("u256"))], returns: [] } });
    const tx = new Transaction();
    // -100,000 at 18 decimals as a u256, as a signed fee travels.
    tx.moveCall({ target: `${PKG}::m::fee`, arguments: [tx.pure.u256(2n ** 256n - 10n ** 23n), tx.pure.u64(2n ** 64n - 1n), tx.pure.u256(5n)] });
    const { commands } = await resolvePtb(tx.getData());
    expect((commands[0].arguments as Body[]).map((a) => a.signed_value)).toEqual(["-100000000000000000000000", "-1", undefined]);
  });
});

describe("resolvePtb wiring", () => {
  beforeEach(() => vi.clearAllMocks());

  it("names the command a Result came from and lists that command's declared returns", async () => {
    const fixedPoint = `${PKG}::fixed_point64::FixedPoint64`;
    signatures({
      "fixed_point64::create_from_raw_value": { parameters: [sig(null, u("u128"))], returns: [sig(null, datatype(fixedPoint))] },
      "py::quote": { parameters: [sig(null, u("u64")), sig(null, datatype(fixedPoint))], returns: [sig(null, u("u64"))] },
    });
    const tx = new Transaction();
    const [index] = tx.moveCall({ target: `${PKG}::fixed_point64::create_from_raw_value`, arguments: [tx.pure.u128(30000n << 64n)] });
    tx.moveCall({ target: `${PKG}::py::quote`, arguments: [tx.pure.u64(1), index] });
    const { commands } = await resolvePtb(tx.getData());
    expect(commands[0]).toMatchObject({ returns: [fixedPoint] });
    expect((commands[0].arguments as Body[])[0]).toMatchObject({ value_type: "u128", value: "553402322211286548480000" });
    expect((commands[1].arguments as Body[])[1]).toEqual({
      type: "NestedResult",
      result: 0,
      subresult: 0,
      from: "fixed_point64::create_from_raw_value",
    });
  });

  it("gives an object argument the version it was read at and its type from the executed transaction", async () => {
    signatures({ "pool::touch": { parameters: [sig("mutable", datatype(`${PKG}::pool::Pool`))], returns: [] } });
    const tx = new Transaction();
    tx.moveCall({
      target: `${PKG}::pool::touch`,
      arguments: [tx.object(Inputs.SharedObjectRef({ objectId: POOL, initialSharedVersion: 5, mutable: true }))],
    });
    const executed = executedObjects({
      signatures: [],
      balanceChanges: [],
      effects: {
        dependencies: [],
        unchangedConsensusObjects: [],
        unchangedLoadedRuntimeObjects: [],
        changedObjects: [{ objectId: POOL, inputState: 2, inputVersion: 41n, outputVersion: 42n, outputState: 2, objectType: `${PKG}::pool::Pool` }],
      },
    } as never);
    const { commands, inputs } = await resolvePtb(tx.getData(), executed);
    expect((commands[0].arguments as Body[])[0]).toEqual({
      type: "Input",
      index: 0,
      object_id: POOL,
      version: "41",
      object_type: "pool::Pool",
    });
    expect(inputs[0]).toEqual({
      type: "SharedObject",
      object_id: POOL,
      initial_shared_version: "5",
      mutable: true,
      version: "41",
      object_type: `${PKG}::pool::Pool`,
    });
  });
});

describe("executedObjects", () => {
  it("takes an input's version from the effects and fills a type only the object set has at its lowest version", () => {
    const frozen = `0x${"ef".repeat(32)}`;
    const clock = `0x${"0".repeat(63)}6`;
    const objects = executedObjects({
      signatures: [],
      balanceChanges: [],
      effects: {
        dependencies: [],
        unchangedLoadedRuntimeObjects: [],
        changedObjects: [
          { objectId: POOL, inputState: 2, inputVersion: 7n, outputVersion: 9n, outputState: 2, objectType: "0x9::pool::Pool" },
          // An address-balance write is not an object.
          { objectId: `0x${"ac".repeat(32)}`, outputState: 4 },
        ],
        unchangedConsensusObjects: [{ objectId: clock, version: 3n, objectType: "0x2::clock::Clock" }],
      },
      objects: {
        objects: [
          { objectId: frozen, version: 12n, objectType: "0x9::config::Config" },
          { objectId: POOL, version: 9n, objectType: "0x9::pool::Pool" },
        ],
      },
    } as never);
    expect(objects.get(POOL)).toEqual({ version: "7", type: "0x9::pool::Pool" });
    expect(objects.get(clock)).toEqual({ version: "3", type: "0x2::clock::Clock" });
    expect(objects.get(frozen)).toEqual({ version: "12", type: "0x9::config::Config" });
    expect(objects.has(`0x${"ac".repeat(32)}`)).toBe(false);
  });
});

describe("selectCommands", () => {
  const framework = (index: number) => ({ index, type: "SplitCoins", pad: "x".repeat(100) });
  const call = (index: number, pkg = PKG) => ({ index, type: "MoveCall", target: `${pkg}::m::f`, pad: "x".repeat(100) });
  const size = JSON.stringify(call(0)).length + 1;

  it("lists every command from the offset when they fit", () => {
    const commands = Array.from({ length: 10 }, (_, i) => framework(i));
    const { page, omitted } = selectCommands(commands, { offset: 7, budget: size * 100 });
    expect(page.map((c) => c.index)).toEqual([7, 8, 9]);
    expect(omitted).toBeNull();
  });

  it("keeps non-framework Move calls ahead of plumbing and reports the exact ranges left out", () => {
    const commands = [framework(0), framework(1), call(2), framework(3), call(4, "0x2"), call(5), framework(6)];
    const { page, omitted } = selectCommands(commands, { budget: size * 3 });
    expect(page.map((c) => c.index)).toEqual([0, 2, 5]);
    expect(omitted).toEqual({ count: 4, ranges: [[1, 1], [3, 4], [6, 6]], from: 1 });
  });

  it("offsets the ranges by the page start and always lists one command", () => {
    const commands = Array.from({ length: 6 }, (_, i) => framework(i));
    const { page, omitted } = selectCommands(commands, { offset: 3, budget: 0 });
    expect(page.map((c) => c.index)).toEqual([3]);
    expect(omitted).toEqual({ count: 2, ranges: [[4, 5]], from: 4 });
  });

  it("on a first page, lists the commands an anomaly names ahead of the other calls", () => {
    const commands = Array.from({ length: 8 }, (_, i) => call(i));
    const { page, omitted } = selectCommands(commands, { budget: size * 3, first: [6, 2] });
    expect(page.map((c) => c.index)).toEqual([0, 2, 6]);
    expect(omitted?.ranges).toEqual([[1, 1], [3, 5], [7, 7]]);
  });

  it("lists exactly the requested indices, whatever their size, and names the missing ones", () => {
    const commands = Array.from({ length: 5 }, (_, i) => call(i));
    const { page, omitted, missing } = selectCommands(commands, { indices: [3, 1, 3, 9], budget: 0 });
    expect(page.map((c) => c.index)).toEqual([1, 3]);
    expect(omitted).toBeNull();
    expect(missing).toEqual([9]);
  });
});
