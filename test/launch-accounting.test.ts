import { normalizeSuiAddress } from "@mysten/sui/utils";
import { describe, expect, it } from "vitest";
import { accountBuy, separateRebuys, sumRaw, isSuiPumpReferralFee, reconcileLaunchWindow } from "../src/utils/launch-accounting.js";

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
    const buy = accountBuy(event, changes, token);
    expect(buy.sui_in).toBe(20_000_000_000n);
    expect(buy.tokens_out).toBe(4_663_012_558n);
    expect(buy.buy_sui_debit_incl_gas).toBe(20_002_507_832n);
    expect(buy.reconciliation_failed).toBe(false);
  });

  it("flags a balance debit over the event amount by more than 0.01 SUI", () => {
    const buy = accountBuy(event, [{ ...changes[0], amount: -20_020_000_000n }, changes[1]], token);
    expect(buy.reconciliation_failed).toBe(true);
    expect(sumRaw([buy.sui_in, 690_000_000_000n])).toBe(710_000_000_000n);
  });

  it("keeps a real buy when the buyer receives a small SUI credit in the same PTB", () => {
    const buy = accountBuy(event, [{ ...changes[0], amount: -19_999_000_000n }, changes[1]], token);
    expect(buy.sui_in).toBe(20_000_000_000n);
    expect(buy.reconciliation_failed).toBe(false);
    expect(accountBuy(event, [{ ...changes[0], amount: -19_980_000_000n }, changes[1]], token).reconciliation_failed).toBe(true);
  });

  it("allows the purchased token to be forwarded inside the buy PTB", () => {
    const buy = accountBuy(event, [{ ...changes[0] }, { ...changes[1], amount: 0n }], token);
    expect(buy.reconciliation_failed).toBe(false);
  });

  it("keeps later buys distinct from initial buys without claiming fungible proceeds as their source", () => {
    const first = accountBuy(event, changes, token);
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
      row("sale", address, 80n * SUI, -100n, 5_000_000n),
      row("send", address, -130n * SUI - 20_000_000n, -80n, 20_000_000n),
    ];
    const input = {
      owner: address, suiType: sui, tokenType: coinType, transactions, fundingSui: 100n * SUI,
      purchasedSui: 40n * SUI, rebuySui: 0n, cetusSuiNet: 80n * SUI,
      cetusSaleDigests: new Set(["sale"]), forwardedSui: 130n * SUI, boughtTokens: 200n,
      soldTokens: 100n, forwardedTokens: 80n
    };
    expect(reconcileLaunchWindow(input)).toMatchObject({
      complete: true, gasNotAlreadyInProceeds: 30_000_000n,
      suiResidual: 0n, tokenResidual: 0n, tokenObservedDelta: 20n,
    });
    expect(reconcileLaunchWindow({ ...input, transactions: transactions.slice(0, 3) }).suiResidual).not.toBe(0n);
  });

});
