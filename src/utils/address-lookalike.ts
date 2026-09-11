/**
 * Address-poisoning detection: counterparties that RENDER like each other.
 *
 * The attack needs no exploit and no approval. Somebody generates an address
 * sharing the first few and last few characters of one you already transact
 * with, sends dust from it, and waits. Every wallet and explorer truncates a
 * 32-byte address to something like `0xe1bf…ed24`, so the poisoned row is
 * visually identical to the real one in the only view anyone actually reads.
 * The payoff is a human copying the wrong row out of their own history.
 *
 * Confirmed on mainnet against a real target: a fresh address was funded, sent
 * 0.001 SUI to the victim, and swept its change back to the funder — nine
 * seconds from first to last transaction. It has no purpose other than to
 * occupy a line in a transaction list.
 *
 * ## Why the threshold is a TOTAL, not a symmetric k
 *
 * The obvious rule is "k leading and k trailing characters match". Both real
 * cases found break it: one matches 3 leading and 4 trailing, the other 5 and
 * 3. At k=4 symmetric both are missed; at k=3 symmetric the noise floor rises
 * by two orders of magnitude. Attackers grind whichever end is cheaper, and the
 * victim's eye reads the concatenation, so the score is the sum.
 *
 * The rule is a floor of {@link MIN_PER_END} at EACH end — 3 and 3. That puts
 * the per-pair collision probability at 16^-6, about 6x10^-8: under one
 * expected false positive across ten million pairs, which is why a pair can be
 * reported at all.
 *
 * Do not make the rule asymmetric without changing the bucketing. Candidates
 * are bucketed on their first {@link MIN_PER_END} characters, which is sound
 * only because the prefix floor equals the bucket width. Admitting a 2+6 match
 * while bucketing on 3 would put a genuine pair in two different buckets and
 * report nothing at all.
 *
 * ## Why low-entropy addresses are excluded first
 *
 * The first run of this flagged `0x0000…0000` against `0x0000…0f0d000000`.
 * Both are real addresses and both genuinely share leading and trailing
 * characters, but they share them through zero padding rather than through
 * anybody's effort. Vanity and burn addresses collide with each other for
 * structural reasons and are not evidence of targeting.
 */

const MIN_PER_END_VALUE = 3;

/**
 * Total leading+trailing characters in a reportable pair. Derived, not
 * enforced: with {@link MIN_PER_END} at 3 the floor of 3+3 already implies it.
 * Kept because the collision arithmetic is stated against this number.
 */
export const MIN_MATCHING_CHARS = MIN_PER_END_VALUE * 2;

/**
 * Minimum match at EACH end.
 *
 * Three, not two, and the difference is a false positive this produced on
 * mainnet. Two addresses matched 4 leading and 2 trailing characters and were
 * flagged; they turned out to be co-recipients of one 2023 batch airdrop that
 * paid 0.01 SUI to dozens of addresses at once, with no contact between them
 * ever. They also do not look alike: `0x3f9ac21d…d301e7b4` beside
 * `0x3f9a7e04…480b6f93` — a 4+2 match collides only in a view truncated to four
 * and two characters, and no wallet or explorer truncates that hard; four
 * trailing is the common floor.
 *
 * So a 2-character match at either end is not deceptive in any view a human
 * reads, and admitting it only buys collisions. Both confirmed mainnet
 * poisoning cases match 3 or more at both ends (3+4 and 5+3), so nothing real
 * is lost. A shared prefix with a divergent tail is the least deceptive shape,
 * not the most.
 */
export const MIN_PER_END = MIN_PER_END_VALUE;

export interface AddressActivity {
  /** How many transactions this address was seen in, over whatever was scanned. */
  transactions?: number;
  /**
   * Raw units received, summed across coin types.
   *
   * Only ever compared against ZERO. Raw units are not comparable across coin
   * types — 1 unit of an 18-decimal spam token outranks 5 SUI — and
   * `funding.ts` already learned that lesson the hard way. What carries signal
   * is "received nothing at all", which is the poisoning shape: funded, fires
   * dust, abandoned.
   */
  received?: bigint;
}

