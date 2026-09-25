import { describe, it, expect } from "vitest";
import { registerWatchTools } from "../../src/tools/watch.js";

const tools = new Map<string, Function>();
registerWatchTools({
  tool: (name: string, _desc: string, _schema: unknown, handler: Function) => tools.set(name, handler),
} as never);

describe("watch tools without a store", () => {
  // A reply with an `error` field but no isError flag reads as a successful
  // call to a client that only checks the flag.
  it.each(["watch_addresses", "poll_watch"])("%s reports the missing store as an error", async (name) => {
    delete process.env.SUI_STORE_PATH;
    const res = await tools.get(name)!({ action: "list" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toMatch(/SUI_STORE_PATH/);
  });
});
