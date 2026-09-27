import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
const getTransaction = vi.fn();
const mockFindEnclosingKiosk = vi.fn();
const mockResolveKioskCapHolder = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => {
  const client = { ledgerService: { getTransaction } };
  return { sui: client, archive: client };
});
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false }));
vi.mock("../src/utils/kiosk.js", () => ({
  findEnclosingKiosk: mockFindEnclosingKiosk,
  resolveKioskCapHolder: mockResolveKioskCapHolder,
}));

const { registerObjectHistoryTools } = await import("../src/tools/object-history.js");

type Args = { object_id: string; limit?: number; order?: "oldest" | "newest"; cursor?: string };
let handler: (args: Args) => Promise<{ content: { text: string }[] }>;
registerObjectHistoryTools({
  tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
    handler = h;
  },
} as never);

const run = async (args: Args) =>
  JSON.parse((await handler(args)).content[0].text);

/** One version node in the shape both `current` and `objectVersions.nodes[]` share. */
const version = (v: string, owner: string, checkpoint = 1) => ({
  version: Number(v),
  previousTransaction: {
    digest: `tx${v}`,
    effects: { timestamp: `2026-01-0${v[0]}T00:00:00Z`, checkpoint: { sequenceNumber: checkpoint } },
  },
  owner: { __typename: "AddressOwner", address: { address: owner } },
  asMoveObject: { contents: { type: { repr: "0x2::package::UpgradeCap" } } },
});

/**
 * The gRPC effects of the transaction that wrote a version: `idOperation` is
 * 2 (CREATED) when that transaction created the object, 1 (NONE) when it only
 * mutated or transferred it, 3 (DELETED) when it deleted it.
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
  mockFindEnclosingKiosk.mockReset();
  mockResolveKioskCapHolder.mockReset();
  // An object that sat still: its current version's transaction mutated it.
  getTransaction.mockResolvedValue(effectsWith("0xcap", 1));
});

describe("trace_object_history — object not found", () => {
  it("errors when neither current nor any prior version exists", async () => {
    mockGqlQuery.mockResolvedValue({
      current: null,
      objectVersions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    });
    const r = await handler({ object_id: "0xnope" });
    expect((r.content[0] as { text: string }).text).toMatch(/not found/i);
  });
});

describe("trace_object_history — an object whose whole life fits in one page", () => {
  it("claims a creation when the walk actually reached the start", async () => {
    mockGqlQuery.mockResolvedValue({
      current: version("3", "0xb"),
      objectVersions: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [version("1", "0xa"), version("3", "0xb")],
      },
    });
    getTransaction.mockResolvedValue(effectsWith("0xshort", 2));
    const r = await run({ object_id: "0xshort", limit: 25 });
    expect(r.history_truncated).toBe(false);
    expect(r.created).not.toBeNull();
    expect(r.created.owner.address).toBe("0xa");
    expect(r.owner_change_count).toBe(1);
    expect(r.owner_change_note).toBeUndefined();
    expect(r.history_unavailable).toBeUndefined();
    expect(r.current.owner.address).toBe("0xb");
  });

  /**
   * An UpgradeCap whose only visible version is held by 0x2, with a
   * creation the walk cannot see. One version looks the same as "created
   * here, never moved", so the tool must not claim a creation, must mark the
   * history truncated, and must not name 0x2 as the creator.
   */
  it("does not claim a creation it cannot see, and says so", async () => {
    mockGqlQuery.mockResolvedValue({
      current: version("412781799", "0x2"),
      objectVersions: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [version("412781799", "0x2")],
      },
    });
    // The default getTransaction mock reports idOperation 1 (not created)
    // for "0xcap", the object id this describe block's tests use.
    const r = await run({ object_id: "0xcap" });
    expect(r.created).toBeNull();
    expect(r.history_truncated).toBe(true);
    expect(r.history_unavailable).toMatch(/beyond retention/i);
    expect(r.history_unavailable).toMatch(/NOT that this object was ne/i);
    expect(r.owner_change_count).toBe(0);
  });
});

