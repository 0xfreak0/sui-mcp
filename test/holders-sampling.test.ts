import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `get_top_holders` walks `objects(filter: Coin<T>)` in object-id order, which
 * is uncorrelated with balance. A scan that stops early therefore returns the
 * largest holder it happened to see, not the largest holder.
 *
 * That figure climbs with scan depth and need not converge on the real top
 * holder, so a ranking from it is an artefact of how far the loop ran.
 */

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({
  sui: { stateService: { getCoinInfo: async () => ({ response: { treasury: { totalSupply: "1000000" } } }) } },
  archive: {},
}));
vi.mock("../src/utils/names.js", () => ({ batchResolveNames: async () => new Map() }));

const { registerHolderTools, scanTokenTopHolders } = await import("../src/tools/holders.js");

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

beforeEach(() => {
  mockGqlQuery.mockReset();
});

/**
 * Serve `coins` to the coin walk. The address-balance walk finds no entries,
 * and the identity lookup for the ranked holders finds nothing at their
 * addresses, which is what both return for a coin held only in coin objects by
 * wallets.
 */
function coinsOnly(coins: () => unknown) {
  mockGqlQuery.mockImplementation((query: string, vars?: { type?: string; keys?: { address: string }[] }) => {
    if (query.includes("multiGetObjects")) return Promise.resolve({ multiGetObjects: vars!.keys!.map(() => null) });
    // The direct balance read of a sampled holder: nothing at these addresses.
    if (query.includes("balance(coinType")) return Promise.resolve({});
    if (query.includes("multiGetAddresses")) {
      return Promise.resolve({
        multiGetAddresses: vars!.keys!.map((k) => ({ address: k.address, objects: { nodes: [] } })),
      });
    }
    if (vars?.type?.includes("::accumulator::Key<")) {
      return Promise.resolve({ objects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    return Promise.resolve(coins());
  });
}

describe("a complete scan is a ranking", () => {
  it("ranks and reports percentages when the walk reached the end", async () => {
    coinsOnly(() => ({
      objects: { nodes: [coin(A, "300"), coin(B, "100")], pageInfo: { hasNextPage: false } },
    }));
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
    coinsOnly(endless());
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
    coinsOnly(endless());
    // A distinct depth, so this exercises the walk rather than the cache entry
    // the test above just wrote. The key is network:mode:type:maxScan:topN.
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 11 });
    expect(r.sampled_holders[0].percentage).toBeUndefined();
  });

  it("says outright that these are not the largest holders", async () => {
    coinsOnly(endless());
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 12 });
    expect(r.caveat).toMatch(/INCOMPLETE/);
    expect(r.caveat).toMatch(/not the largest holders/i);
    expect(r.caveat).toMatch(/object-id order/i);
  });

  /**
   * The walk saw only some of each sampled holder's coins, so its per-holder
   * sum is a floor. On XAGM the largest sampled holder summed to 9.1M of the
   * 24.1M its address holds.
   */
  it("reports what each sampled holder holds, read directly, beside the sampled sum", async () => {
    const walk = endless();
    mockGqlQuery.mockImplementation((query: string, vars?: Record<string, unknown>) => {
      if (query.includes("balance(coinType")) {
        // address(address:) { balance(coinType:) } for each alias, as the service answers it.
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(vars ?? {})) {
          if (!k.startsWith("a")) continue;
          const total = v === B ? "900" : "40";
          out[`h${k.slice(1)}`] = { balance: { totalBalance: total, coinBalance: total, addressBalance: "0" } };
        }
        return Promise.resolve(out);
      }
      if (query.includes("multiGetObjects")) return Promise.resolve({ multiGetObjects: (vars!.keys as unknown[]).map(() => null) });
      if (query.includes("multiGetAddresses")) {
        return Promise.resolve({
          multiGetAddresses: (vars!.keys as { address: string }[]).map((k) => ({ address: k.address, objects: { nodes: [] } })),
        });
      }
      if (String(vars?.type).includes("::accumulator::Key<")) {
        return Promise.resolve({ objects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
      }
      return walk();
    });
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 13 });
    expect(r.truncated).toBe(true);
    // B saw only "1" per page in the sample but holds 900; it leads the sample.
    expect(r.sampled_holders[0]).toMatchObject({ address: B, balance: "900", coin_balance: "900", address_balance: "0" });
    expect(BigInt(r.sampled_holders[0].balance_in_sample)).toBeLessThan(900n);
    expect(r.sampled_holders[1]).toMatchObject({ address: A, balance: "40" });
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
    coinsOnly(() => {
      calls++;
      return {
        objects: {
          nodes: [coin(A, "100")],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      };
    });
    // Distinct max_scan: the tool caches on (mode, type, max_scan, limit), so
    // reusing an earlier test's arguments would serve a cached result and the
    // walk would never run.
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 1234 });
    expect(calls).toBe(1);
    // 100, not 100 x however many times the loop restarted.
    expect(r.sampled_holders?.[0]?.balance_in_sample ?? r.top_holders?.[0]?.balance).toBe("100");
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
    coinsOnly(() => ({
      objects: {
        nodes: [coin(A, "300"), coin(B, "100")],
        pageInfo: { hasNextPage: true, endCursor: null },
      },
    }));
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
    coinsOnly(() => ({ objects: { nodes: [], pageInfo: { hasNextPage: false } } }));
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
    coinsOnly(() => ({
      objects: { nodes: [coin(A, "300")], pageInfo: { hasNextPage: false } },
    }));
    const r = await run({ type: "0x2::sui::SUI", limit: 5, max_scan: 0 });
    expect(mockGqlQuery).toHaveBeenCalled();
    expect(r.total_scanned).toBe(1);
  });

  it("limit: -1 does not silently drop the last holder", async () => {
    coinsOnly(() => ({
      objects: { nodes: [coin(A, "300"), coin(B, "100")], pageInfo: { hasNextPage: false } },
    }));
    const r = await run({ type: "0x2::sui::SUI", limit: -1, max_scan: 997 });
    expect(r.top_holders.length).toBe(1);
    expect(r.top_holders[0].address).toBe(A);
  });
});

