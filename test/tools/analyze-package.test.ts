import { describe, it, expect } from "vitest";
import {
  analyzePackageModules,
  type AnalyzedModule,
} from "../../src/tools/analyze-package.js";

function mod(partial: Partial<AnalyzedModule> & { name: string }): AnalyzedModule {
  return { functions: [], structs: [], ...partial };
}

const codes = (m: AnalyzedModule[]) => analyzePackageModules(m).map((f) => f.code).sort();

describe("analyzePackageModules", () => {
  it("returns no findings for a plain library module with only private fns", () => {
    const findings = analyzePackageModules([
      mod({
        name: "math",
        functions: [
          { name: "add", visibility: "private", isEntry: false, params: ["u64", "u64"], returns: ["u64"] },
        ],
        structs: [],
      }),
    ]);
    expect(findings.map((f) => f.code)).toEqual(["no-public-api"]);
  });

  it("does not read an init-only struct merely named like its module as a one-time witness", () => {
    // `struct Registry has key` in module `registry`: same name case-
    // insensitively, but not a one-time witness (wrong ability, not upper-cased).
    const findings = analyzePackageModules([
      mod({
        name: "registry",
        functions: [{ name: "init", visibility: "private", isEntry: false, params: [], returns: [] }],
        structs: [{ name: "Registry", abilities: ["key"], fields: [] }],
      }),
    ]);
    const finding = findings.find((f) => f.code === "no-public-api");
    expect(finding?.title).toBe("No public entry points");
    expect(finding?.evidence).toEqual([]);
  });

  it("reads the exact one-time-witness shape (upper-cased module name, drop only) as a coin template", () => {
    const findings = analyzePackageModules([
      mod({
        name: "kong",
        functions: [{ name: "init", visibility: "private", isEntry: false, params: [], returns: [] }],
        structs: [{ name: "KONG", abilities: ["drop"], fields: [] }],
      }),
    ]);
    const finding = findings.find((f) => f.code === "no-public-api");
    expect(finding?.title).toBe("No public entry points (bare coin-currency template)");
    expect(finding?.evidence).toEqual(["struct kong::KONG"]);
  });

  it("flags freeze authority from a DenyCap struct (high severity)", () => {
    const findings = analyzePackageModules([
      mod({
        name: "regcoin",
        structs: [{ name: "DenyCap", abilities: ["key", "store"], fields: [] }],
      }),
    ]);
    const freeze = findings.find((f) => f.code === "freeze-authority");
    expect(freeze?.severity).toBe("high");
    expect(freeze?.evidence).toContain("struct regcoin::DenyCap");
  });

  it("flags freeze authority from a deny_list function param", () => {
    expect(
      codes([
        mod({
          name: "regcoin",
          functions: [
            {
              name: "block",
              visibility: "public",
              isEntry: true,
              params: ["0x2::deny_list::DenyList", "address"],
              returns: [],
            },
          ],
        }),
      ]),
    ).toContain("freeze-authority");
  });

  it("flags mint authority from a public mint fn and from a TreasuryCap param", () => {
    expect(
      codes([
        mod({
          name: "coin",
          functions: [
            { name: "mint", visibility: "public", isEntry: true, params: ["u64"], returns: [] },
          ],
        }),
      ]),
    ).toContain("mint-authority");

    expect(
      codes([
        mod({
          name: "coin",
          functions: [
            {
              name: "issue",
              visibility: "public",
              isEntry: false,
              params: ["0x2::coin::TreasuryCap<0x1::x::X>", "u64"],
              returns: ["0x2::coin::Coin<0x1::x::X>"],
            },
          ],
        }),
      ]),
    ).toContain("mint-authority");
  });

  it("does not treat a private function named mint as mint authority (needs public reach)", () => {
    expect(
      codes([
        mod({
          name: "coin",
          functions: [
            { name: "mint", visibility: "private", isEntry: false, params: ["u64"], returns: [] },
          ],
        }),
      ]),
    ).not.toContain("mint-authority");
  });

  it("flags admin/owner capability structs but ignores std caps", () => {
    const findings = analyzePackageModules([
      mod({
        name: "game",
        structs: [
          { name: "AdminCap", abilities: ["key", "store"], fields: [] },
          { name: "GameOwnerCap", abilities: ["key"], fields: [] },
          { name: "UpgradeCap", abilities: ["key", "store"], fields: [] }, // std — ignored
        ],
      }),
    ]);
    const priv = findings.find((f) => f.code === "privileged-capability");
    expect(priv?.evidence).toEqual(["struct game::AdminCap", "struct game::GameOwnerCap"]);
  });

  it("flags fund handling in the public API only", () => {
    expect(
      codes([
        mod({
          name: "market",
          functions: [
            {
              name: "buy",
              visibility: "public",
              isEntry: true,
              params: ["0x2::coin::Coin<0x2::sui::SUI>"],
              returns: [],
            },
          ],
        }),
      ]),
    ).toContain("handles-funds");

    // private coin-taking fn should NOT trigger it
    expect(
      codes([
        mod({
          name: "market",
          functions: [
            {
              name: "settle",
              visibility: "private",
              isEntry: false,
              params: ["0x2::balance::Balance<0x2::sui::SUI>"],
              returns: [],
            },
          ],
        }),
      ]),
    ).not.toContain("handles-funds");
  });

  it("flags randomness and hot-potato types", () => {
    const found = codes([
      mod({
        name: "lottery",
        functions: [
          {
            name: "draw",
            visibility: "public",
            isEntry: true,
            params: ["0x2::random::Random"],
            returns: [],
          },
        ],
        structs: [{ name: "Receipt", abilities: [], fields: [] }],
      }),
    ]);
    expect(found).toContain("uses-randomness");
    expect(found).toContain("hot-potato");
  });
});
