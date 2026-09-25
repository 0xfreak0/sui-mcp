import { describe, it, expect, vi, beforeEach } from "vitest";
import fixtures from "./fixtures/signatures.json" with { type: "json" };

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/names.js", () => ({
  batchResolveNames: async (a: string[]) =>
    new Map(a.filter((x) => x === "0xnamed").map((x) => [x, "someone.sui"])),
}));
vi.mock("../src/utils/labels.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLabel: (a: string) =>
    a === "0xcex"
      ? {
          label: "An Exchange",
          category: "cex",
          source: "disclosed",
          entity: "An Exchange",
          evidence: "proof-of-reserves-listed",
          source_url: "https://example.com/por.csv",
          retrieved_at: "2026-09-25",
        }
      : null,
  isSink: () => false,
}));
vi.mock("../src/protocols/registry.js", () => ({
  prefetchProtocolNames: async () => {},
  lookupProtocolDisplay: (p: string) => (p === "0xpkg" ? { name: "DeepBook", type: "dex" } : null),
}));

const { classifyHeldNames, describeAddresses, identityNote } = await import("../src/utils/identity.js");
const { readAuthentication } = await import("../src/utils/multisig.js");

/** multiGetObjects answers positionally: null means nothing lives there. */
const reply = (entries: Array<unknown>) => ({ multiGetObjects: entries });

const YEAR_MS = 365 * 24 * 3600 * 1000;
/**
 * A registration node as the service returns it. `previousTransaction` is
 * optional because the service can return it as null.
 */
