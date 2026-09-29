import { describe, it, expect } from "vitest";
import type { Authentication } from "../src/utils/multisig.js";
import {
  capExcursions,
  capHolderAtPublish,
  custodyPeriods,
  parseAsOf,
  stateAsOf,
  upgradeFlags,
  usualHolder,
  type CapEnd,
  type CapVersion,
  type PublishedVersion,
} from "../src/utils/upgrade-history.js";

// A mainnet package lineage: a 3-of-4 multisig held the UpgradeCap, lent it
// to a single ed25519 key for eleven minutes around the v10 upgrade, and lent
// it again from 2025-08-10 to 2025-09-08.
const SINGLE = "0xf55cc609b13e87470d3da78d39ad6f84458a8059eb06aa66f94103d775e8a663";
const MULTI = "0xaa71d7166a7f7df65cd0e33b5adc2c53028f31605864a76887180415d604ac8e";

const multisigAuth: Authentication = {
  scheme: "multisig",
  verified: true,
  multisig: {
    threshold: 3,
    members: [0, 1, 2, 3].map((index) => ({ index, scheme: "ed25519" as const, weight: 1, signed_source_tx: index < 3 })),
    total_weight: 4,
    signed_weight: 3,
    bitmap: 7,
  },
};
const singleAuth: Authentication = { scheme: "ed25519", verified: true };
const auth = new Map<string, Authentication>([
  [MULTI, multisigAuth],
  [SINGLE, singleAuth],
]);

const addr = (address: string) => ({ kind: "address" as const, address });

function cap(tx: string, timestamp: string, checkpoint: number, sender: string, owner: string, pkgVersion: number, policy = 0): CapVersion {
  return {
    object_version: checkpoint,
    tx,
    timestamp,
    checkpoint,
    sender,
    owner: addr(owner),
    package_version: pkgVersion,
    policy,
  };
}

function ver(version: number, tx: string, timestamp: string, checkpoint: number, sender: string): PublishedVersion {
  return { package_id: `0xv${version}`, version, tx, timestamp, checkpoint, sender };
}

const versions: PublishedVersion[] = [
  ver(1, "3i8E8y", "2025-02-24T13:25:30.730Z", 116111843, SINGLE),
  ver(9, "9cZW9y", "2025-06-20T11:09:01.280Z", 158750647, MULTI),
  ver(10, "FacZJb", "2025-07-15T10:17:20.462Z", 167887547, SINGLE),
  ver(11, "ApGS82", "2025-09-07T16:58:18.111Z", 187429108, SINGLE),
  ver(12, "34mhZv", "2025-12-03T13:15:06.473Z", 218946269, MULTI),
];

const caps: CapVersion[] = [
  cap("3i8E8y", "2025-02-24T13:25:30.730Z", 116111843, SINGLE, SINGLE, 1),
  cap("C6PWA1", "2025-02-25T15:20:06.562Z", 116496903, SINGLE, MULTI, 1),
  cap("9cZW9y", "2025-06-20T11:09:01.280Z", 158750647, MULTI, MULTI, 9),
  cap("8RDmrU", "2025-07-15T10:07:20.153Z", 167885061, MULTI, SINGLE, 9),
  cap("4mKd7B", "2025-07-15T10:12:22.346Z", 167886327, SINGLE, SINGLE, 9),
  cap("FacZJb", "2025-07-15T10:17:20.462Z", 167887547, SINGLE, SINGLE, 10),
  cap("GGEav9", "2025-07-15T10:18:08.271Z", 167887743, SINGLE, MULTI, 10),
  cap("FRZpCJ", "2025-08-10T08:22:39.091Z", 177319138, MULTI, SINGLE, 10),
  cap("ApGS82", "2025-09-07T16:58:18.111Z", 187429108, SINGLE, SINGLE, 11),
  cap("By4ttx", "2025-09-08T08:47:29.681Z", 187665383, SINGLE, MULTI, 11),
  cap("34mhZv", "2025-12-03T13:15:06.473Z", 218946269, MULTI, MULTI, 12),
];

const NOW = Date.parse("2026-09-25T00:00:00Z");

