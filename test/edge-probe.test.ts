import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient } from "./helpers/mock-grpc.js";
import { clusterEdges, EdgeSet, EQUAL_AMOUNT_CONSOLIDATION_WEIGHT, SIGNAL_WEIGHTS } from "../src/utils/wallet-edges.js";

const { mockGqlQuery, mockGetCachedFirstFunder, mockSaveFirstFunder, mockPrices, cohortFixture } = vi.hoisted(() => ({
  mockGqlQuery: vi.fn(),
  mockGetCachedFirstFunder: vi.fn(),
  mockSaveFirstFunder: vi.fn(() => true),
  mockPrices: vi.fn(),
 cohortFixture: { enabled: false },
}));
vi.mock("../src/clients/graphql.js", () => ({
 gqlQuery: (query: string, vars: { oldest?: boolean }) => {
  if (!cohortFixture.enabled && query.includes("$oldest: Boolean!")) {
   return Promise.resolve({
    [vars.oldest ? "old" : "recent"]:
     { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }
   });
  }
  return mockGqlQuery(query, vars);
 },
}));
// The store is off by default, but mocking it keeps the test independent of
// whether the developer running it happens to have SUI_STORE_PATH set.
vi.mock("../src/utils/store.js", () => ({
  getCachedFirstFunder: mockGetCachedFirstFunder,
  saveFirstFunder: mockSaveFirstFunder,
  loadLabels: () => [],
}));
// firstFunderOf prices candidate inflows the same way find_funding_source
// does; mocked here so the test suite stays offline and deterministic.
vi.mock("../src/utils/price-providers.js", () => ({ pricesForRanking: mockPrices }));
// CoinMetadata reads for the decimals tier and the treasury's total supply.
// The service answers NOT_FOUND for a coin type with no metadata, which is
// what every test coin here gets unless a test registers it in `coinDecimals`
// (and, for a coin whose TreasuryCap the service tracks, `coinSupply`).
const mockSui = createMockClient();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
const coinDecimals: Record<string, number> = {};
const coinSupply: Record<string, bigint> = {};
/** Package id -> the sender of the transaction that published it. */
const packagePublisher: Record<string, string> = {};

/** SUI's coin type as GraphQL reports it, and as the price request carries it. */
const SUI_LONG = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

/**
 * Aftermath as it answers when it is up: SUI always priced, a coin it does not
 * list left out (it answers `price: -1`, which the provider drops).
 */
const aftermathUp =
  (listed: Record<string, number> = {}) =>
  async (coins: string[]) =>
    new Map(
      coins
        .filter((c) => c === SUI_LONG || c in listed)
        .map((c) => [c, { price: c === SUI_LONG ? 3.5 : listed[c]!, source: "aftermath" as const }]),
    );

// Load after mockSui is initialized: the mocked gRPC factory closes over it.
const { Budget, buildWalletEdges, countPaidAddresses, firstFunderOf, probeRecipients, probeSponsored } = await import(
  "../src/utils/edge-probe.js"
);

const { pagedTxConnection } = await import("./helpers/service-shapes.js");
const { resetLiveCoinScale } = await import("../src/utils/valuation.js");
const { resetCoinOrigins } = await import("../src/utils/coin-origin.js");

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

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockGetCachedFirstFunder.mockReset();
 cohortFixture.enabled = false;
  mockSaveFirstFunder.mockClear();
  mockPrices.mockReset().mockImplementation(aftermathUp());
  resetLiveCoinScale();
  resetCoinOrigins();
  for (const k of Object.keys(coinDecimals)) delete coinDecimals[k];
  for (const k of Object.keys(coinSupply)) delete coinSupply[k];
  for (const k of Object.keys(packagePublisher)) delete packagePublisher[k];
  // A package object names its creating transaction; that transaction's
  // sender is the publisher. Anything else is NOT_FOUND, as the ledger answers.
  mockSui.ledgerService.getObject.mockReset().mockImplementation(async ({ objectId }: { objectId: string }) => {
    if (!(objectId in packagePublisher)) throw new Error("NOT_FOUND");
    return { response: { object: { objectId, previousTransaction: `publish-${objectId}` } } };
  });
  mockSui.ledgerService.getTransaction.mockReset().mockImplementation(async ({ digest }: { digest: string }) => {
    const pkg = digest.replace(/^publish-/, "");
    if (!(pkg in packagePublisher)) throw new Error("NOT_FOUND");
    return { response: { transaction: { digest, transaction: { sender: packagePublisher[pkg] } } } };
  });
  mockSui.stateService.getCoinInfo.mockReset().mockImplementation(async ({ coinType }: { coinType: string }) => {
    if (!(coinType in coinDecimals)) throw new Error(`NOT_FOUND: no CoinMetadata for ${coinType}`);
    return {
      response: {
        coinType,
        metadata: { symbol: coinType.split("::").at(-1), decimals: coinDecimals[coinType] },
        ...(coinType in coinSupply ? { treasury: { totalSupply: coinSupply[coinType], supplyState: 1 } } : {}),
      },
    };
  });
});

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

  it("does not make a sponsor that took the storage rebate a sibling candidate", async () => {
    const sweep = payment("0xd1", "0xF", "0xa", "0x5905");
    sweep.effects.balanceChanges.nodes.push({ owner: { address: "0x5905" }, amount: "5748960", coinType: { repr: SUI } });
    mockGqlQuery.mockImplementation(async () => page([sweep], false));
    const r = await probeRecipients("0xF", 50, new Budget(100));
    expect([...r.members.keys()]).toEqual(["0xa"]);
  });
  it("reads only pre-bound sends across pages, not newer recipients", async () => {
    const sends = [
      { checkpoint: 120, tx: payment("late", "0xF", "0xc") },
      { checkpoint: 90, tx: payment("before-2", "0xF", "0xb") },
      { checkpoint: 20, tx: payment("before-1", "0xF", "0xa") },
    ];
    for (const { checkpoint, tx } of sends) tx.effects.checkpoint.sequenceNumber = checkpoint;
    mockGqlQuery.mockImplementation(async (_query: string, vars: { before?: string; afterCheckpoint?: number; beforeCheckpoint?: number }) => {
      const inWindow = sends.filter(({ checkpoint }) => checkpoint > (vars.afterCheckpoint ?? -1) && checkpoint < (vars.beforeCheckpoint ?? Infinity));
      const offset = Number(vars.before ?? 0);
      return page(inWindow.slice(offset, offset + 1).map(({ tx }) => tx), offset + 1 < inWindow.length, String(offset + 1));
    });

    const bounded = await probeRecipients("0xF", 2, new Budget(10), 100);
    expect(bounded.popular).toBe(false);
    expect(bounded.complete).toBe(true);
    expect([...bounded.members.keys()].sort()).toEqual(["0xa", "0xb"]);
    expect(mockGqlQuery.mock.calls).toHaveLength(2);
    for (const [query, vars] of mockGqlQuery.mock.calls) {
      expect(query).toContain("afterCheckpoint: $afterCheckpoint, beforeCheckpoint: $beforeCheckpoint");
      expect(vars).toMatchObject({ afterCheckpoint: 0, beforeCheckpoint: 100 });
    }

    mockGqlQuery.mockClear();
    const unbounded = await probeRecipients("0xF", 2, new Budget(10));
    expect(unbounded.popular).toBe(true);
    expect(mockGqlQuery.mock.calls.every(([query, vars]) => !String(query).includes("afterCheckpoint") && vars.afterCheckpoint === undefined && vars.beforeCheckpoint === undefined)).toBe(true);
  });
});

describe("probeRecipients counts recipients above the dust floor", () => {
  /** One transaction from 0xF paying `to` `amount` of `coin`. */
  const pay = (digest: string, to: string, amount: string, coin = SUI) => ({
    digest,
    sender: { address: "0xF" },
    gasInput: { gasSponsor: { address: "0xF" } },
    effects: {
      balanceChanges: {
        nodes: [
          { owner: { address: "0xF" }, amount: `-${amount}`, coinType: { repr: coin } },
          { owner: { address: to }, amount, coinType: { repr: coin } },
        ],
      },
    },
  });
  const USDC = `0x${"d".repeat(64)}::usdc::USDC`;
  const SPAM = `0x${"e".repeat(64)}::spam::SPAM`;

  it("does not let sub-floor sends make a funder popular", async () => {
    mockGqlQuery.mockImplementation(async () =>
      page([
        ...Array.from({ length: 60 }, (_, i) => pay(`0xdust${i}`, `0xr${i}`, "9999999")),
        pay("0xreal", "0xa", "10000000"),
      ]),
    );
    const r = await probeRecipients("0xF", 50, new Budget(100));
    expect(r.popular).toBe(false);
    expect([...r.members.keys()]).toEqual(["0xa"]);
    expect(r.belowFloor).toBe(60);
  });

  it("judges other coins by the $0.10 floor and leaves a coin nobody prices out", async () => {
    coinDecimals[USDC] = 6;
    mockPrices.mockImplementation(aftermathUp({ [USDC]: 1 }));
    mockGqlQuery.mockImplementation(async () =>
      page([pay("0x1", "0xa", "100000", USDC), pay("0x2", "0xb", "99999", USDC), pay("0x3", "0xc", "1000000000000", SPAM)]),
    );
    const r = await probeRecipients("0xF", 50, new Budget(100));
    expect([...r.members.keys()]).toEqual(["0xa"]);
    expect(r.belowFloor).toBe(2);
  });

  it("does not count a coin named sui::SUI from another package by the SUI floor", async () => {
    const IMPOSTOR = `0x${"b".repeat(64)}::sui::SUI`;
    mockGqlQuery.mockImplementation(async () =>
      page(Array.from({ length: 60 }, (_, i) => pay(`0xfake${i}`, `0xr${i}`, "10000000", IMPOSTOR))),
    );
    const r = await probeRecipients("0xF", 50, new Budget(100));
    expect(r.popular).toBe(false);
    expect(r.belowFloor).toBe(60);
  });

  it("counts other coins at any amount when no price can be read", async () => {
    mockPrices.mockImplementation(async () => new Map());
    mockGqlQuery.mockImplementation(async () => page([pay("0x1", "0xa", "1", USDC), pay("0x2", "0xb", "1", SUI)]));
    const r = await probeRecipients("0xF", 50, new Budget(100));
    expect([...r.members.keys()]).toEqual(["0xa"]);
    expect(r.belowFloor).toBe(1);
  });
});

describe("countPaidAddresses", () => {
  const change = (owner: string, amount: string, coin = SUI) => ({ owner: { address: owner }, amount, coinType: { repr: coin } });

  it("counts neither the sender nor a gas-only sponsor's rebate", () => {
    const changes = [change("0xF", "-3000"), change("0xa", "1000"), change("0xb", "1000"), change("0x5905", "57")];
    expect(
      countPaidAddresses(changes, { sender: { address: "0xF" }, gasInput: { gasSponsor: { address: "0x5905" } } }),
    ).toBe(2);
  });

  it("still counts a sponsor paid in a coin other than SUI", () => {
    const changes = [change("0xF", "-3000", "0xusdc::usdc::USDC"), change("0x5905", "3000", "0xusdc::usdc::USDC")];
    expect(
      countPaidAddresses(changes, { sender: { address: "0xF" }, gasInput: { gasSponsor: { address: "0x5905" } } }),
    ).toBe(1);
  });
});

