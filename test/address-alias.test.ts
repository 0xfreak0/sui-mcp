import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `0x2::address_alias` lets an address authorize up to eight others to act for
 * it. That does not change any derivation — the address is still the hash of
 * its authenticator, and a multisig committee still cannot be edited — but it
 * makes "only this committee can spend this wallet" false in general.
 *
 * These pin the reading, because getting it wrong produces a confident wrong
 * answer rather than a missing one.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));

const { describeAddresses } = await import("../src/utils/identity.js");

const OWNER = `0x43${"1".repeat(62)}`;
const ALIAS_A = `0x66${"2".repeat(62)}`;
const ALIAS_B = `0x33${"3".repeat(62)}`;

/** The alias query is the only one whose response carries `aliases.contents`. */
function respondWith(aliasContents: unknown) {
  mockGqlQuery.mockImplementation(async (q?: string) => {
    if (String(q ?? "").includes("address_alias")) {
      return { a0: { nodes: [{ asMoveObject: { contents: { json: { aliases: { contents: aliasContents } } } } }] } };
    }
    // Every other batched lookup in describeAddresses.
    return { nodes: [], objects: { nodes: [] }, address: null };
  });
}

beforeEach(() => mockGqlQuery.mockReset());

describe("reading an address's alias set", () => {
  it("reports the addresses authorized to act for the wallet", async () => {
    respondWith([ALIAS_A, ALIAS_B]);
    const m = await describeAddresses([OWNER], { aliases: true });
    expect(m.get(OWNER)?.aliases).toEqual([ALIAS_A, ALIAS_B]);
  });

  /**
   * A set begins holding only the owner, so reporting that would turn "has
   * enabled the feature" into "has given someone else authority".
   */
  it("drops the owner's own address, and reports nothing when it is alone", async () => {
    respondWith([OWNER]);
    const m = await describeAddresses([OWNER], { aliases: true });
    expect(m.get(OWNER)?.aliases).toBeUndefined();
  });

  it("keeps the others when the owner is in the set alongside them", async () => {
    respondWith([OWNER, ALIAS_A]);
    const m = await describeAddresses([OWNER], { aliases: true });
    expect(m.get(OWNER)?.aliases).toEqual([ALIAS_A]);
  });

  /** A short form from the chain must compare equal to the padded owner. */
  it("normalizes before comparing, so a short self-entry is still dropped", async () => {
    const shortOwner = "0x5";
    mockGqlQuery.mockImplementation(async (q?: string) => {
      if (String(q ?? "").includes("address_alias")) {
        return { a0: { nodes: [{ asMoveObject: { contents: { json: { aliases: { contents: ["0x5", ALIAS_A] } } } } }] } };
      }
      return { nodes: [], objects: { nodes: [] }, address: null };
    });
    const m = await describeAddresses([shortOwner], { aliases: true });
    expect(m.get(shortOwner)?.aliases).toEqual([ALIAS_A]);
  });

  /** No AddressAliases object is the common case, and it is not a denial. */
  it("reports nothing when the wallet has never enabled aliases", async () => {
    mockGqlQuery.mockImplementation(async (q?: string) => {
      if (String(q ?? "").includes("address_alias")) return { a0: { nodes: [] } };
      return { nodes: [], objects: { nodes: [] }, address: null };
    });
    const m = await describeAddresses([OWNER], { aliases: true });
    expect(m.get(OWNER)?.aliases).toBeUndefined();
  });

  it("ignores a non-string entry rather than carrying it into the set", async () => {
    respondWith([{ nested: true }, ALIAS_A]);
    const m = await describeAddresses([OWNER], { aliases: true });
    expect(m.get(OWNER)?.aliases).toEqual([ALIAS_A]);
  });

  it("survives a malformed response without failing the whole description", async () => {
    respondWith("not-an-array");
    const m = await describeAddresses([OWNER], { aliases: true });
    expect(m.get(OWNER)).toBeDefined();
    expect(m.get(OWNER)?.aliases).toBeUndefined();
  });

  /** Costs a request, so a caller that did not ask must not pay for it. */
  it("makes no alias request unless asked", async () => {
    mockGqlQuery.mockResolvedValue({ nodes: [], objects: { nodes: [] }, address: null });
    await describeAddresses([OWNER], {});
    const asked = mockGqlQuery.mock.calls.some((c) => String(c[0]).includes("address_alias"));
    expect(asked).toBe(false);
  });
});
