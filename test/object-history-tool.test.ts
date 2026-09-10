import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
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

beforeEach(() => mockGqlQuery.mockReset());

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