/**
 * A kiosk's `owner` field is written by `set_owner` and does not follow the
 * `KioskOwnerCap` when the cap is transferred. The error concentrates: one
 * address can be declared by many kiosks, which is enough to invent a top
 * holder.
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
              asObject: {
                asMoveObject: {
                  contents: {
                    type: { repr: "0x0000000000000000000000000000000000000000000000000000000000000002::kiosk::Kiosk" },
                    json: { owner: declared },
                  },
                },
              },
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
              asObject: {
                asMoveObject: {
                  contents: {
                    type: { repr: "0x0000000000000000000000000000000000000000000000000000000000000002::kiosk::Kiosk" },
                    json: { owner: declared },
                  },
                },
              },
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

  /**
   * A holder can be both. Labelling the whole count `kiosk_declared` because
   * one NFT of four came from a kiosk says the other three are a guess too,
   * and a reader filtering for chain-derived holders would drop them.
   */
  it("calls a holder with both kinds mixed, and carries the split", async () => {
    mockGqlQuery.mockResolvedValue({
      objects: {
        nodes: [plainNft(A), plainNft(A), plainNft(A), kioskNft(A, "0xkm")],
        pageInfo: { hasNextPage: false },
      },
    });
    const r = await run({ type: "0xk5::art::Piece", mode: "nft", limit: 5, max_scan: 500 });
    expect(r.top_holders[0]).toMatchObject({
      count: 4,
      holder_kind: "mixed",
      from_kiosk_owner_field: 1,
    });
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

describe("a scan stops at its time budget and says so", () => {
  // A default scan is 100 pages of coin objects, and on a loaded endpoint each
  // page can wait out 429 backoff. Each page here costs 10s of clock; the scan
  // must stop near 35s, return a sample marked as cut short by time, and still
  // include the address-balance walk, which runs beside the coin walk rather
  // than after it.
  const AAA = "0xd976fda9a9786cda1a36dee360013d775a5e5f206f8e20f84fad3385e99eeb2d::aaa::AAA";
  it("returns a marked sample instead of running past the budget", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let coinPages = 0;
    mockGqlQuery.mockImplementation((query: string, vars?: { type?: string; keys?: { address: string }[] }) => {
      if (query.includes("multiGetObjects")) return Promise.resolve({ multiGetObjects: vars!.keys!.map(() => null) });
      if (query.includes("balance(coinType")) return Promise.resolve({});
      if (query.includes("multiGetAddresses")) {
        return Promise.resolve({ multiGetAddresses: vars!.keys!.map((k) => ({ address: k.address, objects: { nodes: [] } })) });
      }
      if (vars?.type?.includes("::accumulator::Key<")) {
        return Promise.resolve({
          objects: {
            nodes: [{ asMoveObject: { contents: { json: { name: { address: B }, value: { value: "500" } } } } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      }
      coinPages++;
      now += 10_000;
      return Promise.resolve({
        objects: { nodes: [coin(A, "1")], pageInfo: { hasNextPage: true, endCursor: `c${coinPages}` } },
      });
    });
    try {
      const r = await run({ type: AAA, mode: "token", limit: 5, max_scan: 1000 });
      expect(coinPages).toBeLessThanOrEqual(5);
      expect(r.truncated).toBe(true);
      expect(r.complete_ranking).toBe(false);
      expect(r.time_budget_reached).toBe(true);
      expect(r.coin_walk_truncated).toBe(true);
      expect(r.address_balance_walk_truncated).toBe(false);
      expect(r.address_balances_scanned).toBe(1);
      expect(r.caveat).toMatch(/time budget/);
      // At holders.ts's expected page time, max_scan 1000 (20 pages) fits the
      // budget with room to spare, so only a slow endpoint stops it. The
      // caveat reports what was read and derives that cause instead of
      // advising a smaller max_scan.
      expect(r.caveat).toMatch(/after 5 objects, 4 page\(s\) deep, in 40\.0s, 10\.00s per page/);
      expect(r.caveat).toMatch(/max_scan 1000 \(20 page\(s\)\) can fit inside the budget/);
      expect(r.caveat).toMatch(/retry once it is less loaded may reach max_scan/);
      expect(r.caveat).not.toMatch(/not the endpoint being unusually slow/i);
      expect(r.caveat).not.toMatch(/Lower max_scan/);

      // Not cached: the same call scans again.
      const before = coinPages;
      await run({ type: AAA, mode: "token", limit: 5, max_scan: 1000 });
      expect(coinPages).toBeGreaterThan(before);
    } finally {
      clock.mockRestore();
    }
  });

  /** The other regime: a max_scan whose pages cannot fit in 35s even at the
   *  expected page time. 7,950 (159 pages) is the largest that fits. */
  it.each([
    { maxScan: 7950, fits: true },
    { maxScan: 8000, fits: false },
    { maxScan: 20000, fits: false },
  ])("derives the cause from max_scan $maxScan, not from a fixed claim", async ({ maxScan, fits }) => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let coinPages = 0;
    mockGqlQuery.mockImplementation((query: string, vars?: { type?: string; keys?: { address: string }[] }) => {
      if (query.includes("multiGetObjects")) return Promise.resolve({ multiGetObjects: vars!.keys!.map(() => null) });
      if (query.includes("balance(coinType")) return Promise.resolve({});
      if (query.includes("multiGetAddresses")) {
        return Promise.resolve({ multiGetAddresses: vars!.keys!.map((k) => ({ address: k.address, objects: { nodes: [] } })) });
      }
      if (vars?.type?.includes("::accumulator::Key<")) {
        return Promise.resolve({ objects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
      }
      coinPages++;
      now += 10_000;
      return Promise.resolve({
        objects: { nodes: [coin(A, "1")], pageInfo: { hasNextPage: true, endCursor: `c${coinPages}` } },
      });
    });
    try {
      const r = await run({ type: AAA, mode: "token", limit: 5, max_scan: maxScan });
      expect(r.time_budget_reached).toBe(true);
      if (fits) {
        expect(r.caveat).toMatch(/inside the budget/);
        expect(r.caveat).toMatch(/retry once it is less loaded may reach max_scan/);
        expect(r.caveat).not.toMatch(/Lower max_scan/);
      } else {
        expect(r.caveat).toMatch(/more than the budget, and a retry at the same max_scan stops short of it too/);
        expect(r.caveat).toMatch(/Lower max_scan to 7950 or less/);
        expect(r.caveat).not.toMatch(/less loaded/);
      }
    } finally {
      clock.mockRestore();
    }
  });
});

describe("an NFT scan stops at its time budget and says so", () => {
  /** The NFT branch builds the same derived caveat as coin mode, so a
   *  time-budget stop there does not blame the endpoint either. */
  it("does not blame the endpoint for a time-budget stop in NFT mode either", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let pages = 0;
    mockGqlQuery.mockImplementation(() => {
      pages++;
      now += 10_000;
      return Promise.resolve({
        objects: { nodes: [{ owner: { address: { address: A } } }], pageInfo: { hasNextPage: true, endCursor: `c${pages}` } },
      });
    });
    try {
      const r = await run({ type: "0xnft::art::Piece", mode: "nft", limit: 5, max_scan: 1000 });
      expect(r.truncated).toBe(true);
      expect(r.time_budget_reached).toBe(true);
      expect(r.caveat).toMatch(/after 4 objects, 4 page\(s\) deep, in 40\.0s, 10\.00s per page/);
      expect(r.caveat).toMatch(/inside the budget/);
      expect(r.caveat).toMatch(/retry once it is less loaded may reach max_scan/);
      expect(r.caveat).not.toMatch(/not the endpoint being unusually slow/i);
    } finally {
      clock.mockRestore();
    }
  });

  /**
   * NFT pages cost more when their items sit in kiosks, since the same page
   * resolves each kiosk, so the expected page time is weighted by the kiosk
   * share read. At the default max_scan 5000, a directly held collection fits
   * in 35s and an all-kiosk one does not.
   */
  const kioskHeld = {
    owner: {
      address: {
        asObject: {
          owner: {
            address: {
              address: "0xkiosk1",
              asObject: {
                asMoveObject: {
                  contents: {
                    type: { repr: "0x0000000000000000000000000000000000000000000000000000000000000002::kiosk::Kiosk" },
                    json: { owner: A },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const direct = { owner: { address: { address: A } } };
  it.each([
    { held: "directly", nodes: [direct], fits: true, expected: /\b0% of the items read here were in kiosks.*max_scan 5000 \(100 page\(s\)\) can fit inside the budget/ },
    { held: "half in kiosks", nodes: [direct, kioskHeld], fits: true, expected: /\b50% of the items read here were in kiosks.*max_scan 5000 \(100 page\(s\)\) can fit inside the budget/ },
    { held: "in kiosks", nodes: [kioskHeld], fits: false, expected: /\b100% of the items read here were in kiosks.*max_scan 5000 \(100 page\(s\)\) takes more than the budget/ },
  ])("derives the default scan's cause from the kiosk mix when items are held $held", async ({ nodes, fits, expected }) => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let pages = 0;
    mockGqlQuery.mockImplementation(() => {
      pages++;
      now += 10_000;
      return Promise.resolve({ objects: { nodes, pageInfo: { hasNextPage: true, endCursor: `c${pages}` } } });
    });
    try {
      const r = await run({ type: "0xnft::art::Piece", mode: "nft", limit: 5 });
      expect(r.time_budget_reached).toBe(true);
      expect(r.caveat).toMatch(expected);
      if (fits) {
        expect(r.caveat).not.toMatch(/Lower max_scan/);
      } else {
        expect(r.caveat).toMatch(/Lower max_scan to 4350 or less/);
      }
    } finally {
      clock.mockRestore();
    }
  });
});

describe("a rejected walk does not leave its sibling paging in the background", () => {
  /**
   * The two walks run under `Promise.allSettled`. If one rejects (an
   * accumulator-key page erroring, say), the call waits for the
   * address-balance walk to settle before rejecting, so that walk does not
   * keep paging in the background, holding a slot of the shared GraphQL
   * limiter while the caller retries.
   */
  it("waits for the address-balance walk to settle before rejecting, instead of returning immediately", async () => {
    const gate = Promise.withResolvers<{ objects: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>();
    mockGqlQuery.mockImplementation((_query: string, vars?: { type?: string }) => {
      if (vars?.type?.includes("::accumulator::Key<")) return gate.promise;
      // The coin-object walk fails on its very first page.
      return Promise.reject(new Error("coin walk failed"));
    });

    const result = scanTokenTopHolders("0x2::sui::SUI", 5, 1000);
    let settled = false;
    result.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    // Flush microtasks without any real wall-clock wait. The coin walk has
    // already rejected, but the call must not settle while the
    // address-balance page is pending.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve({ objects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    await expect(result).rejects.toThrow("coin walk failed");
    expect(settled).toBe(true);
  });
});
