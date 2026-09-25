import { describe, it, expect } from "vitest";
import { registeredTools, unknownToolsIn } from "./helpers/tool-names.js";

/**
 * A description that sends the model to a tool that does not exist costs a
 * failed call at best, and at worst the model concludes the capability is
 * missing. `simulate_transaction` told callers to build input with
 * `build_transaction`, which does not exist.
 */
const tools = registeredTools();
const names = new Set(tools.map((t) => t.name));

describe("tool descriptions name only tools that exist", () => {
  it.each(tools.map((t) => [t.name, t] as const))("%s", (_name, t) => {
    expect(t.texts.flatMap((text) => unknownToolsIn(text, names))).toEqual([]);
  });
});