describe("a narrow verdict off an incomplete scan is provisional", () => {
  it("reports scan_complete false when the page cap stopped it", async () => {
    // The scan walks backwards from recent activity while the fundings it
    // filters are historical, so an address that distributed widely long ago
    // and has been quiet since reads as narrow. Presenting that as measured
    // would let a real airdropper link its recent handful of recipients.
    mockGqlQuery.mockImplementation(async () => page([payment("0xd", "0xF", "0xa")], true));
    const r = await probeRecipients("0xF", 50, new Budget(500));
    expect(r.popular).toBe(false);
    expect(r.complete).toBe(false);
  });

  it("reports scan_complete true when it reached the end of history", async () => {
    mockGqlQuery.mockImplementation(async () => page([payment("0xd", "0xF", "0xa")], false));
    expect((await probeRecipients("0xF", 50, new Budget(500))).complete).toBe(true);
  });

  it("calls a popular verdict complete — the limit was exceeded by what was seen", async () => {
    mockGqlQuery.mockImplementation(async () =>
      page(Array.from({ length: 20 }, (_, i) => payment(`0xd${i}`, "0xF", `0xr${i}`)), true),
    );
    const r = await probeRecipients("0xF", 5, new Budget(500));
    expect(r.popular).toBe(true);
    expect(r.complete).toBe(true);
  });
});

describe("probeRecipients reads whole balance-change lists", () => {
  it("finds recipients past a transaction's first page of 50, and charges the follow-up reads", async () => {
    const changes = [
      { owner: { address: "0xF" }, amount: `-${60n * BigInt(ONE_SUI)}`, coinType: { repr: SUI } },
      ...Array.from({ length: 60 }, (_, i) => ({
        owner: { address: `0x${(i + 1).toString(16).padStart(64, "0")}` },
        amount: ONE_SUI,
        coinType: { repr: SUI },
      })),
    ];
    const conn = pagedTxConnection("batch", changes, "balanceChanges");
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) =>
      conn.respond(q, v) ?? page([{ digest: "batch", effects: { balanceChanges: conn.first } }]),
    );
    const b = new Budget(100);
    const r = await probeRecipients("0xF", 100, b);
    expect(r.members.size).toBe(60);
    expect(b.used).toBe(2);
  });

 it("stops a follow-up read at the budget's ceiling and calls the scan incomplete, not failed", async () => {
  const changes = [
   { owner: { address: "0xF" }, amount: `-${60n * BigInt(ONE_SUI)}`, coinType: { repr: SUI } },
   ...Array.from({ length: 60 }, (_, i) => ({
    owner: { address: `0x${(i + 1).toString(16).padStart(64, "0")}` },
    amount: ONE_SUI,
    coinType: { repr: SUI },
   })),
  ];
  const conn = pagedTxConnection("batch", changes, "balanceChanges");
  mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) =>
   conn.respond(q, v) ?? page([{ digest: "batch", effects: { balanceChanges: conn.first } }]),
  );
  const b = new Budget(1);
  const r = await probeRecipients("0xF", 100, b);
  expect(b.used).toBe(1);
  expect(b.truncated).toBe(true);
  expect(r.complete).toBe(false);
  expect(r.unmeasured).toBeUndefined();
 });
});

