import { describe, it, expect } from "vitest";
import {
  allocate,
  exitCandidates,
  groupExits,
  readExit,
  summarizeFlows,
  type FlowTx,
} from "../src/utils/address-flows.js";

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const ME = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
const FUNDER = "0x1f7b";
const SPONSOR = "0x85c8";

function tx(over: Partial<FlowTx> & { digest: string }): FlowTx {
  return {
    timestamp: "2025-09-07T16:00:00.000Z",
    checkpoint: 1,
    sender: ME,
    gasSponsor: ME,
    netGas: 0n,
    changes: [],
    calls: [],
    eventTypes: [],
    ...over,
  };
}

/** Captured from mainnet tx 4rDEyqGebKd98mc8vpPs3E9jFXe37MhGWFN4tp2HdVvL. */
const CCTP_EVENTS = [
  {
    contents: {
      type: { repr: "0xecf47609::deposit_for_burn::DepositForBurn" },
      json: {
        nonce: "425380",
        burn_token: "0x3f2e28d163e25042ac7c9543c15675af5aa5d3c27dbc656a67f37f4293a3fdef",
        amount: "11085939",
        depositor: ME,
        mint_recipient: "0x0000000000000000000000009a62c1af2dff7f6b1731d9eb36b1622c17eae7be",
        destination_domain: 3,
      },
    },
  },
];

describe("summarizeFlows", () => {
  it("reports gas apart from the SUI totals", () => {
    // Sent 10 SUI to a funder-turned-payee and paid 0.004 SUI gas: the SUI
    // outflow is the 10, not 10.004.
    const s = summarizeFlows(ME, [
      tx({
        digest: "d1",
        netGas: 4_000_000n,
        changes: [
          { owner: ME, coinType: SUI, amount: -10_004_000_000n },
          { owner: FUNDER, coinType: SUI, amount: 10_000_000_000n },
        ],
      }),
    ]);
    expect(s.coins.get(SUI)?.out).toBe(10_000_000_000n);
    expect(s.gasPaid).toBe(4_000_000n);
    expect(s.recipients.get(FUNDER)?.coins.get(SUI)).toBe(10_000_000_000n);
    expect(s.unattributedOut.size).toBe(0);
  });

  it("never treats a gas sponsor's rebate as a recipient, and records who sponsored", () => {
    const s = summarizeFlows(ME, [
      tx({
        digest: "sweep",
        gasSponsor: SPONSOR,
        netGas: -5_748_960n,
        changes: [
          { owner: ME, coinType: USDC, amount: -500n },
          { owner: FUNDER, coinType: USDC, amount: 500n },
          { owner: SPONSOR, coinType: SUI, amount: 5_748_960n },
        ],
      }),
    ]);
    expect([...s.recipients.keys()]).toEqual([FUNDER]);
    // The subject was not the payer, so no gas is charged to it and no SUI moved.
    expect(s.coins.has(SUI)).toBe(false);
    expect(s.gasTransactions).toBe(0);
    expect(s.sponsoredBy.get(SPONSOR)?.digests).toEqual(["sweep"]);
  });

  it("never credits a counterparty with more than the subject moved", () => {
    // The subject pays 100; in the same PTB a stranger pays 50 to someone
    // else. Crediting both payees in full would send 150 out of a 100 change.
    const s = summarizeFlows(ME, [
      tx({
        digest: "ptb",
        changes: [
          { owner: ME, coinType: USDC, amount: -100n },
          { owner: "0xa", coinType: USDC, amount: 100n },
          { owner: "0xb", coinType: USDC, amount: 50n },
          { owner: "0xc", coinType: USDC, amount: -50n },
        ],
      }),
    ]);
    const credited = [...s.recipients.values()].reduce((sum, r) => sum + (r.coins.get(USDC) ?? 0n), 0n);
    expect(credited).toBeLessThanOrEqual(100n);
    expect(s.recipients.get("0xa")!.coins.get(USDC)! > s.recipients.get("0xb")!.coins.get(USDC)!).toBe(true);
  });

  it("reports value with no paying address as unattributed rather than dropping it", () => {
    // A swap: USDC out to a pool object, SUI in from it. No address balance moves.
    const s = summarizeFlows(ME, [
      tx({
        digest: "swap",
        changes: [
          { owner: ME, coinType: USDC, amount: -1_000_000n },
          { owner: ME, coinType: SUI, amount: 300_000_000n },
        ],
      }),
    ]);
    expect(s.sources.size).toBe(0);
    expect(s.unattributedIn.get(SUI)?.amount).toBe(300_000_000n);
    expect(s.unattributedOut.get(USDC)?.amount).toBe(1_000_000n);
  });

  it("lists every paying address, not only the first", () => {
    const s = summarizeFlows(ME, [
      tx({ digest: "f1", sender: FUNDER, gasSponsor: FUNDER, changes: [{ owner: FUNDER, coinType: SUI, amount: -39n }, { owner: ME, coinType: SUI, amount: 39n }] }),
      tx({ digest: "f2", sender: "0x9e55", gasSponsor: "0x9e55", changes: [{ owner: "0x9e55", coinType: SUI, amount: -39n }, { owner: ME, coinType: SUI, amount: 39n }] }),
      tx({ digest: "f3", sender: "0x9e55", gasSponsor: "0x9e55", changes: [{ owner: "0x9e55", coinType: SUI, amount: -39n }, { owner: ME, coinType: SUI, amount: 39n }] }),
    ]);
    expect([...s.sources.keys()].sort()).toEqual([FUNDER, "0x9e55"].sort());
    expect(s.sources.get("0x9e55")?.digests).toEqual(["f2", "f3"]);
    expect(s.coins.get(SUI)?.in).toBe(117n);
  });

  it("restricts totals to the filtered coin, whatever padding it is given in", () => {
    const s = summarizeFlows(
      ME,
      [
        tx({
          digest: "swap",
          changes: [
            { owner: ME, coinType: USDC, amount: -1n },
            { owner: ME, coinType: SUI, amount: 3n },
          ],
        }),
      ],
      "0x2::sui::SUI",
    );
    expect([...s.coins.keys()]).toEqual([SUI]);
  });
});