describe("trace_object_history — a busy object beyond the page limit", () => {
  /**
   * An OperatorCap mutated on every privileged call accumulates thousands of
   * versions, so its handover transaction sits far past any page-based walk.
   * Checkpoint bisection reaches it in a handful of reads regardless.
   */
  it("still finds a distant owner transition via checkpoint search, and still claims the creation", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions(address: $id, first: $first)")) {
        return {
          current: version("999999", "0xoperator", 900),
          objectVersions: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [version("1", "0xmultisig", 10)],
          },
        };
      }
      if (query.includes("atCheckpoint") && query.includes("previousTransaction")) {
        const cp = vars.cp as number;
        return { object: { version: 42, previousTransaction: { digest: `handover-${cp}`, effects: { timestamp: "2026-01-15T00:00:00Z" } } } };
      }
      if (query.includes("atCheckpoint")) {
        const cp = vars.cp as number;
        return { object: { owner: { __typename: "AddressOwner", address: { address: cp < 500 ? "0xmultisig" : "0xoperator" } } } };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xoperatorcap", 2));

    const r = await run({ object_id: "0xoperatorcap", limit: 1 });
    expect(r.history_truncated).toBe(true);
    expect(r.more_versions_note).toMatch(/checkpoint search/i);
    expect(r.history_unavailable).toBeUndefined();
    // Creation is still claimed: forward paging's first row is genesis here,
    // independent of how much later history the page limit cut off.
    expect(r.created).not.toBeNull();
    expect(r.created.owner.address).toBe("0xmultisig");
    // The transition from multisig to operator is found despite sitting past
    // checkpoint 500 and the page's single retained row stopping at 10.
    expect(r.owner_changes.some((c: { to: { address: string } }) => c.to.address === "0xoperator")).toBe(true);
  });

  /**
   * An A -> B -> A round trip the shown `history` page itself displays: the
   * page's own rows go through `computeOwnerChanges` on the branch that
   * searches past the page too, so `owner_change_count` and `owner_changes`
   * report both transfers.
   */
  it("keeps an A -> B -> A round trip the page itself shows, instead of dropping it", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("objectVersions(address: $id, first: $first)")) {
        return {
          current: version("4", "0xa", 500),
          objectVersions: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [version("1", "0xa", 100), version("2", "0xb", 200), version("3", "0xa", 300)],
          },
        };
      }
      throw new Error(`unexpected query (bisection should not run): ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xroundtrip", 2));

    const r = await run({ object_id: "0xroundtrip", limit: 3 });
    expect(r.owner_change_count).toBe(2);
    expect(r.owner_changes.map((c: { from: { address: string }; to: { address: string } }) => [c.from.address, c.to.address])).toEqual([
      ["0xa", "0xb"],
      ["0xb", "0xa"],
    ]);
  });

  /**
   * Owner went A -> B -> A entirely past the shown page, so both ends
   * bisection probes (the page's last row and `current`) agree, and it
   * returns zero reads and zero transitions. This must never be reported
   * complete: bisection cannot tell "nothing happened" from "happened and
   * reversed" when both probed ends agree.
   */
  it("never claims completeness when both bisection ends agree, even with zero transitions found", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("objectVersions(address: $id, first: $first)")) {
        return {
          current: version("2", "0xa", 1_000_000),
          objectVersions: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [version("1", "0xa", 1)],
          },
        };
      }
      throw new Error(`unexpected query (same-owner ends must short-circuit): ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xhidden", 2));

    const r = await run({ object_id: "0xhidden", limit: 1 });
    expect(r.owner_change_count).toBe(0);
    expect(r.owner_change_note).toBeDefined();
    expect(r.owner_change_note).not.toMatch(/full life/i);
    expect(r.more_versions_note).toBeDefined();
    expect(r.more_versions_note).not.toMatch(/FULL life/);
    expect(r.more_versions_note).toMatch(/lower bound/i);
    expect(r.owner_change_note).toMatch(/without finding further disagreement/);
    expect(r.owner_change_note).toMatch(/reversed transfer/);
  });

  /**
   * Two handovers past the page, both found by the search: the note states
   * how many were found rather than saying the search "finished without
   * finding further disagreement".
   */
  it("says how many transitions the finished search found instead of claiming it found none", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions(address: $id, first: $first)")) {
        return {
          current: version("9", "0xc", 900),
          objectVersions: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [version("1", "0xa", 10)] },
        };
      }
      if (query.includes("atCheckpoint") && query.includes("previousTransaction")) {
        const cp = vars.cp as number;
        return { object: { version: cp, previousTransaction: { digest: `handover-${cp}`, effects: { timestamp: "2026-01-15T00:00:00Z" } } } };
      }
      if (query.includes("atCheckpoint")) {
        const cp = vars.cp as number;
        const owner = cp < 300 ? "0xa" : cp < 600 ? "0xb" : "0xc";
        return { object: { owner: { __typename: "AddressOwner", address: { address: owner } } } };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xopcap", 2));

    const r = await run({ object_id: "0xopcap", limit: 1 });
    expect(r.owner_changes.map((c: { from: { address: string }; to: { address: string } }) => [c.from.address, c.to.address])).toEqual([
      ["0xa", "0xb"],
      ["0xb", "0xc"],
    ]);
    expect(r.owner_change_note).toMatch(/found 2 transition\(s\)/);
    expect(r.owner_change_note).not.toMatch(/without finding/);
    // The round-trip limit is stated whether or not anything was found.
    expect(r.owner_change_note).toMatch(/reversed transfer/);
  });

  it("says a search that ran out of budget stopped, and lists every range it stopped inside with the owners at its ends", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions(address: $id, first: $first)")) {
        return {
          current: version("9", "0xo1000", 1_000_001),
          objectVersions: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [version("1", "0xo0", 10)] },
        };
      }
      if (query.includes("atCheckpoint") && query.includes("previousTransaction")) {
        const cp = vars.cp as number;
        return { object: { version: cp, previousTransaction: { digest: `flip-${cp}`, effects: { timestamp: "2026-01-15T00:00:00Z" } } } };
      }
      if (query.includes("atCheckpoint")) {
        // A new owner every 1,000 checkpoints: every probed span's ends
        // disagree, so bisection runs out of its 80-read budget.
        const cp = vars.cp as number;
        return { object: { owner: { __typename: "AddressOwner", address: { address: `0xo${Math.floor(cp / 1000)}` } } } };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xflipper", 2));

    const r = await run({ object_id: "0xflipper", limit: 1 });
    expect(r.owner_change_note).toMatch(/did not finish/);
    type Range = { from_checkpoint: number; to_checkpoint: number; owner_before: { address: string }; owner_after: { address: string } };
    const ranges: Range[] = r.owner_change_unpinned;
    expect(ranges.length).toBeGreaterThan(0);
    let last = 10;
    for (const u of ranges) {
      // Each range holds a change: its ends disagree, and ranges tile the span in order.
      expect(u.owner_before.address).not.toBe(u.owner_after.address);
      expect(u.from_checkpoint).toBeGreaterThanOrEqual(last);
      expect(u.to_checkpoint).toBeGreaterThan(u.from_checkpoint);
      expect(u.to_checkpoint).toBeLessThanOrEqual(1_000_001);
      last = u.to_checkpoint;
    }
    if (r.owner_change_count > 0) expect(r.owner_change_note).toContain(`after finding ${r.owner_change_count} transition(s)`);
  });

  /**
   * Bisection is scoped to `history[history.length - 1]` .. `current`,
   * never `history[0]`. Seeding from the first row would (a)
   * re-spend the search budget re-finding a transition the page already
   * shows for free and (b) probe checkpoints below the last shown row for
   * no reason. `fetchOwnerAt` here must only ever be asked about checkpoints
   * strictly after the last shown row's checkpoint (200), and the page's own
   * A -> B transition must still come through via `computeOwnerChanges`.
   */
  it("bisects only from the last page row to current, not from the first row", async () => {
    const probedCps: number[] = [];
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions(address: $id, first: $first)")) {
        return {
          current: version("3", "0xc", 1000),
          objectVersions: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [version("1", "0xa", 100), version("2", "0xb", 200)],
          },
        };
      }
      if (query.includes("atCheckpoint") && query.includes("previousTransaction")) {
        return { object: { version: 5, previousTransaction: { digest: "handover", effects: { timestamp: "2026-03-01T00:00:00Z" } } } };
      }
      if (query.includes("atCheckpoint")) {
        const cp = vars.cp as number;
        probedCps.push(cp);
        return { object: { owner: { __typename: "AddressOwner", address: { address: cp < 600 ? "0xb" : "0xc" } } } };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xchain", 2));

    const r = await run({ object_id: "0xchain", limit: 2 });
    expect(probedCps.every((cp) => cp > 200)).toBe(true);
    expect(r.owner_changes.map((c: { from: { address: string }; to: { address: string } }) => [c.from.address, c.to.address])).toEqual([
      ["0xa", "0xb"],
      ["0xb", "0xc"],
    ]);
  });
});

