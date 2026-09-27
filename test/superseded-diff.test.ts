import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchModuleDisassembly } = vi.hoisted(() => ({ fetchModuleDisassembly: vi.fn() }));
vi.mock("../src/utils/move-package.js", () => ({ fetchModuleDisassembly }));

const { readSupersededChanges, MAX_SUPERSEDED_MODULES } = await import("../src/utils/superseded-diff.js");

const OLD = `0x${"01".repeat(32)}`;
const NEW = `0x${"04".repeat(32)}`;

const fn = (name: string, body: string[]) => [`public ${name}(Arg0: &mut Pool) {`, "B0:", ...body.map((l, i) => `\t${i}: ${l}`), "}"].join("\n");
const module = (...fns: string[]) => ["module 1.user {", ...fns, "}"].join("\n");

beforeEach(() => fetchModuleDisassembly.mockReset());

describe("readSupersededChanges", () => {
  it("tells a function the newest version changed from one it kept and one it removed", async () => {
    fetchModuleDisassembly.mockImplementation(async (pkg: string) =>
      pkg === OLD
        ? module(fn("update_points", ["MoveLoc[0](Arg0: &mut Pool)", "Ret"]), fn("stake", ["Ret"]), fn("legacy", ["Ret"]))
        : module(fn("update_points", ["MoveLoc[0](Arg0: &mut Pool)", "Call assert_pool_id()", "Ret"]), fn("stake", ["Ret"])),
    );
    const out = await readSupersededChanges(
      ["update_points", "stake", "legacy"].map((f) => ({ target: `${OLD}::user::${f}`, newest: NEW })),
    );
    expect(out.get(`${OLD}::user::update_points`)).toBe("changed");
    expect(out.get(`${OLD}::user::stake`)).toBe("same");
    expect(out.get(`${OLD}::user::legacy`)).toBe("removed");
    // One module pair, two reads, however many functions.
    expect(fetchModuleDisassembly).toHaveBeenCalledTimes(2);
  });

  it("reports a failed read and module pairs past the bound as not compared", async () => {
    fetchModuleDisassembly.mockRejectedValueOnce(new Error("503")).mockResolvedValue(module(fn("go", ["Ret"])));
    const writes = Array.from({ length: MAX_SUPERSEDED_MODULES + 1 }, (_, i) => ({ target: `${OLD}::m${i}::go`, newest: NEW }));
    const out = await readSupersededChanges(writes);
    expect(out.get(`${OLD}::m0::go`)).toBe("unread");
    expect(out.get(`${OLD}::m1::go`)).toBe("same");
    expect(out.get(`${OLD}::m${MAX_SUPERSEDED_MODULES}::go`)).toBe("unread");
  });
});
