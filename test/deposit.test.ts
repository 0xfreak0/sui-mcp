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

// Shape of a Bybit deposit address on mainnet: three deposits were credited
// and swept while a fourth was pending; the fourth went in the next sweep to
// the same wallet 21 minutes later.
describe("a deposit that arrives while a sweep is pending", () => {
  const pending = [
    deposit("d1", 100n, "2026-01-01T15:13:00Z"),
    deposit("d2", 100n, "2026-01-01T15:13:30Z"),
    deposit("d3", 100n, "2026-01-01T15:14:00Z"),
    deposit("d4", 67n, "2026-01-01T15:14:44Z"),
    sweep("s1", 300n, "2026-01-01T15:16:55Z"),
  ];

  it("does not count as a balance left behind when a later sweep to the same wallet empties it", () => {
    const p = readDepositPattern(scan([...pending, sweep("s2", 67n, "2026-01-01T15:37:36Z")]));
    expect(p.sweeps[0]).toMatchObject({ full_balance: true, left_for_next_sweep: { arrived_in: ["d4"], swept_by: "s2" } });
    expect(decideDepositVerdict(p, { cexLabel: true, hub: null }, "relayer").verdict).toBe("likely");
  });

  it("does not count when it is still waiting and equals the deposits that arrived last", () => {
    const p = readDepositPattern(scan(pending, 67n));
    expect(p.sweeps[0]).toMatchObject({ full_balance: true, left_for_next_sweep: { arrived_in: ["d4"] } });
  });

  it("counts when the next outflow of the coin goes somewhere else", () => {
    const p = readDepositPattern(scan([...pending, sweep("s2", 67n, "2026-01-01T15:37:36Z", OTHER)]));
    expect(p.sweeps[0]!.full_balance).toBe(false);
  });

  it("counts when a later transfer to the same wallet does not empty the coin", () => {
    const p = readDepositPattern(scan([...pending, sweep("s2", 60n, "2026-01-01T15:37:36Z")], 7n));
    expect(p.sweeps.map((s) => s.full_balance)).toEqual([false, false]);
    expect(decideDepositVerdict(p, { cexLabel: true, hub: null }, "relayer").verdict).toBe("no");
  });

  it("names the next sweep as the one that took the balance, when that sweep also leaves the next deposit", () => {
    const p = readDepositPattern(
      scan([
        deposit("d1", 100n, "2026-01-01T00:00:00Z"),
        deposit("d2", 50n, "2026-01-01T00:00:10Z"),
        sweep("s1", 100n, "2026-01-01T00:00:20Z"),
        deposit("d3", 30n, "2026-01-01T00:00:30Z"),
        sweep("s2", 50n, "2026-01-01T00:00:40Z"),
        sweep("s3", 30n, "2026-01-01T00:00:50Z"),
      ]),
    );
    expect(p.sweeps.map((s) => s.left_for_next_sweep?.swept_by)).toEqual(["s2", "s3", undefined]);
  });

  it("counts a waiting balance that is not the latest deposits", () => {
    const p = readDepositPattern(scan([...pending.slice(0, 4), sweep("s1", 250n, "2026-01-01T15:16:55Z")], 117n));
    expect(p.sweeps[0]!.full_balance).toBe(false);
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

describe("gas reserve on self-paid sweeps", () => {
  const ADDR = "0x" + "a1".repeat(32);
  const SINK = "0x" + "b2".repeat(32);
  const RELAYER = "0x" + "c3".repeat(32);
  const PAYER = "0x" + "d4".repeat(32);
  const GAS = 2_000_000n;

  const incoming = (digest: string, amount: bigint, coinType = SUI): ScannedTx => ({
    digest,
    timestamp: null,
    sender: PAYER,
    gasSponsor: PAYER,
    changes: [
      { owner: PAYER, coinType, amount: -amount },
      { owner: ADDR, coinType, amount },
    ],
  });
  // The address pays gas: it loses the amount plus gas, the sink gains the amount.
  const selfPaid = (digest: string, amount: bigint, coinType = SUI): ScannedTx => ({
    digest,
    timestamp: null,
    sender: ADDR,
    gasSponsor: ADDR,
    changes:
      coinType === SUI
        ? [
            { owner: ADDR, coinType: SUI, amount: -amount - GAS },
            { owner: SINK, coinType: SUI, amount },
          ]
        : [
            { owner: ADDR, coinType, amount: -amount },
            { owner: ADDR, coinType: SUI, amount: -GAS },
            { owner: SINK, coinType, amount },
          ],
  });
  const sponsored = (digest: string, amount: bigint): ScannedTx => ({
    digest,
    timestamp: null,
    sender: ADDR,
    gasSponsor: RELAYER,
    changes: [
      { owner: ADDR, coinType: SUI, amount: -amount },
      { owner: RELAYER, coinType: SUI, amount: 1_000_000n },
      { owner: SINK, coinType: SUI, amount },
    ],
  });
  const window = (txs: ScannedTx[], balances: Array<[string, bigint]>): DepositScan => ({
    address: ADDR,
    txs,
    complete: true,
    currentBalances: new Map(balances),
  });

  // 30 SUI in, swept self-paid leaving 0.02 SUI; 100 SUI in, swept whole by a relayer.
  const MIXED = window(
    [
      incoming("in1", 30_000_000_000n),
      selfPaid("self1", 29_978_000_000n),
      incoming("in2", 100_000_000_000n),
      sponsored("relay1", 100_020_000_000n),
    ],
    [[SUI, 0n]],
  );

  it("counts a self-paid sweep that leaves only a gas reserve as a full sweep", () => {
    const p = readDepositPattern(MIXED);
    expect(p.sweeps.map((s) => [s.digest, s.full_balance, s.kept_for_gas])).toEqual([
      ["self1", true, "0.02 SUI"],
      ["relay1", true, undefined],
    ]);
    expect(p.sweeps[0]!.coins[0]!.balance_after_raw).toBe("20000000");
  });

  it("reads sponsored full sweeps mixed with older gas-reserve sweeps as likely, with every check run", () => {
    const v = decideDepositVerdict(readDepositPattern(MIXED), { cexLabel: true, hub: null }, "relayer");
    expect(v.verdict).toBe("likely");
    expect(v.checks).toEqual({
      single_destination: true,
      full_balance_sweeps: true,
      sponsored_sweeps: false,
      sponsor_relayer_shaped: true,
      destination_is_exchange: true,
    });
    expect(v.checks_not_run).toEqual({});
  });

  it("is still no when a self-paid transfer leaves more than the gas reserve", () => {
    const p = readDepositPattern(
      window([incoming("in1", 100_000_000_000n), selfPaid("pay1", 40_000_000_000n)], [[SUI, 59_998_000_000n]]),
    );
    expect(p.sweeps[0]!.full_balance).toBe(false);
    const v = decideDepositVerdict(p, { cexLabel: true, hub: null }, null);
    expect(v.verdict).toBe("no");
    // The later checks still ran, so the reasons show all the evidence.
    expect(v.checks.sponsored_sweeps).toBe(false);
    expect(v.checks.sponsor_relayer_shaped).toBe(false);
    expect(v.checks.destination_is_exchange).toBe(true);
  });

  it("allows no reserve of a coin other than SUI", () => {
    const p = readDepositPattern(
      window(
        [incoming("in1", 1_000_000_000n), incoming("in2", 500_000n, USDC), selfPaid("usdc1", 400_000n, USDC)],
        [
          [SUI, 998_000_000n],
          [USDC, 100_000n],
        ],
      ),
    );
    expect(p.sweeps[0]!.full_balance).toBe(false);
  });

  it("explains every check it leaves null", () => {
    const cases = [
      decideDepositVerdict(readDepositPattern(window([incoming("in1", 10n)], [[SUI, 10n]])), null, null),
      decideDepositVerdict(readDepositPattern({ ...MIXED, currentBalances: null }), { cexLabel: false, hub: null }, null, {
        sponsor: "sponsor unmeasured",
        destination: "destination unmeasured",
      }),
      decideDepositVerdict(
        readDepositPattern(window([incoming("in1", 100_000_000_000n), selfPaid("pay1", 40_000_000_000n)], [[SUI, 59_998_000_000n]])),
        null,
        null,
      ),
    ];
    for (const v of cases) {
      const nulls = Object.entries(v.checks).filter(([, value]) => value === null).map(([key]) => key);
      expect(Object.keys(v.checks_not_run).sort()).toEqual(nulls.sort());
    }
    expect(cases[1]!.verdict).toBe("unknown");
    expect(cases[1]!.checks_not_run.sponsor_relayer_shaped).toBe("sponsor unmeasured");
  });
});
