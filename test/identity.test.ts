import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/names.js", () => ({
  batchResolveNames: async (a: string[]) =>
    new Map(a.filter((x) => x === "0xnamed").map((x) => [x, "someone.sui"])),
}));
vi.mock("../src/utils/labels.js", () => ({
  getLabel: (a: string) => (a === "0xcex" ? { label: "An Exchange", category: "cex" } : null),
  isSink: () => false,
}));
vi.mock("../src/protocols/registry.js", () => ({
  prefetchProtocolNames: async () => {},
  lookupProtocolDisplay: (p: string) => (p === "0xpkg" ? { name: "DeepBook", type: "dex" } : null),
}));

const { describeAddresses, identityNote } = await import("../src/utils/identity.js");

/** multiGetObjects answers positionally: null means nothing lives there. */
const reply = (entries: Array<unknown>) => ({ multiGetObjects: entries });

const YEAR_MS = 365 * 24 * 3600 * 1000;
const heldReply = (per: Array<Array<{ domain_name: string; expiration_timestamp_ms: number }>>) => ({
  multiGetAddresses: per.map((names) => ({
    objects: { nodes: names.map((json) => ({ contents: { json } })) },
  })),
});

/** The module issues two different queries; route on their distinctive text. */
function route(kinds: unknown, held: unknown) {
  return async (q: string, v?: unknown) => {
    if (!v) return { multiGetObjects: [], multiGetAddresses: [] };
    return String(q).includes("multiGetAddresses") ? held : kinds;
  };
}

/**
 * The runner invokes a mock implementation once with no arguments, so every
 * implementation below tolerates a missing variables object.
 */
const NO_ARGS = { keys: [] as unknown[] };

beforeEach(() => mockGqlQuery.mockReset());

describe("describeAddresses", () => {
  it("tells a wallet, a package and an object apart", async () => {
    mockGqlQuery.mockImplementation(route(
      reply([
        null,
        { asMovePackage: { address: "0xpkg" } },
        { asMoveObject: { contents: { type: { repr: "0x2::pool::Pool<A,B>" } } } },
      ]),
      heldReply([[], [], []]),
    ));

    const out = await describeAddresses(["0xwallet", "0xpkg", "0xobj"]);
    expect(out.get("0xwallet")!.kind).toBe("wallet");
    expect(out.get("0xpkg")!.kind).toBe("package");
    expect(out.get("0xpkg")!.protocol).toBe("DeepBook");
    expect(out.get("0xobj")!.kind).toBe("object");
    expect(out.get("0xobj")!.object_type).toBe("0x2::pool::Pool<A,B>");
  });

  it("resolves names and labels in the same pass", async () => {
    mockGqlQuery.mockImplementation(route(reply([null, null]), heldReply([[], []])));
    const out = await describeAddresses(["0xnamed", "0xcex"]);
    expect(out.get("0xnamed")!.name).toBe("someone.sui");
    expect(out.get("0xcex")!.label).toBe("An Exchange");
    expect(out.get("0xcex")!.label_category).toBe("cex");
  });

  it("stays at two batched requests however many addresses", async () => {
    // One name resolution (mocked) and one classification. The whole point is
    // that this is affordable per hop; identify_address costs ~5 calls each.
    mockGqlQuery.mockImplementation(
      route(reply(new Array(30).fill(null)), heldReply(new Array(30).fill([]))),
    );
    await describeAddresses(Array.from({ length: 30 }, (_, i) => `0x${i}`));
    // One classification query and one held-names query, regardless of size.
    expect(mockGqlQuery).toHaveBeenCalledTimes(2);
  });

  it("chunks past the page cap rather than sending one huge query", async () => {
    mockGqlQuery.mockImplementation(async (q: string, v = NO_ARGS) => {
      const n = (v as { keys: unknown[] }).keys.length;
      return String(q).includes("multiGetAddresses")
        ? heldReply(new Array(n).fill([]))
        : reply(new Array(n).fill(null));
    });
    await describeAddresses(Array.from({ length: 120 }, (_, i) => `0x${i}`));
    // 50 + 50 + 20, for each of the two queries.
    expect(mockGqlQuery).toHaveBeenCalledTimes(6);
  });

  it("leaves a chunk unclassified rather than guessing when the call fails", async () => {
    // A missing kind is honest. A wrong one changes how a hop reads.
    mockGqlQuery.mockImplementation(async (_q: string, v?: unknown) => {
      if (!v) return reply([]);
      throw new Error("network");
    });
    const out = await describeAddresses(["0xa"]);
    expect(out.get("0xa")!.kind).toBe("wallet"); // the documented default
    expect(out.get("0xa")!.object_type).toBeUndefined();
  });

  it("de-duplicates and ignores empties", async () => {
    mockGqlQuery.mockImplementation(route(reply([null]), heldReply([[]])));
    const out = await describeAddresses(["0xa", "0xa", ""]);
    expect(out.size).toBe(1);
    expect(mockGqlQuery.mock.calls[0][1].keys).toHaveLength(1);
  });

  it("makes no request at all for an empty set", async () => {
    expect((await describeAddresses([])).size).toBe(0);
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });
});

