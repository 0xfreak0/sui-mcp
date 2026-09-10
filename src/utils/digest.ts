/**
 * Transaction digest validation, shared by every tool that takes one.
 *
 * The Base58 alphabet alone is not enough: a run of 44 `1`s is valid Base58 and
 * decodes to 44 zero bytes, which the node refuses on length. Decoding and
 * checking the byte count is the only check that matches what it will accept.
 *
 * Worth doing before the request rather than after the error, for two different
 * reasons in the two shapes of call. A batch read is rejected WHOLE over one
 * malformed key, so a single typo among fifty digests returns nothing at all.
 * A single read merely fails — but it fails as a thrown transport error whose
 * message is about Base58, when the useful thing to say is "that is not a
 * digest".
 */
import { fromBase58 } from "@mysten/sui/utils";

export function isDigest(d: string): boolean {
  try {
    return fromBase58(d.trim()).length === 32;
  } catch {
    return false;
  }
}

/**
 * Trim surrounding whitespace, which carries no meaning in a digest and is the
 * commonest artefact of copying one out of a log or an explorer URL. Rejecting
 * a correct digest for a trailing space is a worse failure than the typo this
 * module exists to catch.
 */
export function normalizeDigest(d: string): string {
  return d.trim();
}

/** Message for a rejected digest. Says what a digest is, not what Base58 is. */
export function invalidDigestMessage(d: string): string {
  return (
    `"${d}" is not a transaction digest. A digest is Base58 that decodes to exactly 32 bytes ` +
    `(44 characters for a typical one). This was rejected before any request was made, so it is ` +
    `not evidence the transaction does not exist.`
  );
}
