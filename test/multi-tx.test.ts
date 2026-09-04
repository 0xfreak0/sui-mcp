import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { fetchTransactions, MAX_DIGESTS } = await import("../src/utils/multi-tx.js");

/** Real mainnet digests — Base58 that decodes to exactly 32 bytes. */
const D1 = "YjD4uaPxdF61wAGViXsYyARij4v9NsiHtJGo3rXa6zN";
const D2 = "6TLpShaSJRccvxiou9rrGFZvKHMwJg7MsTeWe8sxxWjR";
const PKG = "0x2c8d603b";

const tx = (digest: string, opts: { events?: number; more?: boolean } = {}) => ({
  digest,
  sender: { address: "0xsender" },
  kind: {
    __typename: "ProgrammableTransaction",
    commands: {
      nodes: [
        { __typename: "MoveCallCommand", function: { name: "swap", module: { name: "pool", package: { address: PKG } } } },
        { __typename: "SplitCoinsCommand" },
      ],
    },
  },
  effects: {
    status: "SUCCESS",
    timestamp: "2026-01-01T00:00:00.000Z",
    epoch: { epochId: 7 },
    checkpoint: { sequenceNumber: 99 },
    balanceChanges: { nodes: [{ amount: "-5", owner: { address: "0xsender" }, coinType: { repr: "0x2::sui::SUI" } }] },
    events: {
      pageInfo: { hasNextPage: Boolean(opts.more) },
      nodes: Array.from({ length: opts.events ?? 1 }, (_, i) => ({
        contents: { type: { repr: `${PKG}::order::Placed` }, json: { i } },
      })),
    },
  },
});

beforeEach(() => mockGqlQuery.mockReset());

