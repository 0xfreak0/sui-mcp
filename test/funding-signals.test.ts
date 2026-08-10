import { describe, it, expect } from "vitest";
import {
  detectFundingBursts,
  detectSubjectLinks,
  type SignalStep,
} from "../src/utils/funding-signals.js";

const at = (iso: string, over: Partial<SignalStep> & { address: string }): SignalStep => ({
  funded_by: "0xfunder",
  funding_tx: "TX",
  timestamp: iso,
  amount: "5 SUI",
  ...over,
});

describe("detectSubjectLinks", () => {
  // The real case: two of the top five flash-loan operators, one funding the
  // other, sitting rows apart in the input and invisible by eye.
  it("finds a subject that funded another subject", () => {
    const links = detectSubjectLinks(
      [{ address: "0xb", funded_by: "0xa", funding_tx: "T1", amount: "200 SUI" }],
      ["0xa", "0xb"],
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ funder: "0xa", funded: "0xb", amount: "200 SUI" });
  });

  it("ignores a funder that is not itself under investigation", () => {
    const links = detectSubjectLinks([{ address: "0xb", funded_by: "0xoutsider" }], ["0xa", "0xb"]);
    expect(links).toHaveLength(0);
  });

  it("ignores a funded address that is not under investigation", () => {
    const links = detectSubjectLinks([{ address: "0xmid", funded_by: "0xa" }], ["0xa", "0xb"]);
    expect(links).toHaveLength(0);
  });

  // An address funding itself is how the walk attributes a self-sent
  // transaction, not a relationship between two subjects.
  it("does not report an address as funding itself", () => {
    const links = detectSubjectLinks([{ address: "0xa", funded_by: "0xa" }], ["0xa"]);
    expect(links).toHaveLength(0);
  });

  it("skips unresolved funders", () => {
    const links = detectSubjectLinks([{ address: "0xb", funded_by: "unknown" }], ["0xb", "unknown"]);
    expect(links).toHaveLength(0);
  });

  it("reports a repeated link once", () => {
    const links = detectSubjectLinks(
      [
        { address: "0xb", funded_by: "0xa" },
        { address: "0xb", funded_by: "0xa" },
      ],
      ["0xa", "0xb"],
    );
    expect(links).toHaveLength(1);
  });

  it("reports both directions when each funded the other", () => {
    const links = detectSubjectLinks(
      [
        { address: "0xb", funded_by: "0xa" },
        { address: "0xa", funded_by: "0xb" },
      ],
      ["0xa", "0xb"],
    );
    expect(links).toHaveLength(2);
  });

  it("returns nothing for no input", () => {
    expect(detectSubjectLinks([], ["0xa"])).toEqual([]);
  });
});