describe("trace_object_history — paging newest first and by cursor", () => {
  const pairs = (r: { owner_changes: { from: { address: string }; to: { address: string }; at_version: string }[] }) =>
    r.owner_changes.map((c) => [c.from.address, c.to.address, c.at_version]);

  /**
   * A busy object's recent versions: v2..v5 are the newest, v1 its creation.
   * One more version than the page is read, so the change into the oldest
   * listed version (v3, from v2's owner) is exact without listing v2.
   */
  it("lists the newest versions first, with each owner change still from the version before", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("last: $last")) {
        expect(vars.last).toBe(4);
        expect(vars.filter).toBeNull();
        return {
          current: version("5", "0xc", 500),
          objectVersions: {
            pageInfo: { hasNextPage: false, endCursor: "c" },
            nodes: [version("2", "0xa", 200), version("3", "0xb", 300), version("4", "0xb", 400), version("5", "0xc", 500)],
          },
          genesis: { nodes: [version("1", "0xa", 100)] },
        };
      }
      throw new Error(`unexpected query (v1 and v2 share an owner, so no search reads): ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xbusy", 2));

    const r = await run({ object_id: "0xbusy", limit: 3, order: "newest" });
    expect(r.order).toBe("newest");
    expect(r.history.map((h: { version: string }) => h.version)).toEqual(["5", "4", "3"]);
    expect(pairs(r)).toEqual([
      ["0xb", "0xc", "5"],
      ["0xa", "0xb", "3"],
    ]);
    expect(r.created.tx).toBe("tx1");
    expect(r.history_truncated).toBe(true);
    expect(r.next_cursor).toBe("3");
    expect(r.next_call).toEqual({ tool: "trace_object_history", repeat_with: { order: "newest", cursor: "3" } });
  });

  it("continues newest first from a cursor, and stops offering a cursor at the first version", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("last: $last")) {
        expect(vars.filter).toEqual({ beforeVersion: 3 });
        return {
          current: version("5", "0xc", 500),
          objectVersions: { pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [version("1", "0xa", 100), version("2", "0xa", 200)] },
          genesis: { nodes: [version("1", "0xa", 100)] },
        };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xbusy", 2));

    const r = await run({ object_id: "0xbusy", limit: 3, order: "newest", cursor: "3" });
    expect(r.history.map((h: { version: string }) => h.version)).toEqual(["2", "1"]);
    expect(r.owner_change_count).toBe(0);
    expect(r.next_cursor).toBeUndefined();
    // Newer versions sit on the page already walked.
    expect(r.history_truncated).toBe(true);
  });

  it("continues oldest first from a cursor, relating the first row to the previous page's last", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("afterVersion")) {
        expect(vars.after).toBe(2);
        expect(vars.first).toBe(3);
        return {
          current: version("4", "0xb", 400),
          objectVersions: { pageInfo: { hasNextPage: false, endCursor: "c" }, nodes: [version("3", "0xa", 300), version("4", "0xb", 400)] },
          genesis: { nodes: [version("1", "0xa", 100)] },
        };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xslow", 2));

    const r = await run({ object_id: "0xslow", limit: 2, cursor: "3" });
    expect(r.history.map((h: { version: string }) => h.version)).toEqual(["4"]);
    expect(pairs(r)).toEqual([["0xa", "0xb", "4"]]);
    expect(r.next_cursor).toBeUndefined();
  });

  it("never asks GraphQL for more than 50 rows at limit 50, newest first or after a cursor", async () => {
    const asked: number[] = [];
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      const rows = (vars.last ?? vars.first) as number | undefined;
      if (rows !== undefined) {
        asked.push(rows);
        if (rows > 50) throw new Error(`Page size is too large: ${rows} > 50`);
      }
      if (query.includes("objectVersions")) {
        const nodes = Array.from({ length: rows ?? 0 }, (_, i) => version(String(100 + i), "0xa", 1000 + i));
        return {
          current: version("500", "0xa", 5000),
          objectVersions: { pageInfo: { hasNextPage: true, endCursor: "c" }, nodes },
          genesis: { nodes: [version("1", "0xa", 10)] },
        };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xbusy", 2));

    const newestPage = await run({ object_id: "0xbusy", limit: 50, order: "newest" });
    expect(newestPage.history).toHaveLength(49);
    expect(newestPage.next_cursor).toBe("101");
    const cursorPage = await run({ object_id: "0xbusy", limit: 50, cursor: "100" });
    expect(cursorPage.history).toHaveLength(49);
    expect(cursorPage.next_cursor).toBe("149");
    expect(Math.max(...asked)).toBeLessThanOrEqual(50);
  });

  it("offers the next oldest-first page when the first one is full", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("objectVersions(address: $id, first: $first)")) {
        return {
          current: version("4", "0xa", 400),
          objectVersions: { pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [version("1", "0xa", 100), version("2", "0xa", 200)] },
        };
      }
      throw new Error(`unexpected query (both search ends agree): ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xslow", 2));

    const r = await run({ object_id: "0xslow", limit: 2 });
    expect(r.next_call).toEqual({ tool: "trace_object_history", repeat_with: { order: "oldest", cursor: "2" } });
  });

  it("rejects a cursor that is not a version", async () => {
    const r = await handler({ object_id: "0xslow", cursor: "c1" });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });
});