describe("fetchTransactions", () => {
  it("reads many digests in ONE request", async () => {
    // The whole point: ten digests were ten round trips, and the model turn per
    // call cost more than the latency did.
    mockGqlQuery.mockResolvedValue({ multiGetTransactions: [tx(D1), tx(D2)] });
    const r = await fetchTransactions([D1, D2], 0);
    expect(mockGqlQuery).toHaveBeenCalledTimes(1);
    expect(r.found.map((t) => t.digest)).toEqual([D1, D2]);
  });

  it("carries decoded event fields and Move call targets", async () => {
    mockGqlQuery.mockResolvedValue({ multiGetTransactions: [tx(D1, { events: 3 })] });
    const r = await fetchTransactions([D1], 0);
    expect(r.found[0].events).toHaveLength(3);
    expect(r.found[0].events[0].parsed).toEqual({ i: 0 });
    expect(r.found[0].move_calls).toEqual([`${PKG}::pool::swap`]);
    // Both the called package and the event's defining package, for one prefetch.
    expect(r.packages).toContain(PKG);
  });

  it("maps a null entry to the digest it was asked about", async () => {
    // Positional. Getting this wrong would report the wrong digest as missing.
    mockGqlQuery.mockResolvedValue({ multiGetTransactions: [null, tx(D2)] });
    const r = await fetchTransactions([D1, D2], 0);
    expect(r.not_found).toEqual([D1]);
    expect(r.found.map((t) => t.digest)).toEqual([D2]);
  });

  it("flags a transaction whose events were cut short", async () => {
    // Breadth over depth is the deliberate trade here, so it has to be visible.
    mockGqlQuery.mockResolvedValue({ multiGetTransactions: [tx(D1, { events: 50, more: true })] });
    const r = await fetchTransactions([D1], 0);
    expect(r.found[0].events_truncated).toBe(true);
    expect(r.found[0].events_note).toContain("get_transaction");
  });

  it("rejects a malformed digest WITHOUT sending the batch", async () => {
    // The server refuses the whole batch over one bad key, so a single typo
    // among fifty digests returned nothing at all.
    mockGqlQuery.mockResolvedValue({ multiGetTransactions: [tx(D1)] });
    const r = await fetchTransactions([D1, "not-a-digest!!"], 0);
    expect(r.invalid).toEqual(["not-a-digest!!"]);
    expect(mockGqlQuery.mock.calls[0][1].keys).toEqual([D1]);
  });

  it("rejects Base58 that decodes to the wrong length", async () => {
    // The alphabet alone is not enough: 44 ones is valid Base58 and decodes to
    // 44 zero bytes, which the server refuses on length.
    mockGqlQuery.mockResolvedValue({ multiGetTransactions: [] });
    const r = await fetchTransactions(["1".repeat(44)], 0);
    expect(r.invalid).toEqual(["1".repeat(44)]);
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("reports a system transaction's sender as the null address, not null", async () => {
    // GraphQL returns `sender: null` for a system transaction while gRPC
    // returns the null address. Cross-checking 24 real digests against
    // get_transaction, that single difference disagreed on 15 of them. Two
    // tools describing one transaction differently is worse than either alone.
    mockGqlQuery.mockResolvedValue({
      multiGetTransactions: [
        {
          digest: D1,
          sender: null,
          kind: { __typename: "ConsensusCommitPrologueTransaction" },
          effects: {
            status: "SUCCESS",
            timestamp: "2026-01-01T00:00:00.000Z",
            balanceChanges: { nodes: [] },
            events: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        },
      ],
    });
    const r = await fetchTransactions([D1], 0);
    expect(r.found[0].sender).toBe(`0x${"0".repeat(64)}`);
    expect(r.found[0].is_system).toBe(true);
  });

  it("treats a hollow record as absent, not as a transaction that moved nothing", async () => {
    // A pruned digest comes back with a digest and a timestamp and nothing
    // else. Rendering that as a real transaction is the failure trace_funds
    // already guards against — it ends a trace early, looking complete.
    mockGqlQuery.mockResolvedValue({
      multiGetTransactions: [
        {
          digest: D1,
          sender: null,
          kind: null,
          effects: {
            timestamp: "2023-01-01T00:00:00.000Z",
            checkpoint: { sequenceNumber: 1 },
            balanceChanges: { nodes: [] },
            events: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        },
      ],
    });
    const r = await fetchTransactions([D1], 0);
    expect(r.found).toEqual([]);
    expect(r.not_found).toEqual([D1]);
  });

  it("does not mistake a real programmable transaction for a hollow one", async () => {
    // The guard keys on kind, so anything with a kind survives even when it
    // moved no balance and emitted no events.
    mockGqlQuery.mockResolvedValue({
      multiGetTransactions: [
        {
          digest: D1,
          sender: { address: "0xreal" },
          kind: { __typename: "ProgrammableTransaction", commands: { nodes: [] } },
          effects: {
            status: "SUCCESS",
            balanceChanges: { nodes: [] },
            events: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        },
      ],
    });
    const r = await fetchTransactions([D1], 0);
    expect(r.found).toHaveLength(1);
    expect(r.found[0].is_system).toBeUndefined();
  });

  it("reads Move calls from a ProgrammableSystemTransaction too", async () => {
    // A distinct GraphQL type from ProgrammableTransaction that still carries
    // real Move calls — framework settlement, randomness. A fragment on
    // ProgrammableTransaction alone never sees them, and this tool reported no
    // protocols where get_transaction reported "Sui Framework" on 7 of 24
    // cross-checked digests.
    mockGqlQuery.mockResolvedValue({
      multiGetTransactions: [
        {
          digest: D1,
          sender: null,
          kind: {
            __typename: "ProgrammableSystemTransaction",
            commands: {
              nodes: [
                {
                  __typename: "MoveCallCommand",
                  function: { name: "settle", module: { name: "accumulator", package: { address: "0x2" } } },
                },
              ],
            },
          },
          effects: {
            status: "SUCCESS",
            balanceChanges: { nodes: [] },
            events: { pageInfo: { hasNextPage: false }, nodes: [] },
          },
        },
      ],
    });
    const r = await fetchTransactions([D1], 0);
    expect(r.found[0].move_calls).toEqual(["0x2::accumulator::settle"]);
    expect(r.packages).toContain("0x2");
    expect(r.found[0].is_system).toBe(true);
  });

  it("collapses duplicates and caps the batch", async () => {
    mockGqlQuery.mockResolvedValue({ multiGetTransactions: [tx(D1)] });
    await fetchTransactions([D1, D1], 0);
    expect(mockGqlQuery.mock.calls[0][1].keys).toEqual([D1]);
    expect(MAX_DIGESTS).toBe(50);
  });

  it("makes no request when nothing survives validation", async () => {
    const r = await fetchTransactions(["nope!"], 0);
    expect(mockGqlQuery).not.toHaveBeenCalled();
    expect(r.found).toEqual([]);
  });
});