describe("allocate", () => {
  it("passes parts through when they fit and splits in proportion when they do not", () => {
    expect(allocate(100n, [60n, 30n])).toEqual({ shares: [60n, 30n], rest: 10n });
    expect(allocate(100n, [150n, 50n])).toEqual({ shares: [75n, 25n], rest: 0n });
  });
});

describe("bridge exits", () => {
  const burn = (digest: string) =>
    tx({
      digest,
      calls: [{ packageId: "0xecf47609", module: "deposit_for_burn", function: "deposit_for_burn_with_package_auth" }],
      eventTypes: ["0xecf47609::deposit_for_burn::DepositForBurn"],
      changes: [{ owner: ME, coinType: USDC, amount: -11_085_939n }],
    });

  it("takes only transactions the subject sent", () => {
    const theirs = { ...burn("theirs"), sender: "0xother" };
    expect(exitCandidates(ME, [burn("mine"), theirs]).map((t) => t.digest)).toEqual(["mine"]);
  });

  it("reads the CCTP recipient from the burn event and groups exits by destination", () => {
    const a = readExit(ME, burn("a"), CCTP_EVENTS, true)!;
    const b = readExit(ME, burn("b"), CCTP_EVENTS, true)!;
    expect(a.bridge).toBe("Circle CCTP");
    expect(a.beneficiaries[0].account).toBe("eip155:42161:0x9a62c1af2dff7f6b1731d9eb36b1622c17eae7be");
    const [group] = groupExits([a, b]);
    expect(group.destinations).toHaveLength(1);
    expect(group.destinations[0].sent.get(USDC)).toBe(22_171_878n);
  });

  it("drops a candidate taken for a truncated event list when the full list shows no bridge", () => {
    const t = tx({ digest: "busy", eventsTruncated: true, changes: [{ owner: ME, coinType: USDC, amount: -1n }] });
    expect(exitCandidates(ME, [t])).toHaveLength(1);
    expect(readExit(ME, t, [{ contents: { type: { repr: "0xdee9::pool::OrderFilled" } } }], true)).toBeNull();
  });

  it("does not split a transaction that paid two destinations", () => {
    const two = readExit(ME, burn("two"), CCTP_EVENTS, true)!;
    two.beneficiaries = [
      two.beneficiaries[0],
      { ...two.beneficiaries[0], address: "0xdef", account: "eip155:42161:0xdef" },
    ];
    const [group] = groupExits([two]);
    expect(group.destinations.map((d) => d.sharedDigests)).toEqual([["two"], ["two"]]);
    expect(group.destinations.every((d) => d.sent.size === 0)).toBe(true);
    expect(group.sent.get(USDC)).toBe(11_085_939n);
  });
});
