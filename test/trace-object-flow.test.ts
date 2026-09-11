import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tool-level cover for object flow in `trace_funds`.
 *
 * The pure reading is tested in `object-flow.test.ts`. What only shows up here
 * is the honesty of the rendered trace: a hop that handed over a capability
 * used to print `Flows: gas only`, which is the "could not look" rendered as
 * "nothing there" that this repo keeps finding.
 */

const mockGqlQuery = vi.fn();
const mockArchive = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/archive-fallback.js", () => ({
  withArchiveFallback: (...a: unknown[]) => mockArchive(...a),
}));
vi.mock("../src/utils/identity.js", () => ({
  describeAddresses: async () => new Map(),
  identityNote: () => null,
}));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false }));
vi.mock("../src/utils/price-providers.js", () => ({ pricesForRanking: async () => new Map() }));
vi.mock("../src/utils/store.js", () => ({
  getCachedTransaction: () => null,
  saveTransaction: () => {},
}));

const { registerTraceTools } = await import("../src/tools/trace.js");

type Args = { digest: string; direction?: string; hops?: number };
let handler: (a: Args) => Promise<{ content: { text: string }[] }>;
registerTraceTools({
  tool: (n: string, _d: string, _s: unknown, h: typeof handler) => {
    if (n === "trace_funds") handler = h;
  },
} as never);

const run = async (a: Args) => {
  const r = await handler(a);
  const texts = r.content.map((c) => c.text);
  const json = texts.find((t) => t.trim().startsWith("{"));
  return { summary: texts[0]!, data: json ? JSON.parse(json) : null };
};

const FROM = `0x8c4f${"1".repeat(58)}5ee8`;
const TO = `0xeda2${"2".repeat(58)}6c2b`;
const addrOwner = (a: string) => ({ __typename: "AddressOwner", address: { address: a } });
const st = (type: string, a: string) => ({
  asMoveObject: { contents: { type: { repr: type } } },
  owner: addrOwner(a),
});

/**
 * The real mainnet shape of an UpgradeCap handover: the sender pays gas, and
 * nothing else moves. Modelled on 3udm6oPAkpJ1wfDCAZ1vPbbVzkvsAqz8gAGeCy3k82xX.
 */
const capHandover = (type = "0x2::package::UpgradeCap") => ({
  transaction: {
    digest: "hop1",
    sender: { address: FROM },
    effects: {
      status: "SUCCESS",
      timestamp: "2025-01-10T10:25:31Z",
      checkpoint: { sequenceNumber: "1" },
      // Gas only — the sender's own negative change and nothing else.
      balanceChanges: { nodes: [{ coinType: { repr: "0x2::sui::SUI" }, amount: "-2100000", owner: { address: FROM } }] },
      objectChanges: {
        nodes: [
          { address: "0xcap", idCreated: false, idDeleted: false, inputState: st(type, FROM), outputState: st(type, TO) },
        ],
      },
    },
    kind: { commands: { nodes: [{ __typename: "TransferObjectsCommand" }] } },
  },
});

const noNext = (q: string) => String(q).includes("transactions(");

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockArchive.mockReset();
  mockArchive.mockResolvedValue(null);
});

describe("trace_funds — a capability handover is not 'gas only'", () => {
  beforeEach(() => {
    mockGqlQuery.mockImplementation((q: string) =>
      noNext(q) ? Promise.resolve({ transactions: { nodes: [] } }) : Promise.resolve(capHandover()),
    );
  });

  it("stops printing 'gas only' when an object changed hands", async () => {
    const { summary } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(summary).not.toMatch(/gas only/);
  });

  it("names the object, both parties, and what the holder can do", async () => {
    const { summary } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(summary).toMatch(/package::UpgradeCap/);
    expect(summary).toMatch(/publish new code/i);
    // The recipient was previously absent from the output entirely, which is
    // what made the trace a dead end rather than a lead.
    expect(summary).toMatch(/eda2/);
  });

  it("raises it to the trace level, not only the hop", async () => {
    const { summary, data } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(summary).toMatch(/Control of something changed hands/i);
    expect(data.object_flow.capability_transfers).toHaveLength(1);
    expect(data.hops[0].object_transfers).toHaveLength(1);
  });

  it("carries the object id so the claim can be checked", async () => {
    const { data } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(data.object_flow.capability_transfers[0].object_id).toBe("0xcap");
  });
});

describe("trace_funds — ordinary object transfers", () => {
  it("reports an NFT move without the authority language", async () => {
    mockGqlQuery.mockImplementation((q: string) =>
      noNext(q)
        ? Promise.resolve({ transactions: { nodes: [] } })
        : Promise.resolve(capHandover("0xabc::hero::Hero")),
    );
    const { summary, data } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(data.object_flow.transfers).toHaveLength(1);
    expect(data.object_flow.capability_transfers).toHaveLength(0);
    expect(summary).not.toMatch(/Control of something changed hands/i);
    expect(summary).toMatch(/hero::Hero/);
  });

  it("omits object_flow entirely when nothing changed hands", async () => {
    mockGqlQuery.mockImplementation((q: string) => {
      if (noNext(q)) return Promise.resolve({ transactions: { nodes: [] } });
      const tx = capHandover();
      tx.transaction.effects.objectChanges = { nodes: [] };
      return Promise.resolve(tx);
    });
    const { summary, data } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(data.object_flow).toBeUndefined();
    expect(data.hops[0].object_transfers).toBeUndefined();
    // No object section at all, and no unavailability caveat either: the
    // fullnode answered and reported that none moved.
    expect(summary).not.toMatch(/^Objects:/m);
    expect(data.hops[0].object_flow_unavailable).toBeUndefined();
  });
});

describe("trace_funds — the archive cannot see objects", () => {
  /**
   * "No objects moved" and "this transport cannot report object changes" are
   * opposite claims. An archive hop must make the second one.
   */
  it("says object flow is unavailable rather than reporting none", async () => {
    mockGqlQuery.mockImplementation((q: string) =>
      noNext(q) ? Promise.resolve({ transactions: { nodes: [] } }) : Promise.resolve({ transaction: null }),
    );
    mockArchive.mockResolvedValue({
      transaction: { sender: FROM, kind: { inputs: [], commands: [] } },
      effects: { status: { success: true } },
      balanceChanges: [],
      timestamp: "2025-01-10T10:25:31Z",
      checkpoint: "1",
    });
    const { summary, data } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(data.hops[0].object_flow_unavailable).toMatch(/archive/i);
    expect(data.hops[0].object_flow_unavailable).toMatch(/not a statement that none happened/i);
    expect(data.hops[0].object_transfers).toBeUndefined();
    expect(summary).not.toMatch(/gas only/);
  });
});
