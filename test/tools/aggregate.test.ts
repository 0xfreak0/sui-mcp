import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockGraphql } from "../helpers/mock-grpc.js";

const mockGqlQuery = createMockGraphql();
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerAggregateTools } = await import("../../src/tools/aggregate.js");
const { RELOCATE_EVENT_MODULE_CHECKPOINT } = await import("../../src/utils/package-versions.js");

type Result = { isError?: boolean; content: { text: string }[] };
const tools = new Map<string, (a: Record<string, unknown>) => Promise<Result>>();
registerAggregateTools({
  tool: (n: string, _d: string, _s: unknown, h: (a: Record<string, unknown>) => Promise<Result>) => tools.set(n, h),
} as never);

const SENDER = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
const TYPE = "0xabc::pool::SwapEvent";

/** One page of events, shaped as the GraphQL `events` connection returns them. */
const page = {
  events: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [1, 2].map((i) => ({
      sender: { address: SENDER },
      transaction: { digest: `D${i}` },
      contents: { type: { repr: TYPE }, json: { amount_in: String(i * 100), pool: "0xp" } },
    })),
  },
};

describe("aggregate_events with a value_field no event carries", () => {
  // A path nothing carries sums to 0 for every group, and a ranking of zeros
  // would read as a measured one.
  it("is an error that lists the numeric fields the events do carry", async () => {
    mockGqlQuery.mockResolvedValue(page);
    const r = await tools.get("aggregate_events")!({ sender: SENDER, max_events: 50, value_field: "no_such_field" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toBe(
      'value_field "no_such_field" is not a number in any of the 2 events scanned. Numeric fields they carry: amount_in.',
    );
  });

  it("still sums a field the events carry", async () => {
    mockGqlQuery.mockResolvedValue(page);
    const r = await tools.get("aggregate_events")!({ sender: SENDER, max_events: 50, value_field: "amount_in" });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text).groups[0].value_sum).toBe(300);
  });
});

