import { describe, it, expect } from "vitest";
import { groupCapabilities, selectModules, summarizeModule } from "../src/utils/package-summary.js";
import { classifyCapabilityRisk, type CapabilityInfo } from "../src/utils/capabilities.js";

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
  // Each member's note is what the audit writes for it.
  const cap = (over: Partial<CapabilityInfo>): CapabilityInfo => {
    const c: CapabilityInfo = {
      kind: "admin",
      type: "0x3::validator_cap::UnverifiedValidatorOperationCap",
      object_id: "0x1",
      owner: "address",
      owner_address: "0xa",
      risk: "low",
      note: "",
      ...over,
    };
    return { ...c, note: over.note ?? classifyCapabilityRisk({ kind: c.kind, type: c.type, owner: c.owner, ownerAddress: c.owner_address }).note };
  };

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

  /**
   * Two same-type admin caps both sent to 0x0 are each risk "info" and fold
   * into one entry. The note is built from their shared real address, so it
   * agrees with the "info" risk rather than reading as a held capability to
   * review.
   */
  it("passes the real shared address instead of a placeholder when every folded member is unspendable", () => {
    const caps = [
      cap({ object_id: "0x1", type: "0x1::vault::AdminCap", owner_address: "0x0", risk: "info" }),
      cap({ object_id: "0x2", type: "0x1::vault::AdminCap", owner_address: "0x0", risk: "info" }),
    ];
    const [group] = groupCapabilities(caps);
    const note = (group as { note: string }).note;
    expect(note).not.toContain("the holder of each object in holders");
    expect(note).toMatch(/nobody holds a key/);
  });

  it("folds caps held by different objects under a note that names none of them, keeping each holder and its type", () => {
    const held = (id: string, parent: string, parentType: string) => {
      const c = cap({ object_id: id, type: "0x1::vault::AdminCap", owner: "object", owner_address: parent, owner_type: parentType, risk: "low" });
      return { ...c, note: classifyCapabilityRisk({ kind: c.kind, type: c.type, owner: c.owner, ownerAddress: parent, ownerType: parentType }).note };
    };
    const [group] = groupCapabilities([held("0x1", "0xp1", "0x1::vault::Vault"), held("0x2", "0xp2", "0x1::vault::Vault")]);
    expect(group).toMatchObject({
      owner: "object",
      count: 2,
      holders: [
        { object_id: "0x1", owner_address: "0xp1", owner_type: "0x1::vault::Vault" },
        { object_id: "0x2", owner_address: "0xp2", owner_type: "0x1::vault::Vault" },
      ],
    });
    expect(group.note).toContain("is held by another object;");
    expect(group.note).not.toContain("0xp1");
    expect(group.note).not.toContain("holder of each object");
  });
});
