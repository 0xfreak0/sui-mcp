import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `0x2::address_alias` lets an address name up to eight others that may
 * authorize for it.
 *
 * The set **replaces** the signer rather than extending it: the verifier
 * accepts a signature from any member in place of the address itself. So an
 * owner absent from its own set can no longer authorize for itself, and whether
 * it is present is the finding. Measured across all 63 mainnet sets, 50 owners
 * are absent from their own, and only 2 hold the owner alone.
 *
 * These pin the reading, because getting it wrong produces a confident wrong
 * answer about who controls a wallet rather than a missing one.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));

const { describeAddresses } = await import("../src/utils/identity.js");

const OWNER = `0x43${"1".repeat(62)}`;
const ALIAS_A = `0x66${"2".repeat(62)}`;
const ALIAS_B = `0x33${"3".repeat(62)}`;

const isAliasQuery = (q: unknown) => String(q ?? "").includes("address_alias");
const aliasObject = (contents: unknown) => ({
  nodes: [{ asMoveObject: { contents: { json: { aliases: { contents } } } } }],
});

/** Answer the alias query with one set, and every other lookup emptily. */
function respondWith(contents: unknown) {
  mockGqlQuery.mockImplementation(async (q?: string) =>
    isAliasQuery(q) ? { a0: aliasObject(contents) } : { nodes: [], objects: { nodes: [] } },
  );
}

beforeEach(() => mockGqlQuery.mockReset());

describe("who may authorize for a wallet", () => {
  it("reports the authorized set as the chain states it", async () => {
    respondWith([OWNER, ALIAS_A, ALIAS_B]);
    const m = await describeAddresses([OWNER], { aliases: true });
    expect(m.get(OWNER)?.aliases?.authorized).toEqual([OWNER, ALIAS_A, ALIAS_B]);
  });

  /**
   * The owner stays in the list. Dropping it loses the difference between
   * "the owner and A can spend" and "only A can spend", which are opposite
   * conclusions about control.
   */
  it("says the owner can still authorize when it is in its own set", async () => {
    respondWith([OWNER, ALIAS_A]);
    const a = m_(await describeAddresses([OWNER], { aliases: true }));
    expect(a?.owner_can_authorize).toBe(true);
    expect(a?.authorized).toContain(OWNER);
  });

  it("says the owner CANNOT authorize when it is absent from its own set", async () => {
    respondWith([ALIAS_A]);
    const a = m_(await describeAddresses([OWNER], { aliases: true }));
    expect(a?.owner_can_authorize).toBe(false);
    expect(a?.authorized).toEqual([ALIAS_A]);
  });

  /** A short form from the chain has to compare equal to the padded owner. */
  it("normalizes before deciding whether the owner is present", async () => {
    mockGqlQuery.mockImplementation(async (q?: string) =>
      isAliasQuery(q) ? { a0: aliasObject(["0x5", ALIAS_A]) } : { nodes: [], objects: { nodes: [] } },
    );
    const m = await describeAddresses(["0x5"], { aliases: true });
    expect(m.get("0x5")?.aliases?.owner_can_authorize).toBe(true);
  });

  it("reports nothing when the wallet never enabled the feature", async () => {
    mockGqlQuery.mockImplementation(async (q?: string) =>
      isAliasQuery(q) ? { a0: { nodes: [] } } : { nodes: [], objects: { nodes: [] } },
    );
    const m = await describeAddresses([OWNER], { aliases: true });
    expect(m.get(OWNER)?.aliases).toBeUndefined();
    expect(m.get(OWNER)?.aliases_unavailable).toBeUndefined();
  });

  it("ignores a non-string entry rather than carrying it into the set", async () => {
    respondWith([{ nested: true }, ALIAS_A]);
    expect(m_(await describeAddresses([OWNER], { aliases: true }))?.authorized).toEqual([ALIAS_A]);
  });
});

/**
 * A failed lookup is not an absence of delegation. This is the distinction the
 * batch-size defect erased: every full batch was rejected by the service and
 * reported as "this wallet has delegated to nobody".
 */
describe("a lookup that could not run", () => {
  it("marks the address unavailable rather than reporting no aliases", async () => {
    mockGqlQuery.mockImplementation(async (q?: string) => {
      if (isAliasQuery(q)) throw new Error("Query payload too large: 5238B > 5000B");
      return { nodes: [], objects: { nodes: [] } };
    });
    const m = await describeAddresses([OWNER], { aliases: true });
    expect(m.get(OWNER)?.aliases).toBeUndefined();
    expect(m.get(OWNER)?.aliases_unavailable).toBe(true);
  });

  it("does not mark anything unavailable on a malformed but successful response", async () => {
    respondWith("not-an-array");
    const m = await describeAddresses([OWNER], { aliases: true });
    expect(m.get(OWNER)?.aliases).toBeUndefined();
    expect(m.get(OWNER)?.aliases_unavailable).toBeUndefined();
  });
});

/**
 * The batch is the part that broke: `AUTH_BATCH_SIZE` was measured against a
 * much shorter query, and at 19 aliases this one crosses the service's
 * 5,000-byte cap and the whole document is rejected.
 */
describe("batching many addresses", () => {
  const many = Array.from({ length: 40 }, (_, i) => `0x${(i + 16).toString(16)}${"7".repeat(62)}`);

  it("keeps every request under the 5000-byte query cap", async () => {
    const sizes: number[] = [];
    mockGqlQuery.mockImplementation(async (q?: string) => {
      if (!isAliasQuery(q)) return { nodes: [], objects: { nodes: [] } };
      sizes.push(String(q).length);
      const out: Record<string, unknown> = {};
      const count = (String(q).match(/objects\(filter/g) ?? []).length;
      for (let j = 0; j < count; j++) out[`a${j}`] = aliasObject([ALIAS_A]);
      return out;
    });
    await describeAddresses(many, { aliases: true });
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(5000);
  });

  it("correlates each alias back to the address that asked for it", async () => {
    mockGqlQuery.mockImplementation(async (q?: string) => {
      if (!isAliasQuery(q)) return { nodes: [], objects: { nodes: [] } };
      // Each alias answers with the owner it was asked about, so a mis-mapped
      // index shows up as a wallet reporting someone else's set.
      const owners = [...String(q).matchAll(/owner: "(0x[0-9a-f]+)"/g)].map((x) => x[1]!);
      const out: Record<string, unknown> = {};
      owners.forEach((o, j) => (out[`a${j}`] = aliasObject([o, ALIAS_A])));
      return out;
    });
    const m = await describeAddresses(many, { aliases: true });
    for (const a of many) {
      expect(m.get(a)?.aliases?.owner_can_authorize).toBe(true);
    }
  });
});

/** Costs a request, so a caller that did not ask must not pay for it. */
it("makes no alias request unless asked", async () => {
  mockGqlQuery.mockResolvedValue({ nodes: [], objects: { nodes: [] } });
  await describeAddresses([OWNER], {});
  expect(mockGqlQuery.mock.calls.some((c) => isAliasQuery(c[0]))).toBe(false);
});

function m_(m: Map<string, { aliases?: { authorized: string[]; owner_can_authorize: boolean } }>) {
  return m.get(OWNER)?.aliases;
}
