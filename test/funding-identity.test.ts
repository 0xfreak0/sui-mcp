import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression: identity enrichment was fetched and then dropped on the way out.
 *
 * `describeAddresses` returned ten held names, six expired, and the funding
 * tool's own output carried none of them — because the response object was
 * built from an explicit field list that never mentioned them. The unit tests
 * passed throughout, because they exercised the resolver rather than the tool.
 * These assert on what a caller actually receives.
 */

const mockGqlQuery = vi.fn();
const mockDescribe = vi.fn();

vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/price-providers.js", () => ({ pricesForRanking: async () => new Map() }));
vi.mock("../src/utils/fanout.js", () => ({ measureFanout: async () => null, classifyFanout: () => ({}) }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false }));
vi.mock("../src/utils/identity.js", () => ({
  describeAddresses: async (a: string[]) => mockDescribe(a),
  identityNote: () => undefined,
}));

const { registerFundingTools } = await import("../src/tools/funding.js");
const tools = new Map<string, Function>();
registerFundingTools({ tool: (n: string, _d: string, _s: unknown, h: Function) => tools.set(n, h) } as never);

const SUBJECT = "0xsubject";
const FUNDER = "0xfunder";
const ONE_SUI = "1000000000";

/** One inflow that clears the dust floor, so a funder is actually chosen. */
const fundingPage = {
  transactions: {
    nodes: [
      {
        digest: "0xd1",
        sender: { address: FUNDER },
        effects: {
          timestamp: "2026-01-01T00:00:00.000Z",
          checkpoint: { sequenceNumber: 1 },
          balanceChanges: {
            nodes: [
              { owner: { address: FUNDER }, amount: `-${ONE_SUI}`, coinType: { repr: "0x2::sui::SUI" } },
              { owner: { address: SUBJECT }, amount: ONE_SUI, coinType: { repr: "0x2::sui::SUI" } },
            ],
          },
        },
      },
    ],
  },
};

const identity = (address: string) => ({
  address,
  kind: "wallet" as const,
  ...(address === SUBJECT
    ? {
        name: "current.sui",
        names_held: [
          { name: "current.sui", expired: false },
          { name: "lapsed.sui", expired: true },
        ],
      }
    : {}),
});

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockDescribe.mockReset();
  mockGqlQuery.mockImplementation(async (q: string) =>
    String(q).includes("transactions(") ? fundingPage : { transactions: { nodes: [] } },
  );
  mockDescribe.mockImplementation(async (addrs: string[] = []) => new Map(addrs.map((a) => [a, identity(a)])));
});

const run = async (name: string, args: Record<string, unknown>) =>
  JSON.parse((await tools.get(name)!(args)).content.at(-1).text);

describe("find_funding_source surfaces identity, not just fetches it", () => {
  it("carries names_held into the chain entry the caller reads", async () => {
    const d = await run("find_funding_source", { address: SUBJECT, max_hops: 1, measure_fanout: false });
    const held = d.chain[0].address_label.names_held;
    expect(held).toBeDefined();
    expect(held.map((h: { name: string }) => h.name)).toEqual(["current.sui", "lapsed.sui"]);
    expect(held.find((h: { name: string }) => h.name === "lapsed.sui").expired).toBe(true);
  });

  it("accepts max_hops as a string, the way a model often sends it", async () => {
    const d = await run("find_funding_source", { address: SUBJECT, max_hops: "1", measure_fanout: false });
    expect(d.chain).toHaveLength(1);
  });
});

describe("find_funding_sources reports expired names for the batch", () => {
  it("lists addresses whose names no longer resolve", async () => {
    const d = await run("find_funding_sources", { addresses: [SUBJECT], max_hops: 1, measure_fanout: false });
    expect(d.expired_suins_names).toBeDefined();
    expect(d.expired_suins_names[0]).toMatchObject({
      address: SUBJECT,
      current_name: "current.sui",
      expired_names: ["lapsed.sui"],
    });
    expect(d.expired_names_note).toContain("EXPIRED");
  });

  it("says nothing when no name has lapsed", async () => {
    mockDescribe.mockImplementation(async (addrs: string[] = []) =>
      new Map(addrs.map((a) => [a, { address: a, kind: "wallet" as const }])),
    );
    const d = await run("find_funding_sources", { addresses: [SUBJECT], max_hops: 1, measure_fanout: false });
    expect(d.expired_suins_names).toBeUndefined();
  });
});
