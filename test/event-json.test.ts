import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A real mainnet digest. get_transaction validates the digest before making a
 * request and rejects a placeholder like "0xd" up front, so the input has to
 * be well-formed for these tests to reach event decoding.
 */
const TEST_DIGEST = "6rbfmByTyP4k7EREQBV9XZNhaG4RPm2ExT5bhVDfhGpu";

const mockGqlQuery = vi.fn();
const mockLookup = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/protocols/registry.js", () => ({
  prefetchProtocolNames: async () => {},
  lookupProtocolDisplay: (p: string) => mockLookup(p),
  lookupProtocol: (p: string) => mockLookup(p),
  lookupOperation: () => null,
}));

/** The gRPC response shape, delivered through the archive-fallback seam. */
let grpcResponse: unknown;
vi.mock("../src/utils/archive-fallback.js", () => ({
  withArchiveFallback: async () => grpcResponse,
}));

const { packageOfEventType } = await import("../src/utils/event-json.js");
const { registerTransactionTools } = await import("../src/tools/transactions.js");
const tools = new Map<string, Function>();
registerTransactionTools({ tool: (n: string, _d: string, _s: unknown, h: Function) => tools.set(n, h) } as never);
const getTransaction = tools.get("get_transaction")!;

const DEEPBOOK_PKG = "0x2c8d603b";
const WRAPPER_PKG = "0xe74879da";
const EVENT_TYPE = `${DEEPBOOK_PKG}::order_info::OrderPlaced`;

/** A transaction that calls an obfuscated wrapper and emits a DeepBook event. */
function txWithEvents(count: number) {
  return {
    transaction: {
      digest: TEST_DIGEST,
      timestamp: null,
      checkpoint: 1n,
      balanceChanges: [],
      events: {
        events: Array.from({ length: count }, () => ({
          packageId: WRAPPER_PKG,
          module: "h0d1a7",
          eventType: EVENT_TYPE,
          sender: "0xsender",
        })),
      },
      transaction: { sender: "0xsender", kind: { data: { oneofKind: undefined } } },
      effects: { status: undefined, gasUsed: undefined, epoch: 1n },
    },
  };
}

const node = (i: number) => ({
  contents: { type: { repr: EVENT_TYPE }, json: { order_id: `order-${i}` } },
});

const gqlEvents = (count: number, hasNextPage = false, endCursor?: string, from = 0) => ({
  transaction: {
    effects: {
      events: {
        pageInfo: { hasNextPage, endCursor },
        nodes: Array.from({ length: count }, (_, i) => node(from + i)),
      },
    },
  },
});

const run = async () => JSON.parse((await getTransaction({ digest: TEST_DIGEST })).content.at(-1).text);

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockLookup.mockReset();
  // Only the package that DEFINES the event type is a known protocol; the
  // wrapper that emitted it is not.
  mockLookup.mockImplementation((p: string) => (p === DEEPBOOK_PKG ? { name: "DeepBook", type: "dex" } : null));
});

describe("packageOfEventType", () => {
  it("takes the package that DEFINES the type, not the emitter", () => {
    expect(packageOfEventType(EVENT_TYPE)).toBe(DEEPBOOK_PKG);
  });

  it("returns null for anything that is not a package-qualified type", () => {
    expect(packageOfEventType(null)).toBeNull();
    expect(packageOfEventType("")).toBeNull();
    expect(packageOfEventType("not::a::package")).toBeNull();
  });
});

describe("protocols from events", () => {
  it("names a protocol its Move calls never mentioned", async () => {
    // An obfuscated wrapper (h86261::h8b64d) in front of DeepBook names no
    // protocol by its calls; the event's own package resolves by upgrade
    // lineage.
    grpcResponse = txWithEvents(2);
    mockGqlQuery.mockResolvedValue(gqlEvents(2));

    const d = await run();
    expect(d.protocols).toEqual(["DeepBook"]);
    expect(d.protocols_from_events_only).toEqual(["DeepBook"]);
    expect(d.protocol_attribution_note).toContain("wrapper or router");
  });

  it("stays quiet when the calls already named it", async () => {
    // No gap, no note — the flag exists to mark a discrepancy, not to
    // annotate every transaction that emits an event.
    grpcResponse = txWithEvents(0);
    const d = await run();
    expect(d.protocols_from_events_only).toBeUndefined();
    expect(d.protocol_attribution_note).toBeUndefined();
  });
});

