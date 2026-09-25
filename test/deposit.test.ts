import { describe, expect, it } from "vitest";
import {
  decideDepositVerdict,
  readDepositPattern,
  type DepositScan,
  type ScannedTx,
} from "../src/utils/deposit.js";

// Shapes taken from mainnet: Binance deposit address 0x01740e57…4efe received
// 125,941 SUI in DWaTrFMV… and was swept 5 minutes later in 23E7yTWG… into
// Binance's proof-of-reserves wallet 0x935029…, gas sponsored by 0x85c81a4f….
// The sponsor's balance change on a sweep is POSITIVE: sweeping deletes coin
// objects and the storage rebate goes to whoever paid gas.
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const DEPOSIT = "0x01740e57b294476b0ea72ead41ea91689c280b9277e0dcde98024c779f3a4efe";
const HOT = "0x935029ca5219502a47ac9b69f556ccf6e2198b5e7815cf50f68846f723739cbd";
const SPONSOR = "0x85c81a4f616f87a303ba2ae34eed758a2cc1938f80c186526cd3122375b87a95";
const CUSTOMER = "0xf4b76bd08d28fa81c539ffd3e6a806eb863fc8c3b26d8ffecc2ace7a12626432";
const OTHER = "0x" + "ab".repeat(32);

const deposit = (digest: string, amount: bigint, at: string): ScannedTx => ({
  digest,
  timestamp: at,
  sender: CUSTOMER,
  gasSponsor: null,
  changes: [
    { owner: CUSTOMER, coinType: SUI, amount: -amount - 2_000_000n },
    { owner: DEPOSIT, coinType: SUI, amount },
  ],
});

const sweep = (digest: string, amount: bigint, at: string, to = HOT, rebate = 5_748_960n): ScannedTx => ({
  digest,
  timestamp: at,
  sender: DEPOSIT,
  gasSponsor: SPONSOR,
  changes: [
    { owner: DEPOSIT, coinType: SUI, amount: -amount },
    { owner: SPONSOR, coinType: SUI, amount: rebate },
    { owner: to, coinType: SUI, amount },
  ],
});

const scan = (txs: ScannedTx[], balance = 0n): DepositScan => ({
  address: DEPOSIT,
  txs,
  complete: true,
  currentBalances: new Map([[SUI, balance]]),
});

const BINANCE_CASE = scan([
  deposit("DWaTrFMVLkQr7UXwiHNMCyxcoKni3Agg1pc5WCf8pV5A", 125_941_000_000_000n, "2026-09-25T17:38:42.349Z"),
  sweep("23E7yTWGWAbnL1rQZj3ZyJtPEuEWk2DfgsoHP8nfdHHD", 125_941_000_000_000n, "2026-09-25T17:44:00.834Z"),
]);

describe("readDepositPattern", () => {
  it("reads a sponsored sweep as a full-balance transfer to one destination, not two", () => {
    const p = readDepositPattern(BINANCE_CASE);
    expect(p.otherOutflows).toEqual([]);
    expect(p.destinations).toEqual([HOT]);
    expect(p.sponsors).toEqual([SPONSOR]);
    expect(p.sweeps[0]).toMatchObject({
      digest: "23E7yTWGWAbnL1rQZj3ZyJtPEuEWk2DfgsoHP8nfdHHD",
      full_balance: true,
      sponsor: SPONSOR,
    });
    expect(p.sweeps[0]!.coins).toEqual([
      expect.objectContaining({ coin_type: SUI, amount: "125941 SUI", balance_after_raw: "0" }),
    ]);
    expect(p.deposits[0]).toMatchObject({ digest: "DWaTrFMVLkQr7UXwiHNMCyxcoKni3Agg1pc5WCf8pV5A", from: [CUSTOMER] });
  });

  it("reconstructs the balance after each outflow backwards from the current balance", () => {
    // 10 in, 4 out (leaves 6), then 6 out (leaves 0), current balance 0.
    const p = readDepositPattern(
      scan([
        deposit("d1", 10n, "2026-01-01T00:00:00Z"),
        sweep("s1", 4n, "2026-01-01T00:01:00Z"),
        sweep("s2", 6n, "2026-01-01T00:02:00Z"),
      ]),
    );
    expect(p.sweeps.map((s) => [s.digest, s.full_balance])).toEqual([
      ["s1", false],
      ["s2", true],
    ]);
  });

  it("does not count self-paid gas as a swept coin", () => {
    // A USDC sweep the address paid gas for: its SUI drops, the hot wallet
    // gains only USDC. The leftover SUI must not make the sweep look partial.
    const tx: ScannedTx = {
      digest: "usdcSweep",
      timestamp: "2026-01-01T00:00:00Z",
      sender: DEPOSIT,
      gasSponsor: DEPOSIT,
      changes: [
        { owner: DEPOSIT, coinType: USDC, amount: -500_000_000n },
        { owner: DEPOSIT, coinType: SUI, amount: -1_500_000n },
        { owner: HOT, coinType: USDC, amount: 500_000_000n },
      ],
    };
    const p = readDepositPattern({
      address: DEPOSIT,
      txs: [tx],
      complete: false,
      currentBalances: new Map([
        [SUI, 98_500_000n],
        [USDC, 0n],
      ]),
    });
    expect(p.sweeps[0]!.coins.map((c) => c.coin_type)).toEqual([USDC]);
    expect(p.sweeps[0]!.full_balance).toBe(true);
    expect(p.sweeps[0]!.sponsor).toBeNull();
  });

  it("leaves fullness unknown when the current balance could not be read", () => {
    const p = readDepositPattern({ ...BINANCE_CASE, currentBalances: null });
    expect(p.sweeps[0]!.full_balance).toBeNull();
  });
});

