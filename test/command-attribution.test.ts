import { describe, it, expect } from "vitest";
import { eventCommands, objectMatcher } from "../src/utils/command-attribution.js";

const P = `0x${"a".repeat(64)}`;
const ORIGINAL = `0x${"b".repeat(64)}`;
const call = (index: number, module: string, fn = "f", extra: Record<string, unknown> = {}) => ({ index, type: "MoveCall", target: `${P}::${module}::${fn}`, ...extra });
const split = (index: number) => ({ index, type: "SplitCoins" });
const ev = (module: string, pkg = P) => ({ package_id: pkg, module });

describe("eventCommands", () => {
  it("pins each event to the one call its package and module can have come from, in order", () => {
    const commands = [call(0, "oracle"), split(1), call(2, "pool"), call(3, "oracle")];
    expect(eventCommands([ev("oracle"), ev("pool"), ev("pool"), ev("oracle")], commands)).toEqual([[0], [2], [2], [3]]);
  });

  it("lists every command an event can belong to when consecutive calls share a module", () => {
    // Commands 1 and 2 both call `pool`: which of them emitted the middle
    // event is not in the transaction, but the first event before any
    // `oracle` call must be command 1's, and the last one command 2's.
    const commands = [call(0, "oracle"), call(1, "pool"), call(2, "pool"), call(3, "oracle")];
    expect(eventCommands([ev("oracle"), ev("pool"), ev("pool"), ev("oracle")], commands)).toEqual([[0], [1, 2], [1, 2], [3]]);
    expect(eventCommands([ev("pool"), ev("oracle"), ev("pool")], [call(0, "pool"), call(1, "oracle"), call(2, "pool")])).toEqual([[0], [1], [2]]);
  });

  it("matches on the module alone when the events name the package's original id", () => {
    const commands = [call(0, "router"), call(1, "swap")];
    expect(eventCommands([ev("swap", ORIGINAL)], commands)).toEqual([[1]]);
  });

  it("gives no attribution when no order of the commands fits the events", () => {
    expect(eventCommands([ev("pool"), ev("oracle")], [call(0, "oracle"), call(1, "pool")])).toBeNull();
    expect(eventCommands([ev("vault")], [call(0, "pool")])).toBeNull();
  });
});

describe("objectMatcher", () => {
  const OBJ = `0x${"c".repeat(64)}`;
  const OTHER = `0x${"d".repeat(64)}`;
  const chosen = [call(4, "pool", "open", { arguments: [{ type: "Input", index: 0, object_id: OBJ }], returns: ["0x9::position::Position"] })];
  const belongs = objectMatcher(chosen);

  it("keeps an object a chosen command takes and a created object of a type it returns", () => {
    expect(belongs({ object_id: OBJ, type: "0x9::pool::Pool" }, "mutated")).toBe(true);
    expect(belongs({ object_id: OTHER, type: "0x0000000000000000000000000000000000000000000000000000000000000009::position::Position" }, "created")).toBe(true);
  });

  it("leaves out an object no chosen command takes, and a mutated object of a returned type", () => {
    expect(belongs({ object_id: OTHER, type: "0x9::pool::Pool" }, "mutated")).toBe(false);
    expect(belongs({ object_id: OTHER, type: "0x9::position::Position" }, "mutated")).toBe(false);
  });
});
