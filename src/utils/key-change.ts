/**
 * Public keys a transaction replaced in a shared object.
 *
 * An object that stores a public key decides whose signatures the chain
 * accepts for it: an oracle's signing key, a bridge committee member, a
 * guardian. A price feed or a message such an object verifies is only as
 * good as the key it holds, so a transaction that puts a different key there
 * changes who can write every price the object later vouches for.
 *
 * No rule here reads a field name. A key is a byte string (rendered base64)
 * of a public-key length, outside lists (a list's entries shift as items are
 * added and removed, so the same index is not the same key).
 */

import type { PtbAnomaly } from "./ptb-anomalies.js";
import type { StateSnapshot } from "./state-delta.js";

/**
 * Public-key lengths in bytes: compressed and uncompressed secp256k1/r1 (with
 * and without the SEC1 prefix), BLS12-381 G1 and G2. 32 bytes is left out: a
 * 32-byte string is as often a digest (the last transaction, a Merkle root)
 * that changes in ordinary use as an ed25519 key.
 */
export const KEY_LENGTHS: ReadonlySet<number> = new Set([33, 48, 64, 65, 96]);

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The bytes of a base64 string of a public-key length that is not all zeros, else null. */
export function keyBytes(v: unknown): Buffer | null {
  // A number stored as a decimal string is also valid base64.
  if (typeof v !== "string" || v.length % 4 !== 0 || !BASE64.test(v) || /^\d+$/.test(v)) return null;
  const b = Buffer.from(v, "base64");
  if (!KEY_LENGTHS.has(b.length) || b.every((x) => x === 0)) return null;
  return b;
}

/** Byte strings of a key length by JSON path, not descending into lists. */
function keyFields(json: unknown, path = "", out = new Map<string, string>(), depth = 0): Map<string, string> {
  if (depth > 6 || Array.isArray(json)) return out;
  if (typeof json === "string") {
    if (keyBytes(json)) out.set(path, json);
  } else if (json && typeof json === "object") {
    for (const [k, v] of Object.entries(json)) keyFields(v, path ? `${path}.${k}` : k, out, depth + 1);
  }
  return out;
}

export interface KeyChange {
  object: string;
  object_type: string | null;
  field: string;
  /** Key length in bytes. */
  bytes: number;
  before: string;
  after: string;
}

/** Every key a changed shared object held before the transaction and holds replaced by another key after it. */
export function keyChanges(snap: StateSnapshot): KeyChange[] {
  const out: KeyChange[] = [];
  for (const o of snap.objects) {
    if (o.role !== "shared" || o.before === null || o.after === null) continue;
    const before = keyFields(o.before);
    const after = keyFields(o.after);
    for (const [path, b] of before) {
      const a = after.get(path);
      if (a === undefined || a === b) continue;
      out.push({ object: o.objectId, object_type: o.objectType, field: path, bytes: Buffer.from(a, "base64").length, before: b, after: a });
    }
  }
  return out;
}

/** The `signing-key-replaced` anomaly (medium). */
export function keyChangeAnomaly(changes: KeyChange[]): PtbAnomaly | null {
  if (!changes.length) return null;
  return {
    severity: "medium",
    code: "signing-key-replaced",
    title: `Replaces a public key a shared object holds: ${changes.length} key${changes.length === 1 ? "" : "s"}`,
    detail:
      "Read at the transaction's input and output versions, a shared object's byte string of a public-key length changed from one key to another. An object that holds a key decides whose signatures it accepts: an oracle's signing key, a committee member, a guardian. Every price or message it vouches for after this transaction is signed by the new key's holder. A key rotation by the protocol's own operator reads the same; check who sent this transaction and what vouched for the new key with get_transaction, and which objects read this one afterwards with query_transactions and affected_object.",
    evidence: changes
      .slice(0, 10)
      .map((c) => `${c.object} (${c.object_type ? c.object_type.split("<")[0].split("::").slice(1).join("::") : "unknown type"}) ${c.field}: a ${c.bytes}-byte key ${c.before.slice(0, 12)}… -> ${c.after.slice(0, 12)}…`),
  };
}
