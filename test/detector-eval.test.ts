import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ceilingsFrom, flagsOf, scoreRun, validateLabels } from "../scripts/probe/lib/detector-eval.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const caseSlugs = new Set(
  readdirSync(join(ROOT, "cases", "incidents"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5)),
);

const A = "0x" + "a".repeat(64);
const D = (c: string) => c.repeat(43).slice(0, 43);
const POS_A = D("P");
const POS_B = D("Q");
const NEG_1 = D("N");
const NEG_2 = D("M");
const HOLD = D("H");
const HOLD_2 = D("G");

type Flag = { tool: string; code: string; severity: string; text?: string };
const run = (entries: Record<string, Flag[]>) =>
  new Map(Object.entries(entries).map(([d, fs]) => [d, { flags: fs.map((f) => ({ text: "", ...f })), errors: [] as string[] }]));

function labelled() {
  return {
    about: "test set",
    detector_origins: {
      "oracle-set-then-used": { incidents: ["alpha"], tuned_with: [] as string[], basis: "test" },
      "unverified-package-call": { incidents: [] as string[], tuned_with: [] as string[], basis: "test" },
    },
    incidents: {
      alpha: { title: "Alpha", cases: ["typus-2025-10"] },
      beta: { title: "Beta", cases: ["nemo-2025-09"] },
    },
    positives: [
      {
        digest: POS_A,
        incident: "alpha",
        case: "typus-2025-10",
        role: "exploit",
        split: "tuning",
        sender: A,
        timestamp: "2025-10-15T13:05:14.205Z",
        source: "test",
        detected_by: [{ tool: "analyze_attack_tx", code: "oracle-set-then-used" }],
      },
      {
        digest: POS_B,
        incident: "beta",
        case: "nemo-2025-09",
        role: "exploit",
        split: "tuning",
        sender: A,
        timestamp: "2025-09-07T16:05:11.505Z",
        source: "test",
        detected_by: [{ tool: "decode_ptb", code: "unverified-package-call", evidence: "0xec1ac7f4" }],
      },
    ],
    negatives: [
      { digest: NEG_1, split: "tuning", protocol: "X", shape: "swap", sender: A, timestamp: "2026-09-27T00:00:00.000Z", calls: ["0x1::m::f"], source: "test" },
      { digest: NEG_2, split: "tuning", protocol: "Y", shape: "swap", sender: A, timestamp: "2026-09-27T00:00:00.000Z", calls: ["0x1::m::f"], source: "test" },
      { digest: HOLD, split: "holdout", protocol: "Z", shape: "random checkpoint sample", sender: A, timestamp: "2026-09-27T00:00:00.000Z", calls: ["0x1::m::f"], source: "test" },
      { digest: HOLD_2, split: "holdout", protocol: "W", shape: "random checkpoint sample", sender: A, timestamp: "2026-09-27T00:00:00.000Z", calls: ["0x1::m::f"], source: "test" },
    ],
    accepted_fps: [{ digest: NEG_1, tool: "decode_ptb", code: "unverified-package-call", reason: "router outside the registry" } as Record<string, unknown>],
    holdout_ceilings: { measured_on: "test", negatives: 2, kinds: { "decode_ptb:unverified-package-call": 1 } as Record<string, number> },
  };
}

const baseline = () =>
  run({
    [POS_A]: [{ tool: "analyze_attack_tx", code: "oracle-set-then-used", severity: "high" }],
    [POS_B]: [{ tool: "decode_ptb", code: "unverified-package-call", severity: "medium", text: "0xec1ac7f4::user::update_points" }],
    [NEG_1]: [{ tool: "decode_ptb", code: "unverified-package-call", severity: "medium" }],
    [NEG_2]: [{ tool: "decode_ptb", code: "flashloan-pattern", severity: "info" }],
    [HOLD]: [{ tool: "decode_ptb", code: "unverified-package-call", severity: "medium" }],
    [HOLD_2]: [],
  });