describe("trace_object_history — no checkpoint search ran, so no FULL-life claim", () => {
  /**
   * With no checkpoint on `current`'s last write, no search is possible:
   * `more_versions_note` must not say owner_changes cover the object's full
   * life, and `owner_change_note` must not blame a query budget that was
   * never spent.
   */
  it("does not claim full life or a spent budget when current has no checkpoint to bisect to", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("objectVersions(address: $id, first: $first)")) {
        return {
          current: {
            version: 999,
            owner: { __typename: "AddressOwner", address: { address: "0xa" } },
            asMoveObject: { contents: { type: { repr: "0x2::package::UpgradeCap" } } },
            previousTransaction: { digest: "tx999", effects: { timestamp: "2026-01-01T00:00:00Z" } },
          },
          objectVersions: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [version("1", "0xa", 10)],
          },
        };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xnocp", 2));

    const r = await run({ object_id: "0xnocp", limit: 1 });
    expect(r.more_versions_note).toBeDefined();
    expect(r.more_versions_note).not.toMatch(/FULL life/);
    expect(r.more_versions_note).toMatch(/no checkpoint search ran/i);
    expect(r.owner_change_note).toMatch(/no checkpoint search ran/i);
    expect(r.owner_change_note).not.toMatch(/budget/i);
  });

  /**
   * A busy object that is also deleted or wrapped never runs a search
   * either (bisection's upper end would need the deleting transaction's
   * INPUT owner, not a checkpoint read), so the notes must not claim full
   * coverage or a spent budget. The fixture is a position with more
   * versions than the page limit whose last transaction deleted it.
   */
  it("does not claim full life or a spent budget for a busy, deleted object either", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("objectVersions(address: $id, first: $first)")) {
        return {
          current: null,
          objectVersions: {
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            nodes: [version("1", "0xvictim", 10), version("2", "0xvictim", 20)],
          },
        };
      }
      if (query.includes("affectedObject")) {
        return {
          transactions: {
            nodes: [{ digest: "redeemTx", effects: { timestamp: "2026-02-01T00:00:00Z", checkpoint: { sequenceNumber: 99 } } }],
          },
        };
      }
      throw new Error(`unexpected query: ${query.slice(0, 60)}`);
    });
    getTransaction.mockResolvedValue(effectsWith("0xposition", 3)); // DELETED

    const r = await run({ object_id: "0xposition", limit: 2 });
    expect(r.end.kind).toBe("deleted");
    expect(r.more_versions_note).not.toMatch(/FULL life/);
    expect(r.more_versions_note).toMatch(/no checkpoint search ran/i);
    expect(r.owner_change_note).toMatch(/no checkpoint search ran/i);
    expect(r.owner_change_note).not.toMatch(/budget/i);
  });
});

