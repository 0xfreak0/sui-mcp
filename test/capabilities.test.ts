import { describe, it, expect, vi, beforeEach } from "vitest";
import { gqlPage } from "./helpers/service-shapes.js";

const { gqlQuery, withArchiveFallback } = vi.hoisted(() => ({ gqlQuery: vi.fn(), withArchiveFallback: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../src/utils/archive-fallback.js", () => ({ withArchiveFallback }));
vi.mock("../src/utils/identity.js", () => ({
  describeAddresses: async (addrs: string[]) =>
    new Map(addrs.map((a) => [a, { address: a, kind: "wallet" as const, authentication: { scheme: "ed25519" as const, verified: true } }])),
}));

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
  // package::authorize_upgrade, coin::mint and coin::deny_list_v2_add are
  // public and take the cap by &mut; any transaction can pass a shared object
  // that way.
  it("rates a shared framework cap high: anyone can use it", () => {
    const shared = (kind: "upgrade" | "treasury" | "deny", type: string) =>
      classifyCapabilityRisk({ kind, type, owner: "shared", policyLabel: "compatible (any upgrade)" }).risk;
    expect(shared("upgrade", `${P2}::package::UpgradeCap`)).toBe("high");
    expect(shared("treasury", `${P2}::coin::TreasuryCap<0xabc::t::T>`)).toBe("high");
    expect(shared("deny", `${P2}::coin::DenyCapV2<0xabc::t::T>`)).toBe("high");
  });

  // A frozen object passes only by &: the &mut functions close, the & ones
  // open to everyone.
  it("rates a frozen UpgradeCap or DenyCap as renounced, and a frozen TreasuryCap as open to metadata changes", () => {
    const frozen = (kind: "upgrade" | "treasury" | "deny", type: string) => classifyCapabilityRisk({ kind, type, owner: "immutable" }).risk;
    expect(frozen("upgrade", `${P2}::package::UpgradeCap`)).toBe("info");
    expect(frozen("deny", `${P2}::coin::DenyCapV2<0xabc::t::T>`)).toBe("info");
    expect(frozen("treasury", `${P2}::coin::TreasuryCap<0xabc::t::T>`)).toBe("medium");
  });
});

describe("classifyCapabilityRisk — a cap gone from top level with an unread end", () => {
  // A gone admin cap is either wrapped (low) or destroyed (info).
  it("rates an admin cap low and a mint authority medium", () => {
    const gone = (kind: "admin" | "treasury", type: string) => classifyCapabilityRisk({ kind, type, owner: "unknown", gone: true }).risk;
    expect(gone("admin", "0x1::vault::AdminCap")).toBe("low");
    expect(gone("treasury", `${P2}::coin::TreasuryCap<0xabc::t::T>`)).toBe("medium");
  });
});

describe("classifyCapabilityRisk — treasury cap", () => {
  it("address-owned mint authority is high risk", () => {
    const r = classifyCapabilityRisk({ kind: "treasury", type: `${P2}::coin::TreasuryCap<0xabc::t::T>`, owner: "address", ownerAddress: "0xbad" });
    expect(r.risk).toBe("high");
    expect(r.note).toMatch(/mint/i);
  });
  // Destroying a TreasuryCap leaves its Supply, which mints wherever it is
  // kept; only the registry's Fixed or BurnOnly state keeps it from minting.
  it("reads a destroyed treasury cap as fixed supply only when the coin registry records it", () => {
    const burned = (supplyState?: "fixed" | "burn_only" | "unknown") =>
      classifyCapabilityRisk({ kind: "treasury", type: `${P2}::coin::TreasuryCap<0xabc::t::T>`, owner: "burned", supplyState }).risk;
    expect(burned("fixed")).toBe("info");
    expect(burned("burn_only")).toBe("info");
    expect(burned("unknown")).toBe("medium");
    expect(burned(undefined)).toBe("medium");
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

describe("auditPackageCapabilities — destroyed UpgradeCap", () => {
  const CAP = "0x45ae77b4fc370db5992c3d7a3eacc8fd259ed0d1dcc527c6e29be7b5f849e3bb";
  const PUBLISHER = "0x70f1042521565aa5c3fb887f939ef05e8dee264cc11ee07735132691801d360d";

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
                        outputState: { address: CAP, asMoveObject: { contents: { type: { repr: `${P2}::package::UpgradeCap` } } } },
                      },
                    ]),
                  },
                },
              },
            },
          }
        // 0x2::package::make_immutable deletes the cap object outright: the
        // GraphQL object lookup returns null, exactly like a pruned or
        // nonexistent object.
        : query.includes("affectedObject")
          ? { transactions: { nodes: [{ digest: "MakeImmutable" }] } }
          : { object: null },
    );
    withArchiveFallback.mockReset();
    withArchiveFallback.mockResolvedValue({
      transaction: { effects: { changedObjects: [{ objectId: CAP, idOperation: 3 }] } },
    });
  });

  /**
   * An UpgradeCap destroyed by make_immutable reads owner "burned" and has no
   * holder address, so `assessCapHolder` must not run: its "no address owner,
   * whoever can reach it can still upgrade" note would contradict the
   * "destroyed, can never be changed" note beside it.
   */
  it("does not report a contradictory holder_status for a destroyed cap", async () => {
    const audit = await auditPackageCapabilities("0xpkg", PUBLISHER);
    const cap = audit.capabilities[0];
    expect(cap.owner).toBe("burned");
    expect(cap.holder_status).toBeUndefined();
    expect(cap.note).not.toMatch(/can still upgrade/i);
    expect(cap.note).toMatch(/destroyed/i);
  });

  // authorize_upgrade takes &mut, which a frozen cap cannot give; the holder
  // assessment's "whoever can reach it can still upgrade" would contradict it.
  it("gives a frozen UpgradeCap no holder assessment", async () => {
    const base = gqlQuery.getMockImplementation()!;
    gqlQuery.mockImplementation(async (query: string, vars?: unknown) =>
      query.includes("object(address: $id)")
        ? { object: { owner: { __typename: "Immutable" }, asMoveObject: { contents: { json: { policy: 0 } } } } }
        : base(query, vars),
    );
    const cap = (await auditPackageCapabilities("0xpkg", PUBLISHER)).capabilities[0];
    expect(cap.owner).toBe("immutable");
    expect(cap.risk).toBe("info");
    expect(cap.holder_status).toBeUndefined();
  });

  it("gives a wrapped UpgradeCap no holder assessment", async () => {
    withArchiveFallback.mockResolvedValue({
      transaction: { effects: { changedObjects: [{ objectId: CAP, idOperation: 0 }] } },
    });
    const cap = (await auditPackageCapabilities("0xpkg", PUBLISHER)).capabilities[0];
    expect(cap.owner).toBe("wrapped");
    expect(cap.holder_status).toBeUndefined();
  });
});

