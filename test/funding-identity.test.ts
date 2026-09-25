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
vi.mock("../src/utils/identity.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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

/** Shaped as `describeAddresses` returns it, provenance included. */
const identity = (address: string) => ({
  address,
  kind: "wallet" as const,
  ...(address === SUBJECT
    ? {
        name: "current.sui",
        names_held: [
          { name: "current.sui", expired: false, provenance: "registered_or_used", last_tx: "Dg1" },
          { name: "lapsed.sui", expired: true, provenance: "registered_or_used", last_tx: "Dg2" },
        ],
      }
    : {}),
});

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockDescribe.mockReset();
  mockGqlQuery.mockImplementation(async (q: string) =>
    // The funder's popularity probe reads its outgoing transactions: none here.
    String(q).includes("sentAddress")
      ? { transactions: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } } }
      : String(q).includes("transactions(")
        ? fundingPage
        : { transactions: { nodes: [] } },
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

  it("lists a name another address sent apart from the ones the holder used", async () => {
    // The Cetus attacker's taunt name: 0x407fb974 sent the registration to the
    // frozen wallet in 2uE2WRav, and the holder never touched it. Reporting it
    // as a name the address "was known by" attributes a stranger's message.
    const SENDER = "0x407fb97400abc8f37defc658ab9c9f53a8953a1a446cd820561382fb3728ca20";
    mockDescribe.mockImplementation(async (addrs: string[] = []) =>
      new Map(
        addrs.map((a) => [
          a,
          a === SUBJECT
            ? {
                address: a,
                kind: "wallet" as const,
                names_held: [
                  {
                    name: "give-the-funds-back-you-maniac-yngmi.sui",
                    expired: true,
                    provenance: "received_from_third_party",
                    last_tx: "2uE2WRavBRGLDwdvqNVmacytHdExqEmeoqdu4DgZzSCw",
                    last_tx_at: "2025-05-27T04:07:50.218Z",
                    received_from: SENDER,
                  },
                  { name: "own.sui", expired: true, provenance: "registered_or_used", last_tx: "Dg3" },
                ],
              }
            : { address: a, kind: "wallet" as const },
        ]),
      ),
    );
    const d = await run("find_funding_sources", { addresses: [SUBJECT], max_hops: 1, measure_fanout: false });
    expect(d.expired_suins_names).toEqual([{ address: SUBJECT, expired_names: ["own.sui"] }]);
    expect(d.received_suins_names).toEqual([
      {
        address: SUBJECT,
        name: "give-the-funds-back-you-maniac-yngmi.sui",
        expired: true,
        received_from: SENDER,
        received_in: "2uE2WRavBRGLDwdvqNVmacytHdExqEmeoqdu4DgZzSCw",
        received_at: "2025-05-27T04:07:50.218Z",
      },
    ]);
    expect(d.received_names_note).toContain("not attribution");
  });
});
