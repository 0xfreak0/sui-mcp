import { describe, it, expect } from "vitest";
import { assessCoFunding, detectCoFunding, type CoFundingStep } from "../src/utils/co-funding.js";

const step = (over: Partial<CoFundingStep> & { address: string }): CoFundingStep => ({
  funded_by: "0xfunder",
  funding_tx: "TX1",
  timestamp: "2023-07-29T00:00:01Z",
  amount: "5 SUI",
  ...over,
});

describe("detectCoFunding", () => {
  it("groups addresses paid by one transaction", () => {
    const g = detectCoFunding([step({ address: "0xa" }), step({ address: "0xb" })]);
    expect(g).toHaveLength(1);
    expect(g[0].funding_tx).toBe("TX1");
    expect(g[0].addresses).toEqual(["0xa", "0xb"]);
    expect(g[0].funder).toBe("0xfunder");
  });

  // The distinction the whole module exists for: same funder is weak, same
  // transaction is not. A funder paying two addresses separately proves far
  // less than one paying both at once.
  it("does not group addresses that merely share a funder", () => {
    const g = detectCoFunding([
      step({ address: "0xa", funding_tx: "TX1" }),
      step({ address: "0xb", funding_tx: "TX2" }),
    ]);
    expect(g).toHaveLength(0);
  });

  it("ignores a transaction that paid only one address", () => {
    expect(detectCoFunding([step({ address: "0xa" })])).toHaveLength(0);
  });

  it("counts an address once even if the walk revisits it", () => {
    const g = detectCoFunding([
      step({ address: "0xa" }),
      step({ address: "0xa" }),
      step({ address: "0xb" }),
    ]);
    expect(g[0].addresses).toEqual(["0xa", "0xb"]);
  });

  // "unknown" is the walker's marker for an unresolved funder. Grouping on it
  // would join unrelated addresses under a funder that does not exist.
  it("skips steps whose funder could not be resolved", () => {
    const g = detectCoFunding([
      step({ address: "0xa", funded_by: "unknown" }),
      step({ address: "0xb", funded_by: "unknown" }),
    ]);
    expect(g).toHaveLength(0);
  });

  it("skips steps with no transaction digest", () => {
    const g = detectCoFunding([
      step({ address: "0xa", funding_tx: undefined }),
      step({ address: "0xb", funding_tx: undefined }),
    ]);
    expect(g).toHaveLength(0);
  });

  // Identical amounts to every recipient is the signature of a scripted payout.
  it("flags a uniform payout", () => {
    const g = detectCoFunding([
      step({ address: "0xa", amount: "5 SUI" }),
      step({ address: "0xb", amount: "5 SUI" }),
    ]);
    expect(g[0].uniform_amount).toBe(true);
    expect(g[0].amounts).toEqual(["5 SUI"]);
  });

  it("does not flag uniformity when the amounts differ", () => {
    const g = detectCoFunding([
      step({ address: "0xa", amount: "5 SUI" }),
      step({ address: "0xb", amount: "800 SUI" }),
    ]);
    expect(g[0].uniform_amount).toBe(false);
    expect(g[0].amounts).toHaveLength(2);
  });

  it("orders the widest payout first", () => {
    const g = detectCoFunding([
      step({ address: "0xa", funding_tx: "PAIR" }),
      step({ address: "0xb", funding_tx: "PAIR" }),
      step({ address: "0xc", funding_tx: "WIDE" }),
      step({ address: "0xd", funding_tx: "WIDE" }),
      step({ address: "0xe", funding_tx: "WIDE" }),
    ]);
    expect(g.map((x) => x.funding_tx)).toEqual(["WIDE", "PAIR"]);
  });

  describe("subject filtering", () => {
    // A multi-hop batch walks intermediates the caller never asked about.
    // Co-funding among those is noise at the top level of a report.
    it("drops a group that touches only one subject", () => {
      const g = detectCoFunding(
        [step({ address: "0xsubject" }), step({ address: "0xintermediate" })],
        ["0xsubject"],
      );
      expect(g).toHaveLength(0);
    });

    it("keeps a group touching two subjects, with the intermediates listed", () => {
      const g = detectCoFunding(
        [step({ address: "0xs1" }), step({ address: "0xs2" }), step({ address: "0xmid" })],
        ["0xs1", "0xs2"],
      );
      expect(g).toHaveLength(1);
      expect(g[0].addresses).toContain("0xmid");
    });

    it("applies no filter when no subjects are given", () => {
      const g = detectCoFunding([step({ address: "0xa" }), step({ address: "0xb" })]);
      expect(g).toHaveLength(1);
    });
  });

  it("returns nothing for no input", () => {
    expect(detectCoFunding([])).toEqual([]);
  });
});

/**
 * The denominator is the whole point. Two addresses sharing a payout that had
 * two recipients is near-decisive; sharing one that had nineteen is a batch
 * distribution. This is not hypothetical — a randomly drawn control address
 * landed in the same transaction as two cohort wallets, because that
 * transaction paid nineteen addresses.
 */
describe("assessCoFunding", () => {
  it("calls a tiny payout targeted", () => {
    const a = assessCoFunding(2, 2);
    expect(a.strength).toBe("targeted");
    expect(a.subject_share).toBe(1);
    expect(a.interpretation).toMatch(/bespoke|specific/i);
  });

  it("calls a wide payout a batch and says shared membership is weak", () => {
    const a = assessCoFunding(2, 19);
    expect(a.strength).toBe("batch");
    expect(a.subject_share).toBeCloseTo(2 / 19);
    expect(a.interpretation).toMatch(/weak|random/i);
  });

  it("does not overstate a mid-sized payout", () => {
    const a = assessCoFunding(2, 6);
    expect(a.strength).toBe("mixed");
    expect(a.interpretation).toMatch(/not conclusive|corroborate/i);
  });

  // An unknown denominator must not default to something that reads as measured.
  it("refuses to weigh a group when the recipient count is unknown", () => {
    const a = assessCoFunding(2, null);
    expect(a.strength).toBe("unknown");
    expect(a.subject_share).toBeNull();
  });

  it("treats a nonsensical recipient count as unknown", () => {
    expect(assessCoFunding(2, 0).strength).toBe("unknown");
  });

  it("puts the boundaries where documented", () => {
    expect(assessCoFunding(2, 3).strength).toBe("targeted");
    expect(assessCoFunding(2, 4).strength).toBe("mixed");
    expect(assessCoFunding(2, 9).strength).toBe("mixed");
    expect(assessCoFunding(2, 10).strength).toBe("batch");
  });

  // The real case, end to end.
  it("would have caught the EV3vk1Qa false positive", () => {
    expect(assessCoFunding(2, 19).strength).toBe("batch");
  });
});
