import { describe, it, expect, vi } from "vitest";

const getMoveFunction = vi.fn();
vi.mock("../src/clients/grpc.js", () => ({ sui: { getMoveFunction } }));

const { registerPackageTools } = await import("../src/tools/packages.js");

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, Handler> = {};
registerPackageTools({
  tool: (name: string, _d: string, _s: unknown, h: Handler) => {
    handlers[name] = h;
  },
} as never);

const NEMO = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const datatype = (typeName: string, typeParameters: unknown[] = []) => ({
  $kind: "datatype",
  datatype: { typeName, typeParameters },
});
const tp = (index: number) => ({ $kind: "typeParameter", index });

describe("get_move_function", () => {
  it("names each type parameter by its index", async () => {
    // Nemo v5 py::redeem_pt<T0: drop, T1: drop>, as the SDK's getMoveFunction
    // returns it: it takes &mut PyState<T0> and returns Coin<T1>. Which of the
    // two coins comes back is the point of the signature.
    getMoveFunction.mockResolvedValue({
      function: {
        packageId: NEMO,
        moduleName: "py",
        name: "redeem_pt",
        visibility: "public",
        isEntry: false,
        typeParameters: [
          { constraints: ["drop"], isPhantom: false },
          { constraints: ["drop"], isPhantom: false },
        ],
        parameters: [
          { reference: "mutable", body: datatype(`${NEMO}::py::PyState`, [tp(0)]) },
          { reference: null, body: { $kind: "u64" } },
        ],
        returns: [{ reference: null, body: datatype("0x2::coin::Coin", [tp(1)]) }],
      },
    });

    const out = JSON.parse((await handlers.get_move_function({ package_id: NEMO, module_name: "py", function_name: "redeem_pt" })).content[0].text);

    expect(out.parameters).toEqual([`&mut ${NEMO}::py::PyState<T0>`, "u64"]);
    expect(out.returns).toEqual(["0x2::coin::Coin<T1>"]);
  });
});
