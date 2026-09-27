import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkpointChain, gqlPage } from "./helpers/service-shapes.js";

/**
 * build_timeline's window. A time bound has to reach the query as checkpoints:
 * filtered afterwards, it applies to whatever the first page happened to hold,
 * which for an established address is its first transactions ever.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
/** A coin with no CoinMetadata answers NOT_FOUND over gRPC. */
const mockGetCoinInfo = vi.fn();
vi.mock("../src/clients/grpc.js", () => ({ sui: { stateService: { getCoinInfo: mockGetCoinInfo } }, archive: {} }));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));
vi.mock("../src/protocols/registry.js", () => ({
  prefetchProtocolNames: async () => {},
  lookupProtocol: () => null,
  lookupProtocolDisplay: () => null,
}));

const { registerTimelineTools } = await import("../src/tools/timeline.js");
const { resetLiveCoinScale } = await import("../src/utils/valuation.js");

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
  mockGetCoinInfo.mockReset();
  mockGetCoinInfo.mockRejectedValue(Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" }));
  resetLiveCoinScale();
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

  /**
   * The decode formats amounts after each coin's own decimals are read. KONG
   * (1 decimal, in no curated list) in a sale modelled on 5WEK9KPv… must
   * print as 745,279,357 KONG, not as 7.45279357 KONG at an assumed scale.
   */
  it("formats a coin no curated list knows at its on-chain decimals", async () => {
    const KONG = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG";
    mockGetCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => {
      if (coinType === KONG) return { response: { metadata: { decimals: 1, symbol: "KONG" } } };
      throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
    });
    const sale = {
      ...txAt("5WEK9KPvK1NmZ91ZrEhYbTdzyaEz2ipzLbbmRnZs5WEA", 999_990),
      effects: {
        ...txAt("x", 999_990).effects,
        balanceChanges: gqlPage([
          { coinType: { repr: KONG }, amount: "-7452793570", owner: { address: ADDR } },
          { coinType: { repr: KONG }, amount: "7452793570", owner: { address: `0x${"b".repeat(64)}` } },
        ]),
      },
    };
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => chain(q, v) ?? txPage([sale]));
    const { body } = await run({ addresses: [ADDR], per_address: 1 });
    const out = JSON.stringify(body);
    expect(out).toContain("745279357 KONG");
    expect(out).not.toContain("assumed scale");
  });
});

describe("build_timeline size", () => {
  it("lists the entries that fit in order, keeps a failed one past the budget, and counts the rest", async () => {
    const nodes = Array.from({ length: 200 }, (_, i) => txAt(`d${String(i).padStart(3, "0")}`, 500_001 + i));
    nodes[190].effects.status = "FAILURE";
    let served = 0;
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => {
      const cp = chain(q, v);
      if (cp) return cp;
      const page = nodes.slice(served, served + 50);
      served += page.length;
      return txPage(page, { next: served < nodes.length });
    });

    const { body } = await run({ addresses: [ADDR], from: "500000", per_address: 200, limit: 200 });
    const digests = body.timeline.map((e: { digest: string }) => e.digest);
    expect(body.entry_count).toBe(200);
    expect(digests[0]).toBe("d000");
    expect(digests).toContain("d190");
    expect(digests.length).toBeLessThan(200);
    expect(body.omitted.lists.timeline.count).toBe(200 - digests.length);
    expect(body.omitted.next_call).toEqual({ tool: "build_timeline", repeat_with: { detail: "full" } });

    served = 0;
    const full = await run({ addresses: [ADDR], from: "500000", per_address: 200, limit: 200, detail: "full" } as Args);
    expect(full.body.timeline).toHaveLength(200);
  });
});