describe("cases/detectors.json", () => {
  const set = JSON.parse(readFileSync(join(ROOT, "cases", "detectors.json"), "utf8"));
  it("follows the contract in cases/README.md", () => {
    expect(validateLabels(set, { caseSlugs })).toEqual([]);
  });
  it("labels a positive for every incident with an exploit or attack transaction, and both negative splits", () => {
    const incidents = new Set(set.positives.map((p: { incident: string }) => p.incident));
    for (const id of ["cetus-2025-05", "nemo-2025-09", "typus-2025-10", "scallop-2026-04", "volo-vaults-2026-04", "suisses-drainer-2024", "kong-sui-rug-2024-10", "aftermath-2026-04", "bluemove-2026-07", "haedal-2026-06", "fullsail-2026-08", "alphafi-2026-09", "scallop-pass-drainer-2024-05", "giftsui-drainer-2024-08"])
      expect(incidents.has(id), id).toBe(true);
    const split = (s: string) => set.negatives.filter((n: { split: string }) => n.split === s).length;
    expect(split("tuning")).toBeGreaterThanOrEqual(80);
    expect(split("holdout")).toBeGreaterThanOrEqual(100);
  });
});

describe("validateLabels", () => {
  it("accepts a well-formed set", () => {
    expect(validateLabels(labelled(), { caseSlugs })).toEqual([]);
  });
  it("rejects a digest labelled both positive and negative", () => {
    const s = labelled();
    s.negatives[1].digest = POS_A;
    expect(validateLabels(s, { caseSlugs }).join("\n")).toMatch(/already labelled/);
  });
  it("rejects an accepted false positive on a transaction that is not a negative", () => {
    const s = labelled();
    s.accepted_fps.push({ digest: POS_A, tool: "decode_ptb", code: "unverified-package-call", reason: "r" });
    expect(validateLabels(s, { caseSlugs }).join("\n")).toMatch(/not a labelled negative/);
  });
  it("rejects an incident whose case file does not exist, and an origin naming an unknown incident", () => {
    const s = labelled();
    s.incidents.beta.cases = ["no-such-case"];
    s.detector_origins["oracle-set-then-used"].incidents = ["gamma"];
    s.detector_origins["unverified-package-call"].tuned_with = ["delta"];
    const errors = validateLabels(s, { caseSlugs }).join("\n");
    expect(errors).toMatch(/no-such-case/);
    expect(errors).toMatch(/gamma/);
    expect(errors).toMatch(/tuned_with: unknown incident "delta"/);
  });
  it("rejects a negative without a split", () => {
    const s = labelled() as { negatives: Record<string, unknown>[] };
    delete s.negatives[2].split;
    expect(validateLabels(s, { caseSlugs }).join("\n")).toMatch(/split/);
  });
  it("rejects any accepted false positive on a holdout negative", () => {
    const s = labelled();
    s.accepted_fps.push({ digest: HOLD, tool: "decode_ptb", code: "unverified-package-call", reason: "router" });
    expect(validateLabels(s, { caseSlugs }).join("\n")).toMatch(/holdout negative.*holdout_ceilings/);
  });
  it("rejects a positive without a split, and an incident whose positives sit in both splits", () => {
    const s = labelled() as { positives: Record<string, unknown>[] };
    delete s.positives[0].split;
    expect(validateLabels(s, { caseSlugs }).join("\n")).toMatch(/positives\[0\].*split/);
    const both = labelled();
    both.positives.push({ ...both.positives[0], digest: D("R"), split: "holdout" });
    expect(validateLabels(both, { caseSlugs }).join("\n")).toMatch(/incidents\.alpha/);
  });
  it("rejects a holdout incident that a rule was designed from or tuned with", () => {
    const s = labelled();
    s.positives[1].split = "holdout";
    expect(validateLabels(s, { caseSlugs })).toEqual([]);
    s.detector_origins["oracle-set-then-used"].tuned_with = ["beta"];
    s.detector_origins["unverified-package-call"].incidents = ["beta"];
    const errors = validateLabels(s, { caseSlugs });
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toMatch(/oracle-set-then-used\.tuned_with[\s\S]*unverified-package-call\.incidents/);
  });
  it("rejects ceilings measured on a different holdout, and malformed counts", () => {
    const s = labelled();
    s.holdout_ceilings.negatives = 3;
    s.holdout_ceilings.kinds["decode_ptb:flashloan-pattern"] = 0;
    s.holdout_ceilings.kinds["unverified-package-call"] = 1;
    const errors = validateLabels(s, { caseSlugs }).join("\n");
    expect(errors).toMatch(/measured on 3 holdout negatives, but the file has 2/);
    expect(errors).toMatch(/flashloan-pattern: must be a count from 1/);
    expect(errors).toMatch(/"unverified-package-call" is not "tool:code"/);
  });
  it("accepts a victim-signed entry that withholds its sender with a reason, and nothing else without one", () => {
    const s = labelled() as { positives: Record<string, unknown>[]; negatives: Record<string, unknown>[] };
    delete s.positives[0].sender;
    s.positives[0].sender_withheld = "victim-signed drain";
    delete s.negatives[1].sender;
    s.negatives[1].sender_withheld = "the signer is a known victim";
    expect(validateLabels(s, { caseSlugs })).toEqual([]);
    s.positives[0].sender = A;
    s.positives[1].sender_withheld = "";
    delete s.negatives[0].sender;
    const errors = validateLabels(s, { caseSlugs }).join("\n");
    expect(errors).toMatch(/positives\[0\].*exclude each other/);
    expect(errors).toMatch(/positives\[1\].*must say why/);
    expect(errors).toMatch(/negatives\[0\].*"sender" must be a full 0x address/);
  });
  it("rejects an entry without a source or a transaction time", () => {
    const s = labelled() as { negatives: Record<string, unknown>[] };
    delete s.negatives[0].source;
    s.negatives[1].timestamp = "yesterday";
    const errors = validateLabels(s, { caseSlugs }).join("\n");
    expect(errors).toMatch(/source/);
    expect(errors).toMatch(/timestamp/);
  });
  it("rejects an unknown key, so a misspelt field cannot pass", () => {
    const s = labelled() as { positives: Record<string, unknown>[] };
    s.positives[0].detectedby = [];
    expect(validateLabels(s, { caseSlugs }).join("\n")).toMatch(/unknown key "detectedby"/);
  });
});

