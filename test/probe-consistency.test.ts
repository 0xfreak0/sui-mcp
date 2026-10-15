import { describe, expect, it } from "vitest";
import { attributedCredits, coinChanges, custodyRows, directRootOut, externalCredits, firstHop, fundingAgreement, moveCallTargets, norm, rawNet, suiToMist, transactionAgreement } from "../scripts/probe/lib/consistency.mjs";
import { ORACLE_PROBES, probePlan } from "../scripts/probe/lib/tiers.mjs";

const wallet = `0x${"a".repeat(64)}`;
const other = `0x${"b".repeat(64)}`;

describe("cross-tool consistency rules", () => {
  it("normalizes coin types and compares raw signed amounts without float conversion", () => {
    const changes = [{ address: "0xa", coin_type: "0x2::sui::SUI", amount: "9007199254740993" }];
    expect(coinChanges(changes)).toEqual(coinChanges([{ address: norm("0xa"), coin_type: norm("0x2::sui::SUI"), amount: "9007199254740993" }]));
    const a = { sender: "0xa", status: "success", checkpoint: 20, balance_changes: changes };
    const b = { sender: norm("0xa"), status: "success", checkpoint: "20", balance_changes: [changes[0]] };
    const result = transactionAgreement(a, b);
    expect(result.single).toEqual(result.batch);
    expect(transactionAgreement(a, { ...b, balance_changes: [{ ...changes[0], amount: "9007199254740992" }] }).single)
      .not.toEqual(transactionAgreement(a, { ...b, balance_changes: [{ ...changes[0], amount: "9007199254740992" }] }).batch);
  });

  it("compares an object's custody destination, not just its ID", () => {
    const transfer = {
      object_id: wallet, type: "pkg::Item", kind: "transferred",
      from: { kind: "address", address: wallet }, to: { kind: "address", address: other }
    };
    expect(custodyRows([transfer])).not.toEqual(custodyRows([{ ...transfer, to: { kind: "address", address: wallet } }]));
    expect(custodyRows([transfer])).toEqual(custodyRows([{ ...transfer, object_id: wallet.toUpperCase().replace(/^0X/, "0x") }]));
  });

  it("uses the batch row's first hop rather than the origin of a multi-hop walk", () => {
    const hop = { funded_by: other, funding_tx: "digest" };
    const single = { chain: [hop], origin: { address: wallet } };
    const batch = { results: [{ address: wallet, first_hop: hop, first_funder: other }] };
    const edge = { first_funders: { [wallet]: other }, truncated: false };
    expect(firstHop(single)).toEqual({ funder: other, digest: "digest" });
    expect(fundingAgreement(single, batch, edge, wallet)).toEqual({ single: firstHop(single), batch: firstHop(single), edge: other });
    expect(fundingAgreement(single, batch, { first_funders: {}, truncated: true }, wallet)).toEqual({ unavailable: "cluster funding read incomplete" });
    expect(fundingAgreement(single, batch, { first_funders: {}, truncated: false }, wallet).edge).toBeNull();
  });

  it("sums all history rows by coin in integer units", () => {
    expect(rawNet([{ subject_flow: [{ raw_type: "0x2::sui::SUI", amount: "7" }] }, { subject_flow: [{ raw_type: norm("0x2::sui::SUI"), amount: "-11" }] }]))
      .toEqual({ [norm("0x2::sui::SUI")]: "-4" });
  });

  it("reads net gas back to signed MIST, including rebates and exponent forms", () => {
    expect(suiToMist(0.05618864)).toBe(56188640n);
    expect(suiToMist(-0.0012)).toBe(-1200000n);
    expect(suiToMist(9.88e-7)).toBe(988n);
    expect(suiToMist(0)).toBe(0n);
    expect(() => suiToMist(Number.NaN)).toThrow();
  });

  it("lists Move call targets in command order, normalized, and skips plumbing commands", () => {
    const commands = [
      { type: "SplitCoins" },
      { type: "MoveCall", target: "0x2::coin::zero" },
      { type: "MoveCall", target: `${wallet}::pool::swap` },
    ];
    expect(moveCallTargets(commands)).toEqual([norm("0x2::coin::zero"), `${wallet}::pool::swap`]);
  });

  it("adds external source credits by coin without rounding and keeps outgoing self-paid flows out", () => {
    const n = "9007199254740993";
    const history = [{ sender: other, subject_flow: [{ raw_type: "0x2::sui::SUI", amount: n }] },
    { sender: wallet, subject_flow: [{ raw_type: "0x2::sui::SUI", amount: "12" }] }];
    const sources = [{ coins: [{ coin_type: norm("0x2::sui::SUI"), raw: { in: n } }] }];
    expect(externalCredits(history, wallet)).toEqual(attributedCredits(sources));
    expect(externalCredits(history, wallet)).toEqual({ [norm("0x2::sui::SUI")]: n });
  });

  it("compares a direct graph root in raw units and rejects conversions and a partial root", () => {
    const root = { id: `${wallet}|*`, address: wallet, depth: 0 };
    const edge = { from: root.id, coin_type: "0x2::sui::SUI", amount: "9007199254740993", basis: "direct" };
    const graph = { nodes: [root], edges: [edge, { ...edge, amount: "4" }], coverage: {} };
    expect(directRootOut(graph, wallet)).toEqual({ [norm("0x2::sui::SUI")]: "9007199254740997" });
    expect(directRootOut({ ...graph, edges: [{ ...edge, basis: "swap-follow" }] }, wallet)).toBeNull();
    expect(directRootOut({ ...graph, coverage: { partial: ["move cap"] } }, wallet)).toBeNull();
  });

  it("selects the probe for an affected tool with existing case coverage", () => {
    const tool = "find_funding_source";
    expect(ORACLE_PROBES["consistency-pass.mjs"]).toContain(tool);
    const plan = probePlan("affected", {
      tools: [tool], caseTools: new Set([tool]), probes: new Map([["consistency-pass.mjs", `await call("${tool}", {})`]]),
      reach: { full: null, tools: new Set([tool]), scripts: new Set(), cases: new Set(), detectorLabels: false },
    });
    expect(plan?.plan.has("consistency-pass.mjs")).toBe(true);
  });
});
