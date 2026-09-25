import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkpointChain, gqlPage } from "./helpers/service-shapes.js";

/**
 * build_timeline's window. A time bound has to reach the query as checkpoints:
 * filtered afterwards, it applies to whatever the first page happened to hold,
 * which for an established address is its first transactions ever.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
vi.mock("../src/protocols/registry.js", () => ({
  prefetchProtocolNames: async () => {},
  lookupProtocol: () => null,
  lookupProtocolDisplay: () => null,
}));

const { registerTimelineTools } = await import("../src/tools/timeline.js");

type Args = {
  addresses: string[];
  from?: string;
  to?: string;
  limit?: number;
  per_address?: number;
  activity_hours?: boolean;
};
let handler: (a: Args) => Promise<{ isError?: boolean; content: { text: string }[] }>;
registerTimelineTools({
  tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
    handler = h;
  },
} as never);

const run = async (a: Args) => {
  const r = await handler(a);
  return { isError: r.isError, body: JSON.parse(r.content[0].text) };
};

const ADDR = `0x${"a".repeat(64)}`;
/** Checkpoint `seq` is stamped at T0 + 250ms·seq. */
const T0 = Date.parse("2025-01-01T00:00:00Z");
const msAt = (seq: number) => T0 + seq * 250;
const chain = checkpointChain(1_000_000, msAt);

const txAt = (digest: string, seq: number) => ({
  digest,
  sender: { address: ADDR },
  effects: {
    status: "SUCCESS",
    timestamp: new Date(msAt(seq)).toISOString(),
    checkpoint: { sequenceNumber: seq },
    balanceChanges: gqlPage([]),
  },
  kind: { commands: gqlPage([]) },
});

const txPage = (nodes: unknown[], more: { next?: boolean; prev?: boolean } = {}) => ({
  transactions: {
    nodes,
    pageInfo: { hasNextPage: more.next ?? false, endCursor: "end", hasPreviousPage: more.prev ?? false, startCursor: "start" },
  },
});

const txCalls = () => mockGqlQuery.mock.calls.filter(([q]) => String(q).includes("transactions("));

beforeEach(() => {
  mockGqlQuery.mockReset();
});

describe("build_timeline window", () => {
  it("puts an ISO window into the query as the checkpoints stamped inside it", async () => {
    // 100ms past checkpoint 400,000's stamp: the window starts at 400,001.
    const from = new Date(msAt(400_000) + 100).toISOString();
    // 100ms past checkpoint 400,100: the window ends at it, so 400,101 is the first outside.
    const to = new Date(msAt(400_100) + 100).toISOString();
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) =>
      chain(q, v) ?? txPage([txAt("inside", 400_050)]),
    );

    const { body } = await run({ addresses: [ADDR], from, to });

    const vars = txCalls()[0][1];
    expect(vars.afterCp).toBe(400_000);
    expect(vars.beforeCp).toBe(400_101);
    expect(body.window).toMatchObject({ after_checkpoint: 400_000, before_checkpoint: 400_101 });
    expect(body.timeline.map((e: { digest: string }) => e.digest)).toEqual(["inside"]);
  });

  it("rejects a bound that is neither a time nor a checkpoint", async () => {
    const r = await run({ addresses: [ADDR], from: "yesterday" });
    expect(r.isError).toBe(true);
    expect(r.body.error).toMatch(/Could not parse 'yesterday'/);
    expect(txCalls()).toHaveLength(0);
  });

  it("reads the most recent transactions when no start is given", async () => {
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) =>
      chain(q, v) ?? txPage([txAt("a", 999_990), txAt("b", 999_995)]),
    );
    const { body } = await run({ addresses: [ADDR], per_address: 2 });
    const vars = txCalls()[0][1];
    expect(vars.last).toBe(2);
    expect(vars.first).toBeUndefined();
    expect(body.read_from).toBe("latest, backward");
  });

  it("reports an address whose walk per_address cut short, and where to continue", async () => {
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) =>
      chain(q, v) ?? txPage([txAt("a", 500_001), txAt("b", 500_007)], { next: true }),
    );
    const { body } = await run({ addresses: [ADDR], from: "500000", per_address: 2 });
    expect(body.coverage[0]).toMatchObject({
      address: ADDR,
      fetched: 2,
      truncated: true,
      reached_checkpoint: 500_007,
      continue_with: { from: "500006" },
    });
    expect(body.coverage_note).toMatch(/After checkpoint 500007/);
  });

  it("measures activity hours over the window, not over the address's first transactions", async () => {
    // Without a checkpoint bound the service returns the address's genesis-era
    // transactions; with one, the window's.
    const genesis = Array.from({ length: 30 }, (_, i) => txAt(`old${i}`, 10 + i * 1000));
    const inWindow = Array.from({ length: 4 }, (_, i) => txAt(`new${i}`, 400_010 + i));
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) =>
      chain(q, v) ?? (v.afterCp != null ? txPage(inWindow) : txPage(genesis)),
    );
    const { body } = await run({
      addresses: [ADDR],
      from: new Date(msAt(400_000) + 100).toISOString(),
      to: new Date(msAt(400_100) + 100).toISOString(),
      activity_hours: true,
    });
    expect(body.activity_hours[0].sample_size).toBe(4);
    expect(body.entry_count).toBe(4);
  });
});