describe("detectFundingBursts", () => {
  it("clusters fundings that land within the gap", () => {
    const b = detectFundingBursts([
      at("2023-07-29T10:00:00Z", { address: "0xa" }),
      at("2023-07-29T10:00:05Z", { address: "0xb" }),
      at("2023-07-29T10:00:09Z", { address: "0xc" }),
    ]);
    expect(b).toHaveLength(1);
    expect(b[0].addresses).toEqual(["0xa", "0xb", "0xc"]);
    expect(b[0].span_seconds).toBe(9);
  });

  it("splits when the gap is exceeded", () => {
    const b = detectFundingBursts([
      at("2023-07-29T10:00:00Z", { address: "0xa" }),
      at("2023-07-29T10:00:05Z", { address: "0xb" }),
      at("2023-07-29T12:00:00Z", { address: "0xc" }),
      at("2023-07-29T12:00:03Z", { address: "0xd" }),
    ]);
    expect(b).toHaveLength(2);
    expect(b.map((x) => x.addresses.length)).toEqual([2, 2]);
  });

  // A single funding event is not a burst; reporting it as one pads a report.
  it("ignores a lone funding event", () => {
    expect(detectFundingBursts([at("2023-07-29T10:00:00Z", { address: "0xa" })])).toHaveLength(0);
  });

  it("ignores a cluster that is really one address funded twice", () => {
    const b = detectFundingBursts([
      at("2023-07-29T10:00:00Z", { address: "0xa" }),
      at("2023-07-29T10:00:02Z", { address: "0xa" }),
    ]);
    expect(b).toHaveLength(0);
  });

  it("honours a custom gap", () => {
    const steps = [
      at("2023-07-29T10:00:00Z", { address: "0xa" }),
      at("2023-07-29T10:05:00Z", { address: "0xb" }),
    ];
    expect(detectFundingBursts(steps, 60)).toHaveLength(0);
    expect(detectFundingBursts(steps, 600)).toHaveLength(1);
  });

  it("reports whether one funder paid the whole burst", () => {
    const shared = detectFundingBursts([
      at("2023-07-29T10:00:00Z", { address: "0xa", funded_by: "0xf1" }),
      at("2023-07-29T10:00:02Z", { address: "0xb", funded_by: "0xf1" }),
    ]);
    expect(shared[0].single_funder).toBe(true);
    expect(shared[0].funders).toEqual(["0xf1"]);

    const mixed = detectFundingBursts([
      at("2023-07-29T10:00:00Z", { address: "0xa", funded_by: "0xf1" }),
      at("2023-07-29T10:00:02Z", { address: "0xb", funded_by: "0xf2" }),
    ]);
    expect(mixed[0].single_funder).toBe(false);
  });

  // Missing timestamps must not bucket together into an invented burst.
  it("skips steps with no timestamp rather than grouping them", () => {
    const b = detectFundingBursts([
      { address: "0xa", funded_by: "0xf", timestamp: null },
      { address: "0xb", funded_by: "0xf" },
    ]);
    expect(b).toHaveLength(0);
  });

  it("skips unparseable timestamps", () => {
    const b = detectFundingBursts([
      at("not-a-date", { address: "0xa" }),
      at("2023-07-29T10:00:00Z", { address: "0xb" }),
    ]);
    expect(b).toHaveLength(0);
  });

  it("orders the tightest burst first", () => {
    const b = detectFundingBursts([
      at("2023-07-29T10:00:00Z", { address: "0xa" }),
      at("2023-07-29T10:00:50Z", { address: "0xb" }),
      at("2023-07-29T14:00:00Z", { address: "0xc" }),
      at("2023-07-29T14:00:01Z", { address: "0xd" }),
    ]);
    expect(b[0].span_seconds).toBe(1);
    expect(b[1].span_seconds).toBe(50);
  });

  it("accepts input in any order", () => {
    const b = detectFundingBursts([
      at("2023-07-29T10:00:09Z", { address: "0xc" }),
      at("2023-07-29T10:00:00Z", { address: "0xa" }),
      at("2023-07-29T10:00:05Z", { address: "0xb" }),
    ]);
    expect(b[0].addresses).toEqual(["0xa", "0xb", "0xc"]);
    expect(b[0].started_at).toBe("2023-07-29T10:00:00.000Z");
  });

  it("reports a zero span when everything landed at once", () => {
    const b = detectFundingBursts([
      at("2023-07-29T10:00:00Z", { address: "0xa" }),
      at("2023-07-29T10:00:00Z", { address: "0xb" }),
    ]);
    expect(b[0].span_seconds).toBe(0);
  });

  // Double-counting guard: a burst made of one transaction is the co-funding
  // entry restated. Reported without a flag, a reader tallies one fact twice.
  it("flags a burst that is really a single transaction", () => {
    const b = detectFundingBursts([
      at("2023-07-29T10:00:00Z", { address: "0xa", funding_tx: "SAME" }),
      at("2023-07-29T10:00:00Z", { address: "0xb", funding_tx: "SAME" }),
    ]);
    expect(b[0].same_transaction).toBe(true);
    expect(b[0].distinct_transactions).toBe(1);
  });

  it("does not flag a burst built from separate payments", () => {
    const b = detectFundingBursts([
      at("2023-07-29T10:00:00Z", { address: "0xa", funding_tx: "T1" }),
      at("2023-07-29T10:00:04Z", { address: "0xb", funding_tx: "T2" }),
    ]);
    expect(b[0].same_transaction).toBe(false);
    expect(b[0].distinct_transactions).toBe(2);
  });
});