describe("auditPackageCapabilities — wrapped TreasuryCap", () => {
  const CAP = "0x9945b2f35c85dffbb1c6f289c7cef8f7d253771d803d79f9df680f588153590e";
  const PUBLISHER = "0xdd7126a71c9c29145dd71bd28ef0db7d986cde112641d4b659e8144d86e9c2ec";

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
                        outputState: { address: CAP, asMoveObject: { contents: { type: { repr: `${P2}::coin::TreasuryCap<0xabc::t::T>` } } } },
                      },
                    ]),
                  },
                },
              },
            },
          }
        : query.includes("affectedObject")
          ? { transactions: { nodes: [{ digest: "LaunchWrap" }] } }
          : { object: null },
    );
    // A launchpad stored the cap inside its own shared object: the object is
    // gone from top level, and the effects record no deletion.
    withArchiveFallback.mockReset();
    withArchiveFallback.mockResolvedValue({
      transaction: { effects: { changedObjects: [{ objectId: CAP, idOperation: 1 }] } },
    });
  });

  it("does not call a TreasuryCap stored inside another object renounced", async () => {
    const audit = await auditPackageCapabilities("0xpkg", PUBLISHER);
    const cap = audit.capabilities[0];
    expect(cap.owner).toBe("wrapped");
    expect(cap.wrapped_in_tx).toBe("LaunchWrap");
    expect(cap.risk).toBe("medium");
  });

  it("reports an unknown owner when the end of the object cannot be read", async () => {
    withArchiveFallback.mockRejectedValue(new Error("429"));
    const audit = await auditPackageCapabilities("0xpkg", PUBLISHER);
    expect(audit.capabilities[0].owner).toBe("unknown");
    expect(audit.capabilities[0].risk).toBe("medium");
  });

  // Effects version 1 marks a wrapped object DELETED; its output digest is
  // the wrapped marker.
  it("reads an effects-v1 wrap, reported as DELETED with the wrapped digest, as wrapped", async () => {
    withArchiveFallback.mockResolvedValue({
      transaction: {
        effects: { changedObjects: [{ objectId: CAP, idOperation: 3, outputDigest: "6ws1bVyu3F8wGy1fPHhrc2v8UyWiGbRAAuek8SwikKPD" }] },
      },
    });
    expect((await auditPackageCapabilities("0xpkg", PUBLISHER)).capabilities[0].owner).toBe("wrapped");
  });

  it("reads a transaction that does not list the cap as unknown, not wrapped", async () => {
    withArchiveFallback.mockResolvedValue({ transaction: { effects: { changedObjects: [] } } });
    expect((await auditPackageCapabilities("0xpkg", PUBLISHER)).capabilities[0].owner).toBe("unknown");
  });

  describe("when the cap was deleted", () => {
    const registry = (variant: string | null) => {
      const base = gqlQuery.getMockImplementation()!;
      gqlQuery.mockImplementation(async (query: string, vars?: { type?: string }) =>
        vars?.type?.includes("coin_registry::Currency")
          ? { objects: { nodes: variant ? [{ asMoveObject: { contents: { json: { decimals: 9, supply: { "@variant": variant } } } } }] : [] } }
          : base(query, vars),
      );
      withArchiveFallback.mockResolvedValue({
        transaction: { effects: { changedObjects: [{ objectId: CAP, idOperation: 3, outputDigest: "7gyGAp71YXQRoxmFBaHxofQXAipvgHyBKPyxmdSJxyvz" }] } },
      });
    };

    it("reads fixed supply from the coin registry's Fixed state", async () => {
      registry("Fixed");
      const cap = (await auditPackageCapabilities("0xpkg", PUBLISHER)).capabilities[0];
      expect(cap.owner).toBe("burned");
      expect(cap.risk).toBe("info");
    });

    it("does not read fixed supply when the registry records none", async () => {
      registry("Unknown");
      expect((await auditPackageCapabilities("0xpkg", PUBLISHER)).capabilities[0].risk).toBe("medium");
      registry(null);
      expect((await auditPackageCapabilities("0xpkg", PUBLISHER)).capabilities[0].risk).toBe("medium");
    });
  });
});

