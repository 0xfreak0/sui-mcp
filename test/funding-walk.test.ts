import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Where the funding walk stops, and what the batch counts as shared.
 *
 * Shapes follow the Nemo exploit replay: the attacker's first funder paid
 * hundreds of addresses (build_wallet_edges excludes it as a distributor), yet
 * the walk went on through that funder's own 2023 ancestry and called the
 * result a narrow, meaningful origin. In the batch, those ancestors were then
 * counted as shared funders of the attacker and of the funder itself, one
 * chain counted twice. A third wallet's direct payments to the attacker were
 * invisible because neither was its first funding.
 */

const { gqlQuery, measureFanout } = vi.hoisted(() => ({ gqlQuery: vi.fn(), measureFanout: vi.fn() }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {}, archive: {} }));
vi.mock("../src/utils/price-providers.js", () => ({ pricesForRanking: async () => new Map() }));
vi.mock("../src/utils/fanout.js", () => ({ measureFanout }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false }));
vi.mock("../src/utils/store.js", () => ({ getCachedFirstFunder: () => null, saveFirstFunder: () => false }));
vi.mock("../src/utils/identity.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  describeAddresses: async (addrs: string[]) =>
    new Map(addrs.map((a) => [a, { address: a, kind: "wallet" as const }])),
  identityNote: () => undefined,
}));

const { registerFundingTools } = await import("../src/tools/funding.js");
const tools = new Map<string, Function>();
registerFundingTools({ tool: (n: string, _d: string, _s: unknown, h: Function) => tools.set(n, h) } as never);
const run = async (name: string, args: Record<string, unknown>) =>
  JSON.parse((await tools.get(name)!(args)).content.at(-1).text);

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const ATTACKER = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
const DISTRIBUTOR = "0x1f7b27844f2c4a0262b2c481f7ab956d10ace524c5a7b06c3742cfb8701db714";
const PAYER = "0x9e5590502b03b0172d0b78f4ddbaebd48dcaf7e2a7778ba18c0de2110bd6aacb";
const ANCESTOR = "0xcba50b558b18b758a8f962b3feeea71f38a58f0aa18d61426d29725b86a9cdb1";
const ANCESTOR2 = "0x7d1604b58f27e33be2506cae9169936d2986f991fdf6257e0ce790963fd1ba7b";
const PAYER_FUNDER = "0x861284f9839a0334f8bbdbc4d9b254769ca74a5139636de9785ab2b7814dca9c";

const bc = (address: string, amount: string) => ({ amount, owner: { address }, coinType: { repr: SUI } });
const conn = <T>(nodes: T[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });

/** A transaction as the funding query selects it. */
const fundingTx = (digest: string, sender: string, to: string, amount: string, at: string) => ({
  digest,
  sender: { address: sender },
  gasInput: { gasSponsor: { address: sender } },
  effects: {
    timestamp: at,
    checkpoint: { sequenceNumber: 1 },
    balanceChanges: conn([bc(sender, `-${amount}`), bc(to, amount)]),
  },
});

/** Earliest transactions per address: who funded whom. */
let earliest: Record<string, unknown[]>;
/** Distinct recipients each address paid, as its outgoing transactions show. */
let paid: Record<string, string[]>;
/** Transactions `payer` sent that affected `payee`, keyed `payer>payee`. */
let pairs: Record<string, unknown[]>;

