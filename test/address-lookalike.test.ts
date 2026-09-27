import { describe, it, expect } from "vitest";
import {
  ActivityLedger,
  findLookalikes,
  LIFECYCLE_MAX_GAP_MS,
  LookalikeIndex,
  lookalikeReport,
  MIN_MATCHING_CHARS,
  MIN_PER_END,
} from "../src/utils/address-lookalike.js";

/** Build a 32-byte address with the given head and tail and random-looking middle. */
const addr = (head: string, tail: string, fill = "") => {
  const middle = (fill || "9c4a7e2b8d1f60a35e7c2d94b8f13a6e05c7d2984b1f6e3a").repeat(3);
  const body = (head + middle).slice(0, 64 - tail.length) + tail;
  return `0x${body}`;
};

describe("findLookalikes — thresholds", () => {
  /**
   * Both mainnet cases this was built from are asymmetric: 3 leading + 4
   * trailing, and 5 leading + 3 trailing. A symmetric k=4 rule misses both,
   * which is why the score is the total.
   */
  it("catches a 3+4 split", () => {
    const real = addr("7a4c", "2b91de50");
    const fake = addr("7a41", "77c3de50", "0f68319fb712182a83512e20d8bce18127");
    const [pair] = findLookalikes([real, fake]);
    expect(pair).toBeDefined();
    expect(pair!.prefix_chars).toBe(3);
    expect(pair!.suffix_chars).toBe(4);
    expect(pair!.matching_chars).toBe(7);
  });

  it("catches a 5+3 split", () => {
    const a = addr("91c4ab", "5e7f2ac");
    const b = addr("91c4a3", "84d2ac", "488a17736f351aee233b1a4b2476a5fe0c93");
    const [pair] = findLookalikes([a, b]);
    expect(pair).toBeDefined();
    expect(pair!.prefix_chars).toBe(5);
    expect(pair!.suffix_chars).toBe(3);
  });

  it("ignores a long shared prefix with no shared tail", () => {
    // Eight leading characters, but the truncated render still differs at the
    // end, which is the half a reader checks second. Not the attack shape.
    const a = addr("abcdef12", "11112222");
    const b = addr("abcdef12", "33334444", "77ee11aa55bb99cc33dd77ee11aa55bb");
    expect(findLookalikes([a, b])).toEqual([]);
  });

  /**
   * Two addresses matching 4 leading and 2 trailing characters, the shape
   * co-recipients of one batch airdrop form. At 4+2 they do not render alike:
   * no wallet truncates to two trailing characters.
   */
  it("rejects a 4+2 match, which no real UI renders as a collision", () => {
    const a = "0x3f9ac21d5e480b6f93a7e04c1b8d27f6a95c3e0d7b41682fa9c5d301e7b48fb7";
    const b = "0x3f9a7e04c1b8d27f6a95c3e0d7b41682fa9c5d301e7b48fc21d5e480b6f93ab7";
    expect(a.slice(2, 6)).toBe(b.slice(2, 6));
    expect(a.slice(-2)).toBe(b.slice(-2));
    expect(findLookalikes([a, b])).toEqual([]);
  });

  it("states its own thresholds", () => {
    expect(MIN_MATCHING_CHARS).toBe(6);
    expect(MIN_PER_END).toBe(3);
  });
});

describe("findLookalikes — low entropy", () => {
  /**
   * `0x0000…0000` and `0x0000…0f0d000000` match at four characters each end,
   * entirely through zero padding. Neither is grinding for the other.
   */
  it("does not pair two zero-padded addresses", () => {
    const burn = `0x${"0".repeat(64)}`;
    const small = `0x${"0".repeat(48)}0f0d${"0".repeat(12)}`;
    expect(findLookalikes([burn, small])).toEqual([]);
  });

  it("does not pair the small system addresses", () => {
    expect(findLookalikes(["0x2", "0x3", "0xb", "0x5"])).toEqual([]);
  });

  it("does not pair two vanity grinds over a tiny alphabet", () => {
    const a = `0x${"abab".repeat(16)}`;
    const b = `0x${"abba".repeat(16)}`;
    expect(findLookalikes([a, b])).toEqual([]);
  });

  it("still pairs a normal address against a grind of it", () => {
    // Entropy filtering must not swallow the real case: the lookalike here is
    // an ordinary-looking key, not a low-alphabet vanity address.
    const real = addr("cafe", "beef1234");
    const fake = addr("caf1", "0def1234", "77ee11aa55bb99cc33dd77ee11aa55bb22");
    expect(findLookalikes([real, fake])).toHaveLength(1);
  });
});