describe("auditPackageCapabilities — authority-struct discovery", () => {
  const PKG = "0xcd86f77503a755c48fe6c87e1b8e9a137ec0c1bf37aac8878b6083262b27fefa";
  const UPGRADE_CAP = "0x813db902d9c817b64d74a3b006cd7f6203b0f13bcf3a4b70c50003d3335bcb0a";
  const OPERATOR_CAP = "0xba079aab0c8868bc2806185ea4776ad9ac2a0f1c307db318badd10e938293474";
  const HOT_KEY = "0xe76970bbf9b038974f6086009799772db5190f249ce7d065a581b1ac0adaef75";
  const MULTISIG = "0x5da3b6fbf17b59d3c1f1c61d5e29c6b91f5b06a03f6c1c7c0f9b6b7f4a1c6cfd3";

  beforeEach(() => {
    gqlQuery.mockReset();
    gqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("packageAt(version: 1)")) {
        return {
          package: {
            packageAt: {
              previousTransaction: {
                effects: {
                  objectChanges: gqlPage([
                    {
                      idCreated: true,
                      outputState: { address: UPGRADE_CAP, asMoveObject: { contents: { type: { repr: `${P2}::package::UpgradeCap` } } } },
                    },
                  ]),
                },
              },
            },
          },
        };
      }
      // typeOrigins: the OperatorCap struct was defined at this same package id.
      if (query.includes("typeOrigins")) {
        return { package: { typeOrigins: [{ module: "vault", struct: "OperatorCap", definingId: PKG }] } };
      }
      // The authority-struct instance scan: one live OperatorCap, held by the hot key.
      if (query.includes("objects(filter")) {
        return {
          objects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ address: OPERATOR_CAP, owner: { __typename: "AddressOwner", address: { address: HOT_KEY } } }],
          },
        };
      }
      // CAP_STATE_QUERY, keyed by which object id was asked for.
      if (vars?.id === UPGRADE_CAP) {
        return { object: { owner: { __typename: "AddressOwner", address: { address: MULTISIG } }, asMoveObject: { contents: { json: { policy: 0 } } } } };
      }
      if (vars?.id === OPERATOR_CAP) {
        return { object: { owner: { __typename: "AddressOwner", address: { address: HOT_KEY } }, asMoveObject: { contents: { json: null } } } };
      }
      throw new Error(`unexpected query in test: ${query}`);
    });
  });

  /**
   * An OperatorCap minted after publish and handed to one hot key is
   * invisible to a publish-transaction scan alone. The audit finds it from
   * the package's own struct definitions and reports who holds it.
   */
  it("finds an authority cap minted after publish and reports its holder and scheme", async () => {
    const audit = await auditPackageCapabilities(PKG, MULTISIG, [
      { name: "vault", structs: [{ name: "OperatorCap", abilities: ["key", "store"] }] },
    ]);
    const opCap = audit.capabilities.find((c) => c.type.endsWith("::vault::OperatorCap"));
    expect(opCap).toBeDefined();
    expect(opCap?.kind).toBe("admin");
    expect(opCap?.owner_address).toBe(HOT_KEY);
    expect(opCap?.signing_scheme).toBe("ed25519");
  });

  it("does not scan standard framework cap names as authority structs", async () => {
    // TreasuryCap/UpgradeCap/DenyCap/CoinMetadata are excluded even though
    // TreasuryCap ends in "Cap": they are classified by classifyCapType from
    // the publish scan, not rediscovered here.
    const { findAuthorityStructs } = await import("../src/utils/capabilities.js");
    const out = findAuthorityStructs([
      { name: "coin", structs: [{ name: "TreasuryCap", abilities: ["key", "store"] }, { name: "UpgradeCap", abilities: ["key", "store"] }] },
      { name: "vault", structs: [{ name: "OperatorCap", abilities: ["key", "store"] }, { name: "Position", abilities: ["key", "store"] }] },
    ]);
    expect(out).toEqual([{ module: "vault", name: "OperatorCap" }]);
  });

  it("ignores an authority-named struct with no key ability (not a real object)", async () => {
    const { findAuthorityStructs } = await import("../src/utils/capabilities.js");
    const out = findAuthorityStructs([{ name: "vault", structs: [{ name: "VaultManager", abilities: ["copy", "drop"] }] }]);
    expect(out).toEqual([]);
  });

  /**
   * DeepBook v3's `balance_manager::TradeCap` (and 0x2's `KioskOwnerCap`,
   * Suilend's `ObligationOwnerCap`, …) are key+store structs every user of
   * the protocol holds one of. A type whose instance scan hits the cap is
   * reported as a count in `user_held_types` with no `capabilities` entries,
   * and its instances are not re-read with CAP_STATE_QUERY, since the
   * instance scan already has each owner.
   */
  it("reports a per-user-held struct type as a count, not one capabilities entry per holder", async () => {
    const PKG = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
    const holders = Array.from({ length: 50 }, (_, i) => `0x${String(i + 1).padStart(64, "0")}`);
    gqlQuery.mockReset();
    gqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("packageAt(version: 1)")) {
        return { package: { packageAt: { previousTransaction: { effects: { objectChanges: gqlPage([]) } } } } };
      }
      if (query.includes("typeOrigins")) {
        return { package: { typeOrigins: [{ module: "balance_manager", struct: "TradeCap", definingId: PKG }] } };
      }
      if (query.includes("objects(filter")) {
        return {
          objects: {
            // The scan cap is reached with another page still available.
            pageInfo: { hasNextPage: true, endCursor: "next" },
            nodes: holders.map((h, i) => ({ address: `0xcap${i}`, owner: { __typename: "AddressOwner", address: { address: h } } })),
          },
        };
      }
      throw new Error(`unexpected CAP_STATE_QUERY for a per-user object: ${query}`);
    });

    const audit = await auditPackageCapabilities(PKG, "0xpublisher", [
      { name: "balance_manager", structs: [{ name: "TradeCap", abilities: ["key", "store"] }] },
    ]);

    expect(audit.capabilities.filter((c) => c.type.endsWith("::balance_manager::TradeCap"))).toHaveLength(0);
    expect(audit.user_held_types).toEqual([
      { type: `${PKG}::balance_manager::TradeCap`, count: 50, truncated: true },
    ]);
  });

  /**
   * An operator cap held by a small team (7 instances, under the count
   * threshold and short of the scan cap) stays in `capabilities`, one entry
   * per holder: "more than a handful" cannot mean "more than one".
   */
  it("keeps a small multi-holder authority type in capabilities rather than folding it into a count", async () => {
    const PKG = "0xcd86f77503a755c48fe6c87e1b8e9a137ec0c1bf37aac8878b6083262b27fefa";
    const holders = Array.from({ length: 7 }, (_, i) => `0x${String(i + 1).padStart(64, "0")}`);
    gqlQuery.mockReset();
    gqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("packageAt(version: 1)")) {
        return { package: { packageAt: { previousTransaction: { effects: { objectChanges: gqlPage([]) } } } } };
      }
      if (query.includes("typeOrigins")) {
        return { package: { typeOrigins: [{ module: "vault", struct: "OperatorCap", definingId: PKG }] } };
      }
      if (query.includes("objects(filter")) {
        return {
          objects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: holders.map((h, i) => ({ address: `0xcap${i}`, owner: { __typename: "AddressOwner", address: { address: h } } })),
          },
        };
      }
      throw new Error(`unexpected CAP_STATE_QUERY: ${query}`);
    });

    const audit = await auditPackageCapabilities(PKG, "0xpublisher", [
      { name: "vault", structs: [{ name: "OperatorCap", abilities: ["key", "store"] }] },
    ]);

    expect(audit.user_held_types ?? []).toHaveLength(0);
    expect(audit.capabilities.filter((c) => c.type.endsWith("::vault::OperatorCap"))).toHaveLength(7);
  });


  /**
   * A small admin-cap type (well under the per-user threshold) still gets an
   * individual `capabilities` entry, and reuses the owner the instance scan
   * already read live rather than re-reading it with CAP_STATE_QUERY.
   */
  it("reuses the owner the instance scan already returned, without a redundant per-object state read", async () => {
    const PKG = "0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
    const CAP_ID = "0xcapobject";
    const HOLDER = "0xholder";
    let capStateCalls = 0;
    gqlQuery.mockReset();
    gqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("packageAt(version: 1)")) {
        return { package: { packageAt: { previousTransaction: { effects: { objectChanges: gqlPage([]) } } } } };
      }
      if (query.includes("typeOrigins")) {
        return { package: { typeOrigins: [{ module: "vault", struct: "AdminCap", definingId: PKG }] } };
      }
      if (query.includes("objects(filter")) {
        return {
          objects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ address: CAP_ID, owner: { __typename: "AddressOwner", address: { address: HOLDER } } }],
          },
        };
      }
      // A CAP_STATE_QUERY call lands here and returns a different owner, so
      // the assertions below fail if it is ever used.
      capStateCalls++;
      return { object: { owner: { __typename: "Shared" }, asMoveObject: { contents: { json: null } } } };
    });

    const audit = await auditPackageCapabilities(PKG, "0xpublisher", [
      { name: "vault", structs: [{ name: "AdminCap", abilities: ["key", "store"] }] },
    ]);

    expect(capStateCalls).toBe(0);
    const cap = audit.capabilities.find((c) => c.type.endsWith("::vault::AdminCap"));
    expect(cap?.owner).toBe("address");
    expect(cap?.owner_address).toBe(HOLDER);
  });

  /**
   * An instance scan that fails with "HTTP 429" after retries is reported in
   * `incomplete_scans` with a note, so it cannot read the same as a type
   * with no live instances.
   */
  it("reports a struct scan that failed instead of dropping it silently", async () => {
    const PKG = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
    gqlQuery.mockReset();
    gqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("packageAt(version: 1)")) {
        return { package: { packageAt: { previousTransaction: { effects: { objectChanges: gqlPage([]) } } } } };
      }
      if (query.includes("typeOrigins")) {
        return { package: { typeOrigins: [{ module: "vault", struct: "OperatorCap", definingId: PKG }] } };
      }
      if (query.includes("objects(filter")) {
        throw new Error("HTTP 429");
      }
      throw new Error(`unexpected query: ${query}`);
    });

    const audit = await auditPackageCapabilities(PKG, "0xpublisher", [
      { name: "vault", structs: [{ name: "OperatorCap", abilities: ["key", "store"] }] },
    ]);

    expect(audit.checked).toBe(true);
    expect(audit.capabilities.filter((c) => c.type.endsWith("::vault::OperatorCap"))).toHaveLength(0);
    expect(audit.incomplete_scans).toEqual([{ type: `${PKG}::vault::OperatorCap`, reason: "HTTP 429" }]);
    expect(audit.note).toMatch(/could not be scanned/);
  });

  /** The audit runs on v10 of a package whose `OperatorCap` is defined at v1. */
  describe("a struct defined at an earlier version", () => {
    const V1 = "0xcd86f77503a755c48fe6c87e1b8e9a137ec0c1bf37aac8878b6083262b27fefa";
    const V10 = "0x8d9b38f82fcfc70a869eac1f7cefa871e9f22360aab94224f6bf751c1b9d7a2b";
    const holders = Array.from({ length: 7 }, (_, i) => `0x${String(i + 1).padStart(64, "0")}`);
    const vaultModules = [
      { name: "vault", structs: [{ name: "OperatorCap", abilities: ["key", "store"] }, { name: "AdminCap", abilities: ["key", "store"] }] },
    ];

    /** `objects(filter: {type})` matches only the defining id, as the service does. */
    function mockVolo(typeOrigins: () => unknown) {
      let originReads = 0;
      gqlQuery.mockReset();
      gqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
        if (query.includes("packageAt(version: 1)")) {
          return { package: { packageAt: { previousTransaction: { effects: { objectChanges: gqlPage([]) } } } } };
        }
        if (query.includes("typeOrigins")) {
          originReads++;
          return typeOrigins();
        }
        if (query.includes("objects(filter")) {
          const type = JSON.stringify(vars);
          const nodes = type.includes(`${V1}::vault::OperatorCap`)
            ? holders.map((h, i) => ({ address: `0xcap${i}`, owner: { __typename: "AddressOwner", address: { address: h } } }))
            : [];
          return { objects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
        }
        throw new Error(`unexpected query: ${query}`);
      });
      return () => originReads;
    }

    /**
     * A failed typeOrigins read leaves the defining id unknown, so no
     * candidate is scanned under the requested id; each is reported in
     * `incomplete_scans` instead.
     */
    it("reports every candidate unscanned when the type origins cannot be read", async () => {
      const reads = mockVolo(() => {
        throw new Error("HTTP 429");
      });
      const audit = await auditPackageCapabilities(V10, "0xpublisher", vaultModules);

      expect(audit.capabilities).toEqual([]);
      expect(audit.incomplete_scans?.map((s) => s.type).sort()).toEqual([`${V10}::vault::AdminCap`, `${V10}::vault::OperatorCap`]);
      expect(audit.incomplete_scans?.[0].reason).toMatch(/type origins unreadable \(HTTP 429\)/);
      expect(audit.note).toMatch(/could not be scanned/);
      expect(reads()).toBe(1);
    });

    it("scans the defining id when the type origins read succeeds, reading them once", async () => {
      const reads = mockVolo(() => ({
        package: {
          typeOrigins: [
            { module: "vault", struct: "OperatorCap", definingId: V1 },
            { module: "vault", struct: "AdminCap", definingId: V1 },
          ],
        },
      }));
      const audit = await auditPackageCapabilities(V10, "0xpublisher", vaultModules);

      expect(audit.incomplete_scans).toBeUndefined();
      expect(audit.capabilities.filter((c) => c.type === `${V1}::vault::OperatorCap`)).toHaveLength(7);
      expect(reads()).toBe(1);
    });
  });

  /**
   * A package with more than `MAX_AUTHORITY_STRUCTS` candidate types scans
   * Admin/Operator/Authority names first, so one declared after a dozen
   * generic per-user `*Cap` types still fits the budget.
   */
  it("ranks Admin/Operator/Authority names ahead of generic Cap/Owner/Manager names when applying the struct cap", async () => {
    const { findAuthorityStructs } = await import("../src/utils/capabilities.js");
    const generic = Array.from({ length: 12 }, (_, i) => ({
      name: `m${i}`,
      structs: [{ name: `Widget${i}Cap`, abilities: ["key"] }],
    }));
    const strong = { name: "vault", structs: [{ name: "OperatorCap", abilities: ["key"] }] };
    const out = findAuthorityStructs([...generic, strong]).slice(0, 12);
    expect(out).toContainEqual({ module: "vault", name: "OperatorCap" });
  });
});