describe("trace_object_history — deleted and wrapped objects", () => {
  const history = {
    current: null,
    objectVersions: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [version("1", "0xvictim"), version("2", "0xdrainer")],
    },
  };

  /**
   * A deleted object has no current version but still has history: the
   * trace reports its versions, its ownership change and the transaction
   * that deleted it, instead of a "not found" error.
   */
  it("reaches the history of a deleted object instead of erroring", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("objectVersions(address: $id, first: $first)")) return history;
      if (query.includes("affectedObject")) {
        return { transactions: { nodes: [{ digest: "unstakeTx", effects: { timestamp: "2026-02-01T00:00:00Z", checkpoint: { sequenceNumber: 99 } } }] } };
      }
      throw new Error("unexpected");
    });
    getTransaction.mockResolvedValue(effectsWith("0xposition", 3)); // DELETED
    const r = await run({ object_id: "0xposition" });
    expect(r.current).toBeNull();
    expect(r.owner_changes.map((c: { tx: string }) => c.tx)).toContain("tx2");
    expect(r.end).toEqual({
      kind: "deleted",
      tx: "unstakeTx",
      timestamp: "2026-02-01T00:00:00Z",
      note: expect.stringMatching(/deleted/i),
    });
  });

  it("reports wrapped, not deleted, when the last touch did not delete it", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("objectVersions(address: $id, first: $first)")) return history;
      if (query.includes("affectedObject")) {
        return { transactions: { nodes: [{ digest: "wrapTx", effects: { timestamp: "2026-02-01T00:00:00Z", checkpoint: { sequenceNumber: 99 } } }] } };
      }
      throw new Error("unexpected");
    });
    getTransaction.mockResolvedValue(effectsWith("0xposition", 1)); // not DELETED
    const r = await run({ object_id: "0xposition" });
    expect(r.end.kind).toBe("wrapped");
  });
});