describe("probeSponsored", () => {
  it("counts only transactions where the address paid someone else's gas", async () => {
    mockGqlQuery.mockImplementation(async () =>
      page(
        [
          payment("0xd1", "0x51", "0xee", "0xP"), // 0xP sponsored 0x51
          payment("0xd2", "0xP", "0xee"), // 0xP's own self-paid transaction
          payment("0xd3", "0x52", "0xee", "0xP"),
        ],
        false,
      ),
    );
    const r = await probeSponsored("0xP", 50, new Budget(100));
    expect([...r.members.keys()].sort()).toEqual(["0x51", "0x52"]);
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
  recipients?: (digest: string) => unknown;
}) {
  // `vars` defaults because the runner invokes the implementation once with no
  // arguments; an unknown address falls through every handler to an empty page,
  // which is the correct answer for "no such address" anyway.
  return async (query: string, vars: Record<string, string> = {}) => {
    const q = String(query);
    if (q.includes("transactionEffects")) return handlers.recipients?.(vars.digest) ?? { transactionEffects: null };
    if (q.includes("sentAddress")) return handlers.sent?.(vars.addr) ?? page([]);
    if (q.includes("gasInput")) return handlers.recent?.(vars.addr) ?? page([]);
    return handlers.earliest?.(vars.addr) ?? page([]);
  };
}

describe("buildWalletEdges", () => {
  const A = "0xaaa";
  const B = "0xbbb";
  const NARROW = "0x4a4";

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
    // Assert the cofunded edge specifically. The narrow funder also
    // contributes a funding edge to each address it funded, so a total count
    // would be asserting on a different behaviour than this test is about.
    const cofunded = r.edges.filter((e) => e.signal_types.includes("cofunded"));
    expect(cofunded).toHaveLength(1);
    expect(cofunded[0].signals[0].via).toBe(NARROW);
    // The claim is checkable: the funding digests are attached.
    expect(cofunded[0].signals[0].digests.length).toBeGreaterThan(0);
  });

  it("discards a popular funder instead of linking everyone it paid", async () => {
    // The failure this prevents: one exchange collapsing the whole chain into
    // a single 'cluster'.
    const CEX = "0xcec";
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
              digest: "0x4a55",
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

  it("scores a wide batch payout below the merge threshold", async () => {
    // Two addresses first funded by the same transaction is near-decisive when
    // that transaction paid two addresses, and close to meaningless when it
    // paid twenty: an unrelated wallet lands in a batch by being on a list.
    const F = "0xf00d";
    const SHARED = "0x54a4ed";
  const wide = {
   transactionEffects: {
    balanceChanges: {
     nodes:
      Array.from({ length: 20 }, (_, i) => ({ owner: { address: `0xr${i}` }, amount: ONE_SUI }))
    }
   }
  };
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) =>
          addr === A || addr === B
            ? page([{ ...payment(SHARED, F, addr), digest: SHARED }])
            : page([]),
        sent: (addr) => (addr === F ? page([payment("0x1", F, A), payment("0x2", F, B)]) : page([])),
        recipients: () => wide,
      }),
    );
    const r = await buildWalletEdges([A, B], { expand: false });
    const batch = r.edges.filter((e) => e.signal_types.includes("cofunded"));
    expect(batch).toHaveLength(1);
    expect(batch[0].weight).toBe(0.8);
    expect(batch[0].signals[0].detail).toContain("20 addresses");
  });

  it("scores a bespoke two-way payout ABOVE a plain shared funder", async () => {
    const F = "0xf00d";
    const SHARED = "0x54a4ed";
  const narrow = {
   transactionEffects: {
    balanceChanges: {
     nodes: [
      { owner: { address: A }, amount: ONE_SUI }, { owner: { address: B }, amount: ONE_SUI }]
    }
   }
  };
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) =>
          addr === A || addr === B
            ? page([{ ...payment(SHARED, F, addr), digest: SHARED }])
            : page([]),
        sent: (addr) => (addr === F ? page([payment("0x1", F, A), payment("0x2", F, B)]) : page([])),
        recipients: () => narrow,
      }),
    );
    const r = await buildWalletEdges([A, B], { expand: false });
    const bespoke = r.edges.filter((e) => e.signal_types.includes("cofunded"));
    expect(bespoke[0].weight).toBe(1.2);
  });

  it("leaves separately-funded pairs at the default weight", async () => {
    // Two transactions from one funder means each address was funded
    // deliberately. That is the ordinary cofunded case, not a payout list, so
    // no recipient-count lookup should even be spent on it.
    const F = "0xf00d";
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) =>
          addr === A ? page([{ ...payment("0xtxA", F, A), digest: "0xtxA" }])
          : addr === B ? page([{ ...payment("0xtxB", F, B), digest: "0xtxB" }])
          : page([]),
        sent: (addr) => (addr === F ? page([payment("0x1", F, A), payment("0x2", F, B)]) : page([])),
        recipients: () => { throw new Error("must not look up a payout that was never shared"); },
      }),
    );
    const r = await buildWalletEdges([A, B], { expand: false });
    const sep = r.edges.filter((e) => e.signal_types.includes("cofunded"));
    expect(sep[0].weight).toBe(1);
  });

  it("puts a NARROW funder into the cluster it funded", async () => {
    // A narrow funder gets its own funding edge to the address it funded, so
    // the hub of a cluster is part of it and the answer does not depend on
    // which addresses the caller passed as seeds.
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) => (addr === A ? page([payment("0xfa", NARROW, A)]) : page([])),
        sent: (addr) => (addr === NARROW ? page([payment("0xfa", NARROW, A)]) : page([])),
      }),
    );

    const r = await buildWalletEdges([A], { expand: false });
    const fe = r.edges.find((e) => e.signal_types.includes("funding_edge"));
    expect(fe).toBeDefined();
    expect([fe!.wallet_a, fe!.wallet_b]).toContain(NARROW);
    expect(r.examined).toContain(NARROW);
    expect(fe!.signals[0].detail).toContain("not an exchange withdrawal");
  });

  it("keeps a POPULAR funder out, however many it funded", async () => {
    // The whole control. An exchange first-funds everybody, so a funding edge
    // from one would put every withdrawal it ever made in the same cluster.
    const CEX = "0xcec";
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) => (addr === A ? page([payment("0xfa", CEX, A)]) : page([])),
        sent: (addr) =>
          addr === CEX
            ? page(Array.from({ length: 20 }, (_, i) => payment(`0xd${i}`, CEX, `0xr${i}`)), true)
            : page([]),
      }),
    );

    const r = await buildWalletEdges([A], { expand: false, popularityLimit: 10 });
    expect(r.edges).toHaveLength(0);
    expect(r.examined).not.toContain(CEX);
    expect(r.excluded_intermediaries[0]).toMatchObject({ address: CEX, role: "funder" });
  });

  it("links a pair whose value moved BOTH ways, using the probe for the return leg", async () => {
    // The seed's own window usually sees one direction only: a wallet paid 400
    // transactions ago shows the outbound half and nothing else. The return leg
    // is asked of the counterparty instead, and probeRecipients already returns
    // it while measuring whether that counterparty is a service.
    const OTHER = "0x07e";
    mockGqlQuery.mockImplementation(
      router({
        recent: (addr) => (addr === A ? page([payment("0x0a7", A, OTHER)]) : page([])),
        // The probe of OTHER shows it paid A back.
        sent: (addr) => (addr === OTHER ? page([payment("0xbac", OTHER, A)]) : page([])),
      }),
    );

    const r = await buildWalletEdges([A], { expand: false });
    const rec = r.edges.find((e) => e.signal_types.includes("reciprocal"));
    expect(rec).toBeDefined();
    expect([rec!.wallet_a, rec!.wallet_b]).toContain(OTHER);
    expect(rec!.weight).toBe(1);
    expect(rec!.signals[0].digests).toContain("0xbac");
  });

 it("pages reciprocal counterparties and marks either page incomplete on its own", async () => {
  const others = ["0x07e", "0x07f"];
  mockGqlQuery.mockImplementation(router({
   recent: (addr) => addr === A ? page(others.map((other, i) => payment(`out-${i}`, A, other))) : page([]),
   sent: (addr) => others.includes(addr) ? page([payment(`back-${addr}`, addr, A)]) : page([]),
  }));
  const first = await buildWalletEdges([A], { expand: false, reciprocalBudget: 1 });
  const second = await buildWalletEdges([A], { expand: false, reciprocalBudget: 1, reciprocalOffset: 1 });
  expect(first.reciprocal_scan).toMatchObject({ total: 2, offset: 0, checked: 1, next_offset: 1 });
  expect(second.reciprocal_scan).toMatchObject({ total: 2, offset: 1, checked: 1 });
  expect(first.truncated).toBe(true);
  expect(second.truncated).toBe(true);
  expect(first.edges.filter((e) => e.signal_types.includes("reciprocal"))).toHaveLength(1);
  expect(second.edges.filter((e) => e.signal_types.includes("reciprocal"))).toHaveLength(1);
 });

  it("does NOT link a one-directional payment", async () => {
    // Everyone pays an exchange. Paying someone who never pays you back is the
    // commonest relationship on chain and carries almost no information.
    const OTHER = "0x07e";
    mockGqlQuery.mockImplementation(
      router({
        recent: (addr) => (addr === A ? page([payment("0x0a7", A, OTHER)]) : page([])),
        sent: () => page([]), // OTHER paid nobody back
      }),
    );
    const r = await buildWalletEdges([A], { expand: false });
    expect(r.edges.filter((e) => e.signal_types.includes("reciprocal"))).toHaveLength(0);
  });

  it("reads the direction of a payment per coin, whichever of the seed's rows is listed first", async () => {
    // Balance changes of transaction 4b4KuDfY…: the seed pays 5 IKA to another
    // wallet, and its own positive SUI row is the first row GraphQL lists. The
    // IKA payee still counts as a recipient, so its payment back is reciprocal.
    const IKA = "0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA";
    const OTHER = "0x07e";
    const paysIka = {
      digest: "4b4KuDfYa824fii1BZa6EEGT6nJqnJipmrWExq8MTURw",
      sender: { address: A },
      gasInput: { gasSponsor: { address: A } },
      effects: {
        timestamp: "2026-01-01T00:00:00.000Z",
        checkpoint: { sequenceNumber: 1 },
        balanceChanges: {
          nodes: [
            { owner: { address: A }, amount: "2876160", coinType: { repr: SUI } },
            { owner: { address: A }, amount: "-4502943424206", coinType: { repr: IKA } },
            { owner: { address: OTHER }, amount: "5000000000", coinType: { repr: IKA } },
          ],
        },
      },
    };
    mockGqlQuery.mockImplementation(
      router({
        recent: (addr) => (addr === A ? page([paysIka]) : page([])),
        sent: (addr) => (addr === OTHER ? page([payment("0xbac", OTHER, A)]) : page([])),
      }),
    );
    const r = await buildWalletEdges([A], { expand: false });
    const rec = r.edges.find((e) => e.signal_types.includes("reciprocal"));
    expect(rec).toBeDefined();
    expect([rec!.wallet_a, rec!.wallet_b]).toContain(OTHER);
  });

  it("refuses reciprocal flow through a service", async () => {
    // A deposit to an exchange followed by a withdrawal from it is reciprocal
    // and means nothing.
    const CEX = "0xcec";
    mockGqlQuery.mockImplementation(
      router({
        recent: (addr) => (addr === A ? page([payment("0x0a7", A, CEX)]) : page([])),
        sent: (addr) =>
          addr === CEX
            ? page(
                [payment("0xbac", CEX, A), ...Array.from({ length: 20 }, (_, i) => payment(`0xd${i}`, CEX, `0xr${i}`))],
                true,
              )
            : page([]),
      }),
    );
    const r = await buildWalletEdges([A], { expand: false, popularityLimit: 10 });
    expect(r.edges.filter((e) => e.signal_types.includes("reciprocal"))).toHaveLength(0);
    expect(r.excluded_intermediaries.some((e) => e.address === CEX)).toBe(true);
  });

  it("does NOT treat a direct payment between two seeds as co-appearance", async () => {
    // Balance changes include the sender, so "A paid B" lists both as parties.
    // That is plain transfer volume, the one relationship this module refuses
    // to cluster on. A signal that fires on every direct payment carries no
    // information, and at 0.5 it could lift a 0.7 sponsor edge over the 1.0
    // merge threshold.
    mockGqlQuery.mockImplementation(
      router({
        recent: (addr) =>
          addr === A
            ? page([
                {
                  digest: "0xd14e",
                  sender: { address: A },
                  gasInput: { gasSponsor: { address: A } },
                  effects: {
                    balanceChanges: {
                      nodes: [
                        { owner: { address: A }, amount: `-${ONE_SUI}` },
                        { owner: { address: B }, amount: ONE_SUI },
                      ],
                    },
                  },
                },
              ])
            : page([]),
      }),
    );
    const r = await buildWalletEdges([A, B], { expand: false });
    expect(r.edges).toHaveLength(0);
  });

  it("DOES treat a third party paying both seeds as co-appearance", async () => {
    // What remains once the sender is excluded is the real signal: somebody
    // else moved both balances in one transaction.
    mockGqlQuery.mockImplementation(
      router({
        recent: (addr) =>
          addr === A
            ? page([
                {
                  digest: "0xb07",
                  sender: { address: "0x3d" },
                  gasInput: { gasSponsor: { address: "0x3d" } },
                  effects: {
                    balanceChanges: {
                      nodes: [
                        { owner: { address: "0x3d" }, amount: `-${ONE_SUI}` },
                        { owner: { address: A }, amount: ONE_SUI },
                        { owner: { address: B }, amount: ONE_SUI },
                      ],
                    },
                  },
                },
              ])
            : page([]),
      }),
    );
    const r = await buildWalletEdges([A, B], { expand: false });
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0].signal_types).toEqual(["co_tx"]);
  });

  it("reports truncation rather than presenting a partial build as complete", async () => {
    mockGqlQuery.mockImplementation(router({}));
    const r = await buildWalletEdges([A, B], { expand: false, queryBudget: 1 });
    expect(r.truncated).toBe(true);
    expect(r.notes.join(" ")).toContain("edges NOT found");
  });

  it("verifies a sibling candidate's own first funder before admitting it", async () => {
    // The narrow funder also paid 0x57a, but that was a payment, not the
    // inflow that created it. Being paid is not being funded.
    const SIB = "0x51b";
    const STRANGER = "0x57a";
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) => {
          if (addr === A || addr === SIB) return page([payment("0xf" + addr, NARROW, addr)]);
          if (addr === STRANGER) return page([payment("0xf5", "0xe15e", STRANGER)]);
          return page([]);
        },
        sent: (addr) =>
          addr === NARROW
            ? page([
                payment("0xfa", NARROW, A),
                payment("0xf51b", NARROW, SIB),
                payment("0xf57", NARROW, STRANGER),
              ])
            : page([]),
      }),
    );

    const r = await buildWalletEdges([A], { expand: true, expandBudget: 10 });
    const members = new Set(r.edges.flatMap((e) => [e.wallet_a, e.wallet_b]));
    expect(members.has(SIB)).toBe(true);
    expect(members.has(STRANGER)).toBe(false);
  const pageOne = await buildWalletEdges([A], { expand: true, expandBudget: 1 });
  const pageTwo = await buildWalletEdges([A], { expand: true, expandBudget: 1, expandOffset: 1 });
  expect(pageOne.expansion_scan).toMatchObject({ total: 2, offset: 0, checked: 1, next_offset: 1 });
  expect(pageTwo.expansion_scan).toMatchObject({ total: 2, offset: 1, checked: 1 });
  expect(pageOne.truncated).toBe(true);
  expect(pageTwo.truncated).toBe(true);
  });
});

describe("seed-profile balance completion failures", () => {
  const A = "0xaaa";
  const B = "0xbbb";
  const THIRD = "0xccc";

  function incomplete(digest: string, from: string, to: string, sponsor = from, extraParty?: string) {
    const tx = payment(digest, from, to, sponsor);
    if (extraParty) tx.effects.balanceChanges.nodes.push({ owner: { address: extraParty }, amount: ONE_SUI, coinType: { repr: SUI } });
    const padding = Array.from({ length: 50 - tx.effects.balanceChanges.nodes.length }, (_, i) => ({
      owner: { address: from },
      amount: "-1",
      coinType: { repr: `0xcafe::coin::C${i}` },
    }));
    const conn = pagedTxConnection(tx.digest, [
      ...tx.effects.balanceChanges.nodes,
      ...padding,
      ...Array.from({ length: 25 }, (_, i) => ({
        owner: { address: `0x${(i + 100).toString(16)}` },
        amount: ONE_SUI,
        coinType: { repr: SUI },
      })),
    ], "balanceChanges");
    tx.effects.balanceChanges = conn.first;
    return { tx, conn };
  }

  it("withholds co-appearance when missing parties could cross the mass-action limit", async () => {
    const partial = incomplete("partial-mass-action", THIRD, A, THIRD, B);
    const rest = router({ recent: (addr) => addr === A ? page([partial.tx]) : page([]) });
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, string> = {}) => {
      if (partial.conn.respond(q, v)) throw new Error("GraphQL HTTP 429");
      return rest(q, v);
    });

    const result = await buildWalletEdges([A, B], { expand: false });
    expect(result.edges).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toMatch(/unread/i);
    expect(result.notes.join(" ")).toContain(partial.tx.digest);
  });

  it.each(["outbound", "inbound"])("withholds reciprocal flow from an incomplete %s payment", async (leg) => {
    const partial = incomplete(leg, leg === "outbound" ? A : B, leg === "outbound" ? B : A);
    const outbound = leg === "outbound" ? partial.tx : payment("outbound", A, B);
    const inbound = leg === "inbound" ? partial.tx : payment("inbound", B, A);
    const rest = router({ recent: (addr) => addr === A ? page([outbound, inbound]) : page([]) });
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, string> = {}) => {
      if (partial.conn.respond(q, v)) return { transactionEffects: null };
      return rest(q, v);
    });

    const result = await buildWalletEdges([A, B], { expand: false });
    expect(result.edges).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toMatch(/unread/i);
    expect(result.notes.join(" ")).toContain(partial.tx.digest);
  });

  it("does not turn a partially read sponsor payment into an operator edge", async () => {
    const partial = incomplete("partial-operator-payment", B, A);
    const sponsored = payment("sponsored", A, THIRD, B);
    const rest = router({ recent: (addr) => addr === A ? page([partial.tx, sponsored]) : page([]) });
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, string> = {}) => {
      if (partial.conn.respond(q, v)) throw new Error("GraphQL HTTP 429");
      return rest(q, v);
    });

    const result = await buildWalletEdges([A, B], { expand: false });
    expect(result.edges).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toContain(partial.tx.digest);
  });

  it("retains independent sponsorship without payment-derived edges from the unread transaction", async () => {
    const partial = incomplete("partial-sponsored", A, THIRD, THIRD);
    const otherSponsored = payment("other-sponsored", B, THIRD, THIRD);
    const rest = router({
      recent: (addr) => addr === A ? page([partial.tx])
        : addr === B ? page([otherSponsored])
        : addr === THIRD ? page([partial.tx, otherSponsored]) : page([]),
    });
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, string> = {}) => {
      if (partial.conn.respond(q, v)) throw new Error("GraphQL HTTP 429");
      return rest(q, v);
    });

    const result = await buildWalletEdges([A, B], { expand: false });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].signal_types).toEqual(["sponsor"]);
    expect(result.edges[0].signals[0].digests).toEqual([partial.tx.digest, otherSponsored.digest]);
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toContain(partial.tx.digest);
  });

  it("reports an unread seed scan when its transaction page fails", async () => {
    const rest = router({});
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, string> = {}) => {
      if (q.includes("gasInput") && v.addr === A) throw new Error("GraphQL HTTP 429");
      return rest(q, v);
    });

    const result = await buildWalletEdges([A], { expand: false });
    expect(result.edges).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toMatch(/scan.*unread/i);
    expect(result.notes.join(" ")).toContain(A);
  });
});