describe("order events", () => {
  /** A one-event transaction whose event has this type and decoded fields. */
  const withEvent = (type: string, json: Record<string, unknown>) => {
    const tx = txWithEvents(1);
    tx.transaction.events.events[0]!.eventType = type;
    grpcResponse = tx;
    mockGqlQuery.mockResolvedValue({
      transaction: { effects: { events: { pageInfo: { hasNextPage: false }, nodes: [{ contents: { type: { repr: type }, json } }] } } },
    });
  };

  it("says a placed order's fills cover this transaction only", async () => {
    withEvent(`${DEEPBOOK_PKG}::order_info::OrderPlaced`, { order_id: "1" });
    expect((await run()).order_events_note).toBeDefined();
  });

  it("says so for a wrapper that put its order on the book", async () => {
    withEvent(`${WRAPPER_PKG}::utils::PlaceLimitOrderEvent`, { base_filled: "0", maker_injected: true });
    expect((await run()).order_events_note).toBeDefined();
  });

  it("stays quiet for a swap whose order filled at once", async () => {
    const tx = txWithEvents(2);
    tx.transaction.events.events[0]!.eventType = `${DEEPBOOK_PKG}::order_info::OrderFilled`;
    tx.transaction.events.events[1]!.eventType = `${DEEPBOOK_PKG}::order_info::OrderFullyFilled`;
    grpcResponse = tx;
    mockGqlQuery.mockResolvedValue({
      transaction: {
        effects: {
          events: {
            pageInfo: { hasNextPage: false },
            nodes: [
              { contents: { type: { repr: `${DEEPBOOK_PKG}::order_info::OrderFilled` }, json: { base_quantity: "5" } } },
              { contents: { type: { repr: `${DEEPBOOK_PKG}::order_info::OrderFullyFilled` }, json: { order_id: "1" } } },
            ],
          },
        },
      },
    });
    expect((await run()).order_events_note).toBeUndefined();
  });

  it("stays quiet for a market order placed through a wrapper", async () => {
    withEvent(`${WRAPPER_PKG}::utils::PlaceMarktetOrderEvent`, { is_bid: true, base_input: "0", quote_input: "5", base_output: "1", quote_output: "0" });
    expect((await run()).order_events_note).toBeUndefined();
  });

  it("stays quiet for a wrapper whose order never went on the book", async () => {
    withEvent(`${WRAPPER_PKG}::utils::PlaceLimitOrderEvent`, { base_filled: "10", maker_injected: false });
    expect((await run()).order_events_note).toBeUndefined();
  });
});

describe("parsed event fields", () => {
  it("attaches decoded contents, which gRPC does not carry", async () => {
    grpcResponse = txWithEvents(3);
    mockGqlQuery.mockResolvedValue(gqlEvents(3));

    const d = await run();
    expect(d.events.map((e: { parsed: { order_id: string } }) => e.parsed.order_id))
      .toEqual(["order-0", "order-1", "order-2"]);
    expect(d.event_fields_note).toBeUndefined();
  });

  it("pages the events connection, which defaults to 20 and paginates", async () => {
    // Without a page argument the connection returns 20 nodes for a
    // 70-event transaction, and the length guard then attaches nothing.
    grpcResponse = txWithEvents(70);
    mockGqlQuery
      .mockResolvedValueOnce(gqlEvents(50, true, "cursor-1", 0))
      .mockResolvedValueOnce(gqlEvents(20, false, undefined, 50));

    const d = await run();
    expect(mockGqlQuery).toHaveBeenCalledTimes(2);
    expect(mockGqlQuery.mock.calls[1][1].after).toBe("cursor-1");
    expect(d.event_count).toBe(70);
    expect(d.events[0].parsed.order_id).toBe("order-0");
    expect(d.event_fields_note).toBeUndefined();
  });

  it("stops when a connection claims another page but returns no cursor", async () => {
    // Otherwise it would refetch the same page until the page cap.
    grpcResponse = txWithEvents(50);
    mockGqlQuery.mockResolvedValue(gqlEvents(50, true, undefined, 0));

    const d = await run();
    expect(mockGqlQuery).toHaveBeenCalledTimes(1);
    expect(d.events[0].parsed.order_id).toBe("order-0");
  });

  it("treats a response with no pageInfo as one complete page", async () => {
    grpcResponse = txWithEvents(2);
    mockGqlQuery.mockResolvedValue({
      transaction: { effects: { events: { nodes: [node(0), node(1)] } } },
    });

    const d = await run();
    expect(d.events[1].parsed.order_id).toBe("order-1");
  });

  it("attaches nothing when the two lists disagree on length", async () => {
    // Joining by position across mismatched lists would file one event's
    // values under another's type — worse than omitting them.
    grpcResponse = txWithEvents(3);
    mockGqlQuery.mockResolvedValue(gqlEvents(2));

    const d = await run();
    expect(d.events.every((e: { parsed?: unknown }) => e.parsed === undefined)).toBe(true);
    expect(d.event_fields_note).toContain("different number of events");
    // The types and senders gRPC gave us are still reported.
    expect(d.events).toHaveLength(3);
  });

  it("survives a GraphQL failure without failing the lookup", async () => {
    // Parsed fields are an enrichment; gRPC already answered the question.
    grpcResponse = txWithEvents(2);
    mockGqlQuery.mockRejectedValue(new Error("network"));

    const d = await run();
    expect(d.event_count).toBe(2);
    expect(d.event_fields_note).toBeDefined();
  });

  it("makes no request when the transaction has no events", async () => {
    grpcResponse = txWithEvents(0);
    const d = await run();
    expect(mockGqlQuery).not.toHaveBeenCalled();
    expect(d.event_count).toBe(0);
  });
});