export interface LookalikePair {
  /** The address with the larger observed footprint, where that is knowable. */
  established: string;
  /** The address with the smaller footprint — the likelier impostor. */
  suspect: string;
  prefix_chars: number;
  suffix_chars: number;
  matching_chars: number;
  /** How the two look side by side once truncated, which is the actual attack. */
  rendered: { established: string; suspect: string };
  /**
   * Whether `suspect` really is the impostor or the pair is simply unordered.
   * False when the two have indistinguishable footprints, in which case the
   * roles are arbitrary and the reader must not treat them as assigned.
   */
  direction_known: boolean;
  note: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Strip `0x`, lowercase, left-pad to 64. Returns null for anything else. */
function normalize(address: string): string | null {
  const body = address.trim().toLowerCase().replace(/^0x/, "");
  if (body.length === 0 || body.length > 64 || !/^[0-9a-f]+$/.test(body)) return null;
  const padded = body.padStart(64, "0");
  return HEX64.test(padded) ? padded : null;
}

/**
 * Addresses whose characters are structural rather than chosen.
 *
 * A long zero run at either end is padding — `0x2`, `0xb`, burn addresses and
 * the small system addresses all share prefixes and suffixes with each other by
 * construction. So is an address drawn from too few distinct nibbles to be a
 * random key: that is a vanity grind, and two vanity addresses colliding says
 * something about the grinder, not about targeting.
 */
function lowEntropy(hex: string): boolean {
  if (/^0{12}/.test(hex) || /0{12}$/.test(hex)) return true;
  return new Set(hex).size <= 4;
}

/** `0xabcd1234…5678wxyz` — near enough to how wallets truncate. */
function render(hex: string): string {
  return `0x${hex.slice(0, 8)}…${hex.slice(-8)}`;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * The gap in transaction counts before one address may be called the impostor.
 *
 * A 2-vs-1 margin is not evidence. Dust repeating inside one page is the normal
 * shape of this attack, so a poisoner that sends three times beats a real
 * counterparty seen once, and the tool would then point the accusation at the
 * legitimate address. Measured on the pinned mainnet case, the real margin is
 * 4-vs-1 — five dust sends invert it.
 *
 * The established side must also have been seen at least this many times, so a
 * 3-vs-0 reading off a nearly empty page cannot assign roles either.
 */
export const DIRECTION_MIN_MARGIN = 3;

/**
 * Rank two addresses by footprint, or decline to.
 *
 * Returns 0 whenever the evidence cannot carry the claim, and the caller then
 * reports the pair without assigning roles. Declining is cheap; naming the
 * victim as the attacker is not.
 */
function footprintOrder(a: AddressActivity | undefined, b: AddressActivity | undefined): number {
  const at = a?.transactions ?? 0;
  const bt = b?.transactions ?? 0;
  const hi = Math.max(at, bt);
  const lo = Math.min(at, bt);

  if (hi >= DIRECTION_MIN_MARGIN && hi - lo >= DIRECTION_MIN_MARGIN) {
    return at > bt ? 1 : -1;
  }

  // Counts are too close to separate them. One remaining signal is decimals-
  // safe: a poisoning address receives NOTHING. That only speaks when exactly
  // one side received something, and never about how much.
  const ar = (a?.received ?? 0n) > 0n;
  const br = (b?.received ?? 0n) > 0n;
  if (ar !== br) return ar ? 1 : -1;
  return 0;
}

function pairNote(p: LookalikePair): string {
  // Do NOT claim they "render identically in any truncated view". At 8+8 —
  // the width this module itself renders — a 3+4 pair visibly differs. What
  // is true is that they match at both ends, which is what defeats a glance
  // and a short truncation.
  const shape = `the first ${p.prefix_chars} and last ${p.suffix_chars} characters`;
  if (!p.direction_known) {
    return `Two addresses in this result share ${shape}, close enough to be mistaken for one another at a glance or in a short truncation. Nothing here separates their footprints, so which one is the impostor cannot be told from this data — check both before sending anything to either.`;
  }
  return `${p.rendered.suspect} shares ${shape} with ${p.rendered.established}, which has the larger footprint here. That is consistent with address poisoning: a lookalike exists so a copy taken from transaction history lands on it instead. The direction rests on activity seen in this result only. Verify the full 32 bytes of any address taken from this history before sending to it.`;
}

/**
 * Find pairs of addresses that render alike.
 *
 * All-pairs over the candidate set, bucketed so it does not degrade on large
 * inputs: a reportable pair must agree on its first {@link MIN_PER_END}
 * characters, so only addresses sharing that bucket are ever compared.
 *
 * Pass `activity` to have each pair name a likely impostor. Without it the
 * pairs still come back, unordered — the collision is the finding, and which
 * side is fake is a separate claim that needs separate evidence.
 */
export function findLookalikes(
  addresses: Iterable<string>,
  activity?: Map<string, AddressActivity>,
): LookalikePair[] {
  // Index activity by NORMALIZED address. The map arrives keyed by whatever
  // strings the caller collected — canonical ones from the chain, but the
  // subject is whatever the caller typed, and the GraphQL API accepts
  // uppercase and unpadded short forms. Looking up by the raw string then
  // misses the subject's own footprint, it scores zero, and the victim's
  // wallet gets named the impostor. `chain-id.ts`, `package-roots.ts` and
  // `registry.ts` all normalize before using an address as a key.
  const byHex = new Map<string, AddressActivity>();
  if (activity) {
    for (const [raw, act] of activity) {
      const hex = normalize(raw);
      if (!hex) continue;
      const prev = byHex.get(hex);
      byHex.set(
        hex,
        prev
          ? {
              transactions: (prev.transactions ?? 0) + (act.transactions ?? 0),
              received: (prev.received ?? 0n) + (act.received ?? 0n),
            }
          : act,
      );
    }
  }

  const buckets = new Map<string, { hex: string; original: string }[]>();
  const seen = new Set<string>();

  for (const original of addresses) {
    const hex = normalize(original);
    if (!hex || seen.has(hex) || lowEntropy(hex)) continue;
    seen.add(hex);
    // Bucket width MUST equal the prefix floor — see MIN_PER_END.
    const key = hex.slice(0, MIN_PER_END);
    const bucket = buckets.get(key);
    if (bucket) bucket.push({ hex, original });
    else buckets.set(key, [{ hex, original }]);
  }

  const pairs: LookalikePair[] = [];

  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        const prefix = commonPrefix(a.hex, b.hex);
        const suffix = commonSuffix(a.hex, b.hex);
        if (prefix < MIN_PER_END || suffix < MIN_PER_END) continue;
        if (prefix + suffix < MIN_MATCHING_CHARS) continue;

        const order = footprintOrder(byHex.get(a.hex), byHex.get(b.hex));
        const [established, suspect] = order >= 0 ? [a, b] : [b, a];

        const pair: LookalikePair = {
          // Canonical form, so a reported address matches itself downstream in
          // save_finding and export_case.
          established: `0x${established.hex}`,
          suspect: `0x${suspect.hex}`,
          prefix_chars: prefix,
          suffix_chars: suffix,
          matching_chars: prefix + suffix,
          rendered: { established: render(established.hex), suspect: render(suspect.hex) },
          direction_known: order !== 0,
          note: "",
        };
        pair.note = pairNote(pair);
        pairs.push(pair);
      }
    }
  }

  // Strongest collision first: that is the one a reader should check.
  return pairs.sort((x, y) => y.matching_chars - x.matching_chars);
}