describe("send-shape reads remain explicitly bounded", () => {
  it.each(["transaction window", "balance changes"])("does not accept a targeted grant from incomplete %s", async (boundary) => {
    const A = "0xaaa";
    const FUNDER = "0xf00d";
    const LATER = "0x1a7e";
    const PKG = "0xcafe";
    const COIN = `${PKG}::coin::COIN`;
    coinDecimals[COIN] = 0;
    coinSupply[COIN] = 1_000_000_000n;
    packagePublisher[PKG] = FUNDER;
    const grant = payment("small-grant", FUNDER, A);
    grant.effects.balanceChanges.nodes = [
      { owner: { address: FUNDER }, amount: "-100000", coinType: { repr: COIN } },
      { owner: { address: A }, amount: "100000", coinType: { repr: COIN } },
    ];
    const nested = pagedTxConnection("nearby-send", [
      ...Array.from({ length: 50 }, (_, i) => ({
        owner: { address: FUNDER },
        amount: "-1",
        coinType: { repr: `${PKG}::other::C${i}` },
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        owner: { address: `0x${(i + 100).toString(16)}` },
        amount: "100000",
        coinType: { repr: COIN },
      })),
    ], "balanceChanges");
    const rest = router({ earliest: (addr) => addr === A ? page([grant, payment("later", LATER, A)]) : page([]) });
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, string> = {}) => {
      if (q.includes("TransactionFilter")) return {
        transactions: {
          pageInfo: { hasNextPage: boundary === "transaction window" },
          nodes: boundary === "balance changes"
            ? [{ digest: "nearby-send", effects: { balanceChanges: nested.first } }]
            : Array.from({ length: 50 }, (_, i) => payment(`nearby-${i}`, FUNDER, A)),
        },
      };
      return rest(q, v);
    });

    const funding = await firstFunderOf(A, new Budget(100));
    expect(funding?.digest).toBe("later");
    expect(funding?.funder).toBe(LATER);
    expect(mockSaveFirstFunder).not.toHaveBeenCalled();
  });
});

describe("first-funding balance completion failures", () => {
  const A = "0xaaa";
  const FUNDER = "0xf00d";
  const LATER = "0x1a7e";

  it.each(["hidden inflow before later funding", "visible inflow", "hidden inflow without later funding"])(
    "leaves %s unread and uncached",
    async (scenario) => {
      const tx = payment("incomplete-first", FUNDER, A);
      const target = tx.effects.balanceChanges.nodes[1];
      const others = Array.from({ length: 50 }, (_, i) => ({
        owner: { address: `0x${(i + 100).toString(16)}` },
        amount: ONE_SUI,
        coinType: { repr: SUI },
      }));
      const conn = pagedTxConnection(tx.digest, scenario === "visible inflow" ? [target, ...others] : [...others, target], "balanceChanges");
      tx.effects.balanceChanges = conn.first;
      const rest = router({
        earliest: (addr) => addr === A
          ? page(scenario === "hidden inflow before later funding" ? [tx, payment("later", LATER, A)] : [tx])
          : page([]),
      });
      mockGqlQuery.mockImplementation(async (q: string, v: Record<string, string> = {}) => {
        if (conn.respond(q, v)) throw new Error("GraphQL HTTP 429");
        return rest(q, v);
      });

      const budget = new Budget(100);
      expect(await firstFunderOf(A, budget)).toBeNull();
      expect(budget.used).toBe(2);
      expect(mockSaveFirstFunder).not.toHaveBeenCalled();

      const result = await buildWalletEdges([A, FUNDER, LATER], { expand: false });
      expect(result.first_funders).toEqual({});
      expect(result.edges).toEqual([]);
      expect(result.truncated).toBe(true);
      expect(result.notes.join(" ")).toMatch(/first.funding.*unread/i);
      expect(mockSaveFirstFunder).not.toHaveBeenCalled();
    },
  );
});

describe("firstFunderOf prices candidates like find_funding_source does", () => {
  const A = "0xaaa";
  it("skips an unpriced dust transfer as first funding and finds the real funder behind it", async () => {
    const DUST_SENDER = "0x0cea";
    const REAL_FUNDER = "0xf00d";
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) =>
          addr === A
            ? page([
                {
                  digest: "0xdust",
                  sender: { address: DUST_SENDER },
                  effects: {
                    timestamp: "2024-05-19T05:00:00.000Z",
                    checkpoint: { sequenceNumber: 1 },
                    balanceChanges: {
                      nodes: [
                        { owner: { address: DUST_SENDER }, amount: "-1", coinType: { repr: "0x0cea::ocean::OCEAN" } },
                        { owner: { address: A }, amount: "1", coinType: { repr: "0x0cea::ocean::OCEAN" } },
                      ],
                    },
                  },
                },
                payment("0xreal", REAL_FUNDER, A),
              ])
            : page([]),
      }),
    );
    const r = await buildWalletEdges([A], { expand: false });
    // The OCEAN transfer has no price, so it is skipped as spam and the SUI
    // payment behind it names the funder.
    expect(r.first_funders[A]).toBe(REAL_FUNDER);
    const fe = r.edges.find((e) => e.signal_types.includes("funding_edge"));
    expect(fe).toBeDefined();
    expect([fe!.wallet_a, fe!.wallet_b]).toContain(REAL_FUNDER);
    expect(r.examined).not.toContain(DUST_SENDER);
  });
});

describe("firstFunderOf caches only a pick no price could change", () => {
  const A = "0xaaa";
  const CEX = "0xcec";
  const LATER = "0x1a7e";
  const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
  const KONG = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb::kong::KONG";

  /** `from` credits `to` with `amount` raw of `coin`, as the earliest-transactions query returns it. */
  const inflow = (digest: string, from: string, to: string, amount: string, coin: string, at: string) => ({
    digest,
    sender: { address: from },
    effects: {
      timestamp: at,
      checkpoint: { sequenceNumber: 1 },
      balanceChanges: {
        nodes: [
          { owner: { address: from }, amount: `-${amount}`, coinType: { repr: coin } },
          { owner: { address: to }, amount, coinType: { repr: coin } },
        ],
      },
    },
  });

  /** 500 USDC from CEX made A exist; 2 SUI from LATER came afterwards. */
  const usdcThenSui = () =>
    router({
      earliest: (addr) =>
        addr === A
          ? page([
              inflow("0xusdc", CEX, A, "500000000", USDC, "2026-01-01T00:00:00.000Z"),
              inflow("0xsui", LATER, A, "2000000000", SUI_LONG, "2026-01-02T00:00:00.000Z"),
            ])
          : page([]),
    });

  it("keeps the USDC funder during an Aftermath outage, and caches nothing", async () => {
    // fetchAftermath answers an outage with an empty map, never a throw. The
    // USDC inflow is then accepted under the outage fallback, and a pick made
    // without prices is not written to the cache, which has no TTL.
    mockPrices.mockImplementation(async () => new Map());
    mockGqlQuery.mockImplementation(usdcThenSui());
    const r = await buildWalletEdges([A], { expand: false });
    expect(r.first_funders[A]).toBe(CEX);
    expect(mockSaveFirstFunder).not.toHaveBeenCalled();
    expect(r.notes.join(" ")).toMatch(/prices could not be read/i);
  });

  it("picks the USDC funder with prices up, and still does not cache a pick a price decided", async () => {
    mockPrices.mockImplementation(aftermathUp({ [USDC]: 1 }));
    mockGqlQuery.mockImplementation(usdcThenSui());
    const r = await buildWalletEdges([A], { expand: false });
    expect(r.first_funders[A]).toBe(CEX);
    expect(mockSaveFirstFunder).not.toHaveBeenCalled();
    expect(r.notes.join(" ")).not.toMatch(/prices could not be read/i);
  });

  it("does not cache a SUI pick made after an unpriced inflow was skipped", async () => {
    // The KONG grant has no price, so the 3 SUI that followed is the pick. A
    // later price for KONG would change it, so it is not cached.
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) =>
          addr === A
            ? page([
                inflow("7SumEF", CEX, A, "10000000000", KONG, "2024-09-26T05:56:22.186Z"),
                inflow("ET5Cey", CEX, A, "3000000000", SUI_LONG, "2024-09-27T16:18:05.865Z"),
              ])
            : page([]),
      }),
    );
    const r = await buildWalletEdges([A], { expand: false });
    expect(r.first_funders[A]).toBe(CEX);
    expect(mockSaveFirstFunder).not.toHaveBeenCalled();
  });

  it("caches a pick made from SUI alone", async () => {
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) =>
          addr === A ? page([inflow("0xsui", LATER, A, "2000000000", SUI_LONG, "2026-01-02T00:00:00.000Z")]) : page([]),
      }),
    );
    await buildWalletEdges([A], { expand: false });
    expect(mockSaveFirstFunder).toHaveBeenCalledTimes(1);
    expect(mockSaveFirstFunder.mock.calls[0]![2]).toBe("0xsui");
  });

  it("ignores cached future funding and does not cache a bounded first funder", async () => {
    const FIRST = "0xf01";
    mockGetCachedFirstFunder.mockReturnValue({
      funder_account: `sui:mainnet:0x${"0".repeat(61)}fa7`,
      digest: "cached-late",
    });
    const txs = [
      { checkpoint: 45, tx: payment("early", FIRST, A) },
      { checkpoint: 120, tx: payment("late", LATER, A) },
    ];
    for (const { checkpoint, tx } of txs) tx.effects.checkpoint.sequenceNumber = checkpoint;
    mockGqlQuery.mockImplementation(async (_query: string, vars: { afterCheckpoint?: number; beforeCheckpoint?: number }) =>
      page(txs
        .filter(({ checkpoint }) => checkpoint > (vars.afterCheckpoint ?? -1) && checkpoint < (vars.beforeCheckpoint ?? Infinity))
        .map(({ tx }) => tx)),
    );

    const bounded = await firstFunderOf(A, new Budget(10), 100);
    expect(bounded).toMatchObject({ funder: FIRST, digest: "early" });
    expect(mockGetCachedFirstFunder).not.toHaveBeenCalled();
    expect(mockSaveFirstFunder).not.toHaveBeenCalled();
    expect(mockGqlQuery.mock.calls[0]![0]).toContain("afterCheckpoint: $afterCheckpoint, beforeCheckpoint: $beforeCheckpoint");
    expect(mockGqlQuery.mock.calls[0]![1]).toMatchObject({ afterCheckpoint: 0, beforeCheckpoint: 100 });

    const beforeFirst = await firstFunderOf(A, new Budget(10), 45);
    expect(beforeFirst).toMatchObject({ funder: null, digest: null });
    expect(mockSaveFirstFunder).not.toHaveBeenCalled();
    expect(mockGqlQuery.mock.calls[1]![1]).toMatchObject({ afterCheckpoint: 0, beforeCheckpoint: 45 });

    const unbounded = await firstFunderOf(A, new Budget(10));
    expect(unbounded?.digest).toBe("cached-late");
    expect(mockGetCachedFirstFunder).toHaveBeenCalledTimes(1);
    expect(mockGqlQuery).toHaveBeenCalledTimes(2);
  });

  it("values a non-registry coin at its CoinMetadata decimals, not an assumed 9", async () => {
    // 100 of a 6-decimal coin at $0.05 is $5 of funding. Read at an assumed 9
    // decimals it would be $0.005 and skipped as below_usd_floor.
    const GAME = "0x9ab3c1e0d57f4a2b8c6d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d::gold::GOLD";
    coinDecimals[GAME] = 6;
    mockPrices.mockImplementation(aftermathUp({ [GAME]: 0.05 }));
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) =>
          addr === A
            ? page([
                inflow("0xgold", CEX, A, "100000000", GAME, "2026-01-01T00:00:00.000Z"),
                inflow("0xsui", LATER, A, "2000000000", SUI_LONG, "2026-01-02T00:00:00.000Z"),
              ])
            : page([]),
      }),
    );
    const r = await buildWalletEdges([A], { expand: false });
    expect(r.first_funders[A]).toBe(CEX);
    expect(mockSui.stateService.getCoinInfo).toHaveBeenCalledWith({ coinType: GAME });
  });
});

