import { describe, it, expect } from "vitest";
import { classifyCapType, classifyCapabilityRisk } from "../src/utils/capabilities.js";

const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";

describe("classifyCapType", () => {
  it("identifies framework caps", () => {
    expect(classifyCapType(`${P2}::package::UpgradeCap`)).toBe("upgrade");
    expect(classifyCapType(`${P2}::coin::TreasuryCap<0xabc::t::T>`)).toBe("treasury");
    expect(classifyCapType(`${P2}::coin::DenyCapV2<0xabc::t::T>`)).toBe("deny");
  });
  it("treats other *Cap types as admin caps", () => {
    expect(classifyCapType("0xabc::vault::AdminCap")).toBe("admin");
    expect(classifyCapType("0xabc::game::OwnerCap")).toBe("admin");
  });
  it("returns null for non-caps", () => {
    expect(classifyCapType(`${P2}::coin::Coin<0xabc::t::T>`)).toBeNull();
    expect(classifyCapType("0xabc::pool::Pool")).toBeNull();
  });
});

describe("classifyCapabilityRisk — upgrade cap", () => {
  it("address-owned upgrade cap is high risk", () => {
    const r = classifyCapabilityRisk({
      kind: "upgrade",
      type: `${P2}::package::UpgradeCap`,
      owner: "address",
      ownerAddress: "0xdead",
      policyLabel: "compatible (any upgrade)",
    });
    expect(r.risk).toBe("high");
    expect(r.note).toMatch(/upgradeable by 0xdead/i);
  });
  it("burned upgrade cap means immutable package (info)", () => {
    const r = classifyCapabilityRisk({ kind: "upgrade", type: `${P2}::package::UpgradeCap`, owner: "burned" });
    expect(r.risk).toBe("info");
    expect(r.note).toMatch(/immutable/i);
  });
  it("immutable policy is low risk even if still owned", () => {
    const r = classifyCapabilityRisk({
      kind: "upgrade", type: `${P2}::package::UpgradeCap`, owner: "address", policyLabel: "immutable",
    });
    expect(r.risk).toBe("low");
  });
  it("shared upgrade cap is medium (governance)", () => {
    const r = classifyCapabilityRisk({ kind: "upgrade", type: `${P2}::package::UpgradeCap`, owner: "shared", policyLabel: "compatible (any upgrade)" });
    expect(r.risk).toBe("medium");
  });
});

describe("classifyCapabilityRisk — treasury cap", () => {
  it("address-owned mint authority is high risk", () => {
    const r = classifyCapabilityRisk({ kind: "treasury", type: `${P2}::coin::TreasuryCap<0xabc::t::T>`, owner: "address", ownerAddress: "0xbad" });
    expect(r.risk).toBe("high");
    expect(r.note).toMatch(/mint/i);
  });
  it("burned treasury cap = renounced mint (info)", () => {
    const r = classifyCapabilityRisk({ kind: "treasury", type: `${P2}::coin::TreasuryCap<0xabc::t::T>`, owner: "burned" });
    expect(r.risk).toBe("info");
    expect(r.note).toMatch(/renounced|fixed/i);
  });
});

describe("classifyCapabilityRisk — deny / admin", () => {
  it("address-owned deny cap is medium", () => {
    const r = classifyCapabilityRisk({ kind: "deny", type: `${P2}::coin::DenyCapV2<0xabc::t::T>`, owner: "address", ownerAddress: "0x1" });
    expect(r.risk).toBe("medium");
    expect(r.note).toMatch(/freeze|denylist/i);
  });
  it("address-owned admin cap is low (surfaced for review)", () => {
    const r = classifyCapabilityRisk({ kind: "admin", type: "0xabc::vault::AdminCap", owner: "address", ownerAddress: "0x1" });
    expect(r.risk).toBe("low");
  });
});