describe("aggregate_events module filter resolution", () => {
  beforeEach(() => mockGqlQuery.mockReset());

  const V1 = `0x${"1".repeat(64)}`;
  const V9 = `0x${"9".repeat(64)}`;
  const CUT = RELOCATE_EVENT_MODULE_CHECKPOINT.mainnet;

  /**
   * Turbos v9's `swap_router` is a pure router module with no event structs
   * of its own. Before the relocate_event_module cutover (mainnet checkpoint
   * 69,982,635, 2024-10-17) Sui anchored a module's runtime identity to the
   * package's original id for the life of the lineage, so over a pre-cutover
   * window a filter written with v9's id matches nothing and is rewritten to
   * v1.
   */
  it("rewrites a module filter to the package's original id for a window entirely before the cutover", async () => {
    mockGqlQuery.mockImplementation(async (q?: string) =>
      q?.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { events: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
    );

    const r = await tools.get("aggregate_events")!({ module: `${V9}::swap_router`, from: CUT - 2000, to: CUT - 1000, max_events: 50 });
    const data = JSON.parse(r.content[0].text);

    expect(data.module_scope?.queried).toBe(`${V1}::swap_router`);
    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events(filter"))!;
    expect((eventsCall[1] as { filter: { module: string } }).filter.module).toBe(`${V1}::swap_router`);
  });

  it("queries the requested id unrewritten for a window entirely at or after the cutover", async () => {
    mockGqlQuery.mockImplementation(async (q?: string) =>
      q?.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { events: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
    );

    const r = await tools.get("aggregate_events")!({ module: `${V9}::swap_router`, from: CUT + 1000, to: CUT + 2000, max_events: 50 });
    const data = JSON.parse(r.content[0].text);

    expect(data.module_scope?.queried).toBe(`${V9}::swap_router`);
    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events(filter"))!;
    expect((eventsCall[1] as { filter: { module: string } }).filter.module).toBe(`${V9}::swap_router`);
  });

  /**
   * A window spanning the cutover scans both ids and merges the counts: a
   * scan of the original id alone would miss every post-cutover event.
   */
  it("scans both segments and merges their counts when the window spans the cutover", async () => {
    mockGqlQuery.mockImplementation(async (q?: string, v?: Record<string, unknown>) => {
      if (q?.includes("packageVersions")) {
        return { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      const filter = (v as { filter?: { module: string } } | undefined)?.filter;
      if (filter?.module === `${V9}::swap_router`) {
        return {
          events: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ sender: { address: "0xseller" }, transaction: { digest: "PostTx" }, contents: { type: { repr: TYPE }, json: {} } }],
          },
        };
      }
      return {
        events: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { sender: { address: "0xa" }, transaction: { digest: "PreTx1" }, contents: { type: { repr: TYPE }, json: {} } },
            { sender: { address: "0xb" }, transaction: { digest: "PreTx2" }, contents: { type: { repr: TYPE }, json: {} } },
          ],
        },
      };
    });

    const r = await tools.get("aggregate_events")!({ module: `${V9}::swap_router`, from: CUT - 2000, to: CUT + 1000, max_events: 50 });
    const data = JSON.parse(r.content[0].text);

    expect(data.module_scope?.note).toMatch(/spans the cutover/);
    expect(data.events_scanned).toBe(3);
    expect(data.truncated).toBe(false);
    const eventsCalls = mockGqlQuery.mock.calls.filter(([q]) => String(q).includes("events(filter"));
    expect(eventsCalls).toHaveLength(2);
  });

  it("reports no module_scope for a framework package upgraded in place", async () => {
    const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
    mockGqlQuery.mockImplementation(async (q?: string) =>
      q?.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: P2, version: 1 }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { events: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
    );

    const r = await tools.get("aggregate_events")!({ module: `${P2}::kiosk`, max_events: 50 });
    const data = JSON.parse(r.content[0].text);

    expect(data.module_scope).toBeUndefined();
    const eventsCall = mockGqlQuery.mock.calls.find(([q]) => String(q).includes("events(filter"))!;
    expect((eventsCall[1] as { filter: { module: string } }).filter.module).toBe(`${P2}::kiosk`);
  });

  /**
   * A module queried at its original id after the cutover, when no call goes
   * through that version: the empty ranking names the other version ids in
   * module_scope, and its hint does not mention event_type, which was not
   * set.
   */
  it("names the other versions for an empty original-id scan after the cutover", async () => {
    mockGqlQuery.mockImplementation(async (q?: string) =>
      q?.includes("packageVersions")
        ? { packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { events: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
    );

    const r = await tools.get("aggregate_events")!({ module: `${V1}::swap_router`, from: CUT + 1000, to: CUT + 2000, max_events: 50 });
    const data = JSON.parse(r.content[0].text);

    expect(data.module_scope?.other_version_ids).toEqual([V9]);
    expect(data.no_results_hint).toMatch(/module_scope\.other_version_ids/);
    expect(data.no_results_hint).not.toMatch(/event_type/);
  });
});

describe("aggregate_events bounded event slices", () => {
  beforeEach(() => { mockGqlQuery.mockReset(); });

  const event = (amount: number) => ({
    sender: { address: "0x1" },
    transaction: { digest: `tx${amount}` },
    contents: { type: { repr: "0x2::test::Event" }, json: { amount } },
  });
  const result = async (args: Record<string, unknown>) => {
    const response = await tools.get("aggregate_events")!(args);
    expect(response.isError).toBeUndefined();
    return JSON.parse(response.content[0].text);
  };

  it("stops short and empty reads independently of event count, then resumes disjoint counts and sums", async () => {
    mockGqlQuery.mockImplementation(async (_q, vars) => {
      const n = Number(vars?.after ?? 0);
      const nodes = n === 0 ? [event(100)] : n === 2 ? [event(200)] : n === 3 ? [event(300)] : [];
      return { events: { nodes, pageInfo: { hasNextPage: n < 3, endCursor: String(n + 1) } } };
    });
    const args = { sender: "0x1", value_field: "amount", max_events: 50, max_reads: 3 };
    const first = await result(args);
    expect(first.events_scanned).toBe(2);
    expect(first.groups[0]).toMatchObject({ key: "0x1", event_count: 2, value_sum: 300 });
    expect(first.truncated).toBe(true);
    expect(first.has_next_page).toBe(true);
    expect(first.scan.stop_reason).toBe("read_budget");
    expect(first.scan.reads).toBe(3);
    expect(first.scan.next_call.tool).toBe("aggregate_events");
    const second = await result({ ...args, ...first.scan.next_call.repeat_with });
    expect(second.groups[0]).toMatchObject({ key: "0x1", event_count: 1, value_sum: 300 });
    expect(second.has_next_page).toBe(false);
    expect(second.truncated).toBe(true);
    expect(second.scan.stop_reason).toBe("exhausted");
    expect(second.scan.start_cursor).toBe(first.next_cursor);
  });

  it("bounds empty reads without declaring an empty window", async () => {
    mockGqlQuery.mockImplementation(async (_q, vars) => {
      const n = Number(vars?.after ?? 0);
      return { events: { nodes: [], pageInfo: { hasNextPage: n < 4, endCursor: String(n + 1) } } };
    });
    const first = await result({ sender: "0x1", max_reads: 2 });
    expect(first.events_scanned).toBe(0);
    expect(first.truncated).toBe(true);
    expect(first.has_next_page).toBe(true);
    expect(first.scan.stop_reason).toBe("read_budget");
    expect(mockGqlQuery).toHaveBeenCalledTimes(2);
    expect(first.next_cursor).toBe("0|2");
  });

  it("shares the read cap across cutover segments and resumes in the unfinished segment", async () => {
    const original = `0x${"a".repeat(64)}`;
    const upgraded = `0x${"b".repeat(64)}`;
    const cut = RELOCATE_EVENT_MODULE_CHECKPOINT.mainnet;
    mockGqlQuery.mockImplementation(async (q, vars) => {
      if (q?.includes("packageVersions")) {
        return { packageVersions: { nodes: [{ address: original, version: 1 }, { address: upgraded, version: 2 }], pageInfo: { hasNextPage: false } } };
      }
      const filter = vars?.filter as { module: string };
      const before = filter.module.startsWith(original);
      const n = Number(vars?.after ?? 0);
      return { events: { nodes: n ? [event(before ? 10 : 20)] : [], pageInfo: { hasNextPage: n === 0, endCursor: String(n + 1) } } };
    });
    const args = { module: `${upgraded}::test`, from: cut - 100, to: cut + 100, max_reads: 3, value_field: "amount" };
    const first = await result(args);
    expect(first.events_scanned).toBe(1);
    expect(first.scan.stop_reason).toBe("read_budget");
    expect(first.scan.reads).toBe(3);
    expect(first.next_cursor).toBe("1|1");
    const second = await result({ ...args, ...first.scan.next_call.repeat_with });
    expect(second.events_scanned).toBe(1);
    expect(second.groups[0].value_sum).toBe(20);
    expect(second.has_next_page).toBe(false);
    expect(second.scan.reads).toBe(1);
  });

  it("distinguishes an event-budget stop at a segment boundary and continues in the next segment", async () => {
    const original = `0x${"c".repeat(64)}`;
    const upgraded = `0x${"d".repeat(64)}`;
    const cut = RELOCATE_EVENT_MODULE_CHECKPOINT.mainnet;
    mockGqlQuery.mockImplementation(async (q, vars) => {
      if (q?.includes("packageVersions")) {
        return { packageVersions: { nodes: [{ address: original, version: 1 }, { address: upgraded, version: 2 }], pageInfo: { hasNextPage: false } } };
      }
      const filter = vars?.filter as { module: string };
      const before = filter.module.startsWith(original);
      return { events: { nodes: before ? Array.from({ length: 50 }, (_, i) => event(i)) : [event(100)], pageInfo: { hasNextPage: false, endCursor: "end" } } };
    });
    const args = { module: `${upgraded}::test`, from: cut - 100, to: cut + 100, max_reads: 5, max_events: 50 };
    const first = await result(args);
    expect(first.events_scanned).toBe(50);
    expect(first.scan.stop_reason).toBe("event_budget");
    expect(first.next_cursor).toBe("1|");
    const second = await result({ ...args, ...first.scan.next_call.repeat_with });
    expect(second.events_scanned).toBe(1);
    expect(second.has_next_page).toBe(false);
  });

  it("marks a top-N slice's omitted groups so its rows cannot be treated as an additive total", async () => {
    mockGqlQuery.mockResolvedValue({
      events: {
        nodes: [event(100), { ...event(200), contents: { type: { repr: "0x2::test::Other" }, json: { amount: 200 } } }],
        pageInfo: { hasNextPage: true, endCursor: "next" },
      },
    });
    const page = await result({ sender: "0x1", group_by: "event_type", max_reads: 1, top: 1, value_field: "amount" });
    expect(page.groups).toEqual([{ key: "0x2::test::Other", event_count: 1, value_sum: 200, missing_value_count: 0 }]);
    expect(page.distinct_keys).toBe(2);
    expect(page.scan.groups_complete).toBe(false);
  });
});

describe("aggregate_events default read bound", () => {
  it("stops empty reads even when max_reads was not supplied", async () => {
    mockGqlQuery.mockReset();
    mockGqlQuery.mockImplementation(async (_q, vars) => {
      const n = Number(vars?.after ?? 0);
      return { events: { nodes: [], pageInfo: { hasNextPage: n < 201, endCursor: String(n + 1) } } };
    });
    const response = await tools.get("aggregate_events")!({ sender: "0x1" });
    const result = JSON.parse(response.content[0].text);
    expect(result.truncated).toBe(true);
    expect(result.scan.stop_reason).toBe("read_budget");
    expect(result.scan.reads).toBe(200);
    expect(result.next_cursor).toBe("0|200");
  });
});