describe("bounded first funding grant shape", () => {
  it("does not judge an early grant using a later send burst", async () => {
    const address = "0xaaa";
    const funder = "0xf00d";
    const coin = "0xcafe::grant::GRANT";
    coinDecimals[coin] = 0;
    coinSupply[coin] = 1_000_000_000n;
    packagePublisher["0xcafe"] = funder;
    const grant = {
      digest: "grant",
      sender: { address: funder },
      effects: {
        timestamp: "2026-01-01T00:00:00.000Z",
        checkpoint: { sequenceNumber: 45 },
        balanceChanges: {
          nodes: [
            { owner: { address: funder }, amount: "-100000", coinType: { repr: coin } },
            { owner: { address }, amount: "100000", coinType: { repr: coin } },
          ]
        },
      },
    };
    const later = payment("later-sui", "0xbee", address);
    later.effects.checkpoint.sequenceNumber = 90;
    mockGqlQuery.mockImplementation(async (query: string, vars: { filter?: { beforeCheckpoint: number }; beforeCheckpoint?: number }) => {
      if (query.includes("TransactionFilter")) {
        const future = [payment("future-1", funder, "0xb1"), payment("future-2", funder, "0xb2"), payment("future-3", funder, "0xb3")];
        return {
          transactions: {
            pageInfo: { hasNextPage: false }, nodes: vars.filter!.beforeCheckpoint <= 100
              ? [] : future.map((tx) => ({ ...tx, effects: { balanceChanges: tx.effects.balanceChanges } }))
          }
        };
      }
      return page([grant, later].filter((tx) => tx.effects.checkpoint.sequenceNumber < (vars.beforeCheckpoint ?? Infinity)));
    });

    const result = await firstFunderOf(address, new Budget(10), 100);
    expect(result).toMatchObject({ funder, digest: "grant" });
    const windowRead = mockGqlQuery.mock.calls.find(([query]) => String(query).includes("TransactionFilter"));
    expect(windowRead?.[1].filter).toMatchObject({ sentAddress: funder, beforeCheckpoint: 100 });
    expect(mockSaveFirstFunder).not.toHaveBeenCalled();
  });
});

describe("a coin nobody prices counts as funding when no airdrop could send that much", () => {
  // Transactions 7SumEF… and ET5Cey… as mainnet returns them: the deployer
  // published KONG (1 decimal, supply 100,000,000,000 raw) and granted INSIDER
  // 10% of it a day before sending it 3 SUI. Aftermath quotes KONG at -1.
  const DEPLOYER = "0x70f1042521565aa5c3fb887f939ef05e8dee264cc11ee07735132691801d360d";
  const INSIDER = "0x7ea76fb3e64d7c4bcb1d0f57454810062beee1c81b8c0e3cede9a7e63886ef5b";
  const KONG_PKG = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb";
  const KONG = `${KONG_PKG}::kong::KONG`;
  const transfer = (digest: string, from: string, coin: string, amount: string, at: string) => ({
    digest,
    sender: { address: from },
    effects: {
      timestamp: at,
      checkpoint: { sequenceNumber: 1 },
      balanceChanges: {
        nodes: [
          { owner: { address: from }, amount: "-2095504", coinType: { repr: SUI_LONG } },
          { owner: { address: from }, amount: `-${amount}`, coinType: { repr: coin } },
          { owner: { address: INSIDER }, amount, coinType: { repr: coin } },
        ],
      },
    },
  });
  const grant = transfer("7SumEFmUMbBRv47a5A3MaMFeV31eoTxBrvET7uAhuicw", DEPLOYER, KONG, "10000000000", "2024-09-26T05:56:22.186Z");
  const gas = transfer("ET5CeyPRbNzQWUQXzAgnw7iPrurvBFmBPojptdBeSgwP", DEPLOYER, SUI_LONG, "3000000000", "2024-09-27T16:18:05.865Z");

  beforeEach(() => {
    coinDecimals[KONG] = 1;
    coinSupply[KONG] = 100_000_000_000n;
    packagePublisher[KONG_PKG] = DEPLOYER;
  });

  it("names the deployer's 10% KONG grant as the insider's first funding", async () => {
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) => (addr === INSIDER ? page([grant, gas]) : page([])),
      }),
    );
    const r = await buildWalletEdges([DEPLOYER, INSIDER], { expand: false });
    const fe = r.edges.find((e) => e.signal_types.includes("funding_edge"));
    expect(fe!.signals[0].digests).toEqual([grant.digest]);
    expect(r.first_funders[INSIDER]).toBe(DEPLOYER);
    // Judged on a supply read, which can change, so never cached.
    expect(mockSaveFirstFunder).not.toHaveBeenCalled();
  });

  /** The deployer's other sends of KONG around the inflow, as the window read returns them. */
  const windowOf = (sends: Array<{ to: string; amount: string }>) => ({
    transactions: {
      pageInfo: { hasNextPage: false },
      nodes: sends.map((p, i) => ({
        digest: `burst${i}`,
        effects: {
          balanceChanges: {
            nodes: [
              { owner: { address: DEPLOYER }, amount: `-${p.amount}`, coinType: { repr: KONG } },
              { owner: { address: p.to }, amount: p.amount, coinType: { repr: KONG } },
            ],
          },
        },
      })),
    },
  });
  const withWindow = (window: unknown, rest: ReturnType<typeof router>) => async (q: string, v: Record<string, string> = {}) =>
    String(q).includes("TransactionFilter") ? window : rest(q, v);

  it("still skips a publisher's spam airdrop of the same coin", async () => {
    // 0.01% of supply to this wallet, sent the same amount to 30 wallets in a burst.
    const airdrop = transfer("SpamDrop", DEPLOYER, KONG, "10000000", "2024-09-26T05:56:22.186Z");
    mockGqlQuery.mockImplementation(
      withWindow(
        windowOf(Array.from({ length: 30 }, (_, i) => ({ to: `0xd${i}`, amount: "10000000" }))),
        router({ earliest: (addr) => (addr === INSIDER ? page([airdrop, gas]) : page([])) }),
      ),
    );
    const r = await buildWalletEdges([DEPLOYER, INSIDER], { expand: false });
    const fe = r.edges.find((e) => e.signal_types.includes("funding_edge"));
    expect(fe!.signals[0].digests).toEqual([gas.digest]);
  });

  it("names a 0.01% grant sent to this wallet alone as its first funding", async () => {
    const small = transfer("SmallGrant", DEPLOYER, KONG, "10000000", "2024-09-26T05:56:22.186Z");
    mockGqlQuery.mockImplementation(
      withWindow(windowOf([]), router({ earliest: (addr) => (addr === INSIDER ? page([small, gas]) : page([])) })),
    );
    const r = await buildWalletEdges([DEPLOYER, INSIDER], { expand: false });
    const fe = r.edges.find((e) => e.signal_types.includes("funding_edge"));
    expect(fe!.signals[0].digests).toEqual([small.digest]);
  });

  it("keeps a 0.01% send spam when the same amount went to several wallets", async () => {
    const small = transfer("EvenList", DEPLOYER, KONG, "10000000", "2024-09-26T05:56:22.186Z");
    mockGqlQuery.mockImplementation(
      withWindow(
        windowOf([{ to: "0xd1", amount: "10000000" }, { to: "0xd2", amount: "10000000" }]),
        router({ earliest: (addr) => (addr === INSIDER ? page([small, gas]) : page([])) }),
      ),
    );
    const r = await buildWalletEdges([DEPLOYER, INSIDER], { expand: false });
    const fe = r.edges.find((e) => e.signal_types.includes("funding_edge"));
    expect(fe!.signals[0].digests).toEqual([gas.digest]);
  });

  it("marks the build partial when the grant's supply read fails, instead of naming the SUI in silence", async () => {
    mockSui.stateService.getCoinInfo.mockImplementation(async () => {
      throw new Error("RESOURCE_EXHAUSTED: 429");
    });
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) => (addr === INSIDER ? page([grant, gas]) : page([])),
      }),
    );
    const r = await buildWalletEdges([DEPLOYER, INSIDER], { expand: false });
    const fe = r.edges.find((e) => e.signal_types.includes("funding_edge"));
    expect(fe!.signals[0].digests).toEqual([gas.digest]);
    expect(r.truncated).toBe(true);
    expect(r.notes.join(" ")).toMatch(/supply or publisher of a coin nobody prices could not be read for 1 first-funding lookup/);
  });
});

