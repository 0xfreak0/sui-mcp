import { describe, it, expect } from "vitest";
import { groupCapabilities, selectModules, summarizeModule } from "../src/utils/package-summary.js";
import type { CapabilityInfo } from "../src/utils/capabilities.js";

const fn = (name: string, visibility: string, isEntry = false) => ({ name, visibility, isEntry });

describe("summarizeModule", () => {
  it("files an entry function as entry whatever its visibility, and counts the rest", () => {
    const s = summarizeModule({
      name: "pool",
      functions: [
        fn("swap", "public", true),
        fn("claim", "private", true),
        fn("price", "public"),
        fn("settle", "public(friend)"),
        fn("check", "private"),
        fn("math", "private"),
      ],
      structs: [{ name: "Pool" }, { name: "AdminCap" }],
    });
    expect(s).toEqual({
      name: "pool",
      function_count: 6,
      struct_count: 2,
      entry_functions: ["swap", "claim"],
      public_functions: ["price"],
      friend_function_count: 1,
      private_function_count: 2,
    });
  });
});

describe("selectModules", () => {
  const modules = [{ name: "a" }, { name: "b" }, { name: "c" }];

  it("keeps package order and reports names that match nothing", () => {
    expect(selectModules(modules, ["c", "a", "zz"])).toEqual({
      selected: [{ name: "a" }, { name: "c" }],
      missing: ["zz"],
    });
  });

  it("selects nothing for an absent or empty list", () => {
    expect(selectModules(modules, undefined)).toEqual({ selected: [], missing: [] });
    expect(selectModules(modules, [])).toEqual({ selected: [], missing: [] });
  });
});

describe("groupCapabilities", () => {
  const cap = (over: Partial<CapabilityInfo>): CapabilityInfo => ({
    kind: "admin",
    type: "0x3::validator_cap::UnverifiedValidatorOperationCap",
    object_id: "0x1",
    owner: "address",
    owner_address: "0xa",
    risk: "low",
    note: "n",
    ...over,
  });

  it("folds same-type caps into one entry that keeps every object and holder", () => {
    const caps = [
      cap({ object_id: "0x1", owner_address: "0xa" }),
      cap({ object_id: "0x2", owner_address: "0xb" }),
      cap({ object_id: "0x3", owner_address: "0xc" }),
    ];
    const [group] = groupCapabilities(caps);
    expect(group).toMatchObject({
      kind: "admin",
      owner: "address",
      risk: "low",
      count: 3,
      holders: [
        { object_id: "0x1", owner_address: "0xa" },
        { object_id: "0x2", owner_address: "0xb" },
        { object_id: "0x3", owner_address: "0xc" },
      ],
    });
    // The note speaks for every holder rather than naming one of them.
    expect((group as { note: string }).note).not.toContain("0xa");
  });

  it("keeps caps apart when ownership or risk differs, and never folds an UpgradeCap", () => {
    const upgrade = cap({ kind: "upgrade", type: "0x2::package::UpgradeCap", risk: "high" });
    const out = groupCapabilities([
      upgrade,
      cap({ object_id: "0x1", owner: "address" }),
      cap({ object_id: "0x2", owner: "shared", owner_address: undefined, risk: "medium" }),
      { ...upgrade, object_id: "0x9" },
    ]);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(upgrade);
  });
});
