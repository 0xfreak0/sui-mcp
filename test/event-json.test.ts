import { describe, it, expect, vi, beforeEach } from "vitest";

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
      digest: "0xd",
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

const gqlEvents = (count: number) => ({
  transaction: {
    effects: {
      events: {
        nodes: Array.from({ length: count }, (_, i) => ({
          contents: { type: { repr: EVENT_TYPE }, json: { order_id: `order-${i}` } },
        })),
      },
    },
  },
});

const run = async () => JSON.parse((await getTransaction({ digest: "0xd" })).content.at(-1).text);

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
    // The failure this fixes: an obfuscated wrapper (h86261::h8b64d) in front
    // of DeepBook reported protocols: [] while the registry, asked directly,
    // resolves the event's own package by upgrade lineage.
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

describe("parsed event fields", () => {
  it("attaches decoded contents, which gRPC does not carry", async () => {
    grpcResponse = txWithEvents(3);
    mockGqlQuery.mockResolvedValue(gqlEvents(3));

    const d = await run();
    expect(d.events.map((e: { parsed: { order_id: string } }) => e.parsed.order_id))
      .toEqual(["order-0", "order-1", "order-2"]);
    expect(d.event_fields_note).toBeUndefined();
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