describe("historical SuiNS names", () => {
  it("reports registrations the address still holds, expired ones included", async () => {
    // The gap this closes: reverse lookup answers only "what is the current
    // default name" and returns nothing once a name lapses, so a wallet's
    // former aliases vanish from an investigation. The registration object
    // outlives expiry, and the address was known by that name at the time of
    // the activity being investigated.
    mockGqlQuery.mockImplementation(
      route(
        reply([null]),
        heldReply([
          [
            { domain_name: "current.sui", expiration_timestamp_ms: Date.now() + YEAR_MS },
            { domain_name: "lapsed.sui", expiration_timestamp_ms: Date.now() - YEAR_MS },
          ],
        ]),
      ),
    );

    const out = await describeAddresses(["0xa"]);
    const held = out.get("0xa")!.names_held!;
    expect(held.map((h) => h.name)).toEqual(["current.sui", "lapsed.sui"]);
    expect(held.find((h) => h.name === "lapsed.sui")!.expired).toBe(true);
    expect(held.find((h) => h.name === "current.sui")!.expired).toBe(false);
  });

  it("flags an address whose ONLY names have expired", async () => {
    // No current name at all — the case where an investigation would otherwise
    // show a bare hex address and lose the attribution entirely.
    mockGqlQuery.mockImplementation(
      route(
        reply([null]),
        heldReply([[{ domain_name: "gone.sui", expiration_timestamp_ms: Date.now() - YEAR_MS }]]),
      ),
    );

    const out = await describeAddresses(["0xa"]);
    const note = identityNote(out.get("0xa")!)!;
    expect(note).toContain("EXPIRED");
    expect(note).toContain("gone.sui");
  });

  it("says nothing when the address holds no registrations", async () => {
    mockGqlQuery.mockImplementation(route(reply([null]), heldReply([[]])));
    const out = await describeAddresses(["0xa"]);
    expect(out.get("0xa")!.names_held).toBeUndefined();
  });
});

describe("identityNote", () => {
  it("warns that a package is not a person holding funds", () => {
    const n = identityNote({ address: "0xp", kind: "package", protocol: "DeepBook" })!;
    expect(n).toContain("PACKAGE");
    expect(n).toContain("DeepBook");
  });

  it("warns that an object may be shared", () => {
    const n = identityNote({ address: "0xo", kind: "object", object_type: "0x2::pool::Pool" })!;
    expect(n).toContain("OBJECT");
    expect(n).toContain("pool::Pool");
  });

  it("says nothing about an ordinary wallet", () => {
    expect(identityNote({ address: "0xw", kind: "wallet" })).toBeUndefined();
  });
});