function analyse(windowHours = 24, end: CapEnd | null = null, capList = caps, versionList = versions, gone = false) {
  const periods = custodyPeriods(capList, end);
  const usual = usualHolder(periods, NOW);
  const excursions = capExcursions(periods, versionList, usual?.holder ?? null, windowHours);
  const signerByVersion = new Map(versionList.map((v) => [v.version, v.sender === MULTI ? multisigAuth : singleAuth]));
  const flags = upgradeFlags({ versions: versionList, caps: capList, end, gone, periods, excursions, usual, signerByVersion, auth });
  return { periods, usual, excursions, flags };
}

describe("cap custody", () => {
  it("measures the usual holder in time, so an eleven-minute loan is not the norm", () => {
    const { periods, usual } = analyse();
    expect(periods.map((p) => (p.holder.kind === "address" ? p.holder.address : p.holder.kind))).toEqual([
      SINGLE,
      MULTI,
      SINGLE,
      MULTI,
      SINGLE,
      MULTI,
    ]);
    expect(usual?.holder).toEqual(addr(MULTI));
  });

  it("does not count the deployer's first custody as an excursion", () => {
    const { excursions } = analyse();
    expect(excursions.map((x) => x.left.tx)).toEqual(["8RDmrU", "FRZpCJ"]);
  });
});

describe("cap round trips", () => {
  it("flags the v10 loan: out at 10:07:20, v10 at 10:17:20, back at 10:18:08", () => {
    const { excursions, flags } = analyse();
    const [v10Loan, augustLoan] = excursions;
    expect(v10Loan).toMatchObject({
      round_trip: true,
      upgrades_during: [10],
      returned: { tx: "GGEav9" },
    });
    expect(v10Loan.duration_hours).toBeCloseTo(0.18, 2);

    // Four weeks away: an upgrade shipped, but that is not a round trip.
    expect(augustLoan).toMatchObject({ round_trip: false, upgrades_during: [11] });

    const trips = flags.filter((f) => f.kind === "cap_round_trip");
    expect(trips).toHaveLength(1);
    expect(trips[0].versions).toEqual([10]);
    expect(trips[0].txs).toEqual(["8RDmrU", "FacZJb", "GGEav9"]);
  });

  it("widens with the window: a 30-day window also catches the August loan", () => {
    const { flags } = analyse(24 * 30);
    expect(flags.filter((f) => f.kind === "cap_round_trip").map((f) => f.versions)).toEqual([[10], [11]]);
  });

  it("does not flag a loan with no upgrade inside it", () => {
    const quiet = caps.filter((c) => c.tx !== "FacZJb");
    const { excursions, flags } = analyse(24, null, quiet, versions.filter((v) => v.version !== 10));
    expect(excursions[0]).toMatchObject({ round_trip: false, upgrades_during: [] });
    expect(flags.some((f) => f.kind === "cap_round_trip")).toBe(false);
  });

  it("leaves an excursion open while the cap is still away", () => {
    // Read on 2025-09-08, before the cap came back.
    const periods = custodyPeriods(caps.slice(0, 9));
    const usual = usualHolder(periods, Date.parse("2025-09-08T00:00:00Z"));
    expect(usual?.holder).toEqual(addr(MULTI));
    const excursions = capExcursions(periods, versions.slice(0, 4), usual!.holder, 24);
    expect(excursions[excursions.length - 1]).toMatchObject({ returned: null, round_trip: false, upgrades_during: [11] });
  });
});

describe("single-key upgrades", () => {
  it("flags every upgrade after v1 signed by one key while a multisig usually holds the cap", () => {
    const { flags } = analyse();
    expect(flags.filter((f) => f.kind === "single_key_upgrade").map((f) => f.versions)).toEqual([[10], [11]]);
  });

  it("does not flag the deployer's own publish of v1", () => {
    const { flags } = analyse();
    expect(flags.some((f) => f.kind === "single_key_upgrade" && f.versions?.includes(1))).toBe(false);
  });
});

