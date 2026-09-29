import { describe, expect, it } from "vitest";
import {
  inboundSenders,
  inferDepositLabel,
  isDepositShaped,
  lookalikeSuspects,
  MIN_SWEEPS,
  sponsorRejection,
  type InferredDeposit,
} from "../src/utils/deposit-labels.js";
import { readDepositPattern, SWEEP_GAS_RESERVE_MIST, type DepositScan, type ScannedTx } from "../src/utils/deposit.js";

// Synthetic addresses only. The shapes follow deposit.test.ts: a sponsored
// sweep moves the whole balance to the exchange wallet, and the sponsor's
// SUI change on it is a positive storage rebate.
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0x" + "0e".repeat(32) + "::usdc::USDC";
const addr = (byte: string) => "0x" + byte.repeat(32);
const DEPOSIT = addr("d1");
const A1 = addr("a1");
const A2 = addr("a2");
const B1 = addr("b1");
const ELSEWHERE = addr("e1");
const SPONSOR = addr("5e");
const CUSTOMER = addr("c1");
const WALLETS = new Map([
  [A1, "ExchangeA"],
  [A2, "ExchangeA"],
  [B1, "ExchangeB"],
]);
const NONE = new Set<string>();
const CTX = { exchangeWallets: WALLETS, labelled: NONE };

let n = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, n++)).toISOString();

const pay = (amount: bigint, coin = SUI, from = CUSTOMER): ScannedTx => ({
  digest: `in${n}`,
  timestamp: at(),
  sender: from,
  gasSponsor: null,
  changes: [
    { owner: from, coinType: coin, amount: -amount },
    { owner: DEPOSIT, coinType: coin, amount },
  ],
});

const sweep = (digest: string, amount: bigint, to: string, coin = SUI): ScannedTx => ({
  digest,
  timestamp: at(),
  sender: DEPOSIT,
  gasSponsor: SPONSOR,
  changes: [
    { owner: DEPOSIT, coinType: coin, amount: -amount },
    { owner: SPONSOR, coinType: SUI, amount: 5_000_000n },
    { owner: to, coinType: coin, amount },
  ],
});

/** A self-paid SUI sweep of `amount`, gas 3,000,000 MIST. */
const selfPaid = (digest: string, amount: bigint, to: string): ScannedTx => ({
  digest,
  timestamp: at(),
  sender: DEPOSIT,
  gasSponsor: null,
  changes: [
    { owner: DEPOSIT, coinType: SUI, amount: -amount - 3_000_000n },
    { owner: to, coinType: SUI, amount },
  ],
});

const scan = (txs: ScannedTx[], balances: Map<string, bigint> | null = new Map([[SUI, 0n]])): DepositScan => ({
  address: DEPOSIT,
  txs,
  complete: true,
  currentBalances: balances,
});

/** Deposits and full sweeps into `targets` in turn. */
const sweepsInto = (...targets: string[]) =>
  targets.flatMap((to, i) => [pay(100n + BigInt(i)), sweep(`s${i}`, 100n + BigInt(i), to)]);

