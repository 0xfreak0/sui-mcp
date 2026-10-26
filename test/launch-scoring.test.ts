import { describe, expect, it } from "vitest";
import {
  scoreLaunch,
  type LaunchBuyer,
  type LaunchDestination,
  type LaunchScoringInput,
  type LaunchScoringResult,
} from "../src/utils/launch-scoring.js";
import { pageAt } from "../src/utils/output-cap.js";

const CREATOR = "0xc0";
const STUDIO = "0xdd1";
const DEPOSIT = "0xdd2";
const SUI = 1_000_000_000n;
const SUPPLY = 1_000_000_000n;

function buyer(address: string): LaunchBuyer {
  return { address, funding: [], transfers: [], payments: [], referrals: [], suinsNames: [] };
}

function input(buyers: LaunchBuyer[], destinations: LaunchDestination[] = []): LaunchScoringInput {
  return { creator: { address: CREATOR, payments: [] }, buyers, destinations, totalSupplyRaw: SUPPLY };
}

function wallet(address: string, popularity: LaunchDestination["popularity"] = "narrow"): LaunchDestination {
  return { address, kind: "wallet", popularity };
}

function transfer(b: LaunchBuyer, destination: string, asset: "sui" | "token" = "sui", qualifies = true): void {
  b.transfers.push({
    destination, asset, amount: asset === "sui" ? 20n * SUI : 2_000_000n,
    digest: `transfer-${b.address}-${destination}`, qualifies
  });
}

function topup(b: LaunchBuyer, minute: number, digest: string, status: "narrow" | "hub" | "unmeasured" = "narrow", recipientCount = 3): void {
  b.funding.push({
    source: "0xf1", amountMist: 20n * SUI, at: minute * 60_000,
    digest, sourceStatus: status, transactionRecipientCount: recipientCount
  });
}

function pair(result: LaunchScoringResult, a: string, b: string) {
  const [left, right] = [a, b].sort();
  return result.pairs.find((p) => p.a === left && p.b === right);
}

