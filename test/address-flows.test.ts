import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  allocate,
  exitCandidates,
  groupExits,
  readExit,
  summarizeFlows,
  type FlowTx,
} from "../src/utils/address-flows.js";
import { bridgeExitsOf } from "../src/utils/screening.js";

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
    status: "success",
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

  it("excludes a failed transaction — its bridge call is what it attempted, not what happened", () => {
    // A Mayan MCTP attempt that aborted with INSUFFICIENT_COIN_BALANCE moved
    // nothing but gas, yet a bridge call still sits in its PTB. Only the
    // successful one is a real exit.
    const failed = { ...burn("aborted"), status: "failure" };
    expect(exitCandidates(ME, [burn("ok"), failed]).map((t) => t.digest)).toEqual(["ok"]);
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

  it("excludes a bridge fee and a relayer payment from what left Sui, and reports them as retained", () => {
    // Balance changes of 7ehoqkiBm3Wx…, a 400,000 USDC CCTP burn: 40 USDC
    // went to a fee address and 0.559771286 SUI went to a relayer as a
    // LayerZero executor fee. Neither crossed the bridge; only the 399,960
    // USDC DepositForBurn amount did.
    const FEE = "0xbfa1240e48c622d97881473953be730091161b7931d89bd6afe667841cf69ef4";
    const RELAYER = "0xfa922d7f6eaad8b0014ed9ac262ea0d8f19f4a7a7f2caf249b4cd1ad05c45e18";
    const t = tx({
      digest: "cctpFee",
      calls: [{ packageId: "0xecf47609", module: "deposit_for_burn", function: "deposit_for_burn_with_package_auth" }],
      eventTypes: ["0xecf47609::deposit_for_burn::DepositForBurn"],
      changes: [
        { owner: FEE, coinType: USDC, amount: 40_000_000n },
        { owner: ME, coinType: SUI, amount: -559_771_286n },
        { owner: ME, coinType: USDC, amount: -400_000_000_000n },
        { owner: RELAYER, coinType: SUI, amount: 559_771_286n },
      ],
    });
    const e = readExit(ME, t, null, true)!;
    expect(e.sent.get(USDC)).toBe(399_960_000_000n);
    expect(e.sent.has(SUI)).toBe(false);
    expect(e.retained.get(USDC)).toBe(40_000_000n);
    expect(e.retained.get(SUI)).toBe(559_771_286n);

    const [group] = groupExits([e]);
    expect(group.retained.get(USDC)).toBe(40_000_000n);
    expect(group.retained.get(SUI)).toBe(559_771_286n);
  });

  /**
   * 6S9udfgK… is an Allbridge pool transfer sent through Allbridge's Wormhole
   * messenger. Its WormholeMessage is Allbridge's own and names no recipient,
   * and TokensSentEvent already names one, so the message is no unresolved
   * VAA and needs no Wormholescan lookup.
   */
  it("does not list the carrier's own Wormhole message as unresolved (6S9udfgK…)", () => {
    const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/bridge-transactions.json", import.meta.url), "utf8"));
    const { effects, kind } = FIXTURES["6S9udfgK1GSCabDEsuUDB4ysdCTXkfvt2rwze2Wrdb7K"].transaction;
    const events = effects.events.nodes as Array<{ contents: { type: { repr: string }; json: unknown } }>;
    const sender = "0x22101391e2bbd3141e0aabd093643fad4c6fba70438071d8cd7364ca0225f9a7";
    const allbridge = tx({
      digest: "6S9udfgK1GSCabDEsuUDB4ysdCTXkfvt2rwze2Wrdb7K",
      sender,
      gasSponsor: sender,
      calls: (kind.commands.nodes as Array<{ function?: { name: string; module: { name: string; package: { address: string } } } }>).flatMap((c) =>
        c.function ? [{ packageId: c.function.module.package.address, module: c.function.module.name, function: c.function.name }] : [],
      ),
      eventTypes: events.map((e) => e.contents.type.repr),
      changes: [{ owner: sender, coinType: USDC, amount: -100_000n }],
    });
    const e = readExit(sender, allbridge, events, true)!;
    expect(e.bridge).toBe("Allbridge Core");
    expect(e.beneficiaries.map((b) => b.account)).toEqual(["eip155:42161:0xfb4717318748a204b028e7920bb86fe2b110917c"]);
    expect(e.unresolvedVaas).toEqual([]);

    // The same message with no Allbridge transfer beside it is a Wormhole
    // transfer whose recipient this server cannot read.
    const wormholeOnly = events.filter((ev) => ev.contents.type.repr.endsWith("::publish_message::WormholeMessage"));
    const bare = readExit(sender, { ...allbridge, calls: [], eventTypes: wormholeOnly.map((ev) => ev.contents.type.repr) }, wormholeOnly, true)!;
    expect(bare.bridge).toBe("Wormhole");
    expect(bare.unresolvedVaas).toEqual(["21/45a4ce7279dc1da00f16555dca7c04c0f19bb168fd787e57026a79600524515b/0"]);
  });

  /**
   * A Sui Bridge deposit (from 4xLuY6N6…) and a CCTP burn (from 4rDEyqGe…)
   * in one transaction. The screen cannot know the first beneficiary's
   * protocol before it reads events, so readExit picks the carrier by the
   * same rule screen_address uses, and both file it under Sui Bridge.
   */
  it("files two unrelated bridges under the carrier screen_address files them under", () => {
    const deposit = {
      contents: {
        type: { repr: "0x000000000000000000000000000000000000000000000000000000000000000b::bridge::TokenDepositedEvent" },
        json: {
          seq_num: "23371",
          source_chain: 0,
          sender_address: "xKRFS6UEKXM8q3C7Q0rJnXTSCnU0w9/Tux+m6Ts8SzI=",
          target_chain: 10,
          target_address: "1vBbGb8sBcJkpka3dXBX13RmHFw=",
          token_type: 4,
          amount: "130004100000",
        },
      },
    };
    const events = [...CCTP_EVENTS, deposit];
    const both = tx({ digest: "both", eventTypes: events.map((e) => e.contents.type.repr), changes: [{ owner: ME, coinType: USDC, amount: -11_085_939n }] });
    const e = readExit(ME, both, events, true)!;
    const [screened] = bridgeExitsOf(ME, [{ ...both, gasSponsor: ME, netGas: null }]);
    expect(e.bridge).toBe("Sui Bridge");
    expect(screened.protocol).toBe(e.bridge);
    expect(e.beneficiaries.map((b) => b.protocol).sort()).toEqual(["Circle CCTP", "Sui Bridge"]);
  });
});