/** One address's appearance in a single transaction. */
export interface Appearance {
  address: string;
  /** Its balance change, if any. Negative and zero both count as no receipt. */
  amount?: bigint;
}

/**
 * Accumulates per-address footprints across transactions, which is what decides
 * which side of a lookalike pair is named the impostor.
 *
 * The counting rule is the reason this is a type rather than two closures: an
 * address that both SENT a transaction and took a balance change in it appeared
 * once, not twice, and double-counting inflates exactly the party whose
 * footprint the direction call rests on. {@link observe} takes a whole
 * transaction's appearances at once so that rule cannot be forgotten at a call
 * site.
 */
export class ActivityLedger {
  private readonly byAddress = new Map<string, AddressActivity>();

  /** Record every appearance within ONE transaction. */
  observe(appearances: Iterable<Appearance>): void {
    const seen = new Set<string>();
    for (const { address, amount } of appearances) {
      const entry = this.byAddress.get(address) ?? { transactions: 0, received: 0n };
      if (!seen.has(address)) {
        seen.add(address);
        entry.transactions = (entry.transactions ?? 0) + 1;
      }
      if (amount !== undefined && amount > 0n) {
        entry.received = (entry.received ?? 0n) + amount;
      }
      this.byAddress.set(address, entry);
    }
  }