describe("an unmeasured intermediary is excluded, never used as narrow", () => {
  const A = "0xaaa";
  const B = "0xbbb";
  const NARROW = "0x4a4";
  it("routes a budget-starved funder probe to excluded_intermediaries, not used", async () => {
    // Same shared-narrow-funder shape as the earlier "links two seeds" test,
    // but with a budget that covers phase 1 (first funders + profiling) and
    // leaves nothing for the funder's own popularity probe.
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
    const r = await buildWalletEdges([A, B], { expand: false, queryBudget: 4 });
    expect(r.edges).toHaveLength(0);
    expect(r.used_intermediaries.some((u) => u.address === NARROW)).toBe(false);
    const excludedEntry = r.excluded_intermediaries.find((e) => e.address === NARROW);
    expect(excludedEntry).toMatchObject({ role: "funder", observed_counterparties: 0 });
    expect(excludedEntry!.reason).toMatch(/budget ran out/i);
  });
});

describe("an unread reciprocal counterparty is excluded, never linked", () => {
  const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
  const S1 = "0x51aa";
  const S2 = "0x52bb";
  const MM = "0x3a3a";

  /** `seed` sells MM 100 USDC for 80 SUI in one transaction: value moves both ways. */
  const swapWithMaker = (seed: string) => ({
    digest: `swap-${seed}`,
    sender: { address: seed },
    gasInput: { gasSponsor: { address: seed } },
    effects: {
      balanceChanges: {
        nodes: [
          { owner: { address: seed }, amount: "-100000000", coinType: { repr: USDC } },
          { owner: { address: MM }, amount: "100000000", coinType: { repr: USDC } },
          { owner: { address: MM }, amount: "-80000000000", coinType: { repr: SUI } },
          { owner: { address: seed }, amount: "79997000000", coinType: { repr: SUI } },
        ],
      },
    },
  });

  /** MM pays 55 distinct addresses, so a probe that reads its payouts finds a service. */
  const makerPayouts = page(
    Array.from({ length: 55 }, (_, i) => payment(`mm-${i}`, MM, `0xc${i.toString(16).padStart(4, "0")}`)),
    true,
  );

  it("does not give a budget-starved market maker weight-1.0 reciprocal edges to both seeds", async () => {
    // queryBudget 4 covers the two first-funder lookups and the two seed
    // profiles, so the reciprocal probe of MM reads nothing, and MM must not
    // count as narrow with 0 observed.
    mockGqlQuery.mockImplementation(
      router({
        recent: (addr) => (addr === S1 || addr === S2 ? page([swapWithMaker(addr)]) : page([])),
        sent: (addr) => (addr === MM ? makerPayouts : page([])),
      }),
    );
    const r = await buildWalletEdges([S1, S2], { expand: false, queryBudget: 4 });
    expect(r.edges.filter((e) => e.signal_types.includes("reciprocal"))).toHaveLength(0);
    expect(r.used_intermediaries.some((u) => u.address === MM)).toBe(false);
    // Probed once, listed once, and the reason names the budget.
    const mm = r.excluded_intermediaries.filter((e) => e.address === MM);
    expect(mm).toHaveLength(1);
    expect(mm[0]).toMatchObject({ observed_counterparties: 0 });
    expect(mm[0]!.reason).toMatch(/budget ran out/i);
    expect(r.truncated).toBe(true);
  });

  it("still measures MM once for both seeds when the budget allows, and excludes it as a service", async () => {
    mockGqlQuery.mockImplementation(
      router({
        recent: (addr) => (addr === S1 || addr === S2 ? page([swapWithMaker(addr)]) : page([])),
        sent: (addr) => (addr === MM ? makerPayouts : page([])),
      }),
    );
    const r = await buildWalletEdges([S1, S2], { expand: false });
    expect(r.edges.filter((e) => e.signal_types.includes("reciprocal"))).toHaveLength(0);
    expect(r.excluded_intermediaries.filter((e) => e.address === MM)).toHaveLength(1);
    const sentProbes = mockGqlQuery.mock.calls.filter(([q, v]) => String(q).includes("sentAddress") && v?.addr === MM);
    expect(sentProbes).toHaveLength(1);
  });

  it("names a failed read as a read failure, not a budget stop, and marks the build partial", async () => {
    // The SENT probe for MM throws after the client's own retries, with most
    // of the budget unspent. Raising query_budget would not help.
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, string> = {}) => {
      if (String(query).includes("sentAddress") && vars.addr === MM) throw new Error("GraphQL HTTP 429");
      return router({ recent: (addr) => (addr === S1 || addr === S2 ? page([swapWithMaker(addr)]) : page([])) })(
        query,
        vars,
      );
    });
    const r = await buildWalletEdges([S1, S2], { expand: false });
    expect(r.edges.filter((e) => e.signal_types.includes("reciprocal"))).toHaveLength(0);
    const [mm] = r.excluded_intermediaries.filter((e) => e.address === MM);
    expect(mm!.reason).toMatch(/read .*failed/i);
    expect(mm!.reason).not.toMatch(/budget ran out/i);
    expect(r.truncated).toBe(true);
    expect(r.notes.join(" ")).toMatch(/failed/i);
  });

  it("names a failed funder read the same way", async () => {
    const NARROW = "0x4a4";
    const A = "0xaaa";
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, string> = {}) => {
      if (String(query).includes("sentAddress") && vars.addr === NARROW) throw new Error("GraphQL HTTP 503");
      return router({ earliest: (addr) => (addr === A ? page([payment("0xfa", NARROW, A)]) : page([])) })(query, vars);
    });
    const r = await buildWalletEdges([A], { expand: false });
    const [f] = r.excluded_intermediaries.filter((e) => e.address === NARROW);
    expect(f!.reason).toMatch(/read .*failed/i);
    expect(r.edges.filter((e) => e.signal_types.includes("funding_edge"))).toHaveLength(0);
    expect(r.truncated).toBe(true);
  });
});

describe("a popularity read that fails after its first page gives no verdict", () => {
  const A = "0xaaa";
  const B = "0xbbb";
  const CEX = "0xcec";
  /** An exchange withdrawal wallet's first SENT page: one recipient per transaction, older pages behind it. */
  const withdrawals = page(
    Array.from({ length: 50 }, (_, i) => payment(`0xw${i}`, CEX, `0xr${i}`)),
    true,
    "page2",
  );

  it("does not link two seeds through an exchange whose second SENT page threw", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, string> = {}) => {
      if (String(query).includes("sentAddress") && vars.addr === CEX && vars.before) throw new Error("GraphQL HTTP 429");
      return router({
        earliest: (addr) => (addr === A || addr === B ? page([payment("0xf" + addr, CEX, addr)]) : page([])),
        sent: (addr) => (addr === CEX ? withdrawals : page([])),
      })(query, vars);
    });
    const r = await buildWalletEdges([A, B], { expand: false });
    expect(r.edges.filter((e) => e.signal_types.some((s) => s === "cofunded" || s === "funding_edge"))).toHaveLength(0);
    expect(r.used_intermediaries.some((u) => u.address === CEX)).toBe(false);
    const [cex] = r.excluded_intermediaries.filter((e) => e.address === CEX);
    expect(cex).toMatchObject({ role: "funder", observed_counterparties: 50 });
    expect(cex!.reason).toMatch(/failed after 50 distinct counterparties were seen/);
    expect(r.truncated).toBe(true);
    expect(r.notes.join(" ")).toMatch(/popularity read\(s\) failed/);
  });

  it("reports a probe stopped by the budget after its first page as a provisional lower bound, not unmeasured", async () => {
    mockGqlQuery.mockImplementation(async () => withdrawals);
    const r = await probeRecipients(CEX, 50, new Budget(1));
    expect(r).toMatchObject({ popular: false, observed: 50, complete: false });
    expect(r.unmeasured).toBeUndefined();
  });

  it("keeps a popular verdict the pages read before the failure proved", async () => {
    mockGqlQuery.mockImplementation(async (_q: string, vars: Record<string, string> = {}) => {
      if (vars.before) throw new Error("GraphQL HTTP 429");
      return withdrawals;
    });
    const r = await probeRecipients(CEX, 10, new Budget(10));
    expect(r).toMatchObject({ popular: true });
    expect(r.unmeasured).toBeUndefined();
  });

  it("marks probeSponsored unmeasured when a later page throws", async () => {
    const sponsored = page(
      Array.from({ length: 50 }, (_, i) => payment(`0xs${i}`, `0x5${i}`, "0xee", "0xP")),
      true,
      "page2",
    );
    mockGqlQuery.mockImplementation(async (_q: string, vars: Record<string, string> = {}) => {
      if (vars.before) throw new Error("GraphQL HTTP 503");
      return sponsored;
    });
    const r = await probeSponsored("0xP", 50, new Budget(10));
    expect(r).toMatchObject({ popular: false, observed: 50, unmeasured: "read_failed" });
  });

  it("marks a probe unmeasured when a transaction's balance-change continuation fails", async () => {
    const changes = [
      { owner: { address: "0xF" }, amount: `-${60n * BigInt(ONE_SUI)}`, coinType: { repr: SUI } },
      ...Array.from({ length: 60 }, (_, i) => ({
        owner: { address: `0x${(i + 1).toString(16).padStart(64, "0")}` },
        amount: ONE_SUI,
        coinType: { repr: SUI },
      })),
    ];
    const conn = pagedTxConnection("batch", changes, "balanceChanges");
    mockGqlQuery.mockImplementation(async (q: string, v: Record<string, unknown>) => {
      if (conn.respond(q, v)) throw new Error("GraphQL HTTP 429");
      return page([{ digest: "batch", effects: { balanceChanges: conn.first } }]);
    });
    const r = await probeRecipients("0xF", 100, new Budget(100));
    expect(r).toMatchObject({ popular: false, observed: 49, complete: true, unmeasured: "read_failed" });
  });
});

describe("first funders are resolved before profiling spends the shared budget", () => {
  it("keeps every seed-to-seed funding edge even when the budget cannot also cover profiling", async () => {
    // firstFunderOf is cheap and runs for every seed before profiling (the
    // more expensive, lower-priority signal) spends a query, so no seed loses
    // its funding edge to the shared budget, whatever the input order.
    const FUNDER = "0xfeed";
    const collectors = ["0xc1", "0xc2", "0xc3", "0xc4"];
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) => (collectors.includes(addr) ? page([payment("0xf" + addr, FUNDER, addr)]) : page([])),
      }),
    );
    const r = await buildWalletEdges([FUNDER, ...collectors], { expand: false, queryBudget: 5 });
    const funded = new Set(
      r.edges
        .filter((e) => e.signal_types.includes("funding_edge"))
        .flatMap((e) => [e.wallet_a, e.wallet_b])
        .filter((a) => collectors.includes(a)),
    );
    expect(funded).toEqual(new Set(collectors));
    // The budget is too tight to also profile every seed; the order work
    // happens in is what keeps every funding edge.
    expect(r.truncated).toBe(true);
  });
});

