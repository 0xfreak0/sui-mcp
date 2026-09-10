/**
 * Who published a package, and when.
 *
 * An unknown package is one of the commonest things an investigation turns up,
 * and "who deployed this" is the question that turns it back into an address
 * you can trace. The chain answers it directly: a package object records the
 * transaction that created it, and that transaction has a sender.
 *
 * Two things make it less trivial than it sounds:
 *
 * - **Attribute the ROOT, not the version you were handed.** An upgrade mints
 *   a new package ID whose creating transaction was sent by whoever held the
 *   `UpgradeCap` at the time. That is the upgrader, which may not be the
 *   original publisher and is a different claim. Callers pass the lineage root
 *   (`src/protocols/package-roots.ts` resolves it); this reports which ID it
 *   actually read so the distinction survives into the response.
 * - **Publish transactions are usually pruned.** Packages are long-lived and
 *   their creating transaction is not, so the fullnode answers `NOT_FOUND` for
 *   most of them. Verified on mainnet: a package published 2026-05-11 resolved
 *   only from the archive. `withArchiveFallback` handles it.
 */

import { withArchiveFallback } from "./archive-fallback.js";
import { timestampToIso } from "./formatting.js";
import type { GrpcTypes } from "@mysten/sui/grpc";

/** The zero address, which is how the chain reports a system-authored change. */
function isSystemPublisher(sender: string): boolean {
  return /^0x0+$/.test(sender);
}

export interface PackagePublisher {
  /** The package ID actually attributed — the root, when one was given. */
  package_id: string;
  /** Address that sent the transaction creating this package. */
  publisher: string | null;
  /** Digest of that transaction, so the claim can be checked. */
  publish_tx: string | null;
  published_at: string | null;
  /** True for a framework package, which upgrades in place. See {@link resolvePublisher}. */
  system_package?: boolean;
  /**
   * Set when the publisher could not be resolved, saying which step failed.
   *
   * "Could not look" and "nobody published it" are opposite conclusions, and an
   * absent publisher with no reason reads as the second.
   */
  unresolved?: string;
}

/**
 * Resolve a package to the address that published it.
 *
 * Never throws: this is enrichment on top of package analysis, and a pruned or
 * unreachable publish transaction must not fail the tool that called it.
 */
export async function resolvePublisher(packageId: string): Promise<PackagePublisher> {
  const out: PackagePublisher = {
    package_id: packageId,
    publisher: null,
    publish_tx: null,
    published_at: null,
  };

  let previousTransaction: string | undefined;
  try {
    const res = await withArchiveFallback<GrpcTypes.GetObjectResponse>(
      (client) =>
        client.ledgerService.getObject({
          objectId: packageId,
          readMask: { paths: ["object_id", "previous_transaction"] },
        }),
      (r) => !r.object,
    );
    previousTransaction = res.object?.previousTransaction;
  } catch (err) {
    out.unresolved = `Could not read the package object (${err instanceof Error ? err.message : String(err)}). This is not evidence about who published it.`;
    return out;
  }

  if (!previousTransaction) {
    out.unresolved =
      "The package object carries no creating transaction. Nothing further can be said about its publisher from chain data.";
    return out;
  }
  out.publish_tx = previousTransaction;

  const req = { digest: previousTransaction, readMask: { paths: ["transaction", "timestamp"] } };
  try {
    const res = await withArchiveFallback<GrpcTypes.GetTransactionResponse>(
      (client) => client.ledgerService.getTransaction(req),
      (r) => !r.transaction,
    );
    const tx = res.transaction;
    out.publisher = tx?.transaction?.sender ?? null;
    out.published_at = timestampToIso(tx?.timestamp) ?? null;
    if (!out.publisher) {
      out.unresolved =
        "The publish transaction was found but reports no sender, which is what a pruned record looks like.";
    } else if (isSystemPublisher(out.publisher)) {
      // System packages (0x1, 0x2, 0x3, 0xb …) upgrade IN PLACE, keeping their
      // ID while the version climbs, so `previousTransaction` is the most
      // recent framework upgrade rather than an original publish. Every other
      // package is immutable, which is what makes the field mean "created by"
      // for them. Reporting a framework upgrade date as a publish date would be
      // wrong in exactly the case a reader is least likely to check.
      out.system_package = true;
      out.unresolved =
        "This is a system package. It upgrades in place at protocol version boundaries, so `published_at` is its most recent framework upgrade, not an original publish, and the sender is the system rather than a person.";
    }
  } catch (err) {
    out.unresolved = `The package's creating transaction ${previousTransaction} could not be read (${err instanceof Error ? err.message : String(err)}). Publish transactions are frequently pruned; the archive was tried and did not have it either.`;
  }

  return out;
}