describe("trace_object_history — party objects", () => {
  // Mainnet shape: an authority::AuthorityCap sent with a party transfer,
  // created in 83Av9X1c….
  const CAP = "0xdbf46ffe39f2525660a0235dd130961ce1250ef62252a75ca006459de167d80f";
  const OWNER = "0xea5588c8b8cd44d4a78142fb07fb89af80a64931d0e129507bc5af41f82a647d";
  const CREATED_IN = "83Av9X1c1LcFjHTebMBW6c1Lw3ojdUYPjoBNxtbu1ENb";
  const partyNode = {
    version: 1018740892,
    owner: { __typename: "ConsensusAddressOwner", address: { address: OWNER } },
    asMoveObject: { contents: { type: { repr: "0x4e2d::authority::AuthorityCap<0x3ec7::registry::ADMIN>" } } },
    previousTransaction: {
      digest: CREATED_IN,
      effects: { timestamp: "2026-09-25T13:37:14.568Z", checkpoint: { sequenceNumber: 326800000 } },
    },
  };
  const partyHeld = {
    current: partyNode,
    objectVersions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [partyNode] },
  };

  /**
   * A ConsensusAddressOwner names the one address that can use the object;
   * reading it as `shared` would say anyone might.
   */
  it("reports the single owner of a party object, not 'shared'", async () => {
    mockGqlQuery.mockResolvedValue(partyHeld);
    getTransaction.mockResolvedValue(effectsWith(CAP, 2));
    const r = await run({ object_id: CAP });
    expect(r.current.owner).toEqual({ kind: "consensus", address: OWNER });
  });

  it("fills `created` when the walk's first row created the object", async () => {
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

describe("trace_object_history — a kiosk-held item", () => {
  const BULLSHARK = "0x8e6e6a180664976027d4ece2d441dead9de319123f1d537450e06dcc3033dabf";
  const WRAPPER = "0x2f699d7454664e560f970930efa106e0556c3d2a0cf34781db9a5b033ae724f4";
  const KIOSK = "0x306b2b5bcec1a7d1a4e780dce1f418fba11f21081575f42c261d09de5eedfd90";
  const DRAINER = "0x5ecf90fa681d13629e91067782316d89893c5cede1b889d7e2ea4eabd0e54088";
  const node = {
    version: 33517250,
    owner: { __typename: "ObjectOwner", address: { address: WRAPPER } },
    asMoveObject: { contents: { type: { repr: "0xee496a::suifrens::SuiFren<0x8894fa::bullshark::Bullshark>" } } },
    previousTransaction: { digest: "mintTx", effects: { timestamp: "2023-06-29T15:31:04.605Z", checkpoint: { sequenceNumber: 6379204 } } },
  };

  /**
   * A kiosk-held item's owner is an `ObjectOwner` (the kiosk's
   * `kiosk::Item` wrapper): it reads as owner kind `object`, with the
   * enclosing kiosk and its cap holder named.
   */
  it("reports owner kind 'object', not 'unknown', and names the kiosk and its cap holder", async () => {
    mockGqlQuery.mockResolvedValue({
      current: node,
      objectVersions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] },
    });
    getTransaction.mockResolvedValue(effectsWith("0xbullshark", 2));
    mockFindEnclosingKiosk.mockResolvedValue(KIOSK);
    mockResolveKioskCapHolder.mockResolvedValue({
      status: "resolved",
      result: { cap_id: "0xcap", creation_tx: "mintTx", original_holder: { kind: "address", address: "0xvictim" }, holder: { kind: "address", address: DRAINER } },
    });

    const r = await run({ object_id: BULLSHARK });
    expect(r.current.owner.kind).toBe("object");
    expect(r.current.owner.address).toBe(WRAPPER);
    expect(r.current.owner.kiosk_id).toBe(KIOSK);
    expect(r.current.owner.kiosk_cap_holder).toEqual({ kind: "address", address: DRAINER });
    expect(mockFindEnclosingKiosk).toHaveBeenCalledWith(WRAPPER);
  });

  it("does not claim a kiosk when the container cannot be resolved to one", async () => {
    mockGqlQuery.mockResolvedValue({
      current: node,
      objectVersions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] },
    });
    getTransaction.mockResolvedValue(effectsWith("0xbullshark", 2));
    mockFindEnclosingKiosk.mockResolvedValue(null);

    const r = await run({ object_id: BULLSHARK });
    expect(r.current.owner.kind).toBe("object");
    expect(r.current.owner.kiosk_id).toBeUndefined();
    expect(mockResolveKioskCapHolder).not.toHaveBeenCalled();
  });

  /** The same wiring as get_object and identify_address: a failed kiosk cap
   *  lookup degrades to a note and keeps the version history already read. */
  it("degrades a failed kiosk cap lookup to a note instead of failing the call", async () => {
    mockGqlQuery.mockResolvedValue({
      current: node,
      objectVersions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] },
    });
    getTransaction.mockResolvedValue(effectsWith("0xbullshark", 2));
    mockFindEnclosingKiosk.mockResolvedValue(KIOSK);
    mockResolveKioskCapHolder.mockResolvedValue({ status: "lookup_failed", message: "429 Too Many Requests" });

    const r = await run({ object_id: BULLSHARK });
    expect(r.current.owner.kiosk_id).toBe(KIOSK);
    expect(r.current.owner.kiosk_cap_holder).toBeUndefined();
    expect(r.current.owner.kiosk_cap_holder_note).toMatch(/429 Too Many Requests/);
  });

  /** A failure in the walk up to the kiosk (`findEnclosingKiosk`, up to two
   *  GraphQL reads), such as a 429, keeps the trace and the history already
   *  read, with a note that the kiosk check was skipped. */
  it("keeps the trace when the walk up to the kiosk fails, and says the kiosk check was skipped", async () => {
    mockGqlQuery.mockResolvedValue({
      current: node,
      objectVersions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] },
    });
    getTransaction.mockResolvedValue(effectsWith("0xbullshark", 2));
    mockFindEnclosingKiosk.mockRejectedValue(new Error("Rate-limited by graphql.mainnet.sui.io (HTTP 429) after 4 attempts."));

    const r = await run({ object_id: BULLSHARK });
    expect(r.history).toHaveLength(1);
    expect(r.current.owner.kind).toBe("object");
    expect(r.current.owner.address).toBe(WRAPPER);
    expect(r.current.owner.kiosk_id).toBeUndefined();
    expect(r.current.owner.kiosk_cap_holder).toBeUndefined();
    expect(r.current.owner.kiosk_cap_holder_note).toMatch(/HTTP 429/);
    expect(mockResolveKioskCapHolder).not.toHaveBeenCalled();
    // Only `current` carries the note; the same container on a history row does not.
    expect(r.history[0].owner.kiosk_cap_holder_note).toBeUndefined();
  });

  /**
   * `created`, every `history` row and every owner_changes endpoint can
   * share current's kiosk wrapper address, but only `current` gets the
   * cap's current holder: at an earlier version, such as the mint, that
   * holder need not have controlled the kiosk.
   */
  it("does not attach kiosk_cap_holder to created or history rows, only to current", async () => {
    const mintNode = { ...node, version: 1 };
    const laterNode = {
      ...node,
      version: 2,
      previousTransaction: { digest: "laterTx", effects: { timestamp: "2024-05-21T00:00:00Z", checkpoint: { sequenceNumber: 9000000 } } },
    };
    mockGqlQuery.mockResolvedValue({
      current: laterNode,
      objectVersions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [mintNode, laterNode] },
    });
    getTransaction.mockResolvedValue(effectsWith(BULLSHARK, 2));
    mockFindEnclosingKiosk.mockResolvedValue(KIOSK);
    mockResolveKioskCapHolder.mockResolvedValue({
      status: "resolved",
      result: { cap_id: "0xcap", creation_tx: "mintTx", original_holder: { kind: "address", address: "0xvictim" }, holder: { kind: "address", address: DRAINER } },
    });

    const r = await run({ object_id: BULLSHARK, limit: 2 });
    expect(r.current.owner.kiosk_cap_holder).toEqual({ kind: "address", address: DRAINER });
    expect(r.created.owner.kiosk_cap_holder).toBeUndefined();
    expect(r.created.owner.kiosk_id).toBeUndefined();
    expect(r.history[0].owner.kiosk_cap_holder).toBeUndefined();
    // Even the last history row, describing the same version as `current`,
    // does not inherit the enrichment: only the literal `current` field does.
    expect(r.history[1].owner.kiosk_cap_holder).toBeUndefined();
  });
});