describe("a sponsor that also first-funded the address it sponsors is an operator", () => {
  const OPERATOR = "0x7c8e";
  const dustAndSponsoredSend = (lookalike: string, victim: string) => [
    {
      digest: `dust-${lookalike}`,
      sender: { address: OPERATOR },
      gasInput: { gasSponsor: { address: OPERATOR } },
      effects: {
        balanceChanges: {
          nodes: [
            { owner: { address: OPERATOR }, amount: "-1533", coinType: { repr: SUI } },
            { owner: { address: lookalike }, amount: "1533", coinType: { repr: SUI } },
          ],
        },
      },
    },
    {
      digest: `fwd-${lookalike}`,
      sender: { address: lookalike },
      gasInput: { gasSponsor: { address: OPERATOR } },
      effects: {
        balanceChanges: {
          nodes: [
            { owner: { address: OPERATOR }, amount: "-100000", coinType: { repr: SUI } },
            { owner: { address: lookalike }, amount: "-2", coinType: { repr: SUI } },
            { owner: { address: victim }, amount: "2", coinType: { repr: SUI } },
          ],
        },
      },
    },
  ];

  it("links the operator to a lookalike it seeds and sponsors, even when the operator is itself a seed", async () => {
    // The dust (1533 MIST) is below the SUI funding floor, so it never
    // becomes `first_funders[LOOKALIKE]` and the ordinary funding_edge path
    // has nothing to build on. The operator relationship is real anyway.
    const LOOKALIKE = "0x6b74";
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) => (addr === LOOKALIKE ? page([dustAndSponsoredSend(LOOKALIKE, "0xvictim")[0]]) : page([])),
        recent: (addr) => (addr === LOOKALIKE ? page(dustAndSponsoredSend(LOOKALIKE, "0xvictim")) : page([])),
      }),
    );
    const r = await buildWalletEdges([OPERATOR, LOOKALIKE], { expand: false });
    expect(r.first_funders[LOOKALIKE]).toBeUndefined();
    expect(r.edges).toHaveLength(1);
    const [e] = r.edges;
    expect(e.signal_types).toEqual(["sponsor"]);
    expect([e.wallet_a, e.wallet_b].sort()).toEqual([LOOKALIKE, OPERATOR].sort());
    expect(e.signals[0].digests.sort()).toEqual([`dust-${LOOKALIKE}`, `fwd-${LOOKALIKE}`].sort());
    expect(e.weight).toBe(1);
  });

  it("links the operator to every lookalike it seeds and sponsors, without waiting on a popularity verdict", async () => {
    // Here the operator is discovered as a shared sponsor of both seeds, and
    // it is linked without waiting on a popularity verdict.
    const L1 = "0x6b74";
    const L2 = "0x5aad";
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) =>
          addr === L1 || addr === L2 ? page([dustAndSponsoredSend(addr, "0xvictim")[0]]) : page([]),
        recent: (addr) => (addr === L1 || addr === L2 ? page(dustAndSponsoredSend(addr, "0xvictim")) : page([])),
      }),
    );
    const r = await buildWalletEdges([L1, L2], { expand: false });
    const operatorEdges = r.edges.filter((e) => [e.wallet_a, e.wallet_b].includes(OPERATOR));
    expect(operatorEdges).toHaveLength(2);
    expect(new Set(operatorEdges.flatMap((e) => [e.wallet_a, e.wallet_b]))).toEqual(new Set([OPERATOR, L1, L2]));
    // Proven an operator for these seeds, so it is neither excluded nor used.
    expect(r.excluded_intermediaries.some((e) => e.address === OPERATOR)).toBe(false);
    expect(r.used_intermediaries.some((u) => u.address === OPERATOR)).toBe(false);
  });
});

describe("a public gas station's gas row does not make it an operator", () => {
  const GAS_STATION = "0x9a5c";

  /** `payer` sends `seed` 5 SUI in a transaction GAS_STATION sponsors. */
  const sponsoredPayment = (seed: string, payer: string) => [
    {
      digest: `pay-${seed}`,
      sender: { address: payer },
      gasInput: { gasSponsor: { address: GAS_STATION } },
      effects: {
        balanceChanges: {
          nodes: [
            { owner: { address: payer }, amount: "-5000000000", coinType: { repr: SUI } },
            { owner: { address: seed }, amount: "5000000000", coinType: { repr: SUI } },
            // The sponsor's own SUI change is its gas cost, never a payment.
            { owner: { address: GAS_STATION }, amount: "-2000000", coinType: { repr: SUI } },
          ],
        },
      },
    },
  ];

  /** GAS_STATION sponsoring `n` distinct strangers' own transactions. */
  const manySponsoredSenders = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      digest: `relay-${i}`,
      sender: { address: `0xdeaf${i.toString(16).padStart(4, "0")}` },
      gasInput: { gasSponsor: { address: GAS_STATION } },
      effects: { balanceChanges: { nodes: [] } },
    }));

  it("does not link two seeds through a public gas station that merely sponsored the unrelated payments crediting them", async () => {
    // S1 and S2 are each paid 5 SUI by different, unrelated senders, in
    // transactions GAS_STATION sponsors, and GAS_STATION sponsors 55 senders
    // (a public relayer). Its own gas row must not put it in `paidBy`, where,
    // paired with `sponsors`, it would become an "operator" edge at weight 1.0
    // that skips the popularity probe.
    const S1 = "0x51aa";
    const S2 = "0x52bb";
    const PAYER1 = "0xea91";
    const PAYER2 = "0xea92";
    mockGqlQuery.mockImplementation(
      router({
        earliest: (addr) =>
          addr === S1 ? page(sponsoredPayment(S1, PAYER1)) : addr === S2 ? page(sponsoredPayment(S2, PAYER2)) : page([]),
        recent: (addr) =>
          addr === S1
            ? page(sponsoredPayment(S1, PAYER1))
            : addr === S2
              ? page(sponsoredPayment(S2, PAYER2))
              : addr === GAS_STATION
                ? page(manySponsoredSenders(55))
                : page([]),
      }),
    );
    const r = await buildWalletEdges([S1, S2], { expand: false });
    const operatorEdges = r.edges.filter(
      (e) => [e.wallet_a, e.wallet_b].includes(GAS_STATION) && e.signal_types.includes("sponsor") && e.weight === 1,
    );
    expect(operatorEdges).toHaveLength(0);
    // The real funders are the unrelated senders, not the gas station.
    expect(r.first_funders[S1]).toBe(PAYER1);
    expect(r.first_funders[S2]).toBe(PAYER2);
    // Measured and correctly excluded as a wide public relayer.
    expect(r.excluded_intermediaries.some((e) => e.address === GAS_STATION)).toBe(true);
  });
});

describe("a sponsor and a funder serving the same wallets from two addresses", () => {
  const W1 = "0xa01";
  const W2 = "0xa02";
  const FUNDER = "0xf0f";
  const SPONSOR = "0x5b0";
  const others = Array.from({ length: 58 }, (_, i) => `0xc${i.toString(16).padStart(2, "0")}`);
  /** A transaction `sender` sent with SPONSOR paying its gas. */
  const sponsored = (digest: string, sender: string) => ({
    digest,
    sender: { address: sender },
    gasInput: { gasSponsor: { address: SPONSOR } },
    effects: { balanceChanges: { nodes: [] } },
  });

  /**
   * FUNDER first funds both seeds, and pays 8 addresses (narrow) or 60 (an
   * exchange hot wallet). SPONSOR pays gas for 60 wallets and funds none.
   */
  function chain(firstFunderOfOther: (i: number) => string, funderPays = 8) {
    return router({
      earliest: (addr) => {
        if (addr === W1 || addr === W2) return page([payment(`0xfund${addr}`, FUNDER, addr)]);
        const i = others.indexOf(addr);
        return i >= 0 ? page([payment(`0xfund${addr}`, firstFunderOfOther(i), addr)]) : page([]);
      },
      recent: (addr) => {
        if (addr === W1 || addr === W2) return page([sponsored(`0xgas${addr}`, addr)]);
        if (addr === SPONSOR) return page([...others, W1, W2].map((a) => sponsored(`0xgas${a}`, a)), true);
        return page([]);
      },
      sent: (addr) =>
        addr === FUNDER
          ? page(Array.from({ length: funderPays }, (_, i) => payment(`0xpay${i}`, FUNDER, `0xe${i}`)), funderPays > 50)
          : page([]),
    });
  }

  it("links the sponsor to the seeds and their funder when the wallets it serves share that funder", async () => {
    mockGqlQuery.mockImplementation(chain(() => FUNDER));
    const r = await buildWalletEdges([W1, W2], { expand: false });
    const pair = (a: string, b: string) => r.edges.find((e) => [e.wallet_a, e.wallet_b].sort().join() === [a, b].sort().join());
    expect(pair(SPONSOR, FUNDER)?.weight).toBe(1);
    expect(pair(SPONSOR, W1)?.weight).toBe(1);
    expect(pair(SPONSOR, W2)?.weight).toBe(1);
    const used = r.used_intermediaries.find((u) => u.address === SPONSOR);
    expect(used?.role_split).toMatchObject({ funder: FUNDER, wallets_checked: 6, first_funded_by_funder: 6, linked: true });
    expect(r.excluded_intermediaries.map((e) => e.address)).not.toContain(SPONSOR);
  });

  it("keeps two users of an exchange-funded, relayer-sponsored wallet unlinked", async () => {
    // Every wallet the relayer serves withdrew first from the same exchange hot wallet.
    mockGqlQuery.mockImplementation(chain(() => FUNDER, 60));
    const r = await buildWalletEdges([W1, W2], { expand: false });
    expect(r.edges.filter((e) => e.weight >= 1)).toEqual([]);
    const excluded = r.excluded_intermediaries.find((e) => e.address === SPONSOR);
    expect(excluded?.role_split).toMatchObject({ funder: FUNDER, wallets_checked: 0, linked: false });
    expect(excluded?.role_split?.not_checked).toBeTruthy();
  });

  it("keeps a relayer whose users were funded by others out, and says what it measured", async () => {
    mockGqlQuery.mockImplementation(chain((i) => (i < 1 ? FUNDER : `0xd${i.toString(16).padStart(2, "0")}`)));
    const r = await buildWalletEdges([W1, W2], { expand: false });
    expect(r.edges.some((e) => e.signals.some((s) => s.weight >= 1 && (e.wallet_a === SPONSOR || e.wallet_b === SPONSOR)))).toBe(false);
    const excluded = r.excluded_intermediaries.find((e) => e.address === SPONSOR);
    expect(excluded?.role_split).toMatchObject({ funder: FUNDER, wallets_checked: 6, first_funded_by_funder: 1, linked: false });
  });
});

