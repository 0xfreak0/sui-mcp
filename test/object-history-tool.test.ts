import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
const getTransaction = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => {
  const client = { ledgerService: { getTransaction } };
  return { sui: client, archive: client };
});
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false }));

const { registerObjectHistoryTools } = await import("../src/tools/object-history.js");

let handler: (args: { object_id: string; limit?: number }) => Promise<{ content: { text: string }[] }>;
registerObjectHistoryTools({
  tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => { handler = h; },
} as never);

const run = async (args: { object_id: string; limit?: number }) =>
  JSON.parse((await handler(args)).content[0].text);

/** One version node in the shape the GraphQL query returns. */
const version = (v: string, owner: string) => ({
  version: v,
  previousTransaction: { digest: `tx${v}`, effects: { timestamp: `2026-01-0${v[0]}T00:00:00Z`, checkpoint: { sequenceNumber: 1 } } },
  owner: { __typename: "AddressOwner", address: { address: owner } },
  asMoveObject: { contents: { type: { repr: "0x2::package::UpgradeCap" } } },
});

/**
 * The gRPC effects of the transaction that wrote a version: `idOperation` is
 * 2 (CREATED) when that transaction created the object, 1 (NONE) when it only
 * mutated or transferred it.
 */
const effectsWith = (objectId: string, idOperation: number) => ({
  response: {
    transaction: {
      effects: {
        changedObjects: [
          { objectId: "0x0000000000000000000000000000000000000000000000000000000000000abc", idOperation: 1 },
          { objectId, idOperation },
        ],
      },
    },
  },
});

beforeEach(() => {
  mockGqlQuery.mockReset();
  getTransaction.mockReset();
  // An object that sat still: its current version's transaction mutated it.
  getTransaction.mockResolvedValue(effectsWith("0xcap", 1));
});

describe("trace_object_history — an empty history is not an empty life", () => {
  /**
   * Regression, verified on a real mainnet UpgradeCap: published by
   * 0x158d6f85, now held by 0x2, so it provably changed hands. The tool
   * reported `owner_change_count: 0`, `history_truncated: false`, and named the
   * burn address as its creator.
   *
   * Historical versions fall outside the indexer's retention for any object
   * that has sat still, so a long-lived object comes back with ONE version.
   * Read naively that is indistinguishable from "created here, never moved" —
   * three false claims from one missing page.
   */
  const onlyCurrent = {
    object: { ...version("412781799", "0x2"), objectVersionsBefore: { nodes: [] } },
  };

  it("does not claim a creation it cannot see", async () => {
    mockGqlQuery.mockResolvedValue(onlyCurrent);
    const r = await run({ object_id: "0xcap" });
    expect(r.created).toBeNull();
  });

  it("reports the history as truncated, not complete", async () => {
    mockGqlQuery.mockResolvedValue(onlyCurrent);
    expect((await run({ object_id: "0xcap" })).history_truncated).toBe(true);
  });

  it("says outright that the history is unavailable", async () => {
    mockGqlQuery.mockResolvedValue(onlyCurrent);
    const r = await run({ object_id: "0xcap" });
    expect(r.history_unavailable).toMatch(/beyond retention/i);
    expect(r.history_unavailable).toMatch(/NOT that this object was never transferred/i);
  });

  it("caveats the owner-change count rather than letting 0 read as never", async () => {
    mockGqlQuery.mockResolvedValue(onlyCurrent);
    const r = await run({ object_id: "0xcap" });
    expect(r.owner_change_count).toBe(0);
    expect(r.owner_change_note).toMatch(/versions shown only/i);
  });

  /**
   * The other truncation: a full page means older versions exist that we did
   * not ask for. Already handled, and must stay handled.
   */
  it("still detects a full page as truncated", async () => {
    mockGqlQuery.mockResolvedValue({
      object: {
        ...version("9", "0xb"),
        objectVersionsBefore: { nodes: [version("7", "0xa"), version("8", "0xa")] },
      },
    });
    const r = await run({ object_id: "0xhot", limit: 2 });
    expect(r.history_truncated).toBe(true);
    expect(r.created).toBeNull();
    expect(r.history_unavailable).toBeUndefined();
  });

  /** A walk that reached the beginning may still claim what it saw. */
  it("claims a creation when the walk actually reached the start", async () => {
    mockGqlQuery.mockResolvedValue({
      object: {
        ...version("3", "0xb"),
        objectVersionsBefore: { nodes: [version("1", "0xa")] },
      },
    });
    const r = await run({ object_id: "0xshort", limit: 25 });
    expect(r.history_truncated).toBe(false);
    expect(r.created).not.toBeNull();
    expect(r.created.owner.address).toBe("0xa");
    // A real transition, visible because the whole history was.
    expect(r.owner_change_count).toBe(1);
    expect(r.owner_change_note).toBeUndefined();
    expect(r.history_unavailable).toBeUndefined();
  });
});

describe("trace_object_history — party objects", () => {
  // Real mainnet shape (GapResearch D4): an authority::AuthorityCap sent with
  // a party transfer, created in 83Av9X1c… a few hours before it was traced.
  const CAP = "0xdbf46ffe39f2525660a0235dd130961ce1250ef62252a75ca006459de167d80f";
  const OWNER = "0xea5588c8b8cd44d4a78142fb07fb89af80a64931d0e129507bc5af41f82a647d";
  const CREATED_IN = "83Av9X1c1LcFjHTebMBW6c1Lw3ojdUYPjoBNxtbu1ENb";
  const partyHeld = {
    object: {
      version: "1018740892",
      owner: { __typename: "ConsensusAddressOwner", address: { address: OWNER } },
      asMoveObject: { contents: { type: { repr: "0x4e2d::authority::AuthorityCap<0x3ec7::registry::ADMIN>" } } },
      previousTransaction: {
        digest: CREATED_IN,
        effects: { timestamp: "2026-09-25T13:37:14.568Z", checkpoint: { sequenceNumber: 326800000 } },
      },
      objectVersionsBefore: { nodes: [] },
    },
  };

  /**
   * Regression: ConsensusAddressOwner was read as `shared`, which drops the
   * one address that can use the object and says anyone might.
   */
  it("reports the single owner of a party object, not 'shared'", async () => {
    mockGqlQuery.mockResolvedValue(partyHeld);
    getTransaction.mockResolvedValue(effectsWith(CAP, 2));
    const r = await run({ object_id: CAP });
    expect(r.current.owner).toEqual({ kind: "consensus", address: OWNER });
  });

  /**
   * Regression: with no earlier version the tool reported `created: null` and
   * "history is beyond retention" for an object created hours earlier. The
   * creating transaction's effects settle which of the two it is.
   */
  it("fills `created` when the current version's transaction created the object", async () => {
    mockGqlQuery.mockResolvedValue(partyHeld);
    getTransaction.mockResolvedValue(effectsWith(CAP, 2));
    const r = await run({ object_id: CAP });
    expect(r.created).toEqual({
      tx: CREATED_IN,
      timestamp: "2026-09-25T13:37:14.568Z",
      owner: { kind: "consensus", address: OWNER },
    });
    expect(r.history_truncated).toBe(false);
    expect(r.history_unavailable).toBeUndefined();
  });

  it("keeps the retention caveat when the creating transaction cannot be read", async () => {
    mockGqlQuery.mockResolvedValue(partyHeld);
    getTransaction.mockRejectedValue(Object.assign(new Error("NOT_FOUND"), { code: 5 }));
    const r = await run({ object_id: CAP });
    expect(r.created).toBeNull();
    expect(r.history_unavailable).toMatch(/beyond retention/i);
  });
});