describe("inferDepositLabel", () => {
  it("labels an address whose every outflow is a full sweep into one exchange wallet", () => {
    const r = inferDepositLabel(scan(sweepsInto(A1, A1, A1, A1)), CTX);
    expect(r.kind).toBe("deposit");
    if (r.kind !== "deposit") return;
    expect(r.deposit).toMatchObject({
      address: DEPOSIT,
      entity: "ExchangeA",
      swept_to: A1,
      sweep_count: 4,
      // The latest three, oldest first.
      evidence_txs: ["s1", "s2", "s3"],
    });
    expect(r.deposit.first_sweep_at! < r.deposit.last_sweep_at!).toBe(true);
  });

  it("rejects sweeps into two wallets, as classify_deposit_address does, even of one exchange", () => {
    expect(inferDepositLabel(scan(sweepsInto(A1, A2, A1)), CTX)).toEqual({ kind: "rejected", reason: "several-wallets" });
  });

  it(`needs ${MIN_SWEEPS} sweeps: one full transfer is one payment`, () => {
    expect(inferDepositLabel(scan(sweepsInto(A1)), CTX)).toEqual({ kind: "rejected", reason: "few-sweeps" });
    expect(inferDepositLabel(scan(sweepsInto(A1, A1)), CTX).kind).toBe("deposit");
  });

  it("never labels an address a disclosed or curated label already names", () => {
    const labelled = new Set([DEPOSIT]);
    expect(inferDepositLabel(scan(sweepsInto(A1, A1, A1)), { ...CTX, labelled })).toEqual({ kind: "rejected", reason: "labelled" });
  });

  it("rejects sweeps into two exchanges", () => {
    expect(inferDepositLabel(scan(sweepsInto(A1, A1, B1)), CTX)).toEqual({ kind: "rejected", reason: "several-exchanges" });
  });

  it("rejects an address that also sweeps somewhere no exchange discloses", () => {
    expect(inferDepositLabel(scan(sweepsInto(A1, A1, ELSEWHERE)), CTX)).toEqual({ kind: "rejected", reason: "sweeps-elsewhere" });
  });

  it("rejects an outflow that is not a transfer to one recipient", () => {
    // Value leaves and no address gains it: a swap into a pool.
    const swap: ScannedTx = {
      digest: "swap",
      timestamp: at(),
      sender: DEPOSIT,
      gasSponsor: SPONSOR,
      changes: [{ owner: DEPOSIT, coinType: USDC, amount: -5n }],
    };
    const r = inferDepositLabel(scan([...sweepsInto(A1, A1), pay(5n, USDC), swap]), CTX);
    expect(r).toEqual({ kind: "rejected", reason: "other-outflow" });
  });

  it("rejects a transfer that leaves a balance behind", () => {
    // 100 in, 60 out to the exchange: 40 stays, so it is a payment, not a sweep.
    const txs = [pay(100n), sweep("s0", 100n, A1), pay(100n), sweep("s1", 60n, A1)];
    expect(inferDepositLabel(scan(txs, new Map([[SUI, 40n]])), CTX)).toEqual({ kind: "rejected", reason: "partial-sweep" });
  });

  it("uses deposit.ts's gas reserve for a self-paid sweep", () => {
    const amount = 10_000_000_000n;
    const txs = [pay(amount), selfPaid("s0", amount, A1), pay(amount), selfPaid("s1", amount, A1)];
    // Balances are rebuilt backwards from the current one: the first sweep
    // leaves the current balance plus the second sweep's gas.
    const leftWithin = SWEEP_GAS_RESERVE_MIST - 3_000_000n;
    expect(inferDepositLabel(scan(txs, new Map([[SUI, leftWithin]])), CTX).kind).toBe("deposit");
    // One MIST over the reserve after the first sweep is a payment.
    expect(inferDepositLabel(scan(txs, new Map([[SUI, leftWithin + 1n]])), CTX)).toEqual({
      kind: "rejected",
      reason: "partial-sweep",
    });
  });

  it("does not decide on balances it could not read", () => {
    expect(inferDepositLabel(scan(sweepsInto(A1, A1), null), CTX)).toEqual({ kind: "rejected", reason: "balance-unknown" });
  });
});