describe("flagsOf", () => {
  it("reads code, severity and a searchable text from a tool's anomalies", () => {
    const flags = flagsOf("decode_ptb", {
      anomalies: [{ code: "unverified-package-call", severity: "medium", title: "Calls", detail: "d", evidence: ["0xabc::m::f"] }],
    });
    expect(flags).toEqual([{ tool: "decode_ptb", code: "unverified-package-call", severity: "medium", text: "Calls | d | 0xabc::m::f", evidence: ["0xabc::m::f"] }]);
    expect(flagsOf("analyze_attack_tx", {})).toEqual([]);
  });
});

describe("scoreRun", () => {
  it("passes the baseline it was written from", () => {
    expect(scoreRun(labelled(), baseline()).failures).toEqual([]);
  });

  it("fails when a negative gets a medium or high flag that is not an accepted false positive", () => {
    const r = baseline();
    r.get(NEG_2)!.flags.push({ tool: "analyze_attack_tx", code: "outsized-mint", severity: "high", text: "" });
    const failures = scoreRun(labelled(), r).failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(NEG_2);
    expect(failures[0]).toContain("analyze_attack_tx:outsized-mint");
  });

  it("does not fail on an info flag on a negative, but counts it", () => {
    const report = scoreRun(labelled(), baseline());
    const row = report.kinds.find((k: { kind: string }) => k.kind === "decode_ptb:flashloan-pattern");
    expect(row.fp.tuning.any).toBe(1);
    expect(row.fp.tuning.medium_high).toBe(0);
  });

  it("does not accept a false positive for a different tool than the one listed", () => {
    const r = baseline();
    r.get(NEG_1)!.flags.push({ tool: "analyze_attack_tx", code: "unverified-package-call", severity: "medium", text: "" });
    expect(scoreRun(labelled(), r).failures.join("\n")).toMatch(/analyze_attack_tx:unverified-package-call/);
  });

  it("fails when an accepted false positive stops firing, so the entry gets removed", () => {
    const r = baseline();
    r.get(NEG_1)!.flags = [];
    expect(scoreRun(labelled(), r).failures.join("\n")).toMatch(/no longer fires/);
  });

  it("fails when a positive loses its detection, including a drop to info", () => {
    const r = baseline();
    r.get(POS_A)!.flags = [{ tool: "analyze_attack_tx", code: "oracle-set-then-used", severity: "info", text: "" }];
    expect(scoreRun(labelled(), r).failures.join("\n")).toMatch(new RegExp(`${POS_A}.*lost its detection`));
  });

  it("counts a detection only when the flag names the evidence the label requires", () => {
    const r = baseline();
    r.get(POS_B)!.flags = [{ tool: "decode_ptb", code: "unverified-package-call", severity: "medium", text: "0x5a3ff1::aggregator::run" }];
    const report = scoreRun(labelled(), r);
    expect(report.failures.join("\n")).toMatch(/lost its detection.*0xec1ac7f4/);
    expect(report.kinds.find((k: { kind: string }) => k.kind === "decode_ptb:unverified-package-call").other_positive_hits).toBe(1);
  });

  it("fails when a tool call errors, whatever the label", () => {
    const r = baseline();
    r.get(NEG_2)!.errors.push("decode_ptb failed: timed out");
    expect(scoreRun(labelled(), r).failures.join("\n")).toMatch(/timed out/);
  });

  it("scores only the transactions that ran", () => {
    const r = baseline();
    r.delete(POS_B);
    r.delete(NEG_1);
    const report = scoreRun(labelled(), r);
    expect(report.failures).toEqual([]);
    expect(report.counts.positives).toBe(1);
    expect(report.counts.splits.tuning.negatives).toBe(1);
  });

  it("reports the false-positive rate on the negatives that ran", () => {
    const row = scoreRun(labelled(), baseline()).kinds.find((k: { kind: string }) => k.kind === "decode_ptb:unverified-package-call");
    expect(row.fp.tuning.medium_high).toBe(1);
    expect(row.fp.tuning.rate_medium_high).toBe(0.5);
    expect(row.fp.holdout).toMatchObject({ medium_high: 1, rate_medium_high: 0.5 });
  });

  it("marks a detector that detects only its origin incident, and one that detects another", () => {
    const report = scoreRun(labelled(), baseline());
    const oracle = report.kinds.find((k: { kind: string }) => k.kind === "analyze_attack_tx:oracle-set-then-used");
    expect(oracle.detects_incidents).toEqual(["alpha"]);
    expect(oracle.only_on_origin).toBe(true);

    const s = labelled();
    s.positives[1].detected_by.push({ tool: "analyze_attack_tx", code: "oracle-set-then-used" } as never);
    const r = baseline();
    r.get(POS_B)!.flags.push({ tool: "analyze_attack_tx", code: "oracle-set-then-used", severity: "high", text: "" });
    const wider = scoreRun(s, r).kinds.find((k: { kind: string }) => k.kind === "analyze_attack_tx:oracle-set-then-used");
    expect(wider.detects_incidents).toEqual(["alpha", "beta"]);
    expect(wider.only_on_origin).toBe(false);
  });

  it("leaves one incident out: a held-out detection comes only from detectors written from other incidents", () => {
    const report = scoreRun(labelled(), baseline());
    const alpha = report.incidents.find((i: { incident: string }) => i.incident === "alpha");
    const beta = report.incidents.find((i: { incident: string }) => i.incident === "beta");
    expect(alpha.detected_by).toEqual(["analyze_attack_tx:oracle-set-then-used"]);
    expect(alpha.held_out_detected_by).toEqual([]);
    expect(beta.held_out_detected_by).toEqual(["decode_ptb:unverified-package-call"]);
    expect(beta.detected_by_tool).toEqual({ analyze_attack_tx: false, decode_ptb: true, decode_ptb_bytes: false });
  });

  it("gates holdout by count per kind, never entry by entry", () => {
    const report = scoreRun(labelled(), baseline());
    expect(report.failures).toEqual([]);
    expect(report.holdout_gate.kinds).toEqual([
      { kind: "decode_ptb:unverified-package-call", ceiling: 1, ceiling_rate: 0.5, measured: 1, measured_rate: 0.5, status: "held" },
    ]);
    expect(report.counts.splits.holdout).toMatchObject({ negatives: 2, with_medium_high: 1, failures: 0 });
  });

  it("fails when a holdout rate rises, including a kind with no ceiling", () => {
    const r = baseline();
    r.get(HOLD_2)!.flags.push(
      { tool: "decode_ptb", code: "unverified-package-call", severity: "medium", text: "" },
      { tool: "decode_ptb_bytes", code: "transfers-to-non-sender", severity: "high", text: "" },
    );
    const report = scoreRun(labelled(), r);
    expect(report.failures).toHaveLength(2);
    expect(report.failures.join("\n")).toMatch(/holdout rate decode_ptb:unverified-package-call rose to 2 of 2/);
    expect(report.failures.join("\n")).toMatch(/holdout rate decode_ptb_bytes:transfers-to-non-sender rose to 1 of 2 .*from the ceiling 0/);
    expect(report.counts.splits.holdout.failures).toBe(2);
  });

  it("fails when a holdout rate falls, so the ceiling comes down", () => {
    const r = baseline();
    r.get(HOLD)!.flags = [];
    expect(scoreRun(labelled(), r).failures.join("\n")).toMatch(/decode_ptb:unverified-package-call fell to 0 of 2.*lower holdout_ceilings/);
  });

  it("does not judge the holdout gate on a run that left holdout negatives out", () => {
    const r = baseline();
    r.get(HOLD)!.flags.push({ tool: "analyze_attack_tx", code: "shared-state-jump", severity: "high", text: "" });
    r.delete(HOLD_2);
    const report = scoreRun(labelled(), r);
    expect(report.failures).toEqual([]);
    expect(report.holdout_gate.ran).toBe(false);
    expect(ceilingsFrom(report, "x")).toBeNull();
  });

  it("records ceilings from a run of the whole holdout split", () => {
    const r = baseline();
    r.get(HOLD_2)!.flags.push({ tool: "decode_ptb_bytes", code: "transfers-to-non-sender", severity: "high", text: "" });
    r.get(HOLD_2)!.flags.push({ tool: "decode_ptb", code: "flashloan-pattern", severity: "info", text: "" });
    expect(ceilingsFrom(scoreRun(labelled(), r), "build 1")).toEqual({
      measured_on: "build 1",
      negatives: 2,
      kinds: { "decode_ptb:unverified-package-call": 1, "decode_ptb_bytes:transfers-to-non-sender": 1 },
    });
  });

  it("does not count a detection as held out when the detector was tuned while that incident was labelled", () => {
    const s = labelled();
    s.detector_origins["unverified-package-call"].tuned_with = ["beta"];
    const report = scoreRun(s, baseline());
    const beta = report.incidents.find((i: { incident: string }) => i.incident === "beta");
    expect(beta.detected_by).toEqual(["decode_ptb:unverified-package-call"]);
    expect(beta.held_out_detected_by).toEqual([]);
    expect(report.kinds.find((k: { kind: string }) => k.kind === "decode_ptb:unverified-package-call").held_out_detects).toEqual([]);
  });

  it("reports an incident nothing detects", () => {
    const s = labelled();
    s.positives[0].detected_by = [];
    const r = baseline();
    r.get(POS_A)!.flags = [];
    const alpha = scoreRun(s, r).incidents.find((i: { incident: string }) => i.incident === "alpha");
    expect(alpha.detected).toBe(false);
  });

  it("reports detection per split, so a holdout incident is scored apart from the tuned ones", () => {
    const s = labelled();
    s.positives[1].split = "holdout";
    const r = baseline();
    r.get(POS_B)!.flags = [{ tool: "analyze_attack_tx", code: "shared-state-jump", severity: "high", text: "vault drained" }];
    s.positives[1].detected_by = [];
    const report = scoreRun(s, r);
    expect(report.failures).toEqual([]);
    expect(report.counts.splits.tuning).toMatchObject({ positives: 1, positives_detected: 1, incidents: 1, incidents_detected: 1 });
    expect(report.counts.splits.holdout).toMatchObject({ positives: 1, positives_detected: 0, incidents: 1, incidents_detected: 0 });
    const beta = report.incidents.find((i: { incident: string }) => i.incident === "beta");
    expect(beta.split).toBe("holdout");
    expect(beta.other_flags).toEqual(["analyze_attack_tx:shared-state-jump@high"]);
    expect(report.positives.find((p: { digest: string }) => p.digest === POS_B).flag_details).toEqual([
      { kind: "analyze_attack_tx:shared-state-jump", severity: "high", text: "vault drained", evidence: [] },
    ]);
  });
});
