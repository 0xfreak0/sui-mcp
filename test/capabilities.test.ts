import { describe, it, expect, vi, beforeEach } from "vitest";
import { gqlPage } from "./helpers/service-shapes.js";

const { gqlQuery } = vi.hoisted(() => ({ gqlQuery: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));

const { auditPackageCapabilities, classifyCapType, classifyCapabilityRisk } = await import(
  "../src/utils/capabilities.js"
);

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

describe("classifyCapabilityRisk — party-held caps", () => {
  /**
   * A party object (ConsensusAddressOwner) has one owner. It was classed as
   * shared, so a party-held TreasuryCap read "Mint authority is a shared
   * object" at medium risk while one address could mint at will.
   */
  it("treats a party-held mint authority as held by its owner", () => {
    const r = classifyCapabilityRisk({
      kind: "treasury", type: `${P2}::coin::TreasuryCap<0xabc::t::T>`, owner: "consensus", ownerAddress: "0xbad",
    });
    expect(r.risk).toBe("high");
    expect(r.note).toMatch(/held by 0xbad/);
    expect(r.note).not.toMatch(/shared/);
  });
});

describe("auditPackageCapabilities — party objects", () => {
  const CAP = "0xdbf46ffe39f2525660a0235dd130961ce1250ef62252a75ca006459de167d80f";
  const OWNER = "0xea5588c8b8cd44d4a78142fb07fb89af80a64931d0e129507bc5af41f82a647d";

  beforeEach(() => {
    gqlQuery.mockReset();
    gqlQuery.mockImplementation(async (query: string) =>
      query.includes("packageAt(version: 1)")
        ? {
            package: {
              packageAt: {
                previousTransaction: {
                  effects: {
                    objectChanges: gqlPage([
                      {
                        idCreated: true,
                        outputState: {
                          address: CAP,
                          asMoveObject: { contents: { type: { repr: `${P2}::package::UpgradeCap` } } },
                        },
                      },
                    ]),
                  },
                },
              },
            },
          }
        : {
            object: {
              owner: { __typename: "ConsensusAddressOwner", address: { address: OWNER } },
              asMoveObject: { contents: { json: { policy: 0 } } },
            },
          },
    );
  });

  it("reports the owner of a party-held UpgradeCap and compares it with the publisher", async () => {
    const audit = await auditPackageCapabilities("0xpkg", OWNER);
    expect(audit.capabilities[0]).toMatchObject({
      owner: "consensus",
      owner_address: OWNER,
      holder_status: "publisher",
      risk: "high",
    });
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
