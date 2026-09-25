import { describe, it, expect, vi } from "vitest";
import { createMockGraphql } from "../helpers/mock-grpc.js";

const mockGqlQuery = createMockGraphql();
vi.mock("../../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { registerAggregateTools } = await import("../../src/tools/aggregate.js");

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
  // A path nothing carries summed to 0 for every group, and the ranking of
  // zeros came back as a measured one.
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