describe("launch pairwise scoring", () => {
  it("joins five independently evidenced core buyers and the creator, without absorbing two flippers", () => {
    const [a, b, c, d, e, f, g] = ["0xa1", "0xa2", "0xa3", "0xa4", "0xa5", "0xf1", "0xf2"].map(buyer);
    transfer(a, DEPOSIT);
    transfer(b, DEPOSIT);
    for (const member of [b, c, d, e]) transfer(member, STUDIO, "token");
    // Four qualifying launch top-ups are enough to corroborate the pairwise
    // destination links; e has no launch top-up and enters through the creator.
    for (const [member, minute] of [[a, 0], [b, 2], [c, 3], [d, 4]] as const) {
      topup(member, minute, `fund-${member.address}`);
    }
    topup(a, 0, "targeted");
    topup(b, 1, "targeted");
    topup(c, 2, "targeted");
    const data = input([a, b, c, d, e, f, g], [wallet(STUDIO), { ...wallet(DEPOSIT, "unmeasured"), depositVerdict: "likely", classificationComplete: true, distinctDepositors: 4 }]);
    data.creator.payments.push({
      to: STUDIO, asset: "token", amount: 5_000_000n,
      digest: "historical-creator-studio"
    });
    const result = scoreLaunch(data);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toMatchObject({ status: "core", members: ["0xa1", "0xa2", "0xa3", "0xa4", "0xa5", CREATOR] });
    expect(result.buyers.map((row) => row.status)).toEqual([
      "core", "core", "core", "core", "core", "unclustered", "unclustered",
    ]);
    expect(result.destinations.find((dest) => dest.address === STUDIO)?.affiliation).toBe("creator_affiliated");
    expect(result.destinations.find((dest) => dest.address === DEPOSIT)?.affiliation).toBe("buyer_shared");
    expect(pair(result, e.address, CREATOR)?.signals).toEqual([
      expect.objectContaining({ type: "creator_linked_destination", weight: 6, via: STUDIO }),
    ]);
    expect(result.clusters[0].score).toBeGreaterThanOrEqual(6);
  });

  it("does not bridge pairs across a component by summing subthreshold scores", () => {
    const a = buyer("0xa1");
    const b = buyer("0xa2");
    const c = buyer("0xa3");
    transfer(a, STUDIO);
    transfer(b, STUDIO);
    transfer(b, DEPOSIT);
    transfer(c, DEPOSIT);
    const result = scoreLaunch(input([a, b, c], [wallet(STUDIO), wallet(DEPOSIT)]));
    expect(result.clusters).toEqual([]);
    expect(result.below_threshold.map((p) => [p.a, p.b, p.score])).toEqual([
      [a.address, b.address, 3], [b.address, c.address, 3],
    ]);
  });

  it("does not score hub funding bursts or hub-mediated shared transactions", () => {
    const buyers = [buyer("0xa1"), buyer("0xa2"), buyer("0xa3")];
    for (const [i, b] of buyers.entries()) {
      transfer(b, STUDIO);
      topup(b, i, "exchange-batch", "hub", 100);
    }
    const result = scoreLaunch(input(buyers, [wallet(STUDIO)]));
    expect(result.clusters).toEqual([]);
    expect(pair(result, buyers[0].address, buyers[1].address)?.score).toBe(3);
    expect(result.observations.filter((o) => o.type === "hub_mediated")).toHaveLength(3);
    expect(result.pairs.every((p) => p.signals.every((signal) => signal.type !== "funding_burst" && signal.type !== "shared_funding_tx"))).toBe(true);
    buyers[0].funding[0].sourceStatus = "unmeasured";
    const incomplete = scoreLaunch(input(buyers, [wallet(STUDIO)]));
    expect(incomplete.clusters).toEqual([]);
    expect(incomplete.observations.filter((o) => o.type === "funding_unmeasured")).toHaveLength(1);
  });

  it("requires a targeted shared funding transaction and a narrow launch source", () => {
    const buyers = [buyer("0xa1"), buyer("0xa2"), buyer("0xa3")];
    for (const [i, b] of buyers.entries()) {
      transfer(b, STUDIO);
      topup(b, i, "distribution", "narrow", 100);
    }
    let result = scoreLaunch(input(buyers, [wallet(STUDIO)]));
    expect(pair(result, buyers[0].address, buyers[1].address)?.score).toBe(5);
    expect(result.clusters).toEqual([]);
    expect(result.observations.some((o) => o.type === "non_targeted_funding_tx")).toBe(true);
    for (const b of buyers) b.funding[0].transactionStrength = "targeted";
    result = scoreLaunch(input(buyers, [wallet(STUDIO)]));
    expect(result.clusters[0]?.members).toEqual(buyers.map((b) => b.address));
    expect(pair(result, buyers[0].address, buyers[1].address)?.score).toBe(7);
    // A qualifying payment can make the pair strong, but without a shared
    // destination it remains a micro-cluster, not a core coordination claim.
    for (const b of buyers) {
      b.transfers = [];
      b.payments.push({
        to: buyers[(buyers.indexOf(b) + 1) % buyers.length].address,
        asset: "sui", amount: SUI, digest: `direct-${b.address}`
      });
    }
    result = scoreLaunch(input(buyers, [wallet(STUDIO)]));
    expect(result.clusters[0]?.status).toBe("micro_cluster");
  });

  it("caps repeated targeted funding transactions at two points per pair", () => {
    const buyers = [buyer("0xa1"), buyer("0xa2"), buyer("0xa3")];
    for (const [i, b] of buyers.entries()) {
      transfer(b, STUDIO);
      topup(b, i, "first-targeted");
      topup(b, i + 1, "second-targeted");
    }
    const result = scoreLaunch(input(buyers, [wallet(STUDIO)]));
    expect(pair(result, buyers[0].address, buyers[1].address)?.score).toBe(7);
    expect(pair(result, buyers[0].address, buyers[1].address)?.signals
      .find((signal) => signal.type === "shared_funding_tx")?.digests)
      .toEqual(["first-targeted", "second-targeted"]);
  });

  it("keeps dust and referral fees out of direct payments, and caps referral to one point", () => {
    const a = buyer("0xa1");
    const b = buyer("0xa2");
    a.referrals.push(b.address, b.address);
    a.payments.push({ to: b.address, asset: "sui", amount: 10n * SUI, digest: "referral-fee", referral: true });
    for (let i = 0; i < 3; i++) {
      a.payments.push({ to: b.address, asset: "sui", amount: 100_000_000n, digest: `dust-${i}` });
    }
    const result = scoreLaunch(input([a, b]));
    expect(pair(result, a.address, b.address)).toMatchObject({ score: 1, sharedDestination: false });
    expect(result.sub_threshold_payments).toEqual([{
      from: a.address, to: b.address, asset: "sui",
      amount: "300000000", digests: ["dust-0", "dust-1", "dust-2"]
    }]);
    expect(result.buyers.every((row) => row.status === "unclustered")).toBe(true);
  });

  it("scores aggregate floored payments, with a separate raw-token supply floor", () => {
    const a = buyer("0xa1");
    const b = buyer("0xa2");
    a.payments.push({ to: b.address, asset: "sui", amount: 600_000_000n, digest: "first" },
      { to: b.address, asset: "sui", amount: 400_000_000n, digest: "second" },
      { to: b.address, asset: "token", amount: 499_999n, digest: "small-token" });
    const result = scoreLaunch(input([a, b]));
    expect(pair(result, a.address, b.address)?.signals).toEqual([
      expect.objectContaining({ type: "direct", weight: 3, amount: "1000000000 sui" }),
    ]);
    expect(result.sub_threshold_payments[0]).toMatchObject({ amount: "499999", asset: "token" });
  });

  it("refuses unknown, popular, protocol, and incomplete destinations even if many buyers reach them", () => {
    const buyers = [buyer("0xa1"), buyer("0xa2"), buyer("0xa3")];
    const destinations = [wallet("0xdd1", "unmeasured"), wallet("0xdd2", "provisional"),
    wallet("0xdd3", "popular"), { ...wallet("0xdd4"), labelCategory: "cex" as const },
    { ...wallet("0xdd5"), kind: "object" as const },
    { ...wallet("0xdd6"), depositVerdict: "likely" as const, classificationComplete: true, distinctDepositors: 4 },
    { ...wallet("0xdd8"), depositVerdict: "likely" as const, classificationComplete: true, distinctDepositors: 4, exchangeHotWallet: true }];
    for (const [i, b] of buyers.entries()) {
      for (const destination of destinations) transfer(b, destination.address);
      transfer(b, "0xdd7"); // No classification is not a narrow verdict.
      topup(b, i, `fund-${i}`);
    }
    const result = scoreLaunch(input(buyers, destinations));
    expect(pair(result, buyers[0].address, buyers[1].address)?.signals.filter((s) => s.type === "shared_deposit_address")).toEqual([
      expect.objectContaining({ via: "0xdd6", weight: 6 }),
    ]);
    expect(result.observations.filter((o) => o.type === "destination_ineligible")).toHaveLength(7);
    expect(result.destinations.find((d) => d.address === "0xdd7")?.eligible).toBe(false);
  });

  it("qualifies one likely single-account deposit alone, with payer and sweep digests", () => {
    const a = buyer("0xa1");
    const b = buyer("0xa2");
    transfer(a, DEPOSIT);
    transfer(b, DEPOSIT);
    const likely = {
      ...wallet(DEPOSIT, "unmeasured"), depositVerdict: "likely" as const,
      classificationComplete: true, distinctDepositors: 4,
      sweeps: [{ digest: "joint-sweep" }]
    };
    const result = scoreLaunch(input([a, b], [likely]));
    expect(result.clusters[0]?.members).toEqual([a.address, b.address]);
    expect(pair(result, a.address, b.address)?.signals).toEqual([
      expect.objectContaining({
        type: "shared_deposit_address", weight: 6,
        digests: [`transfer-${a.address}-${DEPOSIT}`, `transfer-${b.address}-${DEPOSIT}`],
        sweep_digests: ["joint-sweep"]
      }),
    ]);
    const unknown = scoreLaunch(input([a, b], [{ ...likely, depositVerdict: "unknown" as const, popularity: "narrow" as const }]));
    expect(unknown.clusters).toEqual([]);

    expect(pair(unknown, a.address, b.address)?.score).toBe(3);
  });

  it("reserves six points for a complete likely deposit with at most 50 distinct depositors", () => {
    const a = buyer("0xa1");
    const b = buyer("0xa2");
    transfer(a, DEPOSIT);
    transfer(b, DEPOSIT);
    const base = { ...wallet(DEPOSIT, "unmeasured"), depositVerdict: "likely" as const };
    for (const count of [4, 50]) {
      const result = scoreLaunch(input([a, b], [{ ...base, classificationComplete: true, distinctDepositors: count }]));
      expect(pair(result, a.address, b.address)?.signals).toEqual([
        expect.objectContaining({ type: "shared_deposit_address", weight: 6 }),
      ]);
      expect(result.clusters).toHaveLength(1);
    }
    for (const destination of [
      { ...base, classificationComplete: true, distinctDepositors: 51 },
      { ...base, classificationComplete: false, distinctDepositors: 4 },
      { ...base, classificationComplete: true, distinctDepositors: null },
    ]) {
      const unmeasured = scoreLaunch(input([a, b], [destination]));
      expect(unmeasured.pairs).toEqual([]);
      expect(unmeasured.clusters).toEqual([]);
      expect(unmeasured.observations).toEqual([
        expect.objectContaining({ type: "destination_ineligible", via: DEPOSIT }),
      ]);
      const measured = scoreLaunch(input([a, b], [{ ...destination, popularity: "narrow" }]));
      expect(pair(measured, a.address, b.address)?.signals).toEqual([
        expect.objectContaining({ type: "shared_destination", weight: 3 }),
      ]);
      expect(measured.clusters).toEqual([]);
    }
  });

  it("keeps an inferred per-user exchange deposit eligible without treating a hot wallet as a deposit", () => {
    const a = buyer("0xa1");
    const b = buyer("0xa2");
    transfer(a, DEPOSIT);
    transfer(b, DEPOSIT);
    const classified = {
      ...wallet(DEPOSIT, "unmeasured"), labelCategory: "cex" as const, exchangeHotWallet: false,
      depositVerdict: "likely" as const, classificationComplete: true, distinctDepositors: 4,
    };
    const perUser = scoreLaunch(input([a, b], [classified]));
    expect(pair(perUser, a.address, b.address)?.signals).toEqual([
      expect.objectContaining({ type: "shared_deposit_address", weight: 6 }),
    ]);
    const incomplete = scoreLaunch(input([a, b], [{
      ...classified, popularity: "narrow", classificationComplete: false,
    }]));
    expect(pair(incomplete, a.address, b.address)?.signals).toEqual([
      expect.objectContaining({ type: "shared_destination", weight: 3 }),
    ]);
    expect(incomplete.clusters).toEqual([]);
    const unconfirmed = scoreLaunch(input([a, b], [{
      ...classified, popularity: "narrow", depositVerdict: "unknown",
    }]));
    expect(pair(unconfirmed, a.address, b.address)?.signals).toEqual([
      expect.objectContaining({ type: "shared_destination", weight: 3 }),
    ]);
    const unmarked = scoreLaunch(input([a, b], [{
      ...classified, popularity: "narrow", classificationComplete: false, exchangeHotWallet: undefined,
    }]));
    expect(unmarked.pairs).toEqual([]);
    const hotWallet = scoreLaunch(input([a, b], [{ ...classified, exchangeHotWallet: true }]));
    expect(hotWallet.pairs).toEqual([]);
    expect(hotWallet.destinations).toEqual([
      { address: DEPOSIT, eligible: false, affiliation: "none" },
    ]);
    expect(hotWallet.observations).toEqual([
      expect.objectContaining({ type: "destination_ineligible", via: DEPOSIT }),
    ]);
  });

  it("does not score unknown token valuation as a qualifying transfer or as known dust", () => {
    const a = buyer("0xa1");
    const b = buyer("0xa2");
    transfer(a, STUDIO, "token");
    transfer(b, STUDIO, "token", false);
    let result = scoreLaunch(input([a, b], [wallet(STUDIO)]));
    expect(result.pairs).toEqual([]);
    expect(result.observations).toEqual([]);
    b.transfers[0].qualifies = "unpriced";
    result = scoreLaunch(input([a, b], [wallet(STUDIO)]));
    expect(result.pairs).toEqual([]);
    expect(result.clusters).toEqual([]);
    expect(result.observations).toEqual([
      expect.objectContaining({
        type: "transfer_unpriced", addresses: [b.address], via: STUDIO,
        digests: [`transfer-${b.address}-${STUDIO}`]
      }),
    ]);
  });
  it("keeps an unrelated qualified buyer pair as a micro-cluster even when it shares a likely deposit", () => {
    const a = buyer("0xa1");
    const b = buyer("0xa2");
    transfer(a, DEPOSIT);
    transfer(b, DEPOSIT);
    const result = scoreLaunch(input([a, b], [{
      ...wallet(DEPOSIT, "unmeasured"), depositVerdict: "likely",
      classificationComplete: true, distinctDepositors: 4,
      sweeps: [{ digest: "joint-sweep" }],
    }]));
    expect(result.clusters[0]).toMatchObject({ members: [a.address, b.address], score: 6, status: "micro_cluster" });
    expect(result.buyers.map(row => row.status)).toEqual(["micro_cluster", "micro_cluster"]);
  });

  it("does not score a shared destination from dust or an unrelated creator payment", () => {
    const a = buyer("0xa1");
    const b = buyer("0xa2");
    transfer(a, STUDIO, "sui", false);
    transfer(b, STUDIO);
    const data = input([a, b], [wallet(STUDIO)]);
    data.creator.payments.push({ to: STUDIO, amount: SUI, asset: "sui", digest: "creator" });
    expect(scoreLaunch(data).clusters).toEqual([]);
    expect(scoreLaunch(data).destinations.find((d) => d.address === STUDIO)?.affiliation).toBe("none");
  });

  it("scores same-name overlap only once and rejects dust launch funding", () => {
    const buyers = [buyer("0xa1"), buyer("0xa2"), buyer("0xa3")];
    for (const [i, b] of buyers.entries()) {
      b.suinsNames = ["name.sui", "old-name.sui"];
      topup(b, i, "dust-batch");
      b.funding[0].amountMist = 1_000_000n;
    }
    const result = scoreLaunch(input(buyers));
    expect(pair(result, buyers[0].address, buyers[1].address)?.score).toBe(1);
    expect(result.observations.filter((o) => o.type === "funding_below_floor")).toHaveLength(3);
    expect(result.clusters).toEqual([]);
  });
  it("never links buyers through a burn address", () => {
    const a = buyer("0xa1");
    const b = buyer("0xa2");
    for (const member of [a, b]) {
      transfer(member, "0x0", "token");
      transfer(member, "0x0", "sui");
    }
    const result = scoreLaunch(input([a, b], [wallet("0x0")]));
    expect(result.pairs).toEqual([]);
    expect(result.destinations.find((d) => d.address === "0x0")?.eligible).toBe(false);
  });

  it("links the creator to a destination only above the direct-payment floor, and never through itself", () => {
    const a = buyer("0xa1");
    const b = buyer("0xa2");
    transfer(a, STUDIO);
    transfer(b, STUDIO);
    transfer(a, CREATOR);
    transfer(b, CREATOR);
    const data = input([a, b], [wallet(STUDIO), wallet(CREATOR)]);
    // A creator's own receipts are not a payment to a destination.
    data.creator.payments.push({ to: CREATOR, asset: "sui", amount: 50n * SUI, digest: "creator-self" });
    // Dust sends to the studio sum below the 1 SUI floor.
    data.creator.payments.push({ to: STUDIO, asset: "sui", amount: 400_000_000n, digest: "creator-dust-1" },
      { to: STUDIO, asset: "sui", amount: 500_000_000n, digest: "creator-dust-2" },
      { to: STUDIO, asset: "token", amount: 1n, digest: "creator-token-dust" });
    let result = scoreLaunch(data);
    expect(result.pairs.some((p) => p.signals.some((s) => s.type === "creator_linked_destination"))).toBe(false);
    expect(result.clusters.every((c) => c.status !== "core")).toBe(true);
    data.creator.payments.push({ to: STUDIO, asset: "sui", amount: 100_000_000n, digest: "creator-third" });
    result = scoreLaunch(data);
    expect(pair(result, a.address, CREATOR)?.signals.filter((s) => s.type === "creator_linked_destination")).toEqual([
      expect.objectContaining({ via: STUDIO, weight: 6 }),
    ]);
  });

  it("scores a direct first funder only when both source verdicts are narrow and complete", () => {
    const [a, b, c] = ["0xa1", "0xa2", "0xa3"].map(buyer);
    for (const member of [a, b, c]) transfer(member, STUDIO);
    a.firstFunding = { funder: "0xf100", digest: "first-a", status: "narrow" };
    b.firstFunding = { funder: "0xf100", digest: "first-b", status: "narrow" };
    c.firstFunding = { funder: "0xf100", digest: "first-c", status: "hub" };
    const data = input([a, b, c], [wallet(STUDIO)]);
    data.creator.firstFunding = { funder: "0xf100", digest: "first-creator", status: "unmeasured" };
    let result = scoreLaunch(data);
    expect(pair(result, a.address, b.address)?.signals).toEqual([
      expect.objectContaining({ type: "shared_destination", weight: 3 }),
      expect.objectContaining({ type: "shared_first_funder", weight: 3, via: "0xf100", digests: ["first-a", "first-b"] }),
    ]);
    expect(pair(result, a.address, c.address)?.score).toBe(3);
    expect(pair(result, CREATOR, a.address)).toBeUndefined();
    expect(result.clusters).toMatchObject([{ status: "micro_cluster", members: [a.address, b.address] }]);
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "hub_mediated", addresses: [a.address, c.address], via: "0xf100" }),
      expect.objectContaining({ type: "funding_unmeasured", addresses: [a.address, CREATOR], via: "0xf100" }),
    ]));
    data.creator.firstFunding.status = "narrow";
    c.firstFunding.status = "provisional";
    result = scoreLaunch(data);
    expect(pair(result, CREATOR, a.address)?.signals).toEqual([
      expect.objectContaining({ type: "shared_first_funder", weight: 3, digests: ["first-a", "first-creator"] }),
    ]);
    expect(pair(result, b.address, c.address)?.signals.some((s) => s.type === "shared_first_funder")).toBe(false);
    c.firstFunding.status = "no_qualifying_inflow";
    c.firstFunding.funder = null;
    expect(scoreLaunch(data).observations.some((o) => o.addresses.includes(c.address) && o.via === "0xf100")).toBe(false);
  });

  it("treats prior creator payments to likely deposits as three-point payments, not private funding or six-point links", () => {
    const [a, b] = ["0xa1", "0xa2"].map(buyer);
    transfer(a, DEPOSIT);
    transfer(b, DEPOSIT);
    const data = input([a, b], [{
      ...wallet(DEPOSIT, "unmeasured"), depositVerdict: "likely", classificationComplete: true,
      distinctDepositors: 4, labelCategory: "cex", exchangeHotWallet: false,
    }]);
    const payment = { to: DEPOSIT, asset: "sui" as const, amount: SUI, digest: "creator-before" };
    data.creator.priorPayments = [
      payment, payment,
      { to: DEPOSIT, asset: "sui", amount: 100n * SUI, digest: "referral", referral: true },
      { to: CREATOR, asset: "sui", amount: 100n * SUI, digest: "own-receipt" },
    ];
    let result = scoreLaunch(data);
    expect(pair(result, CREATOR, a.address)).toMatchObject({ score: 3, sharedDestination: false });
    expect(pair(result, CREATOR, a.address)?.signals).toEqual([
      expect.objectContaining({
        type: "creator_paid_deposit", weight: 3, via: DEPOSIT,
        digests: ["creator-before", `transfer-${a.address}-${DEPOSIT}`],
      }),
    ]);
    expect(pair(result, a.address, b.address)?.score).toBe(6);
    expect(result.clusters[0]).toMatchObject({ status: "micro_cluster", members: [a.address, b.address] });
    expect(result.destinations.find((d) => d.address === DEPOSIT)?.affiliation).toBe("buyer_shared");
    expect(result.pairs.some((p) => p.signals.some((s) => s.type === "creator_linked_destination" || s.type === "shared_first_funder"))).toBe(false);
    b.transfers = [];
    result = scoreLaunch(data);
    expect(pair(result, CREATOR, a.address)?.score).toBe(3); // A sole buyer still witnessed the prior deposit.
    data.creator.firstFunding = { funder: "0xf100", digest: "creator-origin", status: "hub" };
    a.firstFunding = { funder: "0xf100", digest: "buyer-origin", status: "narrow" };
    result = scoreLaunch(data);
    expect(pair(result, CREATOR, a.address)?.score).toBe(3);
    expect(result.clusters).toEqual([]);
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "hub_mediated", via: "0xf100", addresses: [a.address, CREATOR] }),
    ]));
    data.creator.firstFunding.status = "narrow";
    result = scoreLaunch(data);
    expect(pair(result, CREATOR, a.address)).toMatchObject({ score: 6, sharedDestination: false });
    expect(result.clusters[0]?.member_links.find((link) => link.address === a.address)).toMatchObject({
      status: "buyer_link_only", path: [{ from: CREATOR, to: a.address }],
    });
    data.creator.firstFunding.status = "hub";
    data.destinations[0].classificationComplete = false;
    expect(pair(scoreLaunch(data), CREATOR, a.address)).toBeUndefined();
  });

  it("summarizes long historical deposit evidence without losing its complete count or dated source rows", () => {
    const a = buyer("0xa1");
    transfer(a, DEPOSIT);
    const data = input([a], [{
      ...wallet(DEPOSIT, "unmeasured"), depositVerdict: "likely", classificationComplete: true,
      distinctDepositors: 1, labelCategory: "cex", exchangeHotWallet: false,
    }]);
    data.creator.priorPayments = Array.from({ length: 25 }, (_, i) => ({
      to: DEPOSIT, asset: "sui" as const, amount: SUI,
      timestamp: `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      digest: `prior-${String(i).padStart(2, "0")}`,
    }));
    const evidence = pair(scoreLaunch(data), CREATOR, a.address)!.signals[0];
    expect(evidence).toMatchObject({
      type: "creator_paid_deposit", weight: 3, prior_payment_count: 25,
      amount: `20000000000 sui, 25000000000 sui in 25 prior payment(s)`,
    });
    expect(evidence.digests).toEqual([
      "prior-00", "prior-01", "prior-02", "prior-03",
      "prior-21", "prior-22", "prior-23", "prior-24",
      `transfer-${a.address}-${DEPOSIT}`,
    ]);
    expect(data.creator.priorPayments).toHaveLength(25);
  });

  it("uses historical narrow studio payments once for creator links but never scores receipts or referral fees", () => {
    const [a, b] = ["0xa1", "0xa2"].map(buyer);
    transfer(a, STUDIO);
    transfer(b, STUDIO);
    const data = input([a, b], [wallet(STUDIO)]);
    data.creator.priorPayments = [
      { to: STUDIO, asset: "sui", amount: 600_000_000n, digest: "prior-1" },
      { to: STUDIO, asset: "sui", amount: 400_000_000n, digest: "prior-2" },
      { to: STUDIO, asset: "sui", amount: 400_000_000n, digest: "prior-2" },
      { to: STUDIO, asset: "sui", amount: 50n * SUI, digest: "referral", referral: true },
      { to: CREATOR, asset: "sui", amount: 50n * SUI, digest: "self" },
    ];
    const result = scoreLaunch(data);
    expect(pair(result, CREATOR, a.address)?.signals).toEqual([
      expect.objectContaining({
        type: "creator_linked_destination", weight: 6, via: STUDIO,
        digests: ["prior-1", "prior-2", `transfer-${a.address}-${STUDIO}`],
        amount: `20000000000 sui, 600000000 sui, 400000000 sui`,
      }),
    ]);
    expect(result.clusters[0]?.status).toBe("core");
    const historical = data.creator.priorPayments[0];
    data.creator.payments.push(historical);
    expect(pair(scoreLaunch(data), CREATOR, a.address)?.signals.filter((s) => s.type === "creator_linked_destination")).toHaveLength(1);
  });

  it("reports shortest real qualifying paths and keeps indirectly connected buyers buyer_link_only", () => {
    const [a, b, c, d] = ["0xa1", "0xa2", "0xa3", "0xa4"].map(buyer);
    const x = "0xdd3", y = "0xdd4", z = "0xdd5", w = "0xdd6";
    for (const member of [a, d]) transfer(member, STUDIO);
    for (const member of [a, b]) { transfer(member, x); transfer(member, y); }
    for (const member of [b, c]) { transfer(member, z); transfer(member, w); }
    for (const member of [a, c]) { transfer(member, DEPOSIT); transfer(member, "0xdd7"); }
    const data = input([a, b, c, d], [STUDIO, x, y, z, w, DEPOSIT, "0xdd7"].map((address) => wallet(address)));
    data.creator.priorPayments = [{ to: STUDIO, asset: "sui", amount: SUI, digest: "creator-studio" }];
    data.creator.payments.push({ to: d.address, asset: "sui", amount: SUI, digest: "creator-d" });
    const result = scoreLaunch(data);
    const links = result.clusters[0].member_links;
    expect(links.find((link) => link.address === CREATOR)).toEqual({ address: CREATOR, status: "direct", path: [] });
    expect(links.find((link) => link.address === a.address)).toMatchObject({ status: "via_creator_linked_destination", path: [{ from: CREATOR, to: a.address }] });
    expect(links.find((link) => link.address === d.address)).toMatchObject({ status: "direct", path: [{ from: CREATOR, to: d.address }] });
    expect(links.find((link) => link.address === b.address)?.path.map((edge) => [edge.from, edge.to]))
      .toEqual([[CREATOR, a.address], [a.address, b.address]]);
    expect(links.find((link) => link.address === c.address)?.path.map((edge) => [edge.from, edge.to]))
      .toEqual([[CREATOR, a.address], [a.address, c.address]]);
    for (const member of [b, c]) {
      const link = links.find((row) => row.address === member.address)!;
      expect(link.status).toBe("buyer_link_only");
      expect(result.buyers.find((row) => row.address === member.address)?.creator_relation).toEqual({ status: link.status, path: link.path });
      for (const edge of link.path) {
        expect(edge.score).toBeGreaterThanOrEqual(6);
        expect(edge.signals).toEqual(pair(result, edge.from, edge.to)?.signals);
      }
    }
    const [m, n] = ["0xb1", "0xb2"].map(buyer);
    transfer(m, DEPOSIT);
    transfer(n, DEPOSIT);
    const micro = scoreLaunch(input([m, n], [{
      ...wallet(DEPOSIT), depositVerdict: "likely", classificationComplete: true, distinctDepositors: 2,
    }])).clusters[0].member_links;
    expect(micro).toMatchObject([
      { address: m.address, status: "buyer_link_only", path: [] },
      { address: n.address, status: "buyer_link_only", path: [{ from: m.address, to: n.address }] },
    ]);
  });

  it("round-trips consecutive full-list pages without losing or repeating an evidence row", () => {
    const rows = Array.from({ length: 37 }, (_, index) => ({ index, digest: `synthetic-${index}` }));
    const recovered: typeof rows = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = pageAt(rows, offset, 120);
      expect(page.rows.length).toBeGreaterThan(0);
      recovered.push(...page.rows);
      offset = page.next;
    }
    expect(recovered).toEqual(rows);
  });
});