  get activity(): Map<string, AddressActivity> {
    return this.byAddress;
  }

  addresses(): string[] {
    return [...this.byAddress.keys()];
  }

  /** Every address seen, with `first` ahead of them and never duplicated. */
  addressesLedBy(first: string): string[] {
    return [first, ...this.byAddress.keys()].filter(
      (a, i, all) => all.indexOf(a) === i,
    );
  }
}

export interface LookalikeReport {
  /** Distinct addresses actually compared, after normalizing and filtering. */
  addresses_compared: number;
  /**
   * Set when the SUBJECT of the investigation was itself excluded as
   * structurally low-entropy — a vanity or zero-padded address.
   *
   * Only the subject. Low-entropy counterparties turn up on nearly every page
   * (any page containing `0x0` has one), so reporting those would be noise.
   * The subject is different: a vanity address is a PREFERRED poisoning
   * target, and silently declining to check it reads as a clean result.
   */
  subject_excluded?: string;
  pairs: LookalikePair[];
  note: string;
}

/**
 * Wrap {@link findLookalikes} for a tool response, or return null when there is
 * nothing to say.
 *
 * Null rather than an empty report on purpose: an absent field is correct here.
 * A clean scan over one page of history is not a statement that an address has
 * never been poisoned, and a `address_poisoning: { pairs: [] }` block on every
 * response would read like one.
 */
export function lookalikeReport(
  addresses: Iterable<string>,
  activity?: Map<string, AddressActivity>,
  subject?: string,
): LookalikeReport | null {
  const list = [...addresses];
  const pairs = findLookalikes(list, activity);

  // Count what was really compared, not the raw input: duplicates, different
  // spellings of one address and unparseable entries all inflate `list.length`.
  const compared = new Set<string>();
  for (const a of list) {
    const hex = normalize(a);
    if (hex && !lowEntropy(hex)) compared.add(hex);
  }

  const subjectHex = subject ? normalize(subject) : null;
  const subjectExcluded = subjectHex != null && lowEntropy(subjectHex);

  if (pairs.length === 0 && !subjectExcluded) return null;

  const excludedNote = subjectExcluded
    ? `This address was itself left out of the comparison as structurally low-entropy — a vanity or zero-padded address, which collides with others of its kind by construction. A vanity address is a preferred poisoning target, so this is NOT a statement that it has not been targeted.`
    : null;

  if (pairs.length === 0) {
    return {
      addresses_compared: compared.size,
      subject_excluded: subject,
      pairs: [],
      note: excludedNote!,
    };
  }

  return {
    addresses_compared: compared.size,
    ...(subjectExcluded ? { subject_excluded: subject } : {}),
    pairs,
    note:
      `${pairs.length} pair${pairs.length === 1 ? "" : "s"} of addresses in this result are close enough to be mistaken for one another. Addresses were compared only within what was returned here, so this is not a complete scan of the wallet's counterparties.` +
      (excludedNote ? ` ${excludedNote}` : ""),
  };
}