describe("single-key upgrades before the cap ever reaches its usual holder", () => {
  // The deployer publishes v2-v4 with its own single key while it still
  // holds the cap, before handing it to the 2-of-4 admin multisig for the
  // first time. That is normal setup before handover, the same reason v1
  // itself is never flagged. Long afterward, a loan (v5) away from the
  // established multisig custody is still a departure.
  const preHandoverCaps: CapVersion[] = [
    cap("v1tx", "2025-01-01T00:00:00Z", 100, SINGLE, SINGLE, 1),
    cap("handover", "2025-01-10T00:00:00Z", 1000, SINGLE, MULTI, 4),
    cap("loanout", "2025-06-01T00:00:00Z", 5000, MULTI, SINGLE, 5),
    cap("loanback", "2025-06-02T00:00:00Z", 5100, SINGLE, MULTI, 5),
  ];
  const preHandoverVersions: PublishedVersion[] = [
    ver(1, "v1tx", "2025-01-01T00:00:00Z", 100, SINGLE),
    ver(2, "v2tx", "2025-01-03T00:00:00Z", 300, SINGLE),
    ver(3, "v3tx", "2025-01-05T00:00:00Z", 500, SINGLE),
    ver(4, "v4tx", "2025-01-09T00:00:00Z", 900, SINGLE),
    ver(5, "v5tx", "2025-06-01T12:00:00Z", 5050, SINGLE),
  ];

  it("does not flag v2-v4, published by the deployer before the cap ever reached the multisig", () => {
    const { flags } = analyse(24, null, preHandoverCaps, preHandoverVersions);
    const flaggedVersions = flags.filter((f) => f.kind === "single_key_upgrade").flatMap((f) => f.versions ?? []);
    expect(flaggedVersions).not.toContain(2);
    expect(flaggedVersions).not.toContain(3);
    expect(flaggedVersions).not.toContain(4);
  });

  it("still flags a genuine single-key loan long after the multisig was established", () => {
    const { flags } = analyse(24, null, preHandoverCaps, preHandoverVersions);
    const flaggedVersions = flags.filter((f) => f.kind === "single_key_upgrade").flatMap((f) => f.versions ?? []);
    expect(flaggedVersions).toContain(5);
  });
});

describe("capHolderAtPublish", () => {
  it("reads the holder from the cap's input state, not the upgrade's output", () => {
    expect(capHolderAtPublish(versions[2], caps)).toEqual(addr(SINGLE));
    // An upgrade that also hands the cap back in the same transaction: the
    // output owner is the multisig, but the key that signed held it going in.
    const handBack = caps.map((c) => (c.tx === "FacZJb" ? { ...c, owner: addr(MULTI) } : c));
    expect(capHolderAtPublish(versions[2], handBack)).toEqual(addr(SINGLE));
  });

  it("names the cap's first owner for v1, which created it", () => {
    expect(capHolderAtPublish(versions[0], caps)).toEqual(addr(SINGLE));
  });

  it("falls back to the last cap version before the publish when the upgrade is not in the cap history", () => {
    const missing = caps.filter((c) => c.tx !== "FacZJb");
    expect(capHolderAtPublish(versions[2], missing)).toEqual(addr(SINGLE));
  });
});

describe("stateAsOf", () => {
  it("at the exploit, the single key held the cap and v10 was the newest version", () => {
    const s = stateAsOf(parseAsOf("2025-09-07T16:03Z"), versions, caps, null);
    expect(s.cap_state).toBe("held");
    expect(s.holder).toEqual(addr(SINGLE));
    expect(s.holder_since?.tx).toBe("FRZpCJ");
    expect(s.latest_version?.version).toBe(10);
  });

  it("gives the same answer by checkpoint", () => {
    const s = stateAsOf(parseAsOf("187400000"), versions, caps, null);
    expect(s.holder).toEqual(addr(SINGLE));
    expect(s.latest_version?.version).toBe(10);
  });

  it("counts an event in the as_of checkpoint as having happened", () => {
    const s = stateAsOf({ checkpoint: 187429108 }, versions, caps, null);
    expect(s.latest_version?.version).toBe(11);
  });

  it("walks back to the start of the holder's custody, across upgrades it made", () => {
    const s = stateAsOf(parseAsOf("2025-07-15T10:17:30Z"), versions, caps, null);
    expect(s.holder).toEqual(addr(SINGLE));
    expect(s.holder_since?.tx).toBe("8RDmrU");
  });

  it("reports a moment before the cap existed", () => {
    const s = stateAsOf(parseAsOf("2025-01-01T00:00:00Z"), versions, caps, null);
    expect(s).toMatchObject({ cap_state: "not_created", holder: null, latest_version: null });
  });

  it("reports a destroyed cap after its deletion, and the holder before it", () => {
    const end: CapEnd = { kind: "deleted", tx: "Del", timestamp: "2026-01-01T00:00:00Z", checkpoint: 230000000, sender: MULTI };
    expect(stateAsOf(parseAsOf("2026-02-01T00:00:00Z"), versions, caps, end)).toMatchObject({ cap_state: "deleted", holder: null });
    expect(stateAsOf(parseAsOf("2025-12-31T00:00:00Z"), versions, caps, end).holder).toEqual(addr(MULTI));
  });

  it("does not read a gone cap whose end is unread as still held after its last version", () => {
    expect(stateAsOf(parseAsOf("2026-02-01T00:00:00Z"), versions, caps, null, true)).toMatchObject({ cap_state: "unknown", holder: null });
    expect(stateAsOf(parseAsOf("2025-09-08T00:00:00Z"), versions, caps, null, true).cap_state).toBe("held");
  });
});

