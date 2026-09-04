import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
// The store is off by default, but mocking it keeps the test independent of
// whether the developer running it happens to have SUI_STORE_PATH set.
vi.mock("../src/utils/store.js", () => ({
  getCachedFirstFunder: () => null,
  saveFirstFunder: () => true,
}));

const { Budget, buildWalletEdges, probeRecipients, probeSponsored } = await import(
  "../src/utils/edge-probe.js"
);

const SUI = "0x2::sui::SUI";
const ONE_SUI = "1000000000";

/** A page of transactions in the shape the GraphQL schema returns. */
function page(nodes: unknown[], hasPrev = false, cursor = "c") {
  return { transactions: { nodes, pageInfo: { hasPreviousPage: hasPrev, startCursor: cursor } } };
}

/** One transaction that pays `to` from `from`. */
function payment(digest: string, from: string, to: string, sponsor?: string) {
  return {
    digest,
    sender: { address: from },
    gasInput: { gasSponsor: { address: sponsor ?? from } },
    effects: {
      timestamp: "2026-01-01T00:00:00.000Z",
      checkpoint: { sequenceNumber: 1 },
      balanceChanges: {
        nodes: [
          { owner: { address: from }, amount: `-${ONE_SUI}`, coinType: { repr: SUI } },
          { owner: { address: to }, amount: ONE_SUI, coinType: { repr: SUI } },
        ],
      },
    },
  };
}

beforeEach(() => mockGqlQuery.mockReset());

describe("probeRecipients — the bound, not the count", () => {
  it("stops as soon as the limit is exceeded and reports popular", async () => {
    // The whole design rests on this: an exchange's recipient count is never
    // needed, only the verdict. Continuing past the limit is the query storm
    // that makes people believe live clustering is impossible.
    mockGqlQuery.mockImplementation(async () =>
      page(
        Array.from({ length: 50 }, (_, i) => payment(`0xd${i}`, "0xF", `0xr${i}`)),
        true,
      ),
    );

    const b = new Budget(100);
    const r = await probeRecipients("0xF", 10, b);
    expect(r.popular).toBe(true);
    // One page already blew the limit, so exactly one request was spent.
    expect(b.used).toBe(1);
    // No members: a popular intermediary contributes no candidates at all.
    expect(r.members.size).toBe(0);
  });

  it("returns the member set when the address is narrow", async () => {
    mockGqlQuery.mockImplementation(async () =>
      page([payment("0xd1", "0xF", "0xa"), payment("0xd2", "0xF", "0xb")], false),
    );
    const r = await probeRecipients("0xF", 50, new Budget(100));
    expect(r.popular).toBe(false);
    expect([...r.members.keys()].sort()).toEqual(["0xa", "0xb"]);
  });

  it("ignores the address's own balance change and any outflow", async () => {
    mockGqlQuery.mockImplementation(async () => page([payment("0xd1", "0xF", "0xa")], false));
    const r = await probeRecipients("0xF", 50, new Budget(100));
    expect(r.members.has("0xF")).toBe(false);
  });

  it("respects the shared query budget and latches truncated", async () => {
    mockGqlQuery.mockImplementation(async () => page([payment("0xd", "0xF", "0xa")], true));
    const b = new Budget(2);
    await probeRecipients("0xF", 50, b);
    expect(b.used).toBe(2);
    expect(b.truncated).toBe(true);
  });
});

describe("probeSponsored", () => {
  it("counts only transactions where the address paid someone else's gas", async () => {
    mockGqlQuery.mockImplementation(async () =>
      page(
        [
          payment("0xd1", "0xs1", "0xz", "0xP"), // 0xP sponsored 0xs1
          payment("0xd2", "0xP", "0xz"), // 0xP's own self-paid transaction
          payment("0xd3", "0xs2", "0xz", "0xP"),
        ],
        false,
      ),
    );
    const r = await probeSponsored("0xP", 50, new Budget(100));
    expect([...r.members.keys()].sort()).toEqual(["0xs1", "0xs2"]);
    // Self-payment must not make an address its own sponsor.
    expect(r.members.has("0xP")).toBe(false);
  });
});

/**
 * Routes the three query shapes buildWalletEdges issues. Keyed on distinctive
 * text rather than exact strings so a reworded query does not silently make
 * every mock return the wrong shape.
 */