describe("decideDepositVerdict", () => {
  it("is likely for full sponsored sweeps into a cex-labelled wallet paid by a relayer", () => {
    const v = decideDepositVerdict(readDepositPattern(BINANCE_CASE), { cexLabel: true, hub: null }, "relayer");
    expect(v.verdict).toBe("likely");
    expect(v.checks).toEqual({
      single_destination: true,
      full_balance_sweeps: true,
      sponsored_sweeps: true,
      sponsor_relayer_shaped: true,
      destination_is_exchange: true,
    });
  });

  it("is still likely from the label alone when the sponsor was not measured", () => {
    const v = decideDepositVerdict(readDepositPattern(BINANCE_CASE), { cexLabel: true, hub: null }, null);
    expect(v.verdict).toBe("likely");
    expect(v.checks.sponsor_relayer_shaped).toBeNull();
  });

  it("stays unknown for an unlabelled hub when the sweeps paid their own gas", () => {
    const selfPaid = scan([
      deposit("d1", 10n, "2026-01-01T00:00:00Z"),
      { ...sweep("s1", 10n, "2026-01-01T00:01:00Z"), gasSponsor: DEPOSIT, changes: [
        { owner: DEPOSIT, coinType: SUI, amount: -10n },
        { owner: HOT, coinType: SUI, amount: 10n },
      ] },
    ]);
    const v = decideDepositVerdict(readDepositPattern(selfPaid), { cexLabel: false, hub: true }, null);
    expect(v.verdict).toBe("unknown");
    expect(v.checks.sponsored_sweeps).toBe(false);
  });

  it("is no when outflows go to two destinations", () => {
    const p = readDepositPattern(
      scan([
        deposit("d1", 20n, "2026-01-01T00:00:00Z"),
        sweep("s1", 10n, "2026-01-01T00:01:00Z"),
        sweep("s2", 10n, "2026-01-01T00:02:00Z", OTHER),
      ]),
    );
    const v = decideDepositVerdict(p, { cexLabel: false, hub: null }, "relayer");
    expect(v.verdict).toBe("no");
    expect(v.checks.single_destination).toBe(false);
  });

  it("is no when an outflow left a balance behind", () => {
    const p = readDepositPattern(
      scan([deposit("d1", 10n, "2026-01-01T00:00:00Z"), sweep("s1", 4n, "2026-01-01T00:01:00Z")], 6n),
    );
    expect(decideDepositVerdict(p, { cexLabel: true, hub: null }, "relayer").verdict).toBe("no");
  });

  it("is no when value left without a single recipient", () => {
    const swap: ScannedTx = {
      digest: "swap",
      timestamp: "2026-01-01T00:01:00Z",
      sender: DEPOSIT,
      gasSponsor: DEPOSIT,
      changes: [
        { owner: DEPOSIT, coinType: SUI, amount: -10n },
        { owner: DEPOSIT, coinType: USDC, amount: 30n },
      ],
    };
    const v = decideDepositVerdict(
      readDepositPattern(scan([deposit("d1", 10n, "2026-01-01T00:00:00Z"), swap])),
      null,
      null,
    );
    expect(v.verdict).toBe("no");
  });

  it("is unknown for an address that has only received", () => {
    const v = decideDepositVerdict(
      readDepositPattern(scan([deposit("d1", 10n, "2026-01-01T00:00:00Z")], 10n)),
      null,
      null,
    );
    expect(v.verdict).toBe("unknown");
  });
});