describe("inferDepositLabel: who paid the candidate", () => {
  it("rejects a dust sweeper its own sweep sponsor funds (a poisoner's lookalike)", () => {
    const txs = [pay(3n, SUI, SPONSOR), sweep("s0", 3n, A1), pay(27n, SUI, SPONSOR), sweep("s1", 27n, A1)];
    expect(inferDepositLabel(scan(txs), CTX)).toEqual({ kind: "rejected", reason: "sponsor-funded" });
    // One customer payment among them makes it a customer's address again.
    const withCustomer = [pay(3n, SUI, SPONSOR), sweep("s0", 3n, A1), pay(27n), sweep("s1", 27n, A1)];
    expect(inferDepositLabel(scan(withCustomer), CTX).kind).toBe("deposit");
  });

  it("rejects an address only the same exchange's wallets pay", () => {
    const txs = [pay(5n, SUI, A2), sweep("s0", 5n, A1), pay(7n, SUI, A2), sweep("s1", 7n, A1)];
    expect(inferDepositLabel(scan(txs), CTX)).toEqual({ kind: "rejected", reason: "exchange-funded" });
  });

  it("does not count a gas top-up in a coin it never swept as a customer payment", () => {
    const GAS_FUNDER = addr("9a");
    const txs = [
      pay(20_000_000n, SUI, GAS_FUNDER),
      pay(5n, USDC, A2),
      sweep("s0", 5n, A1, USDC),
      pay(7n, USDC, A2),
      sweep("s1", 7n, A1, USDC),
    ];
    const balances = new Map([
      [SUI, 20_000_000n],
      [USDC, 0n],
    ]);
    expect(inferDepositLabel(scan(txs, balances), CTX)).toEqual({ kind: "rejected", reason: "exchange-funded" });
  });

  it("rejects an address paid only by where the swept-to wallet sweeps", () => {
    const txs = [pay(5n, SUI, ELSEWHERE), sweep("s0", 5n, A1), pay(7n, SUI, ELSEWHERE), sweep("s1", 7n, A1)];
    const ctx = { ...CTX, walletSweepsInto: new Map([[A1, [ELSEWHERE]]]) };
    expect(inferDepositLabel(scan(txs), ctx)).toEqual({ kind: "rejected", reason: "round-trip" });
    expect(inferDepositLabel(scan(txs), CTX).kind).toBe("deposit");
  });

  it("rejects an address paid only by a mix of its sponsor and the exchange", () => {
    const txs = [pay(5n, SUI, SPONSOR), sweep("s0", 5n, A1), pay(7n, SUI, A2), sweep("s1", 7n, A1)];
    expect(inferDepositLabel(scan(txs), CTX)).toEqual({ kind: "rejected", reason: "not-customer-funded" });
  });

  it("rejects sweeps into a disclosed wallet that is deposit-shaped itself", () => {
    expect(inferDepositLabel(scan(sweepsInto(A1, A1)), { ...CTX, depositShaped: new Set([A1]) })).toEqual({
      kind: "rejected",
      reason: "target-deposit-shaped",
    });
  });

  it("rejects a lookalike", () => {
    expect(inferDepositLabel(scan(sweepsInto(A1, A1)), { ...CTX, lookalikes: new Set([DEPOSIT]) })).toEqual({
      kind: "rejected",
      reason: "lookalike",
    });
  });
});

describe("sponsorRejection", () => {
  const deposit = (sponsors: string[]): InferredDeposit => ({
    address: DEPOSIT,
    entity: "ExchangeA",
    swept_to: A1,
    sweep_count: 2,
    evidence_txs: ["s0", "s1"],
    first_sweep_at: null,
    last_sweep_at: null,
    sponsors,
  });
  const shapes = new Map([
    [addr("f1"), "relayer" as const],
    [addr("f2"), "operator" as const],
    [addr("f3"), "private_sponsor" as const],
  ]);

  it("keeps self-paid sweeps, a relayer and the exchange's own wallet", () => {
    expect(sponsorRejection(deposit([]), shapes, WALLETS)).toBeNull();
    expect(sponsorRejection(deposit([addr("f1")]), shapes, WALLETS)).toBeNull();
    expect(sponsorRejection(deposit([A2]), shapes, WALLETS)).toBeNull();
  });

  it("rejects an operator, a private sponsor, another exchange's wallet and an unmeasured sponsor", () => {
    expect(sponsorRejection(deposit([addr("f1"), addr("f2")]), shapes, WALLETS)).toBe("sponsor-operator");
    expect(sponsorRejection(deposit([addr("f3")]), shapes, WALLETS)).toBe("sponsor-not-relayer");
    expect(sponsorRejection(deposit([B1]), shapes, WALLETS)).toBe("sponsor-unmeasured");
    expect(sponsorRejection(deposit([addr("f4")]), shapes, WALLETS)).toBe("sponsor-unmeasured");
  });
});