describe("LookalikeIndex — one address at a time", () => {
  const real = addr("cafe", "beef1234");
  const fake = addr("caf1", "0def1234", "77ee11aa55bb99cc33dd77ee11aa55bb22");

  it("flags an address that renders like one recorded before, and only then", () => {
    const index = new LookalikeIndex();
    expect(index.addAndCheck(real)).toBe(false);
    expect(index.addAndCheck(addr("1111", "22223333"))).toBe(false);
    expect(index.addAndCheck(fake)).toBe(true);
  });

  it("does not call an address its own lookalike under another spelling", () => {
    const index = new LookalikeIndex();
    index.addAndCheck(real);
    expect(index.addAndCheck(real.toUpperCase().replace("0X", "0x"))).toBe(false);
  });

  it("never flags a structurally low-entropy address", () => {
    const index = new LookalikeIndex();
    index.addAndCheck(`0x${"0".repeat(64)}`);
    expect(index.addAndCheck(`0x${"0".repeat(48)}0f0d${"0".repeat(12)}`)).toBe(false);
  });
});

describe("findLookalikes — which one is the impostor", () => {
  const real = addr("7a4c", "2b91de50");
  const fake = addr("7a41", "77c3de50", "0f68319fb712182a83512e20d8bce18127");

  it("names the smaller footprint as the suspect", () => {
    const activity = new Map([
      [real, { transactions: 6, received: 65343688245371n }],
      [fake, { transactions: 1, received: 0n }],
    ]);
    const [pair] = findLookalikes([real, fake], activity);
    expect(pair!.established).toBe(real);
    expect(pair!.suspect).toBe(fake);
    expect(pair!.direction_known).toBe(true);
    expect(pair!.note).toMatch(/address poisoning/i);
  });

  it("breaks a transaction-count tie on value received", () => {
    // A poisoning address receives nothing; it is funded, it sends, it stops.
    const activity = new Map([
      [real, { transactions: 1, received: 500n }],
      [fake, { transactions: 1, received: 0n }],
    ]);
    const [pair] = findLookalikes([real, fake], activity);
    expect(pair!.suspect).toBe(fake);
  });

  /**
   * The roles are a separate claim from the collision. With nothing to separate
   * the two, assigning one would be inventing evidence — so the pair is
   * reported and the note says outright that the direction is unknown.
   */
  it("refuses to assign roles when the footprints match", () => {
    const [pair] = findLookalikes([real, fake]);
    expect(pair!.direction_known).toBe(false);
    expect(pair!.note).toMatch(/cannot be told from this data/i);
  });

  it("refuses to assign roles with activity that does not separate them", () => {
    const activity = new Map([
      [real, { transactions: 3, received: 10n }],
      [fake, { transactions: 3, received: 10n }],
    ]);
    expect(findLookalikes([real, fake], activity)[0]!.direction_known).toBe(false);
  });
});

describe("findLookalikes — input handling", () => {
  it("normalizes short and mixed-case forms to one address", () => {
    const long = "0x00000000000000000000000000000000000000000000000000000000000000AB";
    // Same address written three ways must not pair with itself.
    expect(findLookalikes([long, long.toLowerCase(), "0xab"])).toEqual([]);
  });

  it("skips anything that is not an address", () => {
    const real = addr("cafe", "beef1234");
    const fake = addr("caf1", "0def1234", "77ee11aa55bb99cc33dd77ee11aa55bb22");
    expect(findLookalikes([real, fake, "", "0x", "not-an-address", "0xzz"])).toHaveLength(1);
  });

  it("compares every pair, not just consecutive ones", () => {
    const real = addr("cafe", "beef1234");
    const noise = addr("1111", "22223333", "88aa99bb77cc66dd55ee44ff33aa22bb");
    const fake = addr("caf1", "0def1234", "77ee11aa55bb99cc33dd77ee11aa55bb22");
    expect(findLookalikes([real, noise, fake])).toHaveLength(1);
  });

  it("sorts the strongest collision first", () => {
    // Built so the match lengths are exact: 6+8 between the first two, 4+6
    // from either of them to the third.
    const base = `0xab12cd${"a".repeat(50)}11223344`;
    const close = `0xab12cd${"b".repeat(50)}11223344`;
    const weaker = `0xab12ff${"c".repeat(50)}99223344`;
    const pairs = findLookalikes([base, close, weaker]);
    expect(pairs).toHaveLength(3);
    expect(pairs.map((p) => p.matching_chars)).toEqual([14, 10, 10]);
  });
});