describe("consolidation probe", () => {
 const COLLECTOR = "0xc011";
 const payers = Array.from({ length: 6 }, (_, i) => `0xa${i}`);
 const sweeps = payers.map((payer, i) => ({
  ...payment(`sweep-${i}`, payer, COLLECTOR),
  effects: {
   ...payment(`sweep-${i}`, payer, COLLECTOR).effects,
   timestamp: `2025-03-27T10:${String(i).padStart(2, "0")}:00.000Z`,
   checkpoint: { sequenceNumber: i + 10 },
   balanceChanges: {
    nodes: [
     { owner: { address: payer }, amount: `-${(i + 1) * 1_000_000_000}`, coinType: { repr: SUI } },
     { owner: { address: COLLECTOR }, amount: `${(i + 1) * 1_000_000_000}`, coinType: { repr: SUI } },
    ],
   },
  },
 }));

 /** What each payer held before its sweep (a test seam): its one funding transaction. */
 let funded = (i: number) => BigInt((i + 1) * 1_000_000_000);

 function route(service: "narrow" | "popular" | "deposit" | "failed") {
  cohortFixture.enabled = true;
  mockGqlQuery.mockImplementation(async (query: string, vars: { addr?: string; oldest?: boolean }) => {
   if (query.includes("old: transactions")) {
    return vars.oldest ? { old: { nodes: sweeps, pageInfo: { hasNextPage: false } } } :
     { recent: { nodes: sweeps, pageInfo: { hasPreviousPage: false } } };
   }
   if (query.includes("beforeCheckpoint: $through")) {
    const i = payers.indexOf(vars.addr!);
    return page([{
     ...payment(`fund-${i}`, "0xf", payers[i]),
     effects: {
      ...payment(`fund-${i}`, "0xf", payers[i]).effects,
      checkpoint: { sequenceNumber: 1 },
      balanceChanges: {
       nodes: [
        { owner: { address: payers[i] }, amount: `${funded(i)}`, coinType: { repr: SUI } },
       ]
      },
     },
    }, sweeps[i]]);
   }
   if (query.includes("sentAddress")) {
    if (service === "failed") throw new Error("unavailable");
    return page(service === "popular" ?
     Array.from({ length: 51 }, (_, i) => payment(`paid-${i}`, COLLECTOR, `0x${i.toString(16).padStart(3, "0")}`)) :
     service === "deposit" ? [payment("out-1", COLLECTOR, "0xreserve"), payment("out-2", COLLECTOR, "0xreserve")] : []);
   }
   if (query.includes("first: $first")) return { transactions: { nodes: [] } };
   if (query.includes("affectedAddress") && vars.addr === COLLECTOR) return page(sweeps);
   return page([]);
  });
 }

 it("links a collector to six sweepers with their own transaction digests, as leads below the merge floor", async () => {
  route("narrow");
  const result = await buildWalletEdges([COLLECTOR], { expand: true });
  const swept = result.edges.filter((edge) => edge.signal_types.includes("consolidation"));
  expect(swept).toHaveLength(6);
  expect(swept.map((edge) => edge.signals.find((s) => s.type === "consolidation")?.digests[0]).sort())
   .toEqual(sweeps.map((tx) => tx.digest).sort());
  expect(swept.map((edge) => edge.weight)).toEqual(Array(6).fill(SIGNAL_WEIGHTS.consolidation));
  expect(SIGNAL_WEIGHTS.consolidation).toBeLessThan(1);
  expect(clusterEdges(swept).clusters).toEqual([]);
  expect(result.examined).toEqual([COLLECTOR, ...payers].sort());
 });

 it("merges a sweeper with its collector when another signal corroborates it", async () => {
  route("narrow");
  const result = await buildWalletEdges([COLLECTOR], { expand: true });
  const edges = new EdgeSet();
  for (const edge of result.edges) for (const s of edge.signals) edges.add(s.type, edge.wallet_a, edge.wallet_b, s.detail, s.digests, s.via, s.weight);
  edges.add("cofunded", COLLECTOR, payers[0], "shared narrow funder", [], "0xfunder");
  expect(clusterEdges(edges.edges()).clusters.map((c) => c.members)).toEqual([[COLLECTOR, payers[0]].sort()]);
 });

 it("accepts a sender's small storage rebate without counting an unrelated payment", async () => {
  // The payer's whole balance is 0.99978 SUI; with the rebate the collector receives 1 SUI.
  const debit = sweeps[0].effects.balanceChanges.nodes[0];
  const original = { amount: debit.amount, funded };
  debit.amount = "-999781760";
  funded = (i) => (i === 0 ? 999_781_760n : original.funded(i));
  try {
   route("narrow");
   const result = await buildWalletEdges([COLLECTOR], { expand: true });
   const swept = result.edges.filter((edge) => edge.signal_types.includes("consolidation"));
   expect(swept).toHaveLength(6);
   expect(swept.map((edge) => edge.weight)).toEqual(Array(6).fill(SIGNAL_WEIGHTS.consolidation));
  } finally {
   debit.amount = original.amount;
   funded = original.funded;
  }
 });

 it("leaves near-equal payments without a full-balance sweep below the merge floor", async () => {
  // Each payer holds 10 SUI and pays 1 SUI: six equal payments, none a sweep.
  const original = funded;
  funded = () => 10_000_000_000n;
  try {
   const edges = await consolidationEdgesWith((_, payer) => ({
    nodes: [
     { owner: { address: payer }, amount: "-1000000000", coinType: { repr: SUI } },
     { owner: { address: COLLECTOR }, amount: "1000000000", coinType: { repr: SUI } },
    ],
   }));
   expect(edges).toHaveLength(6);
   expect(edges.map((edge) => edge.weight)).toEqual(Array(6).fill(EQUAL_AMOUNT_CONSOLIDATION_WEIGHT));
   expect(clusterEdges(edges).clusters).toEqual([]);
  } finally {
   funded = original;
  }
 });

 it("keeps repeat-payee deposit collectors out of a merge", async () => {
  route("deposit");
  const result = await buildWalletEdges([COLLECTOR]);
  expect(result.edges.filter((edge) => edge.signal_types.includes("consolidation"))).toEqual([]);
  expect(result.excluded_intermediaries.find((entry) => entry.address === COLLECTOR)?.reason).toMatch(/deposit address/);
 });

 it("excludes a popular collector and an unread collector rather than treating either as narrow", async () => {
  route("popular");
  const popular = await buildWalletEdges([COLLECTOR]);
  expect(popular.edges.filter((edge) => edge.signal_types.includes("consolidation"))).toEqual([]);
  expect(popular.excluded_intermediaries).toEqual(expect.arrayContaining([expect.objectContaining({ address: COLLECTOR, role: "collector" })]));
  route("failed");
  const failed = await buildWalletEdges([COLLECTOR]);
  expect(failed.edges.filter((edge) => edge.signal_types.includes("consolidation"))).toEqual([]);
  expect(failed.used_intermediaries.some((entry) => entry.address === COLLECTOR)).toBe(false);
  expect(failed.truncated).toBe(true);
 });

 it("does not promote a collector when the shared budget ran out", async () => {
  route("narrow");
  const result = await buildWalletEdges([COLLECTOR], { queryBudget: 3 });
  expect(result.edges.filter((edge) => edge.signal_types.includes("consolidation"))).toEqual([]);
  expect(result.used_intermediaries.some((entry) => entry.address === COLLECTOR)).toBe(false);
  expect(result.truncated).toBe(true);
 });

 it("does not make the budget-starved result depend on seed order", async () => {
  route("narrow");
  const first = await buildWalletEdges([COLLECTOR, payers[0]], { expand: false, queryBudget: 3 });
  route("narrow");
  const reversed = await buildWalletEdges([payers[0], COLLECTOR], { expand: false, queryBudget: 3 });
  expect(first.edges).toEqual(reversed.edges);
  expect(first.excluded_intermediaries).toEqual(reversed.excluded_intermediaries);
  expect(first.truncated).toBe(true);
 });

 /** Rewrite every sweep's balance changes and gas sponsor for one test. */
 async function consolidationEdgesWith(
  rewrite: (i: number, payer: string) => { nodes: Array<{ owner: { address: string }; amount: string; coinType: { repr: string } }>; sponsor?: string },
 ) {
  const saved = sweeps.map((tx) => ({ nodes: tx.effects.balanceChanges.nodes, gasInput: tx.gasInput }));
  try {
   sweeps.forEach((tx, i) => {
    const { nodes, sponsor } = rewrite(i, payers[i]);
    tx.effects.balanceChanges.nodes = nodes;
    if (sponsor) tx.gasInput = { gasSponsor: { address: sponsor } };
   });
   route("narrow");
   const result = await buildWalletEdges([COLLECTOR], { expand: true });
   return result.edges.filter((edge) => edge.signal_types.includes("consolidation"));
  } finally {
   sweeps.forEach((tx, i) => {
    tx.effects.balanceChanges.nodes = saved[i].nodes;
    tx.gasInput = saved[i].gasInput;
   });
  }
 }

 it("does not read a fee taken from equal-sized trades as a sweep", async () => {
  // Six traders each spend 100 SUI into a pool; the collector takes a 0.06 SUI fee from each.
  const edges = await consolidationEdgesWith((_, payer) => ({
   nodes: [
    { owner: { address: payer }, amount: "-100060000000", coinType: { repr: SUI } },
    { owner: { address: COLLECTOR }, amount: "60000000", coinType: { repr: SUI } },
   ],
  }));
  expect(edges).toEqual([]);
 });

 it("measures the sweep against the balance before it, including what it paid others", async () => {
  // Each payer held 1.05x and sent 0.9x to the collector and 0.1x elsewhere: 86% of its balance.
  const original = funded;
  funded = (i) => (BigInt((i + 1) * 1_000_000_000) * 105n) / 100n;
  try {
   const edges = await consolidationEdgesWith((i, payer) => {
    const spent = BigInt((i + 1) * 1_000_000_000);
    return {
     nodes: [
      { owner: { address: payer }, amount: `-${spent}`, coinType: { repr: SUI } },
      { owner: { address: COLLECTOR }, amount: `${(spent * 9n) / 10n}`, coinType: { repr: SUI } },
      { owner: { address: "0xe1sewhere" }, amount: `${spent / 10n}`, coinType: { repr: SUI } },
     ],
    };
   });
   expect(edges).toEqual([]);
  } finally {
   funded = original;
  }
 });

 it("does not count the collector's storage rebate as sponsor of the payers' transactions", async () => {
  const edges = await consolidationEdgesWith((_, payer) => ({
   nodes: [
    { owner: { address: payer }, amount: "-20100000", coinType: { repr: SUI } },
    { owner: { address: COLLECTOR }, amount: "20000000", coinType: { repr: SUI } },
   ],
   sponsor: COLLECTOR,
  }));
  expect(edges).toEqual([]);
 });

 it("does not link senders of equal dust in a priced coin", async () => {
  const usdc = `0x${"d".repeat(64)}::usdc::USDC`;
  coinDecimals[usdc] = 6;
  mockPrices.mockImplementation(aftermathUp({ [usdc]: 1 }));
  const sweepsOf = (amount: string) => consolidationEdgesWith((_, payer) => ({
   nodes: [
    { owner: { address: payer }, amount: `-${amount}`, coinType: { repr: usdc } },
    { owner: { address: COLLECTOR }, amount, coinType: { repr: usdc } },
   ],
  }));
  expect(await sweepsOf("10000000")).toHaveLength(6);
  const edges = await sweepsOf("10000");
  expect(edges).toEqual([]);
 });
});
