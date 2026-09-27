import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockClient } from "./helpers/mock-grpc.js";

/**
 * Where the funding walk stops, and what the batch counts as shared.
 *
 * The subject's first funder pays hundreds of addresses, which
 * build_wallet_edges excludes as a distributor, so the walk stops there and
 * does not report that funder's own ancestry as a narrow origin. In the batch,
 * ancestors reached through the subject and through its funder are one chain
 * and count once. A payment between two subjects is reported even when it was
 * not the payee's first funding.
 */

const { gqlQuery, measureFanout, pricesForRanking } = vi.hoisted(() => ({
  gqlQuery: vi.fn(),
  measureFanout: vi.fn(),
  pricesForRanking: vi.fn(),
}));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery }));
// CoinMetadata reads for the decimals tier and the treasury's total supply:
// NOT_FOUND unless a test registers the coin in `coinDecimals` (and
// `coinSupply` for a coin whose TreasuryCap the service tracks), as the
// service answers for a type with no metadata.
const mockSui = createMockClient();
const coinDecimals: Record<string, number> = {};
const coinSupply: Record<string, bigint> = {};
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../src/utils/price-providers.js", () => ({ pricesForRanking }));
vi.mock("../src/utils/fanout.js", () => ({ measureFanout }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSink: () => false }));
vi.mock("../src/utils/store.js", () => ({ getCachedFirstFunder: () => null, saveFirstFunder: () => false, saveResult: () => null }));
vi.mock("../src/utils/identity.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  describeAddresses: async (addrs: string[]) =>
    new Map(addrs.map((a) => [a, { address: a, kind: "wallet" as const }])),
  identityNote: () => undefined,
}));

