import { describe, it, expect } from "vitest";
import { participantPnl, type PnlTx } from "../src/utils/participant-pnl.js";

const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const CLAIMER = "0x62781b5e94000000000000000000000000000000000000000000000000000001";
const POOL_LP = "0x00000000000000000000000000000000000000000000000000000000000000aa";
const NEMO_V10 = "0x0f286ad004ea93ea6ad3a953b5d4f3c7306378b0dcc354c3f4ebb1d506d3b47f";
const NEMO_ROOT = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const SCALLOP = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";

function claim(digest: string, usdc: string, calls: string[]): PnlTx {
  return {
    digest,
    sender: CLAIMER,
    balanceChanges: [
      { address: CLAIMER, coinType: USDC, amount: usdc },
      { address: CLAIMER, coinType: SUI, amount: "-3000000" },
      // Somebody else's side of the same PTB is not the sender's P&L.
      { address: POOL_LP, coinType: USDC, amount: `-${usdc}` },
    ],
    calls: calls.map((p) => ({ package: p })),
  };
}

describe("participantPnl", () => {
  it("sums only the sender's own changes, per coin, across its transactions", () => {
    const [row] = participantPnl(
      [claim("a", "30000000000", [NEMO_V10]), claim("b", "7690990000", [NEMO_V10])],
      new Set([NEMO_ROOT, NEMO_V10]),
    );
    expect(row.sender).toBe(CLAIMER);
    expect(row.net.get(USDC)).toBe(37_690_990_000n);
    expect(row.net.get(SUI)).toBe(-6_000_000n);
    expect(row.digests).toEqual(["a", "b"]);
    expect(row.multiLeg).toEqual([]);
  });

  it("flags a PTB that also called a protocol outside the filtered lineage, ignoring the framework", () => {
    const [row] = participantPnl(
      [claim("a", "1", [NEMO_V10, "0x2", SCALLOP]), claim("b", "1", [NEMO_V10, "0x1"])],
      new Set([NEMO_ROOT, NEMO_V10]),
    );
    expect(row.multiLeg).toEqual(["a"]);
    expect([...row.otherPackages]).toEqual([SCALLOP]);
  });

  it("does not flag legs when there is no package filter to compare against", () => {
    const [row] = participantPnl([claim("a", "1", [NEMO_V10, SCALLOP])], null);
    expect(row.multiLeg).toEqual([]);
  });

  it("matches the sender's short and padded forms as one address", () => {
    const rows = participantPnl(
      [
        { digest: "a", sender: "0xabc", balanceChanges: [{ address: `0x${"0".repeat(61)}abc`, coinType: "0x2::sui::SUI", amount: "5" }], calls: [] },
      ],
      null,
    );
    expect(rows[0].net.get(SUI)).toBe(5n);
  });
});