describe("lookalikeReport", () => {
  it("reports the comparison with no pairs when nothing collides", () => {
    // An absent block cannot be told from a check that never ran; the empty
    // one names how many addresses it covered.
    const report = lookalikeReport([addr("1111", "22223333"), addr("4444", "55556666")]);
    expect(report.pairs).toEqual([]);
    expect(report.addresses_compared).toBe(2);
  });

  it("says the comparison was bounded by what was returned", () => {
    const real = addr("cafe", "beef1234");
    const fake = addr("caf1", "0def1234", "77ee11aa55bb99cc33dd77ee11aa55bb22");
    const report = lookalikeReport([real, fake])!;
    expect(report.addresses_compared).toBe(2);
    expect(report.pairs).toHaveLength(1);
    expect(report.note).toMatch(/not a complete scan/i);
  });
});

describe("ActivityLedger", () => {
  const A = "0xaa";
  const B = "0xbb";

  it("counts an address once per transaction however often it appears", () => {
    // The shape that made this a type: a sender who also takes a balance change
    // in the same transaction appeared once, not twice. Over-counting inflates
    // exactly the party whose footprint decides the impostor call.
    const ledger = new ActivityLedger();
    ledger.observe([{ address: A }, { address: A, amount: -5n }, { address: B, amount: 5n }]);
    expect(ledger.activity.get(A)!.transactions).toBe(1);
    expect(ledger.activity.get(B)!.transactions).toBe(1);
  });

  it("accumulates across transactions", () => {
    const ledger = new ActivityLedger();
    ledger.observe([{ address: A, amount: 10n }]);
    ledger.observe([{ address: A, amount: 7n }]);
    expect(ledger.activity.get(A)).toEqual({ transactions: 2, received: 17n });
  });

  it("counts only positive amounts as received", () => {
    const ledger = new ActivityLedger();
    ledger.observe([{ address: A, amount: -100n }]);
    ledger.observe([{ address: A, amount: 0n }]);
    ledger.observe([{ address: A }]);
    expect(ledger.activity.get(A)).toEqual({ transactions: 3, received: 0n });
  });

  it("leads with the subject without duplicating it", () => {
    const ledger = new ActivityLedger();
    ledger.observe([{ address: A }, { address: B }]);
    expect(ledger.addressesLedBy(A)).toEqual([A, B]);
    expect(ledger.addressesLedBy("0xcc")).toEqual(["0xcc", A, B]);
  });
});