describe("terminal cap states and policy", () => {
  it("flags a policy restriction", () => {
    const restricted = [...caps, { ...caps[caps.length - 1], tx: "Pol", checkpoint: 220000000, timestamp: "2025-12-10T00:00:00Z", policy: 128 }];
    const { flags } = analyse(24, null, restricted);
    const f = flags.find((x) => x.kind === "policy_change");
    expect(f?.txs).toEqual(["Pol"]);
    expect(f?.summary).toContain("compatible to additive");
  });

  it("flags a destroyed cap", () => {
    const end: CapEnd = { kind: "deleted", tx: "Del", timestamp: "2026-01-01T00:00:00Z", checkpoint: 230000000, sender: MULTI };
    expect(analyse(24, end).flags.find((f) => f.kind === "cap_destroyed")?.txs).toEqual(["Del"]);
  });

  it("raises no current-holder flag for a gone cap whose end is unread", () => {
    const burned = [...caps, { ...caps[caps.length - 1], tx: "Burn", checkpoint: 220000000, timestamp: "2025-12-10T00:00:00Z", owner: addr(`0x${"0".repeat(64)}`) }];
    expect(analyse(24, null, burned).flags.some((f) => f.kind === "cap_renounced")).toBe(true);
    expect(analyse(24, null, burned, versions, true).flags.some((f) => f.kind === "cap_renounced")).toBe(false);
  });

  it("flags a shared cap as high severity", () => {
    const shared = [...caps, { ...caps[caps.length - 1], tx: "Shr", checkpoint: 220000000, timestamp: "2025-12-10T00:00:00Z", owner: { kind: "shared" as const } }];
    expect(analyse(24, null, shared).flags.find((f) => f.kind === "cap_shared")?.severity).toBe("high");
  });

  it("reads a cap sent to 0x0 as renounced, and not as the usual holder", () => {
    const burned = [...caps, { ...caps[caps.length - 1], tx: "Burn", checkpoint: 220000000, timestamp: "2025-12-10T00:00:00Z", owner: addr(`0x${"0".repeat(64)}`) }];
    const { flags, usual } = analyse(24, null, burned);
    expect(flags.some((f) => f.kind === "cap_renounced")).toBe(true);
    expect(usual?.holder).toEqual(addr(MULTI));
  });
});

describe("parseAsOf", () => {
  it("reads digits as a checkpoint, 'now' as the current time, and anything else as a date", () => {
    expect(parseAsOf(" 187429108 ")).toEqual({ checkpoint: 187429108 });
    expect(parseAsOf("now", 1_000)).toEqual({ ms: 1_000, iso: "1970-01-01T00:00:01.000Z" });
    expect(parseAsOf("2025-09-07T16:03Z")).toEqual({ ms: Date.parse("2025-09-07T16:03:00Z"), iso: "2025-09-07T16:03:00.000Z" });
  });

  it("rejects what is neither", () => {
    expect(() => parseAsOf("yesterday-ish")).toThrow(/ISO 8601/);
  });
});