describe("classifyCapabilityRisk — deny / admin", () => {
  it("address-owned deny cap is medium", () => {
    const r = classifyCapabilityRisk({ kind: "deny", type: `${P2}::coin::DenyCapV2<0xabc::t::T>`, owner: "address", ownerAddress: "0xdead" });
    expect(r.risk).toBe("medium");
    expect(r.note).toMatch(/freeze|denylist/i);
  });
  it("address-owned admin cap is low (surfaced for review)", () => {
    const r = classifyCapabilityRisk({ kind: "admin", type: "0xabc::vault::AdminCap", owner: "address", ownerAddress: "0xdead" });
    expect(r.risk).toBe("low");
  });
});

describe("classifyCapabilityRisk — sent to an unspendable address", () => {
  /**
   * A TreasuryCap owned by 0x0 cannot mint, since no key can sign for 0x0,
   * so it is a renounced mint rather than a live mint risk.
   */
  it("a TreasuryCap owned by 0x0 is a renounced mint, not a live risk", () => {
    const zero = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const r = classifyCapabilityRisk({ kind: "treasury", type: `${P2}::coin::TreasuryCap<0xabc::t::T>`, owner: "address", ownerAddress: zero });
    expect(r.risk).toBe("info");
    expect(r.note).toMatch(/renounced|fixed|effectively/i);
    expect(r.risk).not.toBe("high");
  });
  it("an UpgradeCap owned by the framework address is renounced, not upgradeable", () => {
    const r = classifyCapabilityRisk({ kind: "upgrade", type: `${P2}::package::UpgradeCap`, owner: "address", ownerAddress: "0x2", policyLabel: "compatible (any upgrade)" });
    expect(r.risk).toBe("info");
    expect(r.note).toMatch(/renounced/i);
  });
  it("a DenyCap sent to an unspendable address is renounced freeze authority", () => {
    const r = classifyCapabilityRisk({ kind: "deny", type: `${P2}::coin::DenyCapV2<0xabc::t::T>`, owner: "address", ownerAddress: "0x0" });
    expect(r.risk).toBe("info");
    expect(r.note).toMatch(/renounced/i);
  });
  it("an admin cap sent to an unspendable address is effectively destroyed", () => {
    const r = classifyCapabilityRisk({ kind: "admin", type: "0xabc::vault::AdminCap", owner: "address", ownerAddress: "0x0" });
    expect(r.risk).toBe("info");
  });
});