describe("isDepositShaped", () => {
  const walletTx = (digest: string, changes: Array<[string, bigint]>): ScannedTx => ({
    digest,
    timestamp: at(),
    sender: changes.find(([, a]) => a < 0n)![0],
    gasSponsor: SPONSOR,
    changes: changes.map(([owner, amount]) => ({ owner, coinType: SUI, amount })),
  });

  it("is true for a wallet whose every outflow empties it into one address", () => {
    const txs = [
      walletTx("in0", [[CUSTOMER, -10n], [A1, 10n]]),
      walletTx("out0", [[A1, -10n], [ELSEWHERE, 10n]]),
      walletTx("in1", [[CUSTOMER, -4n], [A1, 4n]]),
      walletTx("out1", [[A1, -4n], [ELSEWHERE, 4n]]),
    ];
    expect(isDepositShaped(readDepositPattern({ address: A1, txs, complete: true, currentBalances: new Map([[SUI, 0n]]) }))).toBe(true);
  });

  it("is false for a wallet that pays out part of its balance", () => {
    const txs = [walletTx("in0", [[CUSTOMER, -10n], [A1, 10n]]), walletTx("out0", [[A1, -4n], [ELSEWHERE, 4n]])];
    expect(isDepositShaped(readDepositPattern({ address: A1, txs, complete: true, currentBalances: new Map([[SUI, 6n]]) }))).toBe(false);
  });
});

describe("lookalikeSuspects", () => {
  // Same first and last six characters, different middles.
  const REAL = "0xabc123" + "5f0e9d8c7b6a5948372615049382716a5b4c3d2e1f0a9b8c7d6e" + "fed987";
  const FAKE = "0xabc123" + "0918273645546372819a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e" + "fed987";
  const transfer = (from: string, to: string, amount: bigint): ScannedTx => ({
    digest: `t${n}`,
    timestamp: at(),
    sender: from,
    gasSponsor: null,
    changes: [
      { owner: from, coinType: SUI, amount: -amount },
      { owner: to, coinType: SUI, amount },
    ],
  });

  it("names the dust sender that imitates a regular counterparty, not the counterparty", () => {
    const txs = [...[1n, 2n, 3n, 4n].map((a) => transfer(A1, REAL, a * 1000n)), transfer(FAKE, A1, 1n)];
    const suspects = lookalikeSuspects(txs, A1);
    expect(suspects.has(FAKE)).toBe(true);
    expect(suspects.has(REAL)).toBe(false);
  });

  it("names both sides when their roles cannot be told apart", () => {
    const suspects = lookalikeSuspects([transfer(REAL, A1, 5n), transfer(FAKE, A1, 5n)], A1);
    expect([...suspects].sort()).toEqual([FAKE, REAL].sort());
  });
});

describe("inboundSenders", () => {
  it("lists each address that paid the wallet once, in order", () => {
    const txs = [pay(1n), sweep("s0", 1n, A1), sweep("s1", 1n, A1)];
    expect(inboundSenders(txs, A1)).toEqual([DEPOSIT]);
  });

  it("ignores the wallet's own sends and gas it sponsored", () => {
    const withdrawal: ScannedTx = {
      digest: "w",
      timestamp: at(),
      sender: A1,
      gasSponsor: null,
      changes: [
        { owner: A1, coinType: SUI, amount: -10n },
        { owner: CUSTOMER, coinType: SUI, amount: 10n },
      ],
    };
    // The wallet pays gas for another address's sweep elsewhere: its SUI
    // change is a rebate, not a payment from that sender.
    const sponsored: ScannedTx = {
      digest: "g",
      timestamp: at(),
      sender: DEPOSIT,
      gasSponsor: A1,
      changes: [
        { owner: DEPOSIT, coinType: USDC, amount: -10n },
        { owner: ELSEWHERE, coinType: USDC, amount: 10n },
        { owner: A1, coinType: SUI, amount: 4_000_000n },
      ],
    };
    expect(inboundSenders([withdrawal, sponsored], A1)).toEqual([]);
  });
});
