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
        { address: TARGET, amount: "-1000", coinType: SUI },
        { address: "0xother", amount: "1000", coinType: SUI },
      ]),
      // then a real inbound
      tx("in", CEX, [
        { address: CEX, amount: "-2000", coinType: SUI },
        { address: TARGET, amount: "2000", coinType: SUI },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET);
    expect(r?.digest).toBe("in");
    expect(r?.funder).toBe(CEX);
  });

  it("falls back to the sender when there's no negative counterparty (e.g. mint/faucet)", () => {
    const txs = [
      tx("mint", "0xfaucet", [{ address: TARGET, amount: "1000", coinType: SUI }]),
    ];
    const r = pickFundingTx(txs, TARGET);
    expect(r?.funder).toBe("0xfaucet");
  });

  it("chooses the largest inflow coin", () => {
    const OTHER = "0xa::c::OTHER";
    const txs = [
      tx("multi", CEX, [
        { address: CEX, amount: "-100", coinType: SUI },
        { address: TARGET, amount: "100", coinType: SUI },
        { address: TARGET, amount: "999999", coinType: OTHER },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET);
    expect(r?.coinType).toBe(OTHER);
    expect(r?.amount).toBe("999999");
  });

  it("returns null when nothing funds the target", () => {
    const txs = [tx("x", TARGET, [{ address: TARGET, amount: "-1", coinType: SUI }])];
    expect(pickFundingTx(txs, TARGET)).toBeNull();
  });
});
