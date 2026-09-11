import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `get_top_holders` walks `objects(filter: Coin<T>)` in OBJECT-ID order, which
 * is uncorrelated with balance. A scan that stops early therefore returns the
 * largest holder it happened to see, not the largest holder.
 *
 * Measured on mainnet SUI, the reported "#1 holder" by scan depth: 66 SUI at
 * max_scan 200, 522 at 400, 3,454 at 800, 25,000 at 5,000 — with zero of the
 * top five surviving from 200 to 800. The real top holder holds millions. That
 * is not an approximate ranking, it is an artefact of how far the loop ran.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({
  sui: { stateService: { getCoinInfo: async () => ({ response: { treasury: { totalSupply: "1000000" } } }) } },
  archive: {},
}));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));

const { registerHolderTools } = await import("../src/tools/holders.js");

type Args = { type?: string; mode?: string; limit?: number; max_scan?: number };
let handler: (a: Args) => Promise<{ content: { text: string }[] }>;
registerHolderTools({
  tool: (n: string, _d: string, _s: unknown, h: typeof handler) => {
    if (n === "get_top_holders") handler = h;
  },
} as never);
const run = async (a: Args) => JSON.parse((await handler(a)).content[0].text);

const coin = (owner: string, balance: string) => ({
  owner: { address: { address: owner } },
  asMoveObject: { contents: { json: { balance } } },
});
const A = `0xaa${"1".repeat(62)}`;
const B = `0xbb${"2".repeat(62)}`;

beforeEach(() => mockGqlQuery.mockReset());

describe("a complete scan is a ranking", () => {
  it("ranks and reports percentages when the walk reached the end", async () => {
    mockGqlQuery.mockResolvedValue({
      objects: { nodes: [coin(A, "300"), coin(B, "100")], pageInfo: { hasNextPage: false } },
    });
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 1000 });
    expect(r.complete_ranking).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.top_holders[0]).toMatchObject({ rank: 1, address: A, balance: "300" });
    expect(r.top_holders[0].percentage).toBeTruthy();
    expect(r.caveat).toBeUndefined();
    expect(r.sampled_holders).toBeUndefined();
  });
});

describe("a truncated scan is a SAMPLE, not a ranking", () => {
  /** Enough pages that the max_scan bound is hit before the data runs out. */
  const endless = () => {
    let n = 0;
    return () =>
      Promise.resolve({
        objects: {
          nodes: [coin(A, String(++n)), coin(B, "1")],
          pageInfo: { hasNextPage: true, endCursor: `c${n}` },
        },
      });
  };

  it("does not call them top_holders, and assigns no rank", async () => {
    mockGqlQuery.mockImplementation(endless());
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 10 });
    expect(r.truncated).toBe(true);
    expect(r.complete_ranking).toBe(false);
    expect(r.top_holders).toBeUndefined();
    expect(r.sampled_holders.length).toBeGreaterThan(0);
    expect(r.sampled_holders[0].rank).toBeUndefined();
  });

  /**
   * A sampled balance over the REAL total supply looks authoritative and means
   * nothing, so the field is dropped rather than shown with a caveat.
   */
  it("drops the percentage of supply", async () => {
    mockGqlQuery.mockImplementation(endless());
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 10 });
    expect(r.sampled_holders[0].percentage).toBeUndefined();
  });

  it("says outright that these are not the largest holders", async () => {
    mockGqlQuery.mockImplementation(endless());
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 10 });
    expect(r.caveat).toMatch(/INCOMPLETE/);
    expect(r.caveat).toMatch(/not the largest holders/i);
    expect(r.caveat).toMatch(/object-id order/i);
  });
});

describe("the cursor guard #101 missed", () => {
  /**
   * `hasNextPage: true` with a null `endCursor` set `cursor` to undefined, so
   * the next request started from page ONE and the same coin objects were
   * counted again — adding their balances a second time to the same holders.
   * Ten other paginated walks in this repo carry the guard; these two did not.
   */
  it("stops instead of restarting and double-counting balances", async () => {
    let calls = 0;
    mockGqlQuery.mockImplementation(() => {
      calls++;
      return Promise.resolve({
        objects: {
          nodes: [coin(A, "100")],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      });
    });
    // Distinct max_scan: the tool caches on (mode, type, max_scan, limit), so
    // reusing an earlier test's arguments would serve a cached result and the
    // walk would never run.
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 1234 });
    expect(calls).toBe(1);
    // 100, not 100 x however many times the loop restarted.
    expect(r.sampled_holders?.[0]?.balance ?? r.top_holders?.[0]?.balance).toBe("100");
  });

  it("applies the same guard to the NFT walk", async () => {
    let calls = 0;
    mockGqlQuery.mockImplementation(() => {
      calls++;
      return Promise.resolve({
        objects: {
          nodes: [{ owner: { address: { address: A } } }],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      });
    });
    const r = await run({ type: "0xabc::hero::Hero", mode: "nft", limit: 5, max_scan: 4321 });
    expect(calls).toBe(1);
    expect((r.sampled_holders ?? r.top_holders)[0].count).toBe(1);
  });
});
