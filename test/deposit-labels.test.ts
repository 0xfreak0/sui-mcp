import { describe, expect, it } from "vitest";
import { inboundSenders, inferDepositLabel, MIN_SWEEPS } from "../src/utils/deposit-labels.js";
import { SWEEP_GAS_RESERVE_MIST, type DepositScan, type ScannedTx } from "../src/utils/deposit.js";

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

let n = 0;
const at = () => new Date(Date.UTC(2026, 0, 1, 0, n++)).toISOString();

const pay = (amount: bigint, coin = SUI): ScannedTx => ({
  digest: `in${n}`,
  timestamp: at(),
  sender: CUSTOMER,
  gasSponsor: null,
  changes: [
    { owner: CUSTOMER, coinType: coin, amount: -amount },
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
    const r = inferDepositLabel(scan(sweepsInto(A1, A1, A1, A1)), WALLETS, NONE);
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
    expect(inferDepositLabel(scan(sweepsInto(A1, A2, A1)), WALLETS, NONE)).toEqual({ kind: "rejected", reason: "several-wallets" });
  });

  it(`needs ${MIN_SWEEPS} sweeps: one full transfer is one payment`, () => {
    expect(inferDepositLabel(scan(sweepsInto(A1)), WALLETS, NONE)).toEqual({ kind: "rejected", reason: "few-sweeps" });
    expect(inferDepositLabel(scan(sweepsInto(A1, A1)), WALLETS, NONE).kind).toBe("deposit");
  });

  it("never labels an address a disclosed or curated label already names", () => {
    const labelled = new Set([DEPOSIT]);
    expect(inferDepositLabel(scan(sweepsInto(A1, A1, A1)), WALLETS, labelled)).toEqual({ kind: "rejected", reason: "labelled" });
  });

  it("rejects sweeps into two exchanges", () => {
    expect(inferDepositLabel(scan(sweepsInto(A1, A1, B1)), WALLETS, NONE)).toEqual({ kind: "rejected", reason: "several-exchanges" });
  });

  it("rejects an address that also sweeps somewhere no exchange discloses", () => {
    expect(inferDepositLabel(scan(sweepsInto(A1, A1, ELSEWHERE)), WALLETS, NONE)).toEqual({ kind: "rejected", reason: "sweeps-elsewhere" });
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
    const r = inferDepositLabel(scan([...sweepsInto(A1, A1), pay(5n, USDC), swap]), WALLETS, NONE);
    expect(r).toEqual({ kind: "rejected", reason: "other-outflow" });
  });

  it("rejects a transfer that leaves a balance behind", () => {
    // 100 in, 60 out to the exchange: 40 stays, so it is a payment, not a sweep.
    const txs = [pay(100n), sweep("s0", 100n, A1), pay(100n), sweep("s1", 60n, A1)];
    expect(inferDepositLabel(scan(txs, new Map([[SUI, 40n]])), WALLETS, NONE)).toEqual({ kind: "rejected", reason: "partial-sweep" });
  });

  it("uses deposit.ts's gas reserve for a self-paid sweep", () => {
    const amount = 10_000_000_000n;
    const txs = [pay(amount), selfPaid("s0", amount, A1), pay(amount), selfPaid("s1", amount, A1)];
    // Balances are rebuilt backwards from the current one: the first sweep
    // leaves the current balance plus the second sweep's gas.
    const leftWithin = SWEEP_GAS_RESERVE_MIST - 3_000_000n;
    expect(inferDepositLabel(scan(txs, new Map([[SUI, leftWithin]])), WALLETS, NONE).kind).toBe("deposit");
    // One MIST over the reserve after the first sweep is a payment.
    expect(inferDepositLabel(scan(txs, new Map([[SUI, leftWithin + 1n]])), WALLETS, NONE)).toEqual({
      kind: "rejected",
      reason: "partial-sweep",
    });
  });

  it("does not decide on balances it could not read", () => {
    expect(inferDepositLabel(scan(sweepsInto(A1, A1), null), WALLETS, NONE)).toEqual({ kind: "rejected", reason: "balance-unknown" });
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
