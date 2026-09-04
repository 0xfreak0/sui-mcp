import { describe, it, expect } from "vitest";
import { pickFundingTx, type FundingTx } from "../src/utils/funding.js";

const TARGET = "0xtarget";
const CEX = "0xcex";
const SUI = "0x2::sui::SUI";

function tx(digest: string, sender: string | null, changes: FundingTx["changes"]): FundingTx {
  return { digest, sender, timestamp: "2024-01-01T00:00:00Z", checkpoint: "1", changes };
}

describe("pickFundingTx", () => {
  it("picks the first tx that funds the target and names the funder (counterparty)", () => {
    const txs = [
      tx("t1", CEX, [
        { address: CEX, amount: "-5000000000", coinType: SUI },
        { address: TARGET, amount: "5000000000", coinType: SUI },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET);
    expect(r?.funder).toBe(CEX);
    expect(r?.amount).toBe("5000000000");
    expect(r?.coinType).toBe(SUI);
    expect(r?.digest).toBe("t1");
  });

  it("skips transactions where the target only sends / nets negative", () => {
    const txs = [
      // target sends out — not a funding event
      tx("out", TARGET, [
        { address: TARGET, amount: "-1000000000", coinType: SUI },
        { address: "0xother", amount: "1000000000", coinType: SUI },
      ]),
      // then a real inbound
      tx("in", CEX, [
        { address: CEX, amount: "-2000000000", coinType: SUI },
        { address: TARGET, amount: "2000000000", coinType: SUI },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET);
    expect(r?.digest).toBe("in");
    expect(r?.funder).toBe(CEX);
  });

  it("falls back to the sender when there's no negative counterparty (e.g. mint/faucet)", () => {
    const txs = [
      tx("mint", "0xfaucet", [{ address: TARGET, amount: "1000000000", coinType: SUI }]),
    ];
    const r = pickFundingTx(txs, TARGET);
    expect(r?.funder).toBe("0xfaucet");
  });

  it("chooses the largest inflow coin by raw amount when no prices are available", () => {
    const OTHER = "0xa::c::OTHER";
    const txs = [
      tx("multi", CEX, [
        { address: CEX, amount: "-100000000", coinType: SUI },
        { address: TARGET, amount: "100000000", coinType: SUI },
        { address: TARGET, amount: "999999", coinType: OTHER },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET);
    // With no price function, ranking falls back to raw magnitude — which is
    // only meaningful within one coin, hence the USD-aware test below.
    expect(r?.coinType).toBe(SUI);
    expect(r?.amount).toBe("100000000");
  });

  it("ranks inflows by USD when prices are available", () => {
    // Raw magnitude ranks by decimal places: 0.1 SUI (1e8 raw) looks "bigger"
    // than 1 OTHER (999999 raw at 6 decimals) purely because SUI has more
    // decimals. With a price function the more valuable inflow wins.
    const OTHER = "0xa::c::OTHER";
    const txs = [
      tx("multi", CEX, [
        { address: CEX, amount: "-100000000", coinType: SUI },
        { address: TARGET, amount: "100000000", coinType: SUI },
        { address: TARGET, amount: "999999", coinType: OTHER },
      ]),
    ];
    const valueUsd = (coinType: string, raw: bigint) =>
      coinType === SUI ? Number(raw) / 1e9 * 0.75 : Number(raw) / 1e6 * 50;
    const r = pickFundingTx(txs, TARGET, { valueUsd });
    // 0.1 SUI ≈ $0.075 vs ~1 OTHER at $50.
    expect(r?.coinType).toBe(OTHER);
  });

  it("returns null when nothing funds the target", () => {
    const txs = [tx("x", TARGET, [{ address: TARGET, amount: "-1", coinType: SUI }])];
    expect(pickFundingTx(txs, TARGET)).toBeNull();
  });
});

describe("pickFundingTx — dust is not funding", () => {
  it("skips a spam-sized SUI send and reports why", () => {
    // 1 MIST is 1e-9 SUI. Gas for a simple transfer is ~0.001-0.005 SUI, so a
    // dust send is orders of magnitude below anything that could fund a
    // wallet — yet it used to become "first funded by", and the funding walk
    // would then chase the spammer's ancestry as the subject's origin.
    const txs = [
      tx("dust", "0xspammer", [
        { address: "0xspammer", amount: "-1", coinType: SUI },
        { address: TARGET, amount: "1", coinType: SUI },
      ]),
      tx("real", CEX, [
        { address: CEX, amount: "-5000000000", coinType: SUI },
        { address: TARGET, amount: "5000000000", coinType: SUI },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET);
    expect(r?.digest).toBe("real");
    expect(r?.funder).toBe(CEX);
    // Skipped, not hidden — silent filtering is how a reader loses evidence.
    expect(r?.dustSkipped).toEqual([
      { digest: "dust", amount: "1", coinType: SUI, reason: "below_sui_floor" },
    ]);
  });

  it("treats an unpriced coin as spam regardless of how large the number is", () => {
    // The load-bearing rule, and not a threshold: nobody funds a wallet with a
    // token that has no market. A scam token can mint any quantity it likes.
    const SCAM = "0xbad::airdrop::CLAIM";
    const txs = [
      tx("scam", "0xspammer", [{ address: TARGET, amount: "999999999999999", coinType: SCAM }]),
      tx("real", CEX, [
        { address: CEX, amount: "-5000000000", coinType: SUI },
        { address: TARGET, amount: "5000000000", coinType: SUI },
      ]),
    ];
    const valueUsd = (coinType: string) => (coinType === SUI ? 0.75 : null);
    const r = pickFundingTx(txs, TARGET, { valueUsd });
    expect(r?.digest).toBe("real");
    expect(r?.dustSkipped[0]).toMatchObject({ digest: "scam", reason: "unpriced_coin" });
  });

  it("accepts a non-SUI inflow when there is no price oracle at all", () => {
    // Missing prices must not discard evidence — only a *known* lack of market
    // is a spam signal, not an absent dependency.
    const USDC = "0xa::usdc::USDC";
    const txs = [tx("in", CEX, [
      { address: CEX, amount: "-5000000", coinType: USDC },
      { address: TARGET, amount: "5000000", coinType: USDC },
    ])];
    expect(pickFundingTx(txs, TARGET)?.digest).toBe("in");
  });

  it("honours caller-supplied floors, for a faucet-scale investigation", () => {
    const txs = [tx("tiny", CEX, [
      { address: CEX, amount: "-1", coinType: SUI },
      { address: TARGET, amount: "1", coinType: SUI },
    ])];
    expect(pickFundingTx(txs, TARGET)).toBeNull();
    expect(pickFundingTx(txs, TARGET, { minSuiMist: 0n })?.digest).toBe("tiny");
  });
});

describe("pickFundingTx — the funder must have sent what arrived", () => {
  it("does not attribute a sponsored transfer to the gas payer", () => {
    // Gas is folded into the payer's net SUI rather than itemised, so a
    // sponsor's -0.036 SUI (raw -36000000) outranks a real sender's -11 USDC
    // (raw -11085939) purely because SUI has three more decimals. Comparing
    // across all coins named the sponsor as the funder.
    const USDC = "0xa::usdc::USDC";
    const SPONSOR = "0xsponsor";
    const SENDER = "0xrealsender";
    const txs = [
      tx("sponsored", SPONSOR, [
        { address: SPONSOR, amount: "-36000000", coinType: SUI },
        { address: SENDER, amount: "-11085939", coinType: USDC },
        { address: TARGET, amount: "11085939", coinType: USDC },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET);
    expect(r?.coinType).toBe(USDC);
    expect(r?.funder).toBe(SENDER);
    expect(r?.funder).not.toBe(SPONSOR);
  });

  it("falls back to any negative counterparty when nobody sent the received coin", () => {
    // A mint or bridge release has no counterparty losing that coin; naming
    // someone beats reporting "unknown".
    const MINTED = "0xa::c::MINTED";
    const txs = [
      tx("mint", "0xminter", [
        { address: "0xminter", amount: "-5000000000", coinType: SUI },
        { address: TARGET, amount: "1000000", coinType: MINTED },
      ]),
    ];
    expect(pickFundingTx(txs, TARGET)?.funder).toBe("0xminter");
  });
});