const { registerFundingTools } = await import("../src/tools/funding.js");
const { resetLiveCoinScale } = await import("../src/utils/valuation.js");
const { resetCoinOrigins } = await import("../src/utils/coin-origin.js");
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
/** Raw SUI each payment in an address's outgoing transactions carried; 1 SUI unless set. */
let paidAmount: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  resetLiveCoinScale();
  resetCoinOrigins();
  for (const k of Object.keys(coinDecimals)) delete coinDecimals[k];
  for (const k of Object.keys(coinSupply)) delete coinSupply[k];
  mockSui.ledgerService.getObject.mockReset();
  mockSui.ledgerService.getTransaction.mockReset();
  mockSui.stateService.getCoinInfo.mockImplementation(async ({ coinType }: { coinType: string }) => {
    if (!(coinType in coinDecimals)) throw new Error(`NOT_FOUND: no CoinMetadata for ${coinType}`);
    return {
      response: {
        coinType,
        metadata: { symbol: coinType.split("::").at(-1), decimals: coinDecimals[coinType] },
        ...(coinType in coinSupply ? { treasury: { totalSupply: coinSupply[coinType], supplyState: 1 } } : {}),
      },
    };
  });
  // Aftermath as it answers when up: SUI priced, a coin it does not list left out.
  pricesForRanking.mockImplementation(
    async (coins: string[]) =>
      new Map(coins.filter((c) => c === SUI).map((c) => [c, { price: 3.5, source: "aftermath" }])),
  );
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
  paidAmount = {};
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
      const amount = paidAmount[vars.addr as string] ?? "1000000000";
      return {
        transactions: {
          nodes: recipients.map((r, i) => ({
            digest: `sent${i}`,
            effects: { balanceChanges: conn([bc(vars.addr as string, `-${amount}`), bc(r, amount)]) },
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
    // A wide fanout does not settle what the funder is: a sybil-funding
    // operator whose recipients pay it back fans out as widely as an exchange
    // withdrawal wallet, so the stop reason claims no identity.
    expect(d.stop_reason).not.toMatch(/likely an exchange/i);
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

  it("walks on past a funder whose many payments were all dust", async () => {
    // 261 sends of 1,000 MIST cost a fraction of a SUI; counted, they would
    // make any funder a service and end the walk before its own funder.
    paidAmount[DISTRIBUTOR] = "1000";
    const d = await run("find_funding_source", { address: ATTACKER, max_hops: 2 });
    expect(d.chain.map((s: { funded_by: string }) => s.funded_by)).toEqual([DISTRIBUTOR, ANCESTOR]);
    expect(d.chain[0].funder_popularity).toMatchObject({ popular: false, observed_recipients: 0, below_floor_recipients: 261 });
  });

  it("walks on through a narrow funder and says how far its probe got", async () => {
    const d = await run("find_funding_source", { address: DISTRIBUTOR, max_hops: 2 });
    expect(d.chain.map((s: { funded_by: string }) => s.funded_by)).toEqual([ANCESTOR, ANCESTOR2]);
    expect(d.chain[0].funder_popularity).toMatchObject({ popular: false, observed_recipients: 0, scan_complete: true });
  });
});

describe("find_funding_source stops at an established funder", () => {
  const RECEIVER = `0x${"a1".repeat(32)}`;
  const HOLDER = `0x${"b2".repeat(32)}`;
  const HOLDER_FUNDER = `0x${"c3".repeat(32)}`;
  const OTHERS = Array.from({ length: 11 }, (_, i) => `0x${(i + 1).toString(16).padStart(2, "0").repeat(32)}`);
  const holderHistory = [
    fundingTx("HolderFnd", HOLDER_FUNDER, HOLDER, "600000000000000", "2024-01-01T00:00:00.000Z"),
    ...OTHERS.map((o, i) => fundingTx(`HolderPay${i}`, HOLDER, o, "1000000000", `2024-01-0${(i % 9) + 2}T00:00:00.000Z`)),
  ];

  it("ends at a funder that paid the subject from a balance it had long held", async () => {
    // HOLDER's earliest 12 transactions are its own funding and its own
    // payments; the payment to RECEIVER came months later.
    earliest[RECEIVER] = [fundingTx("LaterPay", HOLDER, RECEIVER, "500000000000000", "2024-06-01T00:00:00.000Z")];
    earliest[HOLDER] = holderHistory;
    earliest[HOLDER_FUNDER] = [];
    const d = await run("find_funding_source", { address: RECEIVER });
    expect(d.origin.address).toBe(HOLDER);
    expect(d.hops).toBe(1);
    expect(JSON.stringify(d.chain)).not.toContain(HOLDER_FUNDER);
  });

  it("walks on when the payment is among the funder's earliest transactions", async () => {
    earliest[RECEIVER] = [fundingTx("HolderPay3", HOLDER, RECEIVER, "1000000000", "2024-01-05T00:00:00.000Z")];
    earliest[HOLDER] = holderHistory.map((t, i) => (i === 4 ? earliest[RECEIVER][0] : t));
    earliest[HOLDER_FUNDER] = [];
    const d = await run("find_funding_source", { address: RECEIVER, max_hops: 2 });
    expect(d.chain.map((s: { funded_by: string }) => s.funded_by)).toEqual([HOLDER, HOLDER_FUNDER]);
  });
});

describe("find_funding_source fails closed when popularity cannot be measured", () => {
  it("stops rather than treating an unread popularity as narrow", async () => {
    // Ten funders whose popularity probe never resolves within its own page
    // cap (6 requests each) exhaust the 60-request popularity budget one
    // find_funding_source call gets, so the 11th funder's probe reads no page
    // at all and must not count as "not popular".
    const SUBJECT = "0xsubject00000000000000000000000000000000000000000000000000000000";
    const funders = Array.from(
      { length: 11 },
      (_, i) => `0xfunder${i}00000000000000000000000000000000000000000000000000${i}`,
    );
    earliest[SUBJECT] = [fundingTx("fund0", funders[0], SUBJECT, "1000000000", "2026-01-01T00:00:00.000Z")];
    for (let i = 0; i < funders.length - 1; i++) {
      earliest[funders[i]] = [
        fundingTx(`fund${i + 1}`, funders[i + 1], funders[i], "1000000000", "2026-01-01T00:00:00.000Z"),
      ];
    }
    const neverResolves = new Set(funders.slice(0, 10));
    gqlQuery.mockImplementation(async (q: string, vars: Record<string, unknown> = {}) => {
      const query = String(q);
      if (query.includes("sentAddress")) {
        return neverResolves.has(vars.addr as string)
          ? { transactions: { nodes: [], pageInfo: { hasPreviousPage: true, startCursor: "next" } } }
          : { transactions: { nodes: [], pageInfo: { hasPreviousPage: false, startCursor: null } } };
      }
      if (query.includes("affectedAddress: $addr")) {
        return { transactions: { nodes: earliest[vars.addr as string] ?? [] } };
      }
      return { transactionEffects: null };
    });

    const d = await run("find_funding_source", { address: SUBJECT, max_hops: 11 });
    expect(d.hops).toBe(11);
    expect(d.chain.at(-1).funded_by).toBe(funders[10]);
    expect(d.chain.at(-1).funder_popularity.unmeasured).toBe("budget");
    expect(d.stop_reason).toMatch(/could not measure/i);
    expect(d.stop_reason).toMatch(/budget/i);
    expect(d.stop_reason).not.toMatch(/reached a dead end|hit max_hops/i);
  });

  it("stops at a funder whose popularity read failed, with budget to spare", async () => {
    // SUBJECT is funded by HUB, and the SENT query for HUB throws after the
    // client's retries, once probeRecipients has taken from the budget. The
    // probe must not read as narrow with 0 recipients, so the walk stops at HUB.
    const SUBJECT = `0x5b${"1".repeat(62)}`;
    const HUB = `0x40b${"2".repeat(61)}`;
    const HUB_FUNDER = `0x40bf${"3".repeat(60)}`;
    earliest[SUBJECT] = [fundingTx("SubjFund", HUB, SUBJECT, "2000000000", "2026-01-02T00:00:00.000Z")];
    earliest[HUB] = [fundingTx("HubFund1", HUB_FUNDER, HUB, "90000000000", "2026-01-01T00:00:00.000Z")];
    const walkMock = gqlQuery.getMockImplementation()!;
    gqlQuery.mockImplementation(async (q: string, vars: Record<string, unknown> = {}) => {
      if (String(q).includes("sentAddress") && vars.addr === HUB) throw new Error("GraphQL HTTP 429");
      return walkMock(q, vars);
    });

    const d = await run("find_funding_source", { address: SUBJECT, max_hops: 5 });
    expect(d.hops).toBe(1);
    expect(d.origin.address).toBe(HUB);
    expect(d.chain[0].funder_popularity).toMatchObject({ popular: false, unmeasured: "read_failed" });
    expect(d.stop_reason).toMatch(/read failed/i);
    expect(d.stop_reason).not.toMatch(/budget/i);
    expect(JSON.stringify(d)).not.toContain(HUB_FUNDER);
  });

  it("stops at a funder whose second popularity page failed after a first page of 50 recipients", async () => {
    // An exchange withdrawal wallet pays one recipient per transaction, so its
    // first page shows 50 recipients and only the second can prove it popular.
    const SUBJECT = `0x5c${"1".repeat(62)}`;
    const CEX = `0x40c${"2".repeat(61)}`;
    const CEX_FUNDER = `0x40cf${"3".repeat(60)}`;
    earliest[SUBJECT] = [fundingTx("SubjFund2", CEX, SUBJECT, "2000000000", "2026-01-02T00:00:00.000Z")];
    earliest[CEX] = [fundingTx("CexFund1", CEX_FUNDER, CEX, "90000000000", "2026-01-01T00:00:00.000Z")];
    const walkMock = gqlQuery.getMockImplementation()!;
    gqlQuery.mockImplementation(async (q: string, vars: Record<string, unknown> = {}) => {
      if (String(q).includes("sentAddress") && vars.addr === CEX) {
        if (vars.before) throw new Error("GraphQL HTTP 429");
        return {
          transactions: {
            nodes: Array.from({ length: 50 }, (_, i) => ({
              digest: `cexsent${i}`,
              effects: { balanceChanges: conn([bc(CEX, "-1000000000"), bc(`0x${(i + 1).toString(16).padStart(64, "0")}`, "1000000000")]) },
            })),
            pageInfo: { hasPreviousPage: true, startCursor: "page2" },
          },
        };
      }
      return walkMock(q, vars);
    });

    const d = await run("find_funding_source", { address: SUBJECT, max_hops: 5 });
    expect(d.hops).toBe(1);
    expect(d.origin.address).toBe(CEX);
    expect(d.chain[0].funder_popularity).toMatchObject({ popular: false, observed_recipients: 50, unmeasured: "read_failed" });
    expect(d.chain[0].funder_popularity.provisional).toBeUndefined();
    expect(d.stop_reason).toMatch(/read failed after retries, with 50 distinct recipients seen/);
    expect(JSON.stringify(d)).not.toContain(CEX_FUNDER);
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
    // Here no inflow did qualify, so the dead-end reading stands.
    expect(d.sponsored_by_note).toMatch(/no inflow qualified/i);
  });
});

describe("find_funding_source reports a gas sponsor even when funding was found", () => {
  // Address-poisoning shape: the operator seeds the lookalike with dust
  // (below the funding floor, correctly skipped), the lookalike forwards
  // dust to the victim with the operator paying gas, and later the victim
  // sends real SUI to the lookalike. That SUI clears the funding floor and
  // becomes `chain[0]`, and the operator, the party that created and runs
  // this wallet, is still reported although an unrelated inflow qualified.
  const LOOKALIKE = "0x6b745225460cf4aeebe5edb4e381474a58abf206aa34dd838eb6570edd67b3cf";
  const OPERATOR = "0x7c8e2ceb0839680a3b1f7aa1021d45670405d92f3c88e79aa1d3aa8a600bbdbf";
  const VICTIM = `0xa11ce0${"3".repeat(58)}`;

  it("still lists the sponsor in sponsored_by", async () => {
    earliest[LOOKALIKE] = [
      fundingTx("SeedTx01", OPERATOR, LOOKALIKE, "1533", "2026-09-09T18:00:01.600Z"),
      {
        digest: "DustFwd1",
        sender: { address: LOOKALIKE },
        gasInput: { gasSponsor: { address: OPERATOR } },
        effects: {
          timestamp: "2026-09-09T18:00:05.000Z",
          checkpoint: { sequenceNumber: 2 },
          balanceChanges: conn([bc(OPERATOR, "-100000"), bc(LOOKALIKE, "-2"), bc(VICTIM, "2")]),
        },
      },
      fundingTx("LossTx01", VICTIM, LOOKALIKE, "1188330952", "2026-09-09T18:18:25.063Z"),
    ];
    const d = await run("find_funding_source", { address: LOOKALIKE, max_hops: 1 });
    // The victim's payment is still what the funding floor recognizes.
    expect(d.chain[0].funded_by).toBe(VICTIM);
    expect(d.dust_skipped[0]).toMatchObject({ digest: "SeedTx01", reason: "below_sui_floor" });
    // The operator sent the dust and paid the lookalike's own gas, so it is
    // listed as the lookalike's sponsor.
    expect(d.sponsored_by).toMatchObject([{ address: LOOKALIKE, sponsor: OPERATOR }]);
  });

  it("does not tell the reader no inflow qualified when the hop found funding", async () => {
    // chain[0] is funded_by VICTIM, so the note must not say "No inflow
    // qualified as funding" about the only hop there is.
    earliest[LOOKALIKE] = [
      fundingTx("SeedTx01", OPERATOR, LOOKALIKE, "1533", "2026-09-09T18:00:01.600Z"),
      {
        digest: "DustFwd1",
        sender: { address: LOOKALIKE },
        gasInput: { gasSponsor: { address: OPERATOR } },
        effects: {
          timestamp: "2026-09-09T18:00:05.000Z",
          checkpoint: { sequenceNumber: 2 },
          balanceChanges: conn([bc(OPERATOR, "-100000"), bc(LOOKALIKE, "-2"), bc(VICTIM, "2")]),
        },
      },
      fundingTx("LossTx01", VICTIM, LOOKALIKE, "1188330952", "2026-09-09T18:18:25.063Z"),
    ];
    const d = await run("find_funding_source", { address: LOOKALIKE, max_hops: 1 });
    expect(d.hops).toBe(1);
    expect(d.sponsored_by_note).not.toMatch(/no inflow qualified/i);
    expect(d.sponsored_by_note).toMatch(/independent/i);
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

describe("a shared funder's classification agrees with its interpretation", () => {
  // A shared funder the popularity probe sees paying 55 recipients, while the
  // 300-transaction fan-out window counts 81 recipients, 53 senders and 91
  // counterparties, which classifyFanout calls narrow.
  const FARM = "0xb43139646d70b02e44dd5c16af587197e693b3197ebbcb60a750d03d82abfaa5";
  const CLAIMER_A = "0x07d047d215228bc979f568a2504b87e0ac6d64d09681bf9e868ff9cee6feef83";
  const CLAIMER_B = "0x08826bca504e92b87180ef89907aed340e8e384ca59681b46c5e441ffc68442f";
  const farmWindow = {
    address: FARM,
    recipient_count: 81,
    sender_count: 53,
    counterparty_count: 91,
    coin_type_count: 3,
    out_in_ratio: 1.53,
    flow_shape: "balanced",
    scanned_transactions: 300,
    truncated: true,
    classification: "narrow",
    classification_provisional: true,
    interpretation: "Narrow within the window scanned, but the scan reached its budget before the end of this address's history, so the count is a lower bound. Raise max_transactions before reading shared funding through it as meaningful.",
  };

  beforeEach(() => {
    earliest[CLAIMER_A] = [fundingTx("Hc5KdsNT", FARM, CLAIMER_A, "300000000", "2024-05-19T08:23:00.000Z")];
    earliest[CLAIMER_B] = [fundingTx("FarmFnd2", FARM, CLAIMER_B, "300000000", "2024-05-19T08:23:20.000Z")];
    earliest[FARM] = [];
    paid[FARM] = Array.from({ length: 55 }, (_, i) => `0x${(i + 0x1000).toString(16).padStart(64, "0")}`);
  });

  it("classes a funder the probe found service-scale a distributor, not narrow", async () => {
    measureFanout.mockImplementation(async () => farmWindow);
    const d = await run("find_funding_sources", { addresses: [CLAIMER_A, CLAIMER_B], depth: "first_hop" });
    const farm = d.shared_funders.find((f: { funder: string }) => f.funder === FARM);
    expect(farm.funder_popularity).toMatchObject({ popular: true, observed_recipients: 55 });
    expect(farm.fanout.classification).toBe("distributor");
    expect(farm.fanout.classification_basis).toBeDefined();
    expect(farm.fanout.interpretation).toContain("distributor");
    // The window's counts are reported unchanged.
    expect(farm.fanout.counterparty_count).toBe(91);
  });

  it("keeps a hub's own reading when the probe also found it popular", async () => {
    measureFanout.mockImplementation(async () => ({
      ...farmWindow,
      counterparty_count: 1_200,
      truncated: false,
      classification: "hub",
      classification_provisional: undefined,
      interpretation: "Exchange hot wallet, bridge or faucet-scale distributor. Two addresses sharing this funder tells you nothing.",
    }));
    const d = await run("find_funding_sources", { addresses: [CLAIMER_A, CLAIMER_B], depth: "first_hop" });
    const farm = d.shared_funders.find((f: { funder: string }) => f.funder === FARM);
    expect(farm.fanout.classification).toBe("hub");
    expect(farm.fanout.interpretation).toMatch(/tells you nothing/);
    expect(farm.fanout.classification_basis).toBeUndefined();
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

describe("find_funding_source applies the same price rule as build_wallet_edges during an outage", () => {
  const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
  const SUBJECT = `0x5c${"4".repeat(62)}`;
  const CEX = `0xce${"5".repeat(62)}`;
  const LATER = `0x1a${"6".repeat(62)}`;

  it("keeps the 500 USDC funder when no price can be read, and says the floor was not applied", async () => {
    // fetchAftermath answers an outage with an empty map. The USDC inflow is
    // then accepted under the outage fallback, and the later 2 SUI is not
    // named the funder.
    pricesForRanking.mockImplementation(async () => new Map());
    earliest[SUBJECT] = [
      {
        digest: "UsdcFund",
        sender: { address: CEX },
        gasInput: { gasSponsor: { address: CEX } },
        effects: {
          timestamp: "2026-01-01T00:00:00.000Z",
          checkpoint: { sequenceNumber: 1 },
          balanceChanges: conn([
            { amount: "-500000000", owner: { address: CEX }, coinType: { repr: USDC } },
            { amount: "500000000", owner: { address: SUBJECT }, coinType: { repr: USDC } },
          ]),
        },
      },
      fundingTx("SuiLater", LATER, SUBJECT, "2000000000", "2026-01-02T00:00:00.000Z"),
    ];
    const d = await run("find_funding_source", { address: SUBJECT, max_hops: 1, measure_fanout: false });
    expect(d.chain[0].funded_by).toBe(CEX);
    expect(d.prices_unavailable_at).toEqual([SUBJECT]);
    expect(d.prices_unavailable_note).toMatch(/dust floor/i);
  });
});

describe("find_funding_source judges a coin at its real decimals", () => {
  const GAME = "0x9ab3c1e0d57f4a2b8c6d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d::gold::GOLD";
  const SUBJECT = `0x5d${"7".repeat(62)}`;
  const MINTER = `0xa1${"8".repeat(62)}`;
  const LATER = `0x1b${"9".repeat(62)}`;

  it("counts 100 of a 6-decimal coin at $0.05 as $5 of funding, not $0.005 of dust", async () => {
    // CoinMetadata is read before the floors apply, so the $5 first funding is
    // valued at 6 decimals. At an assumed 9 decimals it would be $0.005 and
    // skipped as below_usd_floor.
    coinDecimals[GAME] = 6;
    pricesForRanking.mockImplementation(
      async (coins: string[]) =>
        new Map(
          coins
            .filter((c) => c === SUI || c === GAME)
            .map((c) => [c, { price: c === SUI ? 3.5 : 0.05, source: "aftermath" }]),
        ),
    );
    earliest[SUBJECT] = [
      {
        digest: "GoldFund",
        sender: { address: MINTER },
        gasInput: { gasSponsor: { address: MINTER } },
        effects: {
          timestamp: "2026-01-01T00:00:00.000Z",
          checkpoint: { sequenceNumber: 1 },
          balanceChanges: conn([
            { amount: "-100000000", owner: { address: MINTER }, coinType: { repr: GAME } },
            { amount: "100000000", owner: { address: SUBJECT }, coinType: { repr: GAME } },
          ]),
        },
      },
      fundingTx("SuiLater", LATER, SUBJECT, "2000000000", "2026-01-02T00:00:00.000Z"),
    ];
    const d = await run("find_funding_source", { address: SUBJECT, max_hops: 1, measure_fanout: false });
    expect(d.chain[0].funded_by).toBe(MINTER);
    expect(d.chain[0].amount).toMatch(/^100 GOLD/);
    expect(d.dust_skipped).toBeUndefined();
  });
});

describe("find_funding_source counts a coin nobody prices when no airdrop could send that much", () => {
  // Transactions 7SumEF… and ET5Cey… as mainnet returns them: the deployer's
  // first transfer to INSIDER was 10% of KONG's supply, a day before 3 SUI.
  // Aftermath quotes KONG at -1.
  const DEPLOYER = "0x70f1042521565aa5c3fb887f939ef05e8dee264cc11ee07735132691801d360d";
  const INSIDER = "0x7ea76fb3e64d7c4bcb1d0f57454810062beee1c81b8c0e3cede9a7e63886ef5b";
  const KONG_PKG = "0xb0c3e7ae67c9161273aab9a06e589c1c13479337d14c794251a97df46822f2cb";
  const KONG = `${KONG_PKG}::kong::KONG`;

  const grant = {
    digest: "7SumEFmUMbBRv47a5A3MaMFeV31eoTxBrvET7uAhuicw",
    sender: { address: DEPLOYER },
    gasInput: { gasSponsor: { address: DEPLOYER } },
    effects: {
      timestamp: "2024-09-26T05:56:22.186Z",
      checkpoint: { sequenceNumber: 1 },
      balanceChanges: conn([
        bc(DEPLOYER, "-2095504"),
        { amount: "-10000000000", owner: { address: DEPLOYER }, coinType: { repr: KONG } },
        { amount: "10000000000", owner: { address: INSIDER }, coinType: { repr: KONG } },
      ]),
    },
  };
  const gas = fundingTx("ET5CeyPRbNzQWUQXzAgnw7iPrurvBFmBPojptdBeSgwP", DEPLOYER, INSIDER, "3000000000", "2024-09-27T16:18:05.865Z");
  /** KONG's package object and its publish transaction (99s8gEPT…), as the ledger returns them. */
  const publisherReadable = () => {
    mockSui.ledgerService.getObject.mockResolvedValue({
      response: { object: { objectId: KONG_PKG, previousTransaction: "99s8gEPTAvdks4xwUVNvtrWDg1npNH3NJKatjqLyKJ7q" } },
    });
    mockSui.ledgerService.getTransaction.mockResolvedValue({
      response: { transaction: { digest: "99s8gEPTAvdks4xwUVNvtrWDg1npNH3NJKatjqLyKJ7q", transaction: { sender: DEPLOYER } } },
    });
  };

  beforeEach(() => {
    coinDecimals[KONG] = 1;
    coinSupply[KONG] = 100_000_000_000n;
    earliest[INSIDER] = [grant, gas];
  });

  it("names the 10% KONG grant, not the later SUI, and says why an unpriced coin counted", async () => {
    publisherReadable();
    const d = await run("find_funding_source", { address: INSIDER, max_hops: 1, measure_fanout: false });
    expect(d.chain[0].funding_tx).toBe("7SumEFmUMbBRv47a5A3MaMFeV31eoTxBrvET7uAhuicw");
    expect(d.chain[0].amount).toMatch(/^1,?000,?000,?000 KONG/);
    expect(d.chain[0].unpriced_funding).toEqual({ share_of_supply: 0.1, from_publisher: true, basis: "supply_share" });
    expect(d.unpriced_funding_note).toMatch(/1% of the coin's current supply/);
    expect(d.dust_skipped).toBeUndefined();
    expect(d.origin_unread_at).toBeUndefined();
  });

  it("discloses a supply read that failed instead of reading the grant as spam in silence", async () => {
    publisherReadable();
    mockSui.stateService.getCoinInfo.mockImplementation(async () => {
      throw new Error("RESOURCE_EXHAUSTED: 429");
    });
    const d = await run("find_funding_source", { address: INSIDER, max_hops: 1, measure_fanout: false });
    expect(d.chain[0].funding_tx).toBe("ET5CeyPRbNzQWUQXzAgnw7iPrurvBFmBPojptdBeSgwP");
    expect(d.origin_unread_at).toEqual([{ address: INSIDER, coin_types: [KONG] }]);
    expect(d.origin_unread_note).toMatch(/could not be read/);
  });

  it("reads the supply again on the next call, since a failed read is not cached", async () => {
    publisherReadable();
    const working = mockSui.stateService.getCoinInfo.getMockImplementation()!;
    mockSui.stateService.getCoinInfo.mockImplementation(async () => {
      throw new Error("UNAVAILABLE: upstream reset");
    });
    await run("find_funding_source", { address: INSIDER, max_hops: 1, measure_fanout: false });
    mockSui.stateService.getCoinInfo.mockImplementation(working);
    const d = await run("find_funding_source", { address: INSIDER, max_hops: 1, measure_fanout: false });
    expect(d.chain[0].funding_tx).toBe("7SumEFmUMbBRv47a5A3MaMFeV31eoTxBrvET7uAhuicw");
    expect(d.origin_unread_at).toBeUndefined();
  });

  it("discloses a failed publisher read when only the publisher rule could count the grant", async () => {
    // 0.5% of supply: funding from the publisher, spam from anyone else.
    coinSupply[KONG] = 2_000_000_000_000n;
    mockSui.ledgerService.getObject.mockRejectedValue(new Error("RESOURCE_EXHAUSTED: 429"));
    const d = await run("find_funding_source", { address: INSIDER, max_hops: 1, measure_fanout: false });
    expect(d.chain[0].funding_tx).toBe("ET5CeyPRbNzQWUQXzAgnw7iPrurvBFmBPojptdBeSgwP");
    expect(d.origin_unread_at).toEqual([{ address: INSIDER, coin_types: [KONG] }]);
  });

  it("keeps a coin the service reports no metadata for as spam, with nothing to disclose", async () => {
    delete coinDecimals[KONG];
    publisherReadable();
    const d = await run("find_funding_source", { address: INSIDER, max_hops: 1, measure_fanout: false });
    expect(d.chain[0].funding_tx).toBe("ET5CeyPRbNzQWUQXzAgnw7iPrurvBFmBPojptdBeSgwP");
    expect(d.dust_skipped).toEqual([expect.objectContaining({ coinType: KONG, reason: "unpriced_coin" })]);
    expect(d.origin_unread_at).toBeUndefined();
  });

  it("reads KONG's origin when the grant rode beside 0.005 SUI, and names the grant", async () => {
    publisherReadable();
    const bundle = {
      ...grant,
      effects: {
        ...grant.effects,
        balanceChanges: conn([
          bc(DEPLOYER, "-7095504"),
          bc(INSIDER, "5000000"),
          { amount: "-10000000000", owner: { address: DEPLOYER }, coinType: { repr: KONG } },
          { amount: "10000000000", owner: { address: INSIDER }, coinType: { repr: KONG } },
        ]),
      },
    };
    earliest[INSIDER] = [bundle, gas];
    const d = await run("find_funding_source", { address: INSIDER, max_hops: 1, measure_fanout: false });
    expect(d.chain[0].funding_tx).toBe("7SumEFmUMbBRv47a5A3MaMFeV31eoTxBrvET7uAhuicw");
    expect(d.chain[0].unpriced_funding).toEqual({ share_of_supply: 0.1, from_publisher: true, basis: "supply_share" });
    expect(d.dust_skipped).toEqual([expect.objectContaining({ coinType: SUI, reason: "below_sui_floor" })]);
  });
});

describe("find_funding_sources caps its listing without losing a linked subject", () => {
  it("keeps every result tied to a shared funder past the budget, counts the rest, and lists all with detail full", async () => {
    const loners = Array.from({ length: 70 }, (_, i) => `0x${(0xabc000 + i).toString(16).padStart(64, "0")}`);
    const linked = [PAYER, `0x${"7".repeat(64)}`];
    earliest[linked[1]] = [fundingTx("Linked2", PAYER_FUNDER, linked[1], "40000000000", "2025-09-07T14:00:05.000Z")];
    const addresses = [...loners, ...linked];

    const d = await run("find_funding_sources", { addresses, measure_fanout: false, depth: "first_hop" });
    expect(d.shared_funders.map((f: { funder: string }) => f.funder)).toEqual([PAYER_FUNDER]);
    const listed = d.results.map((r: { address: string }) => r.address);
    expect(listed).toEqual(expect.arrayContaining(linked));
    expect(d.truncated).toBe(true);
    expect(listed.length + d.omitted.lists.results.count).toBe(addresses.length);
    expect(d.address_count).toBe(addresses.length);
    expect(d.omitted.next_call).toEqual({ tool: "find_funding_sources", repeat_with: { detail: "full" } });

    const full = await run("find_funding_sources", { addresses, measure_fanout: false, depth: "first_hop", detail: "full" });
    expect(full.results).toHaveLength(addresses.length);
    expect(full.truncated).toBeUndefined();
    expect(full.results.find((r: { address: string }) => r.address === PAYER).chain[0].funded_by).toBe(PAYER_FUNDER);
  });
});