beforeEach(() => {
  vi.clearAllMocks();
  earliest = {
    [ATTACKER]: [fundingTx("FjkAurXT", DISTRIBUTOR, ATTACKER, "39447717250", "2025-09-07T09:17:14.328Z")],
    [DISTRIBUTOR]: [fundingTx("GPcaHy8Q", ANCESTOR, DISTRIBUTOR, "1498990120", "2023-04-28T00:00:00.000Z")],
    [ANCESTOR]: [fundingTx("DyTQ1vSu", ANCESTOR2, ANCESTOR, "1500000000", "2023-04-27T00:00:00.000Z")],
    [ANCESTOR2]: [],
    [PAYER]: [fundingTx("PayerFnd", PAYER_FUNDER, PAYER, "40000000000", "2025-09-07T14:00:00.000Z")],
    [PAYER_FUNDER]: [],
  };
  paid = { [DISTRIBUTOR]: Array.from({ length: 261 }, (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}`) };
  pairs = {};
  measureFanout.mockImplementation(async (address: string) => ({
    address,
    recipient_count: 3,
    sender_count: 1,
    counterparty_count: 4,
    coin_type_count: 1,
    out_in_ratio: 3,
    flow_shape: "disperser",
    scanned_transactions: 300,
    truncated: true,
    classification: "narrow",
    classification_provisional: true,
    interpretation: "Narrow within the window scanned.",
  }));

  gqlQuery.mockImplementation(async (q: string, vars: Record<string, unknown> = {}) => {
    const query = String(q);
    if (query.startsWith("query{p0:")) {
      // Aliased pairwise payment check.
      const out: Record<string, unknown> = {};
      for (const m of query.matchAll(/(p\d+):transactions\(filter:\{sentAddress:"(0x[0-9a-f]+)",affectedAddress:"(0x[0-9a-f]+)"\}/g)) {
        out[m[1]] = conn(pairs[`${m[2]}>${m[3]}`] ?? []);
      }
      return out;
    }
    if (query.includes("sentAddress")) {
      // Popularity probe: one page, newest first, one recipient per transaction.
      const recipients = paid[vars.addr as string] ?? [];
      return {
        transactions: {
          nodes: recipients.map((r, i) => ({
            digest: `sent${i}`,
            effects: { balanceChanges: conn([bc(vars.addr as string, "-1000000000"), bc(r, "1000000000")]) },
          })),
          pageInfo: { hasPreviousPage: false, startCursor: null },
        },
      };
    }
    if (query.includes("affectedAddress: $addr")) {
      return { transactions: { nodes: earliest[vars.addr as string] ?? [] } };
    }
    return { transactionEffects: null };
  });
});

describe("find_funding_source stops at a service-scale funder", () => {
  it("ends the walk at a funder that paid more than 50 addresses", async () => {
    const d = await run("find_funding_source", { address: ATTACKER });
    expect(d.origin.address).toBe(DISTRIBUTOR);
    expect(d.hops).toBe(1);
    expect(d.stop_reason).toContain("high-fanout distributor");
    expect(d.stop_reason).toContain("carries no attribution");
    expect(d.chain[0].funder_popularity).toMatchObject({ popular: true, limit: 50 });
    // The distributor's own ancestry is never walked, let alone called an origin.
    expect(JSON.stringify(d)).not.toContain(ANCESTOR);
  });

  it("does not re-measure a hub origin with a window that could call it narrow", async () => {
    const d = await run("find_funding_source", { address: ATTACKER });
    expect(measureFanout).not.toHaveBeenCalled();
    expect(d.origin_fanout).toBeUndefined();
    expect(d.origin_popularity).toMatchObject({ popular: true });
  });

  it("walks on through a narrow funder and says how far its probe got", async () => {
    const d = await run("find_funding_source", { address: DISTRIBUTOR, max_hops: 2 });
    expect(d.chain.map((s: { funded_by: string }) => s.funded_by)).toEqual([ANCESTOR, ANCESTOR2]);
    expect(d.chain[0].funder_popularity).toMatchObject({ popular: false, observed_recipients: 0, scan_complete: true });
  });
});

describe("find_funding_source reports what a dead end saw", () => {
  // A relay wallet that runs on its operator's address balance: its inflows
  // are ~1,900 MIST and every transaction it sends has the operator as sponsor.
  const RELAY = "0xb71effa1cc4425928e0bda7c3b690a356245e705b01b5380b5d4d1a3497c1d47";
  const OPERATOR = "0x7c8e2c0000000000000000000000000000000000000000000000000000000000";
  const sent = (digest: string) => ({
    digest,
    sender: { address: RELAY },
    gasInput: { gasSponsor: { address: OPERATOR } },
    effects: {
      timestamp: "2026-09-01T00:00:00.000Z",
      checkpoint: { sequenceNumber: 2 },
      balanceChanges: conn([bc(OPERATOR, "-100000"), bc(RELAY, "-1847"), bc(PAYER, "1847")]),
    },
  });

  it("keeps the skipped dust and names the gas sponsor", async () => {
    earliest[RELAY] = [
      fundingTx("FS8u6Lub", OPERATOR, RELAY, "1847", "2026-09-01T00:00:00.000Z"),
      sent("D7VqRJxX"),
      fundingTx("14MmbE4g", OPERATOR, RELAY, "1987", "2026-09-01T00:00:01.000Z"),
      sent("ELssxy2E"),
    ];
    const d = await run("find_funding_source", { address: RELAY, max_hops: 1 });
    expect(d.hops).toBe(0);
    expect(d.dust_skipped.map((s: { digest: string }) => s.digest)).toEqual(["FS8u6Lub", "14MmbE4g"]);
    expect(d.sponsored_by).toEqual([{ address: RELAY, sponsor: OPERATOR, transactions: 2, first_digest: "D7VqRJxX" }]);
    expect(d.stop_reason).toContain("sponsored_by");
  });
});

describe("find_funding_sources counts each chain once", () => {
  it("does not count a subject's own ancestry as shared with the subject it funded", async () => {
    // DISTRIBUTOR is a subject here and, for this test, narrow: the attacker's
    // chain passes through it, so its ancestors are reached twice.
    paid[DISTRIBUTOR] = [ATTACKER];
    const d = await run("find_funding_sources", { addresses: [ATTACKER, DISTRIBUTOR], measure_fanout: false });
    expect(d.shared_funders).toEqual([]);
    expect(d.subject_funded_subject).toMatchObject([{ funder: DISTRIBUTOR, funded: ATTACKER }]);
  });

  it("does not let a hub's measured window call it narrow", async () => {
    earliest[PAYER] = [fundingTx("PayerFnd", DISTRIBUTOR, PAYER, "40000000000", "2025-09-07T14:00:00.000Z")];
    const d = await run("find_funding_sources", { addresses: [ATTACKER, PAYER] });
    const hub = d.shared_funders.find((f: { funder: string }) => f.funder === DISTRIBUTOR);
    expect(hub.funder_popularity).toMatchObject({ popular: true });
    expect(hub.fanout.interpretation).not.toContain("Narrow");
    expect(hub.fanout.interpretation).toContain("more than 50 distinct addresses");
  });
});

describe("find_funding_sources reports every payment between subjects", () => {
  it("lists a payment that was not the payee's first funding", async () => {
    pairs[`${PAYER}>${ATTACKER}`] = [
      {
        digest: "AgicqTF1",
        effects: {
          timestamp: "2025-09-07T15:04:00.000Z",
          balanceChanges: conn([bc(PAYER, "-39342495880"), bc(ATTACKER, "39342495880")]),
        },
      },
    ];
    const d = await run("find_funding_sources", {
      addresses: [ATTACKER, DISTRIBUTOR, PAYER],
      measure_fanout: false,
    });
    expect(d.subject_paid_subject).toEqual([
      {
        payer: PAYER,
        payee: ATTACKER,
        digest: "AgicqTF1",
        timestamp: "2025-09-07T15:04:00.000Z",
        received: ["39.34249588 SUI"],
      },
    ]);
    expect(d.subject_payment_scope).toMatchObject({ pairs_checked: 6 });
    // A first funding found by the walk is marked, not repeated as news.
    pairs[`${DISTRIBUTOR}>${ATTACKER}`] = [
      {
        digest: "FjkAurXT",
        effects: {
          timestamp: "2025-09-07T09:17:14.328Z",
          balanceChanges: conn([bc(DISTRIBUTOR, "-39447717250"), bc(ATTACKER, "39447717250")]),
        },
      },
    ];
    const d2 = await run("find_funding_sources", {
      addresses: [ATTACKER, DISTRIBUTOR, PAYER],
      measure_fanout: false,
    });
    expect(d2.subject_paid_subject.find((p: { digest: string }) => p.digest === "FjkAurXT").first_funding).toBe(true);
  });

  it("does not call a transaction the payer signed a payment when the payee gained nothing", async () => {
    pairs[`${PAYER}>${ATTACKER}`] = [
      {
        digest: "touch",
        effects: { timestamp: "2025-09-07T15:05:00.000Z", balanceChanges: conn([bc(PAYER, "-1000")]) },
      },
    ];
    const d = await run("find_funding_sources", { addresses: [ATTACKER, PAYER], measure_fanout: false });
    expect(d.subject_paid_subject).toBeUndefined();
    expect(d.subject_payment_scope).toMatchObject({ pairs_checked: 2 });
  });
});
