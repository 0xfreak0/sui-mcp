import { describe, it, expect } from "vitest";
import {
  ActivityLedger,
  findLookalikes,
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
   * Regression from a live run: two co-recipients of one 2023 batch airdrop
   * matched 4 leading and 2 trailing characters and were flagged. They had
   * never transacted with each other, and at 4+2 they do not even render
   * alike — no wallet truncates to two trailing characters.
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
   * Regression from the first live run: `0x0000…0000` matched
   * `0x0000…0f0d000000` at four characters each end, entirely through zero
   * padding. Both are real addresses; neither was grinding for the other.
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
    expect(pair!.note).toMatch(/cannot be told apart/i);
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
  it("is null when nothing collides, not an empty report", () => {
    // An absent field says "not observed here"; an empty one reads as a clean
    // bill of health for the whole wallet, which one page cannot support.
    expect(lookalikeReport([addr("1111", "22223333"), addr("4444", "55556666")])).toBeNull();
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