describe("activity is looked up by NORMALIZED address", () => {
  /**
   * The ledger is keyed by the strings the chain returned; the subject is
   * whatever the caller typed, and the GraphQL API accepts uppercase and
   * unpadded short forms. Looking activity up by the raw string missed the
   * subject's own footprint, so it scored zero and the VICTIM was named the
   * impostor. Every other module that keys on an address normalizes first.
   */
  const victim = `0xcafe${"1".repeat(56)}beef`;
  const poisoner = `0xcaf1${"2".repeat(56)}beef`;

  it("does not invert direction when the caller spells it differently", () => {
    const activity = new Map([
      [victim, { transactions: 9, received: 100n }],
      [poisoner, { transactions: 1, received: 0n }],
    ]);
    const [pair] = findLookalikes([victim.toUpperCase(), poisoner], activity);
    expect(pair!.established.toLowerCase()).toBe(victim);
    expect(pair!.suspect.toLowerCase()).toBe(poisoner);
  });

  it("emits canonical addresses so they match downstream", () => {
    const [pair] = findLookalikes([victim.toUpperCase(), poisoner]);
    expect(pair!.established).toMatch(/^0x[0-9a-f]{64}$/);
    expect(pair!.suspect).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("direction needs a real margin", () => {
  const real = `0xcafe${"1".repeat(56)}beef`;
  const fake = `0xcaf1${"2".repeat(56)}beef`;

  /**
   * Dust repeating inside one page is the normal shape of this attack, so a
   * poisoner seen three times would otherwise outrank a real counterparty seen
   * once — and the note would point the accusation at the legitimate address.
   */
  it("refuses to name a suspect on a 3-vs-1 margin", () => {
    const activity = new Map([
      [fake, { transactions: 3, received: 0n }],
      [real, { transactions: 1, received: 500n }],
    ]);
    const [pair] = findLookalikes([real, fake], activity);
    // The one decimals-safe signal still applies: the poisoner received
    // nothing, so the real address is established — never the other way round.
    expect(pair!.suspect).toBe(fake);
  });

  it("assigns roles once the gap is real", () => {
    const activity = new Map([
      [real, { transactions: 9, received: 0n }],
      [fake, { transactions: 1, received: 0n }],
    ]);
    const [pair] = findLookalikes([real, fake], activity);
    expect(pair!.established).toBe(real);
    expect(pair!.direction_known).toBe(true);
  });

  /**
   * Raw units are not comparable across coin types: 1 unit of an 18-decimal
   * spam token would outrank 5 SUI. `funding.ts` learned this already, so the
   * tiebreak asks only whether anything was received.
   */
  it("does not rank by raw amount across coin types", () => {
    const activity = new Map([
      [fake, { transactions: 1, received: 10n ** 18n }],
      [real, { transactions: 1, received: 5_000_000_000n }],
    ]);
    expect(findLookalikes([real, fake], activity)[0]!.direction_known).toBe(false);
  });
});

describe("direction falls back to lifecycle only for the poisoning shape", () => {
  const real = `0xcafe${"1".repeat(56)}beef`;
  const fake = `0xcaf1${"2".repeat(56)}beef`;
  /** Anything seen before both, so neither pair member is the result's first row. */
  const older = { [`0x77${"3".repeat(62)}`]: { transactions: 1, received: 5n, first_seen: "2026-09-09T17:00:00.000Z" } };
  const at = (ms: number) => new Date(Date.parse("2026-09-09T18:00:00.000Z") + ms).toISOString();
  const activity = (fakeEntry: Record<string, unknown>, realFirst = at(0)) =>
    new Map(
      Object.entries({
        ...older,
        [real]: { transactions: 1, received: 0n, first_seen: realFirst },
        [fake]: { transactions: 1, received: 0n, ...fakeEntry },
      }),
    );

  it("names the later address when it first appears paying the subject soon after", () => {
    const [pair] = findLookalikes([real, fake], activity({ first_seen: at(3_900), first_seen_paying_subject: true }));
    expect(pair).toMatchObject({ established: real, suspect: fake, direction_known: true, direction_basis: "lifecycle" });
    expect(pair!.note).toMatch(/credited it nothing/i);
  });

  it("declines when the later address was credited in its first appearance", () => {
    const [pair] = findLookalikes([real, fake], activity({ first_seen: at(3_900), first_seen_paying_subject: false }));
    expect(pair!.direction_known).toBe(false);
  });

  it("declines past the gap a poisoning bot leaves", () => {
    const inside = activity({ first_seen: at(LIFECYCLE_MAX_GAP_MS), first_seen_paying_subject: true });
    expect(findLookalikes([real, fake], inside)[0]!.direction_known).toBe(true);
    const outside = activity({ first_seen: at(LIFECYCLE_MAX_GAP_MS + 1), first_seen_paying_subject: true });
    expect(findLookalikes([real, fake], outside)[0]!.direction_known).toBe(false);
  });

  it("declines when the earlier address first appears on the result's oldest row", () => {
    // Nothing before that row was read, so the later address may well have
    // been in use first.
    const onlyPair = new Map([
      [real, { transactions: 1, received: 0n, first_seen: at(0) }],
      [fake, { transactions: 1, received: 0n, first_seen: at(3_900), first_seen_paying_subject: true }],
    ]);
    expect(findLookalikes([real, fake], onlyPair)[0]!.direction_known).toBe(false);
  });

  it("does not use lifecycle when footprint already decided it", () => {
    const m = new Map([
      [real, { transactions: 9, received: 0n, first_seen: "2026-09-09T18:00:01.600Z" }],
      [fake, { transactions: 1, received: 0n, first_seen: "2026-09-09T18:00:00.000Z" }],
    ]);
    const [pair] = findLookalikes([real, fake], m);
    // Fake is chronologically first here but has the smaller footprint by a
    // real margin, and footprint outranks lifecycle.
    expect(pair!.established).toBe(real);
    expect(pair!.direction_basis).toBe("footprint");
  });

  it("stays unknown when first_seen is missing or identical", () => {
    const missing = new Map([
      [real, { transactions: 1, received: 0n }],
      [fake, { transactions: 1, received: 0n }],
    ]);
    expect(findLookalikes([real, fake], missing)[0]!.direction_known).toBe(false);
    expect(findLookalikes([real, fake], activity({ first_seen: at(0), first_seen_paying_subject: true }))[0]!.direction_known).toBe(false);
  });

  it("declines when the earlier address also first appears paying the subject", () => {
    // Through the ledger: V pays X at 09:00; L sends V 20 raw at
    // 09:30, imitating R, whose earlier payment to V is before the page; R
    // pays V 500 SUI at 09:35. Both first appear paying V, so which came
    // first says nothing about which one is the impostor.
    const V = `0xa11ce0${"4".repeat(58)}`;
    const X = `0x77${"3".repeat(62)}`;
    const L = fake;
    const R = real;
    const ledger = new ActivityLedger(V);
    ledger.observe([{ address: V, amount: -1_000_000_000n }, { address: X, amount: 1_000_000_000n }], "2026-09-09T09:00:00.000Z");
    ledger.observe([{ address: L, amount: -20n }, { address: V, amount: 20n }], "2026-09-09T09:30:00.000Z");
    ledger.observe([{ address: R, amount: -500_000_000_000n }, { address: V, amount: 500_000_000_000n }], "2026-09-09T09:35:00.000Z");
    const report = lookalikeReport(ledger.addressesLedBy(V), ledger.activity, V)!;
    const [pair] = report.pairs;
    expect(pair!.direction_known).toBe(false);
  });
});

describe("ActivityLedger tracks first_seen", () => {
  const A = "0xaa";

  it("keeps the EARLIEST timestamp across observations, not the latest", () => {
    const ledger = new ActivityLedger();
    ledger.observe([{ address: A }], "2026-09-09T18:00:05.000Z");
    ledger.observe([{ address: A }], "2026-09-09T18:00:00.000Z");
    ledger.observe([{ address: A }], "2026-09-09T18:00:09.000Z");
    expect(ledger.activity.get(A)!.first_seen).toBe("2026-09-09T18:00:00.000Z");
  });

  it("leaves first_seen unset when no timestamp is passed", () => {
    const ledger = new ActivityLedger();
    ledger.observe([{ address: A }]);
    expect(ledger.activity.get(A)!.first_seen).toBeUndefined();
  });

  it("marks an address first seen crediting the subject and nothing to itself, whatever the subject's spelling", () => {
    const victim = `0xa11ce0${"4".repeat(58)}`;
    const dust = `0x6b7452${"5".repeat(58)}`;
    const real = `0x6b74e9${"6".repeat(58)}`;
    const ledger = new ActivityLedger(victim.toUpperCase().replace("0X", "0x"));
    ledger.observe([{ address: victim, amount: -209_800_000n }, { address: real, amount: 209_800_000n }], "2026-09-09T17:54:29.969Z");
    ledger.observe([{ address: dust }, { address: dust, amount: -20n }, { address: victim, amount: 20n }], "2026-09-09T17:54:33.917Z");
    expect(ledger.activity.get(real)!.first_seen_paying_subject).toBe(false);
    expect(ledger.activity.get(dust)!.first_seen_paying_subject).toBe(true);
    expect(ledger.activity.get(victim)!.first_seen_paying_subject).toBe(false);
  });
});

describe("lookalikeReport counts and discloses", () => {
  const a = `0xcafe${"1".repeat(56)}beef`;
  const b = `0xcaf1${"2".repeat(56)}beef`;

  it("counts distinct compared addresses, not raw input", () => {
    const r = lookalikeReport([a, a.toUpperCase(), b, "", "not-an-address"])!;
    expect(r.addresses_compared).toBe(2);
  });

  /**
   * Vanity and burn addresses are excluded because they collide by
   * construction — but they are also a preferred poisoning target, so a silent
   * exclusion reads as a clean result.
   */
  /**
   * Only the SUBJECT. Low-entropy counterparties appear on nearly every page —
   * anything containing 0x0 has one — so reporting those is noise. A vanity
   * SUBJECT is different: declining to check it silently reads as clean.
   */
  it("says when the subject itself was excluded as low entropy", () => {
    const vanity = `0x${"0".repeat(16)}${"7".repeat(48)}`;
    const r = lookalikeReport([vanity, `0xdead${"3".repeat(56)}1234`], undefined, vanity)!;
    expect(r.subject_excluded).toBe(vanity);
    expect(r.note).toMatch(/preferred poisoning target/i);
  });

  it("stays silent about low-entropy counterparties", () => {
    const burn = `0x${"0".repeat(64)}`;
    const r = lookalikeReport([a, burn], undefined, a);
    expect(r.pairs).toEqual([]);
    expect(r.addresses_compared).toBe(1);
    expect(r.subject_excluded).toBeUndefined();
  });
});

describe("the note does not overclaim", () => {
  it("never says the addresses render identically", () => {
    const a = `0xcafe${"1".repeat(56)}beef`;
    const b = `0xcaf1${"2".repeat(56)}beef`;
    // At the 8+8 width this module itself renders, a 3+4 pair visibly differs.
    const [pair] = findLookalikes([a, b]);
    expect(pair!.note).not.toMatch(/render identically/i);
    expect(pair!.note).toMatch(/at a glance or in a short truncation/i);
  });
});
