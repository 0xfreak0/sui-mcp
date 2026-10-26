import { normalizeSuiAddress } from "@mysten/sui/utils";
import { describe, expect, it } from "vitest";
import { accountBuy, accountBuyer, ownerForwards, tradeLegs, separateRebuys, sumRaw, isSuiPumpReferralFee, reconcileLaunchWindow, type LaunchLedgerTx, type LaunchPool } from "../src/utils/launch-accounting.js";
import { payersIn } from "../src/utils/launch-read.js";

const sui = "0x2::sui::SUI";
const SUI = 1_000_000_000n;
const token = "0x123::coin::TEST";
const buyer = "0x1";
const event = {
  digest: "synthetic-buy", timestamp: "2026-01-01T00:01:00Z", buyer,
  curve_id: "0x2", sui_in: "20000000000", tokens_out: "4663012558", referral: "0x4",
};
const changes = [
  { address: normalizeSuiAddress(buyer), coin_type: sui, amount: -20_002_507_832n },
  { address: normalizeSuiAddress(buyer), coin_type: token, amount: 4_663_012_558n },
];

describe("launch event-first accounting", () => {
  it("uses event amounts, keeping the gas-inclusive debit separately", () => {
    const buy = accountBuy(event, changes, 2_507_832n);
    expect(buy.sui_in).toBe(20_000_000_000n);
    expect(buy.tokens_out).toBe(4_663_012_558n);
    expect(buy.buy_sui_debit_incl_gas).toBe(20_002_507_832n);
    expect(buy.sui_outside_trade).toBe(0n);
    expect(buy.debit_differs).toBe(false);
  });

  it("reports SUI moved beside the trade without touching the event amount", () => {
    // A bot fee of 0.12 SUI paid in the buy PTB, gas of 0.036 SUI, and a buy
    // paid with SUI swapped in from another coin all keep the event's sui_in.
    const fee = accountBuy(event, [{ ...changes[0], amount: -20_156_000_000n }, changes[1]], 36_000_000n);
    expect(fee).toMatchObject({ sui_in: 20_000_000_000n, sui_outside_trade: 120_000_000n, debit_differs: true });
    const swapped = accountBuy(event, [{ ...changes[0], amount: -5_000_000n }, changes[1]], 5_000_000n);
    expect(swapped).toMatchObject({ sui_in: 20_000_000_000n, sui_outside_trade: -20_000_000_000n, debit_differs: true });
    const unknownGas = accountBuy(event, [{ ...changes[0], amount: -19_980_000_000n }, changes[1]]);
    expect(unknownGas).toMatchObject({ sui_outside_trade: null, debit_differs: true });
  });

  it("keeps later buys distinct from initial buys without claiming fungible proceeds as their source", () => {
    const first = accountBuy(event, changes);
    const later = { ...first, digest: "synthetic-rebuy", timestamp: "2026-01-01T01:00:00Z", sui_in: 690_000_000_000n };
    const split = separateRebuys([first, later], Date.parse("2026-01-01T00:30:00Z"));
    expect(split.initial.map(b => b.digest)).toEqual(["synthetic-buy"]);
    expect(split.after_first_sale.map(b => b.digest)).toEqual(["synthetic-rebuy"]);
  });

  it("excludes referral fees from both a curve buy and a curve sell, including earlier other-token sales", () => {
    const recipient = normalizeSuiAddress("0x4");
    const fee = (type: string, referral: string) => [{ type, data: { referral } }];
    expect(isSuiPumpReferralFee(fee("0xab::bonding_curve::TokensPurchased", "0x4"), recipient)).toBe(true);
    expect(isSuiPumpReferralFee(fee("0xcd::bonding_curve::TokensSold", recipient), recipient)).toBe(true);
    expect(isSuiPumpReferralFee(fee("0xcd::bonding_curve::TokensSold", "0x5"), recipient)).toBe(false);
    expect(isSuiPumpReferralFee(fee("0xcd::other::TokensSold", recipient), recipient)).toBe(false);
  });
  it("reconciles trade events and gas to complete-window deltas without inventing a closing balance", () => {
    const address = normalizeSuiAddress(buyer);
    const coinType = normalizeSuiAddress("0x123") + "::coin::TEST";
    const row = (digest: string, sender: string, suiAmount: bigint, tokenAmount: bigint, gas: bigint) => ({
      digest, sender, sponsor: null, gas,
      changes: [
        { address, coin_type: sui, amount: suiAmount },
        { address, coin_type: coinType, amount: tokenAmount },
      ]
    });
    const transactions = [
      row("fund", normalizeSuiAddress("0x2"), 100n * SUI, 0n, 1_000_000n),
      row("buy", address, -40n * SUI - 10_000_000n, 200n, 10_000_000n),
      row("sale", address, 80n * SUI - 5_000_000n, -100n, 5_000_000n),
      row("send", address, -130n * SUI - 20_000_000n, -80n, 20_000_000n),
    ];
    const input = {
      owner: address, suiType: sui, tokenType: coinType, transactions,
      trades: { suiIn: 40n * SUI, suiOut: 80n * SUI, tokensIn: 200n, tokensOut: 100n },
      forwardedSui: 130n * SUI, forwardedTokens: 80n,
    };
    expect(reconcileLaunchWindow(input)).toMatchObject({
      complete: true, gas: 35_000_000n, inflowSui: 100n * SUI,
      suiResidual: 0n, tokenResidual: 0n, tokenObservedDelta: 20n,
    });
    expect(reconcileLaunchWindow({ ...input, transactions: transactions.slice(0, 3) }).suiResidual).not.toBe(0n);
  });

  describe("one buyer's ledger from its window history", () => {
    const owner = normalizeSuiAddress("0xb1");
    const curve = normalizeSuiAddress("0xcc");
    const coin = normalizeSuiAddress("0x123") + "::coin::TEST";
    const SUIT = normalizeSuiAddress("0x2") + "::sui::SUI";
    const funder = normalizeSuiAddress("0xf0");
    const collector = normalizeSuiAddress("0xfee");
    const deposit = normalizeSuiAddress("0xde9");
    const pool: LaunchPool = { id: normalizeSuiAddress("0x9001"), coinIsA: true, isPoolSwap: (type) => type.endsWith("::pool::SwapEvent") };
    const tx = (digest: string, minute: number, sender: string, gas: bigint, changes: Array<[string, string, bigint]>, events: LaunchLedgerTx["events"] = []): LaunchLedgerTx => ({
      digest, sender, sponsor: null, gas, status: "SUCCESS", timestamp: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(), events,
      changes: changes.map(([address, coin_type, amount]) => ({ address, coin_type, amount })),
    });
    const curveBuy = (suiIn: bigint, tokens: bigint) => ({ type: "0xab::bonding_curve::TokensPurchased", data: { curve_id: curve, buyer: owner, sui_in: String(suiIn), tokens_out: String(tokens), referral: null } });
    const swap = (atob: boolean, amountIn: bigint, amountOut: bigint) => ({ type: "0xcd::pool::SwapEvent", data: { pool: pool.id, atob, amount_in: String(amountIn), amount_out: String(amountOut) } });
    const history = [
      tx("fund", 0, funder, 1_000_000n, [[owner, SUIT, 100n * SUI], [funder, SUIT, -100n * SUI - 1_000_000n]]),
      // Window buy with a 0.5 SUI bot fee in the same PTB.
      tx("window-buy", 1, owner, 10_000_000n, [[owner, SUIT, -40_510_000_000n], [owner, coin, 1_000n], [collector, SUIT, 500_000_000n]], [curveBuy(40n * SUI, 1_000n)]),
      // A curve buy after the discovery window and before any sale.
      tx("later-curve-buy", 30, owner, 10_000_000n, [[owner, SUIT, -10_010_000_000n], [owner, coin, 200n]], [curveBuy(10n * SUI, 200n)]),
      // A pool sale whose proceeds are forwarded in the same PTB.
      tx("sell-and-forward", 60, owner, 20_000_000n, [[owner, SUIT, 9_980_000_000n], [owner, coin, -600n], [deposit, SUIT, 60n * SUI]], [swap(true, 600n, 70n * SUI)]),
      // A pool buy after the sale.
      tx("pool-rebuy", 90, owner, 10_000_000n, [[owner, SUIT, -5_010_000_000n], [owner, coin, 50n]], [swap(false, 5n * SUI, 50n)]),
    ];
    const windowBuys = [accountBuy({ digest: "window-buy", timestamp: history[1].timestamp, buyer: owner, curve_id: curve, sui_in: String(40n * SUI), tokens_out: "1000" }, history[1].changes, history[1].gas)];
    const forwards = history.filter((row) => row.sender === owner).flatMap((row) => ownerForwards(row, owner, SUIT, coin, tradeLegs(row.events, owner, curve, pool, true)));

    it("records a fee beside a buy and a forward beside a sale at the amounts credited", () => {
      expect(forwards).toEqual([
        { destination: collector, coin_type: SUIT, amount: 500_000_000n },
        { destination: deposit, coin_type: SUIT, amount: 60n * SUI },
      ]);
    });

    it("counts a debit-mismatched window buy, and every later curve and pool buy gross", () => {
      const result = accountBuyer({
        owner, suiType: SUIT, coinType: coin, curve, pool, history, windowBuys,
        forwardedSui: sumRaw(forwards.map((f) => f.amount)), forwardedTokens: 0n,
      });
      expect(result.initialSui).toBe(40n * SUI);
      expect(result.initialTokens).toBe(1_000n);
      expect(result.later.map((b) => [b.digest, b.venue, b.sui, b.after_first_sale])).toEqual([
        ["later-curve-buy", "SuiPump", 10n * SUI, false],
        ["pool-rebuy", "Cetus", 5n * SUI, true],
      ]);
      expect(result.grossSui).toBe(55n * SUI);
      expect(result.grossTokens).toBe(1_250n);
      expect(result.poolProceeds).toBe(70n * SUI);
      expect(result.debit).toBe(40_510_000_000n);
      expect(result.account).toMatchObject({ suiResidual: 0n, tokenResidual: 0n, inflowSui: 100n * SUI });
    });

    it("forwards a send-all at the credit when the storage rebate exceeds gas, and reconciles exactly", () => {
      const sendAll = tx("send-all", 120, owner, -901_000n, [[owner, SUIT, -1_234_567_000_000n], [deposit, SUIT, 1_234_567_901_000n]]);
      expect(ownerForwards(sendAll, owner, SUIT, coin, tradeLegs([], owner, curve, pool, true)))
        .toEqual([{ destination: deposit, coin_type: SUIT, amount: 1_234_567_901_000n }]);
      const funded = tx("fund-big", 100, funder, 1_000n, [[owner, SUIT, 1_234_567_000_000n]]);
      expect(reconcileLaunchWindow({
        owner, suiType: SUIT, tokenType: coin, transactions: [funded, sendAll],
        trades: { suiIn: 0n, suiOut: 0n, tokensIn: 0n, tokensOut: 0n }, forwardedSui: 1_234_567_901_000n, forwardedTokens: 0n,
      }).suiResidual).toBe(0n);
    });

    it("keeps a stranger's credit in the owner's PTB off its forwards", () => {
      const stranger = normalizeSuiAddress("0x5e1");
      const mixed = tx("mixed", 150, owner, 1_000_000n, [[owner, SUIT, -1_001_000_000n], [stranger, SUIT, 5n * SUI]]);
      expect(ownerForwards(mixed, owner, SUIT, coin, tradeLegs([], owner, curve, pool, true)))
        .toEqual([{ destination: stranger, coin_type: SUIT, amount: SUI }]);
    });
  });

  it("counts distinct payers above the dust floor, not the owner, dust or a sponsor's gas rebate", () => {
    const target = normalizeSuiAddress("0xc011");
    const SUIT = normalizeSuiAddress("0x2") + "::sui::SUI";
    const coin = normalizeSuiAddress("0x123") + "::coin::TEST";
    const row = (sender: string, coinType: string, amount: bigint, sponsor: string | null = null) =>
      ({ sender: normalizeSuiAddress(sender), sponsor: sponsor && normalizeSuiAddress(sponsor), changes: [{ address: target, coin_type: coinType, amount }] });
    const payers = payersIn([
      row("0xa1", SUIT, 10_000_000n), row("0xa2", SUIT, 5n * SUI), row("0xa2", SUIT, 5n * SUI),
      row("0xa3", coin, 1n), row("0xa4", SUIT, 1_000_000n), row("0xa5", SUIT, 2_000_000n, "0xc011"),
      { sender: target, sponsor: null, changes: [{ address: target, coin_type: SUIT, amount: 9n * SUI }] },
    ], target, coin);
    expect([...payers].sort()).toEqual(["0xa1", "0xa2", "0xa3"].map((a) => normalizeSuiAddress(a)));
  });

});
