/**
 * Where a package's `UpgradeCap` ended up, and what that means.
 *
 * Whoever holds the cap can replace the package's code. It is the single most
 * consequential capability on Sui, and `analyze_package` reported only who
 * holds it now — with nothing to compare that against, "held by 0xabc" is not a
 * finding.
 *
 * The comparison that makes it one is the **publisher**: the address that sent
 * the transaction creating the package. If the cap is somewhere else, upgrade
 * authority changed hands.
 *
 * This needs no history, which matters because there is none to be had.
 * Historical object versions and the transactions that moved them both fall
 * outside the indexer's retention for a cap that has sat still for months —
 * `trace_object_history` returns zero versions for every UpgradeCap sampled.
 * Two current facts answer the question that a history walk cannot.
 *
 * ## Burned is not transferred
 *
 * Measured over 150 mainnet caps:
 *
 * ```
 * 120 (80%)  still held by the publisher
 *  30 (20%)  elsewhere — of which
 *              20  ->  0x2   framework address, unspendable
 *               7  ->  0x0   zero address, unspendable
 *               3  ->  a real live address
 * ```
 *
 * So 27 of 30 departures are the team **renouncing** upgrade rights, which is
 * the responsible thing to do and the opposite of a warning. Collapsing them
 * into one "the cap moved" flag would fire on 20% of packages and mark good
 * behaviour as suspicious, which is how a signal gets ignored.
 *
 * A genuine transfer to a live address is 2%. That is the one worth surfacing.
 */

/**
 * An address nobody can spend from: the zero address, or one of the reserved
 * low framework addresses (`0x1`, `0x2`, `0x3`, `0x5`, `0x6`, `0xb` …).
 *
 * No private key exists for any of them, so an object sent there is
 * unrecoverable. Matched by numeric smallness rather than an explicit list,
 * because the reserved range is allocated over time and a new one appearing
 * should not silently start reading as a live recipient.
 */
export function isUnspendableAddress(address: string): boolean {
  const hex = address.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,64}$/.test(hex)) return false;
  // Everything below 0x100 — 62+ leading zeros in the padded form.
  return /^0*[0-9a-f]{0,2}$/.test(hex);
}

export type CapHolderStatus =
  /** Still with the address that published the package. */
  | "publisher"
  /** Sent somewhere unspendable: upgrade rights renounced. */
  | "burned"
  /** Held by a different live address than the publisher. */
  | "transferred"
  /** The publisher could not be resolved, so no comparison was possible. */
  | "unknown";

export interface CapHolderAssessment {
  status: CapHolderStatus;
  publisher?: string;
  holder?: string;
  note: string;
}

/**
 * Compare a cap's current holder against the package's publisher.
 *
 * `unknown` when either side is missing. It is not "publisher" — a publish
 * transaction is frequently pruned, and treating an unresolved publisher as a
 * match would report the reassuring answer whenever the lookup failed.
 */
export function assessCapHolder(
  holder: string | undefined,
  publisher: string | null | undefined,
): CapHolderAssessment {
  if (!holder) {
    return {
      status: "unknown",
      note: "The cap has no address owner — it is shared, immutable, or wrapped inside another object. Whoever can reach it there can still upgrade the package.",
    };
  }
  if (isUnspendableAddress(holder)) {
    return {
      status: "burned",
      holder,
      note: `The upgrade cap was sent to ${holder}, an address nobody holds a key for. Upgrade rights are renounced and this package's code can no longer be replaced — a deliberate act, and a reduction in risk rather than a warning.`,
    };
  }
  if (!publisher) {
    return {
      status: "unknown",
      holder,
      note: "The package's publisher could not be resolved — publish transactions are frequently pruned — so there is nothing to compare the current holder against. This is not evidence the cap is still with whoever deployed it.",
    };
  }
  if (holder.toLowerCase() === publisher.toLowerCase()) {
    return {
      status: "publisher",
      holder,
      publisher,
      note: "The upgrade cap is still held by the address that published the package.",
    };
  }
  return {
    status: "transferred",
    holder,
    publisher,
    note: `Upgrade authority has changed hands: the package was published by ${publisher} but its upgrade cap is now held by ${holder}. Measured on mainnet, this is uncommon — about 2% of packages — and most caps that leave the publisher are burned rather than transferred. It is not by itself wrong: teams move caps to treasuries and multisigs deliberately. Identify the holder before concluding anything.`,
  };
}
