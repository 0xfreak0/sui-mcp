/**
 * Which committee members actually sign, over a multisig's whole history.
 *
 * The committee is fixed for the life of the address — it is part of the
 * address hash — so the only thing that varies between transactions is the
 * bitmap saying who signed that one. That bitmap is the entire behavioural
 * signal a multisig emits, and reading a single transaction cannot interpret
 * it: measured on a mainnet 4-of-7, eight transactions used three different
 * signer sets, and two of the seven keys had never signed at all.
 *
 * ```
 * 4-of-7   8 txs, 3 signer sets      [0,1,3,4]x4  [1,2,3,4]x2  [0,2,3,4]x2
 *                                    → 3 and 4 sign everything; 5 and 6 never sign
 * 2-of-3   200 txs, 3 signer sets    [0,2]x90  [1,2]x68  [0,1]x42
 *                                    → genuinely shared between three live keys
 * ```
 *
 * The two shapes above are the ones this is for. A key that has never signed
 * is a cold or dormant key; a key present in every set is the operator's hot
 * key. Neither is visible from one transaction, and both change how a treasury
 * reads.
 *
 * Pure. The caller fetches the transactions; nothing here touches the network.
 */

import type { MultisigCommittee } from "./multisig.js";

/** One transaction's contribution: who signed, and when. */
export interface SignerObservation {
  digest: string;
  /** Committee member indices that signed. */
  signers: number[];
  /** ISO timestamp, when the transaction carried one. */
  timestamp?: string;
}

export interface MemberActivity {
  index: number;
  address?: string;
  weight: number;
  /** Transactions this member signed, of those examined. */
  signed_count: number;
  /** Share of examined transactions, 0-1, rounded to 2dp. */
  signed_share: number;
  first_signed?: string;
  last_signed?: string;
  /**
   * True when this member signed none of the transactions examined.
   *
   * A key that holds weight and has never used it. On a treasury that is worth
   * saying out loud — it is a cold key, a lost key, or a party that has never
   * needed to act. Which of those it is does not follow from chain data.
   */
  never_signed: boolean;
}

/** A distinct combination of members that has signed together. */
export interface SignerSet {
  /** Member indices, ascending. */
  members: number[];
  count: number;
  first_seen?: string;
  last_seen?: string;
}

export interface SignerHistory {
  transactions_examined: number;
  members: MemberActivity[];
  /** Distinct signer combinations, most frequent first. */
  signer_sets: SignerSet[];
  /** Members that signed nothing examined. Indices, ascending. */
  dormant_members: number[];
  /** Members present in every examined transaction. Indices, ascending. */
  always_present: number[];
  /**
   * The committee's threshold could be met without these members.
   *
   * True when the members that DO sign carry enough weight on their own, which
   * means the dormant keys are not currently load-bearing. It is a statement
   * about the observed period, not a permanent property.
   */
  active_signers_meet_threshold: boolean;
}

/**
 * Aggregate per-transaction signer bitmaps into a per-member picture.
 *
 * `observations` may be a page rather than the whole history; the caller says
 * how far it read and the response reports `transactions_examined` so a reader
 * can see the basis. A member marked `never_signed` over 8 transactions is a
 * much weaker claim than one marked over 200, and only the count distinguishes
 * them — which is why no verdict here is stated without it.
 */
export function summarizeSigners(
  committee: MultisigCommittee,
  observations: SignerObservation[],
): SignerHistory {
  const n = committee.members.length;
  const counts = new Array<number>(n).fill(0);
  const firsts: (string | undefined)[] = new Array(n).fill(undefined);
  const lasts: (string | undefined)[] = new Array(n).fill(undefined);
  const sets = new Map<string, SignerSet>();

  for (const o of observations) {
    for (const i of o.signers) {
      if (i < 0 || i >= n) continue;
      counts[i]++;
      // Observations arrive newest-first from GraphQL, so the earliest
      // timestamp seen is the first signature, not the last one written.
      if (o.timestamp) {
        if (!firsts[i] || o.timestamp < firsts[i]!) firsts[i] = o.timestamp;
        if (!lasts[i] || o.timestamp > lasts[i]!) lasts[i] = o.timestamp;
      }
    }
    const key = [...o.signers].sort((a, b) => a - b).join(",");
    let set = sets.get(key);
    if (!set) {
      sets.set(key, (set = { members: [...o.signers].sort((a, b) => a - b), count: 0 }));
    }
    set.count++;
    if (o.timestamp) {
      if (!set.first_seen || o.timestamp < set.first_seen) set.first_seen = o.timestamp;
      if (!set.last_seen || o.timestamp > set.last_seen) set.last_seen = o.timestamp;
    }
  }

  const total = observations.length;
  const members: MemberActivity[] = committee.members.map((m, i) => ({
    index: i,
    ...(m.address ? { address: m.address } : {}),
    weight: m.weight,
    signed_count: counts[i],
    signed_share: total > 0 ? Number((counts[i] / total).toFixed(2)) : 0,
    ...(firsts[i] ? { first_signed: firsts[i] } : {}),
    ...(lasts[i] ? { last_signed: lasts[i] } : {}),
    never_signed: counts[i] === 0,
  }));

  const dormant = members.filter((m) => m.never_signed).map((m) => m.index);
  // Vacuously true with nothing examined, which would read as a finding. An
  // empty history says nothing about who is always present.
  const alwaysPresent =
    total > 0 ? members.filter((m) => m.signed_count === total).map((m) => m.index) : [];
  const activeWeight = members
    .filter((m) => !m.never_signed)
    .reduce((sum, m) => sum + m.weight, 0);

  return {
    transactions_examined: total,
    members,
    signer_sets: [...sets.values()].sort((a, b) => b.count - a.count),
    dormant_members: dormant,
    always_present: alwaysPresent,
    active_signers_meet_threshold: total > 0 && activeWeight >= committee.threshold,
  };
}

/**
 * A reading for someone scanning the result, or undefined when the history is
 * too thin to support one.
 *
 * The threshold for "too thin" is deliberately low but non-zero: one
 * transaction tells you nothing about a signing pattern, and stating a pattern
 * from it is the exact failure this module exists to fix.
 */
export function signerHistoryNote(h: SignerHistory, threshold: number): string | undefined {
  if (h.transactions_examined < 2) {
    return h.transactions_examined === 0
      ? "No multisig transactions were examined, so nothing follows about which keys are live."
      : "Only one transaction was examined. Which members signed it says nothing about which keys are normally used — a signer set varies per transaction.";
  }

  const parts: string[] = [];
  if (h.dormant_members.length > 0) {
    parts.push(
      `${h.dormant_members.length} of ${h.members.length} committee keys signed none of the ${h.transactions_examined} transactions examined (members ${h.dormant_members.join(", ")}). They hold weight and have not used it — a cold key, a lost key, or a party that has never needed to act; chain data does not say which.`,
    );
  }
  if (h.always_present.length > 0) {
    parts.push(
      `Members ${h.always_present.join(", ")} signed every one, so the wallet cannot currently move without them.`,
    );
  }
  if (h.dormant_members.length > 0 && h.active_signers_meet_threshold) {
    parts.push(
      `The keys that do sign already carry the ${threshold} weight needed, so the dormant ones are not load-bearing over this period.`,
    );
  }
  if (h.signer_sets.length === 1 && h.transactions_examined > 2) {
    parts.push(
      `Only one signer combination appears across all ${h.transactions_examined}, which looks like a fixed operating set rather than a committee taking turns.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