function router(handlers: {
  earliest?: (addr: string) => unknown;
  recent?: (addr: string) => unknown;
  sent?: (addr: string) => unknown;
}) {
  // `vars` defaults because the runner invokes the implementation once with no
  // arguments; an unknown address falls through every handler to an empty page,
  // which is the correct answer for "no such address" anyway.
  return async (query: string, vars: Record<string, string> = {}) => {
    const q = String(query);
    if (q.includes("sentAddress")) return handlers.sent?.(vars.addr) ?? page([]);
    if (q.includes("gasInput")) return handlers.recent?.(vars.addr) ?? page([]);
    return handlers.earliest?.(vars.addr) ?? page([]);
  };
}

describe("buildWalletEdges", () => {
  const A = "0xaaa";
  const B = "0xbbb";
  const NARROW = "0xnarrow";

  it("links two seeds that share a narrow first funder", async () => {
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) =>
          addr === A || addr === B ? page([payment("0xf" + addr, NARROW, addr)]) : page([]),
        sent: (addr) =>
          addr === NARROW
            ? page([payment("0xfa", NARROW, A), payment("0xfb", NARROW, B)])
            : page([]),
      }),
    );

    const r = await buildWalletEdges([A, B], { expand: false });
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0].signal_types).toEqual(["cofunded"]);
    expect(r.edges[0].signals[0].via).toBe(NARROW);
    // The claim is checkable: the funding digests are attached.
    expect(r.edges[0].signals[0].digests.length).toBeGreaterThan(0);
  });

  it("discards a popular funder instead of linking everyone it paid", async () => {
    // The failure this prevents: one exchange collapsing the whole chain into
    // a single 'cluster'.
    const CEX = "0xcex";
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) =>
          addr === A || addr === B ? page([payment("0xf" + addr, CEX, addr)]) : page([]),
        sent: (addr) =>
          addr === CEX
            ? page(
                Array.from({ length: 20 }, (_, i) => payment(`0xd${i}`, CEX, `0xr${i}`)),
                true,
              )
            : page([]),
      }),
    );

    const r = await buildWalletEdges([A, B], { expand: false, popularityLimit: 10 });
    expect(r.edges).toHaveLength(0);
    expect(r.excluded_intermediaries).toHaveLength(1);
    expect(r.excluded_intermediaries[0]).toMatchObject({ address: CEX, role: "funder" });
  });

  it("records one seed first-funding another as a direct edge", async () => {
    mockGqlQuery.mockImplementation(
      router({ earliest: (addr) => (addr === B ? page([payment("0xfb", A, B)]) : page([])) }),
    );
    const r = await buildWalletEdges([A, B], { expand: false });
    expect(r.edges[0].signal_types).toEqual(["funding_edge"]);
  });

  it("does not turn a mass-action transaction into co-appearance edges", async () => {
    // An airdrop puts hundreds of strangers in one transaction.
    const many = Array.from({ length: 40 }, (_, i) => ({
      owner: { address: `0xp${i}` },
      amount: ONE_SUI,
    }));
    mockGqlQuery.mockImplementation(
      router({
        recent: () =>
          page([
            {
              digest: "0xmass",
              sender: { address: A },
              gasInput: { gasSponsor: { address: A } },
              effects: { balanceChanges: { nodes: [...many, { owner: { address: B }, amount: ONE_SUI }] } },
            },
          ]),
      }),
    );
    const r = await buildWalletEdges([A, B], { expand: false });
    expect(r.edges.filter((e) => e.signal_types.includes("co_tx"))).toHaveLength(0);
  });

  it("reports truncation rather than presenting a partial build as complete", async () => {
    mockGqlQuery.mockImplementation(router({}));
    const r = await buildWalletEdges([A, B], { expand: false, queryBudget: 1 });
    expect(r.truncated).toBe(true);
    expect(r.notes.join(" ")).toContain("edges NOT found");
  });

  it("verifies a sibling candidate's own first funder before admitting it", async () => {
    // The narrow funder also paid 0xstranger, but that was a payment, not the
    // inflow that created it. Being paid is not being funded.
    const SIB = "0xsibling";
    const STRANGER = "0xstranger";
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) => {
          if (addr === A || addr === SIB) return page([payment("0xf" + addr, NARROW, addr)]);
          if (addr === STRANGER) return page([payment("0xfs", "0xelsewhere", STRANGER)]);
          return page([]);
        },
        sent: (addr) =>
          addr === NARROW
            ? page([
                payment("0xfa", NARROW, A),
                payment("0xfsib", NARROW, SIB),
                payment("0xfst", NARROW, STRANGER),
              ])
            : page([]),
      }),
    );

    const r = await buildWalletEdges([A], { expand: true, expandBudget: 10 });
    const members = new Set(r.edges.flatMap((e) => [e.wallet_a, e.wallet_b]));
    expect(members.has(SIB)).toBe(true);
    expect(members.has(STRANGER)).toBe(false);
  });
});