type HeldNode = {
  domain_name: string;
  expiration_timestamp_ms: number | string;
  address?: string;
  previousTransaction?: { digest: string; sender: { address: string }; effects: { timestamp: string } } | null;
};
const heldReply = (per: Array<Array<HeldNode>>) => ({
  multiGetAddresses: per.map((names) => ({
    objects: {
      nodes: names.map(({ address, previousTransaction, ...json }) => ({
        ...(address ? { address } : {}),
        contents: { json },
        previousTransaction: previousTransaction ?? null,
      })),
    },
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
    // A label is only as good as its source, so the source travels with it.
    expect(out.get("0xcex")!.label_provenance).toEqual({
      entity: "An Exchange",
      evidence: "proof-of-reserves-listed",
      source_url: "https://example.com/por.csv",
      retrieved_at: "2026-09-25",
    });
    expect(out.get("0xnamed")!.label_provenance).toBeUndefined();
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
    const keysPerCall = (name: string) =>
      mockGqlQuery.mock.calls
        .filter(([q]) => String(q).includes(name))
        .map(([, v]) => (v as { keys: unknown[] }).keys.length);
    // Every address asked about exactly once, by each lookup.
    for (const keys of [keysPerCall("multiGetAddresses"), keysPerCall("multiGetObjects")]) {
      expect(keys.reduce((a, b) => a + b, 0)).toBe(120);
    }
    // The service counts variables toward its 5,000-byte cap, at about 80
    // bytes per full-length address. Measured live: 44 held-names keys were
    // rejected at 5,127 bytes and 40 were accepted.
    expect(Math.max(...keysPerCall("multiGetAddresses"))).toBeLessThanOrEqual(40);
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
    // outlives expiry.
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

describe("where a held SuiNS registration came from", () => {
  // The Cetus attacker: 0x407fb974 sent it the taunt name in 2uE2WRav after
  // validators froze the wallet, and the wallet never touched it. Values are
  // the ones mainnet returned for registration 0xb00a20b5.
  const HOLDER = "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06";
  const SENDER = "0x407fb97400abc8f37defc658ab9c9f53a8953a1a446cd820561382fb3728ca20";
  const taunt: HeldNode = {
    address: "0xb00a20b5e2fd72a27e9dc07e0e9e448f17c30ade559edb65432615e001069f6d",
    domain_name: "give-the-funds-back-you-maniac-yngmi.sui",
    expiration_timestamp_ms: "1779832301904",
    previousTransaction: {
      digest: "2uE2WRavBRGLDwdvqNVmacytHdExqEmeoqdu4DgZzSCw",
      sender: { address: SENDER },
      effects: { timestamp: "2025-05-27T04:07:50.218Z" },
    },
  };
  const own: HeldNode = {
    domain_name: "mine.sui",
    expiration_timestamp_ms: Date.now() - YEAR_MS,
    previousTransaction: { digest: "DgOwn", sender: { address: HOLDER }, effects: { timestamp: "2024-01-01T00:00:00Z" } },
  };

  it("tells a name the holder registered from one another address sent it", async () => {
    mockGqlQuery.mockImplementation(route(reply([null]), heldReply([[taunt, own]])));
    const held = (await describeAddresses([HOLDER])).get(HOLDER)!.names_held!;
    expect(held.find((h) => h.name === "mine.sui")).toMatchObject({
      provenance: "registered_or_used",
      last_tx: "DgOwn",
    });
    expect(held.find((h) => h.name === "mine.sui")!.received_from).toBeUndefined();
    expect(held.find((h) => h.name === taunt.domain_name)).toMatchObject({
      provenance: "received_from_third_party",
      registration_id: taunt.address,
      received_from: SENDER,
      last_tx: "2uE2WRavBRGLDwdvqNVmacytHdExqEmeoqdu4DgZzSCw",
      last_tx_at: "2025-05-27T04:07:50.218Z",
    });
  });

  it("matches the holder in any address form the caller used", async () => {
    // The chain reports the padded address; a caller may drop the leading zero.
    const short = "0x1229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
    const padded = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
    mockGqlQuery.mockImplementation(
      route(reply([null]), heldReply([[{ ...own, previousTransaction: { ...own.previousTransaction!, sender: { address: padded } } }]])),
    );
    const held = (await describeAddresses([short])).get(short)!.names_held!;
    expect(held[0].provenance).toBe("registered_or_used");
  });

  it("says unknown rather than guessing when the writing transaction is missing", async () => {
    mockGqlQuery.mockImplementation(route(reply([null]), heldReply([[{ ...taunt, previousTransaction: null }]])));
    const id = (await describeAddresses([HOLDER])).get(HOLDER)!;
    expect(id.names_held![0].provenance).toBe("unknown");
    expect(id.names_held![0].received_from).toBeUndefined();
    const note = identityNote(id)!;
    expect(note).toContain("could not be read");
    expect(note).not.toContain("registered or used itself");
  });

  it("does not call a received name one the address was known by", async () => {
    mockGqlQuery.mockImplementation(route(reply([null]), heldReply([[taunt]])));
    const note = identityNote((await describeAddresses([HOLDER])).get(HOLDER)!)!;
    expect(note).not.toMatch(/known by/);
    expect(note).toContain(`from ${SENDER} in 2uE2WRavBRGLDwdvqNVmacytHdExqEmeoqdu4DgZzSCw`);
    expect(note).toContain("not attribution");
  });

  it("keeps a lapsed name the holder used as its own", async () => {
    mockGqlQuery.mockImplementation(route(reply([null]), heldReply([[own]])));
    const note = identityNote((await describeAddresses([HOLDER])).get(HOLDER)!)!;
    expect(note).toContain("EXPIRED registration(s) it registered or used itself: mine.sui");
    expect(note).not.toContain("not attribution");
  });

  it("treats a received name set as the current reverse record as the holder's own", () => {
    // Only the address itself can point its reverse record at a name.
    const id = {
      address: HOLDER,
      kind: "wallet" as const,
      name: "gift.sui",
      names_held: [{ name: "gift.sui", expired: false, provenance: "received_from_third_party" as const, received_from: SENDER }],
    };
    expect(classifyHeldNames(id).received).toEqual([]);
    expect(identityNote(id)).toBeUndefined();
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

describe("describeAddresses — authentication", () => {
  const ms = fixtures.ms_2of3;

  /**
   * The alias batch is a third query shape, so the router has to tell it apart
   * from the other two. It carries no variables, which is itself the tell.
   */
  const withAuth = (kinds: unknown, held: unknown, auth: unknown) =>
    async (q: string, v?: unknown) => {
      if (String(q).includes("sentAddress")) return auth;
      if (!v) return { multiGetObjects: [], multiGetAddresses: [] };
      return String(q).includes("multiGetAddresses") ? held : kinds;
    };

  it("does not read authentication unless asked", async () => {
    mockGqlQuery.mockImplementation(route(reply([null]), heldReply([[]])));
    const out = await describeAddresses([ms.address]);
    expect(out.get(ms.address)!.authentication).toBeUndefined();
    // Two calls, not three: the cost that makes this affordable per hop.
    expect(mockGqlQuery).toHaveBeenCalledTimes(2);
  });

  it("reads a multisig committee when asked", async () => {
    mockGqlQuery.mockImplementation(
      withAuth(reply([null]), heldReply([[]]), {
        a0: { nodes: [{ signatures: ms.signatures.map((signatureBytes) => ({ signatureBytes })) }] },
      }),
    );
    const out = await describeAddresses([ms.address], { authentication: true });
    const auth = out.get(ms.address)!.authentication!;
    expect(auth.scheme).toBe("multisig");
    expect(auth.multisig!.threshold).toBe(2);
  });

  /**
   * An address that has never sent has produced no signature. Leaving the
   * field absent is the honest answer; defaulting it to a single-key wallet
   * would make a receive-only treasury multisig read as a personal wallet.
   */
  it("leaves authentication absent for an address that has never sent", async () => {
    mockGqlQuery.mockImplementation(
      withAuth(reply([null]), heldReply([[]]), { a0: { nodes: [] } }),
    );
    const out = await describeAddresses(["0xquiet"], { authentication: true });
    expect(out.get("0xquiet")!.authentication).toBeUndefined();
  });

  it("chunks the alias batch at the service's 20-query limit", async () => {
    mockGqlQuery.mockImplementation(async (q: string, v?: unknown) => {
      if (String(q).includes("sentAddress")) return {};
      if (!v) return { multiGetObjects: [], multiGetAddresses: [] };
      const n = (v as { keys: unknown[] }).keys.length;
      return String(q).includes("multiGetAddresses")
        ? heldReply(new Array(n).fill([]))
        : reply(new Array(n).fill(null));
    });
    await describeAddresses(Array.from({ length: 50 }, (_, i) => `0x${i}`), { authentication: true });
    // Three authentication batches of 20, counted apart from the other lookups.
    expect(mockGqlQuery.mock.calls.filter(([q]) => String(q).includes("sentAddress"))).toHaveLength(3);
  });

  it("survives the authentication query failing", async () => {
    mockGqlQuery.mockImplementation(async (q: string, v?: unknown) => {
      if (String(q).includes("sentAddress")) throw new Error("rate limited");
      if (!v) return { multiGetObjects: [], multiGetAddresses: [] };
      return String(q).includes("multiGetAddresses") ? heldReply([[]]) : reply([null]);
    });
    const out = await describeAddresses([ms.address], { authentication: true });
    expect(out.get(ms.address)!.kind).toBe("wallet");
    expect(out.get(ms.address)!.authentication).toBeUndefined();
    // A failed read is not "never sent".
    expect(out.get(ms.address)!.authentication_unavailable).toBe(true);
  });

  it("records who signed when the address's sent transactions carry none of its own signatures", async () => {
    // B2eGLFo… was sent as a Cetus attacker address and signed by a multisig
    // acting for it. Dropping that transaction reported "never sent".
    const sender = fixtures.ed25519.address;
    mockGqlQuery.mockImplementation(
      withAuth(reply([null]), heldReply([[]]), {
        a0: { nodes: [{ digest: "B2eGLFo", gasInput: { gasSponsor: { address: sender } }, signatures: ms.signatures.map((signatureBytes) => ({ signatureBytes })) }] },
      }),
    );
    const id = (await describeAddresses([sender], { authentication: true })).get(sender)!;
    expect(id.authentication).toBeUndefined();
    expect(id.foreign_authorization).toEqual({ digest: "B2eGLFo", authorized_by: [ms.address], transactions_examined: 1 });
    expect(identityNote(id)).toMatch(/none of the 1 examined carries its own signature/);
  });

  it("calls an id that transactions recorded as an object a former object, not a wallet", async () => {
    // 0x17d0… is a zkSend bag's UID: no live object, never signed.
    mockGqlQuery.mockImplementation(async (q: string, v?: unknown) => {
      if (String(q).includes("affectedObject")) return { a0: { nodes: [{ digest: "2N1WX" }] } };
      if (String(q).includes("sentAddress")) return { a0: { nodes: [] } };
      if (!v) return { multiGetObjects: [], multiGetAddresses: [] };
      return String(q).includes("multiGetAddresses") ? heldReply([[]]) : reply([null]);
    });
    const id = (await describeAddresses(["0x17d0"], { authentication: true })).get("0x17d0")!;
    expect(id.kind).toBe("wrapped_or_deleted_object");
    expect(id.object_seen_in).toBe("2N1WX");
  });

  it("classifies kinds in chunks under the payload cap", async () => {
    // multiGetObjects with 62 keys is 5,222 bytes, over the service's 5,000.
    mockGqlQuery.mockImplementation(async (q: string, v?: unknown) => {
      if (!v) return { multiGetObjects: [], multiGetAddresses: [] };
      const n = (v as { keys: unknown[] }).keys.length;
      return String(q).includes("multiGetAddresses") ? heldReply(new Array(n).fill([])) : reply(new Array(n).fill(null));
    });
    await describeAddresses(Array.from({ length: 120 }, (_, i) => `0x${i}`));
    const kindCalls = mockGqlQuery.mock.calls.filter(([q]) => String(q).includes("multiGetObjects"));
    expect(kindCalls.every(([, v]) => (v as { keys: unknown[] }).keys.length <= 40)).toBe(true);
    expect(kindCalls.reduce((n, [, v]) => n + (v as { keys: unknown[] }).keys.length, 0)).toBe(120);
  });
});

describe("identityNote — authentication", () => {
  it("calls out a multisig wallet", () => {
    const auth = readAuthentication(fixtures.ms_2of3.address, fixtures.ms_2of3.signatures)!;
    const n = identityNote({ address: fixtures.ms_2of3.address, kind: "wallet", authentication: auth })!;
    expect(n).toContain("MULTISIG");
    expect(n).toContain("2-of-3");
  });

  /**
   * What is at the address takes precedence over who can spend from it: a
   * package being mistaken for a person is the louder error.
   */
  it("still leads with the package warning when both apply", () => {
    const auth = readAuthentication(fixtures.ms_2of3.address, fixtures.ms_2of3.signatures)!;
    const n = identityNote({ address: "0xp", kind: "package", authentication: auth })!;
    expect(n).toContain("PACKAGE");
  });
});

describe("describeAddresses — committee member fan-out", () => {
  const ms = fixtures.ms_1of2;
  const [memberA, memberB] = [
    "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777",
    "0xc848c5cc29fdff135650156194a27442b6c8cada58fab5ba9123d635754ae66f",
  ];

  /**
   * The expansion issues a second round of every query over the member set,
   * so the mock answers by which addresses it was asked about rather than by
   * call order.
   */
  const routeByKeys = (auth: Record<string, unknown>) =>
    async (q: string, v?: unknown) => {
      if (String(q).includes("sentAddress")) {
        const wanted = Object.fromEntries(
          Object.entries(auth).filter(([, sigs]) => String(q).includes(String((sigs as { for: string }).for))),
        );
        return Object.fromEntries(
          Object.keys(wanted).map((k, i) => [
            `a${i}`,
            { nodes: [{ signatures: (wanted[k] as { sigs: string[] }).sigs.map((s) => ({ signatureBytes: s })) }] },
          ]),
        );
      }
      if (!v) return { multiGetObjects: [], multiGetAddresses: [] };
      const n = (v as { keys: unknown[] }).keys.length;
      return String(q).includes("multiGetAddresses")
        ? heldReply(new Array(n).fill([]))
        : reply(new Array(n).fill(null));
    };

  it("resolves each committee member's own identity", async () => {
    mockGqlQuery.mockImplementation(
      routeByKeys({
        parent: { for: ms.address, sigs: ms.signatures },
        a: { for: memberA, sigs: fixtures.ed25519.signatures },
      }),
    );
    const out = await describeAddresses([ms.address], { expandMembers: true });
    const members = out.get(ms.address)!.committee_members!;
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.address)).toEqual([memberA, memberB]);
  });

  it("implies authentication without being asked for it separately", async () => {
    mockGqlQuery.mockImplementation(
      routeByKeys({ parent: { for: ms.address, sigs: ms.signatures } }),
    );
    const out = await describeAddresses([ms.address], { expandMembers: true });
    expect(out.get(ms.address)!.authentication!.scheme).toBe("multisig");
  });

  it("does not expand a wallet that is not a multisig", async () => {
    mockGqlQuery.mockImplementation(
      routeByKeys({ p: { for: fixtures.ed25519.address, sigs: fixtures.ed25519.signatures } }),
    );
    const out = await describeAddresses([fixtures.ed25519.address], { expandMembers: true });
    expect(out.get(fixtures.ed25519.address)!.committee_members).toBeUndefined();
  });

  /**
   * A member that resolves to nothing still occupies its seat. Dropping it
   * would misreport the committee's size, which is the number a reader uses to
   * judge how much control one key represents.
   */
  it("keeps a seat for a member it cannot resolve", async () => {
    mockGqlQuery.mockImplementation(async (q: string, v?: unknown) => {
      if (String(q).includes("sentAddress")) {
        return String(q).includes(ms.address)
          ? { a0: { nodes: [{ signatures: ms.signatures.map((s) => ({ signatureBytes: s })) }] } }
          : {};
      }
      if (!v) return { multiGetObjects: [], multiGetAddresses: [] };
      const n = (v as { keys: unknown[] }).keys.length;
      return String(q).includes("multiGetAddresses")
        ? heldReply(new Array(n).fill([]))
        : reply(new Array(n).fill(null));
    });
    const out = await describeAddresses([ms.address], { expandMembers: true });
    expect(out.get(ms.address)!.committee_members).toHaveLength(2);
  });
});
