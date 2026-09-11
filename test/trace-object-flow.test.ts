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
const mockCache = vi.fn(() => null as unknown);
vi.mock("../src/utils/store.js", () => ({
  getCachedTransaction: () => mockCache(),
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
const BURN = `0x${"0".repeat(64)}`;
const KIOSK_A = `0xaaaa${"3".repeat(58)}0001`;
const KIOSK_B = `0xbbbb${"4".repeat(58)}0002`;
const objOwner = (a: string) => ({ __typename: "ObjectOwner", address: { address: a } });
const addrOwner = (a: string) => ({ __typename: "AddressOwner", address: { address: a } });
const st = (type: string, a: string) => ({
  asMoveObject: { contents: { type: { repr: type } } },
  owner: addrOwner(a),
});

/**
 * The real mainnet shape of an UpgradeCap handover: the sender pays gas, and
 * nothing else moves. Modelled on 3udm6oPAkpJ1wfDCAZ1vPbbVzkvsAqz8gAGeCy3k82xX.
 */
const capHandover = (
  type = "0x2::package::UpgradeCap",
  from: unknown = addrOwner(FROM),
  to: unknown = addrOwner(TO),
) => ({
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
          {
            address: "0xcap",
            idCreated: false,
            idDeleted: false,
            inputState: { asMoveObject: { contents: { type: { repr: type } } }, owner: from },
            outputState: { asMoveObject: { contents: { type: { repr: type } } }, owner: to },
          },
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
  mockCache.mockReset();
  mockCache.mockReturnValue(null);
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
    // The trace-level block counts transfers; the records themselves live on
    // the hop, so they are not serialised twice.
    expect(data.object_flow.transfer_count).toBe(1);
    expect(data.object_flow.transfers).toBeUndefined();
    expect(data.hops[0].object_transfers).toHaveLength(1);
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

describe("trace_funds — the archive DOES report object changes", () => {
  /**
   * An earlier version claimed the archive could not see object changes and
   * disclaimed object flow on every archive hop. Verified false against
   * mainnet: for a pruned digest the archive returns `changedObjects` with the
   * type and BOTH owners. This is that shape.
   */
  it("reads the capability transfer out of an archive hop", async () => {
    mockGqlQuery.mockImplementation((q: string) =>
      noNext(q) ? Promise.resolve({ transactions: { nodes: [] } }) : Promise.resolve({ transaction: null }),
    );
    mockArchive.mockResolvedValue({
      transaction: {
        sender: FROM,
        kind: { inputs: [], commands: [] },
        effects: {
          changedObjects: [
            {
              objectId: "0x00055d67",
              objectType: "0x2::package::UpgradeCap",
              inputState: 2,
              idOperation: 1,
              inputOwner: { kind: 1, address: FROM },
              outputOwner: { kind: 1, address: TO },
            },
          ],
        },
      },
      balanceChanges: [],
      timestamp: "2025-01-10T10:25:31Z",
      checkpoint: "1",
    });
    const { summary, data } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(data.hops[0].object_flow_unavailable).toBeUndefined();
    expect(data.hops[0].object_transfers).toHaveLength(1);
    expect(data.object_flow.capability_transfers).toHaveLength(1);
    expect(summary).toMatch(/Control of something changed hands/i);
    expect(summary).not.toMatch(/gas only/);
  });
});

describe("trace_funds — kiosk transfers are custody changes", () => {
  /**
   * Measured against four real mainnet wallets: requiring both ends to be
   * addresses missed 10 of 28 genuine transfers, every one of them kiosk.
   */
  it("reports a kiosk-to-kiosk NFT move instead of printing gas only", async () => {
    mockGqlQuery.mockImplementation((q: string) =>
      noNext(q)
        ? Promise.resolve({ transactions: { nodes: [] } })
        : Promise.resolve(capHandover("0xabc::hero::Hero", objOwner(KIOSK_A), objOwner(KIOSK_B))),
    );
    const { summary, data } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(data.hops[0].object_transfers).toHaveLength(1);
    expect(summary).not.toMatch(/gas only/);
    expect(summary).toMatch(/hero::Hero/);
  });
});

describe("trace_funds — renouncing is not a handover", () => {
  /** 27 of 30 real UpgradeCap departures go to an unspendable address. */
  it("does not warn that control changed hands", async () => {
    mockGqlQuery.mockImplementation((q: string) =>
      noNext(q)
        ? Promise.resolve({ transactions: { nodes: [] } })
        : Promise.resolve(capHandover("0x2::package::UpgradeCap", addrOwner(FROM), addrOwner(BURN))),
    );
    const { summary, data } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(data.object_flow.capability_transfers).toHaveLength(0);
    expect(data.object_flow.renounced_capabilities).toHaveLength(1);
    expect(summary).not.toMatch(/Control of something changed hands/i);
    expect(summary).toMatch(/renounced/i);
    expect(summary).toMatch(/reduction in risk/i);
  });
});

describe("trace_funds — object changes are paginated, not truncated", () => {
  /**
   * About 1 transaction in 400 exceeds a page, and a real three-hop mainnet
   * trace hit one with 101 changes. The connection is ordered by object id,
   * not importance, so silently keeping the first 50 drops a capability
   * transfer on a coin flip.
   */
  const pagedCap = (pages: number) => (q: string, v: Record<string, unknown> = {}) => {
    if (noNext(q)) return Promise.resolve({ transactions: { nodes: [] } });
    const page = Number(v.after ?? 0);
    const last = page >= pages - 1;
    // The capability sits on the LAST page, past the first-page cut.
    const nodes = last
      ? [
          {
            address: "0xcap",
            idCreated: false,
            idDeleted: false,
            inputState: st("0x2::package::UpgradeCap", FROM),
            outputState: st("0x2::package::UpgradeCap", TO),
          },
        ]
      : [];
    const conn = { pageInfo: { hasNextPage: !last, endCursor: last ? null : String(page + 1) }, nodes };
    if (v.after !== undefined) return Promise.resolve({ transaction: { effects: { objectChanges: conn } } });
    const tx = capHandover();
    tx.transaction.effects.objectChanges = conn as never;
    return Promise.resolve(tx);
  };

  it("follows the cursor and finds a capability past the first page", async () => {
    mockGqlQuery.mockImplementation(pagedCap(3));
    const { summary, data } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(data.hops[0].object_changes_truncated).toBeUndefined();
    expect(data.object_flow.capability_transfers).toHaveLength(1);
    expect(summary).toMatch(/Control of something changed hands/i);
  });

  it("states the cap when a transaction exceeds even the page bound", async () => {
    mockGqlQuery.mockImplementation(pagedCap(99));
    const { summary, data } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(data.hops[0].object_changes_truncated).toMatch(/pages of 50/);
    expect(data.object_flow.truncated).toBe(true);
    expect(summary).toMatch(/more object changes than were read/i);
  });

  it("stops on a null cursor rather than looping", async () => {
    mockGqlQuery.mockImplementation((q: string, v: Record<string, unknown> = {}) => {
      if (noNext(q)) return Promise.resolve({ transactions: { nodes: [] } });
      const conn = { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] };
      if (v.after !== undefined) return Promise.resolve({ transaction: { effects: { objectChanges: conn } } });
      const tx = capHandover();
      tx.transaction.effects.objectChanges = conn as never;
      return Promise.resolve(tx);
    });
    const { data } = await run({ digest: "hop1", direction: "forward", hops: 3 });
    expect(data.hops[0].object_changes_truncated).toMatch(/incomplete/);
  });
});

describe("trace_funds — a cached hop is not an archive hop", () => {
  /**
   * A row cached before object flow existed deserialises without the field.
   * Calling that "the archive cannot see objects" was wrong twice: the source
   * is known, and the archive can.
   */
  it("blames the cache, not the archive", async () => {
    mockCache.mockReturnValue({
      sender: FROM,
      balanceChanges: [],
      grpcBalanceChanges: [],
      commands: [],
      callSites: [],
      timestamp: "2025-01-10T10:25:31Z",
      checkpoint: 1,
    });
    mockGqlQuery.mockImplementation(() => Promise.resolve({ transactions: { nodes: [] } }));
    const { data } = await run({ digest: "hop1", direction: "forward", hops: 1 });
    expect(data.hops[0].object_flow_unavailable).toMatch(/local store/i);
    expect(data.hops[0].object_flow_unavailable).not.toMatch(/archive/i);
    expect(data.hops_from_cache).toBe(1);
  });
});
