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
    // A distinct depth, so this exercises the walk rather than the cache entry
    // the test above just wrote. The key is network:mode:type:maxScan:topN.
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 11 });
    expect(r.sampled_holders[0].percentage).toBeUndefined();
  });

  it("says outright that these are not the largest holders", async () => {
    mockGqlQuery.mockImplementation(endless());
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 12 });
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

/**
 * A null `endCursor` beside `hasNextPage: true` is a real service shape this
 * repo already guards against restarting on. Breaking out of the walk without
 * marking it truncated published a known-incomplete scan as a complete ranking,
 * with ranks and percentages of supply restored and the caveat gone.
 */
describe("a walk stopped by a null cursor is truncated, not complete", () => {
  it("token mode reports a sample when the connection claims more and gives no cursor", async () => {
    mockGqlQuery.mockResolvedValue({
      objects: {
        nodes: [coin(A, "300"), coin(B, "100")],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    });
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 998 });
    expect(r.truncated).toBe(true);
    expect(r.complete_ranking).toBe(false);
    expect(r.top_holders).toBeUndefined();
    expect(r.sampled_holders[0].rank).toBeUndefined();
    expect(r.sampled_holders[0].percentage).toBeUndefined();
  });

  it("nft mode does the same", async () => {
    mockGqlQuery.mockResolvedValue({
      objects: {
        nodes: [{ owner: { address: { address: A } } }],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    });
    const r = await run({ type: "0xc2::art::NullCur", mode: "nft", limit: 5, max_scan: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.complete_ranking).toBe(false);
    expect(r.top_holders).toBeUndefined();
  });
});

/** "Nothing of this type exists" and "this type has no holders" are opposites. */
describe("an empty walk is not a complete ranking of zero holders", () => {
  it("token mode says it found nothing rather than ranking nobody", async () => {
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [], pageInfo: { hasNextPage: false } } });
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 999 });
    expect(r.complete_ranking).toBe(false);
    expect(r.caveat).toMatch(/not evidence that the coin has no holders/);
  });

  it("nft mode does the same", async () => {
    mockGqlQuery.mockResolvedValue({ objects: { nodes: [], pageInfo: { hasNextPage: false } } });
    const r = await run({ type: "0xc4::art::Empty", mode: "nft", limit: 5, max_scan: 1000 });
    expect(r.complete_ranking).toBe(false);
    expect(r.caveat).toMatch(/No objects of type/);
  });
});

/**
 * `max_scan ?? DEFAULT` keeps a provided 0, so the walk condition was false from
 * the start: no request was made and the empty result was reported as a
 * complete ranking. A negative `limit` reached `slice(0, topN)` and dropped the
 * last holders from the list.
 */
describe("out-of-range arguments are clamped, not obeyed", () => {
  it("max_scan: 0 still scans", async () => {
    mockGqlQuery.mockResolvedValue({
      objects: { nodes: [coin(A, "300")], pageInfo: { hasNextPage: false } },
    });
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 0 });
    expect(mockGqlQuery).toHaveBeenCalled();
    expect(r.total_scanned).toBe(1);
  });

  it("limit: -1 does not silently drop the last holder", async () => {
    mockGqlQuery.mockResolvedValue({
      objects: { nodes: [coin(A, "300"), coin(B, "100")], pageInfo: { hasNextPage: false } },
    });
    const r = await run({ type: "0x2::sui::SUI", limit: -1, max_scan: 997 });
    expect(r.top_holders.length).toBe(1);
    expect(r.top_holders[0].address).toBe(A);
  });
});

/**
 * A kiosk's `owner` field is written by `set_owner` and is NOT updated when the
 * `KioskOwnerCap` is transferred. Measured over 300 mainnet kiosks it disagreed
 * with the real cap holder 40% of the time, and the disagreement concentrates:
 * one address was declared by 82 kiosks, which is enough to invent a top holder.
 */
describe("kiosk-held NFTs are marked as a weaker kind of answer", () => {
  /** owner -> dynamic field -> kiosk object, which declares `owner`. */
  const kioskNft = (declared: string, kioskId = "0xkiosk1") => ({
    owner: {
      address: {
        asObject: {
          owner: {
            address: {
              address: kioskId,
              asObject: { asMoveObject: { contents: { json: { owner: declared } } } },
            },
          },
        },
      },
    },
  });
  /** The same shape with the kiosk id missing from the response. */
  const kioskNftNoId = (declared: string) => ({
    owner: {
      address: {
        asObject: {
          owner: {
            address: {
              asObject: { asMoveObject: { contents: { json: { owner: declared } } } },
            },
          },
        },
      },
    },
  });
  const plainNft = (owner: string) => ({ owner: { address: { address: owner } } });

  it("tags a kiosk-declared holder and counts how many came that way", async () => {
    mockGqlQuery.mockResolvedValue({
      objects: {
        nodes: [kioskNft(A), kioskNft(A), plainNft(B)],
        pageInfo: { hasNextPage: false },
      },
    });
    const r = await run({ type: "0xk1::art::Piece", mode: "nft", limit: 5, max_scan: 500 });
    const top = r.top_holders.find((h: { address: string }) => h.address === A);
    expect(top.holder_kind).toBe("kiosk_declared");
    expect(top.from_kiosk_owner_field).toBe(2);
    expect(r.kiosk_attributed).toBe(2);
    expect(r.kiosk_caveat).toMatch(/KioskOwnerCap/);
  });

  it("leaves an ordinary address holder unmarked", async () => {
    mockGqlQuery.mockResolvedValue({
      objects: { nodes: [plainNft(B)], pageInfo: { hasNextPage: false } },
    });
    const r = await run({ type: "0xk2::art::Piece", mode: "nft", limit: 5, max_scan: 500 });
    expect(r.top_holders[0].holder_kind).toBe("wallet");
    expect(r.top_holders[0].from_kiosk_owner_field).toBeUndefined();
    expect(r.kiosk_caveat).toBeUndefined();
  });

  /**
   * A kiosk id that did not come back must not cost the holder its marker.
   * Dropping it because resolution is impossible would turn the weakest answer
   * this tool gives into an unqualified one.
   */
  it("still marks a kiosk holder when the kiosk id is missing", async () => {
    mockGqlQuery.mockResolvedValue({
      objects: { nodes: [kioskNftNoId(A)], pageInfo: { hasNextPage: false } },
    });
    const r = await run({ type: "0xk4::art::Piece", mode: "nft", limit: 5, max_scan: 500 });
    expect(r.top_holders[0].holder_kind).toBe("kiosk_declared");
    expect(r.kiosk_attributed).toBe(1);
  });

  /** The json blob is untyped, so a non-string would become a Map key. */
  it("treats a non-string owner field as unresolvable", async () => {
    mockGqlQuery.mockResolvedValue({
      objects: {
        nodes: [kioskNft({ nested: true } as unknown as string)],
        pageInfo: { hasNextPage: false },
      },
    });
    const r = await run({ type: "0xk3::art::Piece", mode: "nft", limit: 5, max_scan: 500 });
    expect(r.unresolved_owners).toBe(1);
  });
});
