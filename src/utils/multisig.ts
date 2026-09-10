/**
 * How an address authenticates, read from the signatures it has produced.
 *
 * A Sui address IS the hash of its authenticator — for a multisig,
 * `blake2b(0x03 ‖ threshold ‖ flag₁‖pk₁‖w₁ ‖ … ‖ flagₙ‖pkₙ‖wₙ)`
 * (`sui-types/src/base_types.rs`, `impl From<&MultiSigPublicKey> for SuiAddress`).
 * So the entire committee — every member key, every weight, the threshold —
 * travels inside every transaction the multisig sends, and re-deriving it
 * reproduces the address. That makes membership **chain-derived**: it trusts
 * no indexer and no heuristic, and a caller can check it independently.
 *
 * Three consequences worth stating, because they are the opposite of the EVM
 * intuition a reader arrives with:
 *
 * - **The committee cannot change.** Rotating a member changes the hash, which
 *   changes the address. A Gnosis Safe rotates owners in place; a Sui multisig
 *   cannot. Measured on one mainnet wallet: 200 sent transactions, one
 *   committee, no variation.
 * - **An address has exactly one authenticator, forever.** There is no key
 *   rotation, so "what is this address" has a single permanent answer.
 * - **A wallet that has never sent cannot be classified at all.** No
 *   transaction, no signature, no committee. That is `null` here, and it must
 *   surface as "unknown", never as "ordinary wallet" — a receive-only treasury
 *   multisig looks exactly like a fresh personal wallet from the outside.
 *
 * Everything in this module is pure. Fetching the signatures is the caller's
 * job; `describeSignatures` and `readAuthentication` only decode what they are
 * handed, and never throw on malformed input.
 */

import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { MultiSigPublicKey } from "@mysten/sui/multisig";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1PublicKey } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1PublicKey } from "@mysten/sui/keypairs/secp256r1";
import { computeZkLoginAddressFromSeed } from "@mysten/sui/zklogin";
import type { PublicKey } from "@mysten/sui/cryptography";

/** Scheme flag byte, as it appears first in a serialized signature. */
const FLAG_MULTISIG = 0x03;

/**
 * Schemes whose member entry carries a plain public key, which is the only
 * case where a member address falls straight out of the committee.
 */
const PLAIN_KEY_CLASSES = {
  ED25519: Ed25519PublicKey,
  Secp256k1: Secp256k1PublicKey,
  Secp256r1: Secp256r1PublicKey,
} as const;

export type AuthScheme =
  | "ed25519"
  | "secp256k1"
  | "secp256r1"
  | "multisig"
  | "zklogin"
  | "passkey"
  | "unknown";

/** SDK scheme names are capitalised; ours are the wire-ish lowercase form. */
const SCHEME_NAMES: Record<string, AuthScheme> = {
  ED25519: "ed25519",
  Secp256k1: "secp256k1",
  Secp256r1: "secp256r1",
  MultiSig: "multisig",
  ZkLogin: "zklogin",
  Passkey: "passkey",
};

/** A zkLogin identity as it appears on chain. See {@link zkLoginNote}. */
export interface ZkLoginIdentity {
  /** OAuth issuer, e.g. `https://accounts.google.com`. */
  iss: string;
  /** Decimal `poseidon(sub, aud, salt)`. One-to-one with the address. */
  address_seed: string;
}

/** One member of a multisig committee. */
export interface MultisigMember {
  /** Position in the committee. Load-bearing: the order is hashed. */
  index: number;
  scheme: AuthScheme;
  weight: number;
  /** Base64 public key, when the scheme has a plain one. */
  public_key?: string;
  /**
   * The member's own Sui address.
   *
   * Absent when the member is a passkey, or a zkLogin identity we could not
   * derive. An absent address is not an absent member — it still holds weight
   * and can still sign.
   */
  address?: string;
  /** Present for a zkLogin member; names the identity provider. */
  zklogin?: ZkLoginIdentity;
  /**
   * Did this member sign **the one transaction this reading came from**.
   *
   * Not a property of the wallet. The committee is fixed for the life of the
   * address, but which members sign varies per transaction: a mainnet 4-of-7
   * used three different signer sets across eight transactions, and two of its
   * seven keys had never signed at all. Reading one transaction and presenting
   * its bitmap as "who signs" cannot tell a permanently dormant key from one
   * that sat out a single transfer.
   *
   * For the wallet-level question, see `analyze_multisig`.
   */
  signed_source_tx: boolean;
}

export interface MultisigCommittee {
  threshold: number;
  members: MultisigMember[];
  /** Sum of every member's weight — the most a committee could ever muster. */
  total_weight: number;
  /** Weight that signed the one transaction this reading came from. */
  signed_weight: number;
  /** Raw signer bitmap, kept so a caller can check the member flags. */
  bitmap: number;
}

export interface Authentication {
  scheme: AuthScheme;
  /**
   * The derivation reproduced the address asked about.
   *
   * False means we decoded something but it describes a different address —
   * report it as unresolved, never as this address's committee.
   */
  verified: boolean;
  multisig?: MultisigCommittee;
  zklogin?: ZkLoginIdentity;
}

/** One signature from a transaction, and the address it proves. */
export interface SignatureIdentity {
  scheme: AuthScheme;
  /** The address this signature authenticates, when we could derive it. */
  address?: string;
  multisig?: MultisigCommittee;
  zklogin?: ZkLoginIdentity;
}

/** Normalize to the padded lowercase 0x form the chain reports. */
function normalize(address: string): string {
  const hex = address.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,64}$/.test(hex)) return address.trim().toLowerCase();
  return "0x" + hex.padStart(64, "0");
}

/** The scheme flag byte, or -1 if the input is not decodable base64. */
function flagOf(serialized: string): number {
  try {
    const bytes = Buffer.from(serialized, "base64");
    return bytes.length > 0 ? bytes[0] : -1;
  } catch {
    return -1;
  }
}

function publicKeyFor(scheme: string, bytes: Uint8Array): PublicKey | null {
  const C = PLAIN_KEY_CLASSES[scheme as keyof typeof PLAIN_KEY_CLASSES];
  if (!C) return null;
  try {
    return new C(bytes);
  } catch {
    return null;
  }
}

/**
 * A zkLogin address, trying both derivations.
 *
 * zkLogin shipped two: the current one left-pads the address seed to 32 bytes,
 * the legacy one does not, and both produced live mainnet addresses. Nothing
 * in the signature says which was used, so the only way to know is to derive
 * both and see which reproduces the address — which is why this takes the
 * address it is trying to match rather than returning one answer.
 */
function zkLoginAddress(seed: bigint | string, iss: string, expected?: string): string | null {
  for (const legacy of [false, true]) {
    try {
      const derived = computeZkLoginAddressFromSeed(BigInt(seed), iss, legacy);
      if (!expected || normalize(derived) === normalize(expected)) return normalize(derived);
    } catch {
      // Try the other derivation before giving up.
    }
  }
  return null;
}

/**
 * Derive the address a committee hashes to, or null if any member lacks a
 * plain public key.
 *
 * Returning null rather than a partial answer is deliberate: a committee
 * containing a zkLogin or passkey member hashes over that member's own
 * identifier bytes, and guessing a substitute would produce a valid-looking
 * address belonging to nobody.
 */
export function deriveMultisigAddress(members: MultisigMember[], threshold: number): string | null {
  const publicKeys: { publicKey: PublicKey; weight: number }[] = [];
  for (const m of members) {
    if (!m.public_key) return null;
    const pk = publicKeyFor(schemeToSdkName(m.scheme), Buffer.from(m.public_key, "base64"));
    if (!pk) return null;
    publicKeys.push({ publicKey: pk, weight: m.weight });
  }
  try {
    return normalize(MultiSigPublicKey.fromPublicKeys({ threshold, publicKeys }).toSuiAddress());
  } catch {
    return null;
  }
}

function schemeToSdkName(scheme: AuthScheme): string {
  for (const [sdk, ours] of Object.entries(SCHEME_NAMES)) if (ours === scheme) return sdk;
  return scheme;
}

/** Decode a multisig signature's committee. Null if it will not parse. */
function readCommittee(parsed: {
  multisig: {
    bitmap: number;
    multisig_pk: { threshold: number; pk_map: { pubKey: Record<string, unknown>; weight: number }[] };
  };
}): { committee: MultisigCommittee; address: string | null } | null {
  const { bitmap, multisig_pk } = parsed.multisig;
  const members: MultisigMember[] = [];

  for (const [index, entry] of multisig_pk.pk_map.entries()) {
    const [sdkScheme] = Object.keys(entry.pubKey);
    const scheme = SCHEME_NAMES[sdkScheme] ?? "unknown";
    const signedSourceTx = Boolean((bitmap >> index) & 1);
    const raw = entry.pubKey[sdkScheme];

    const member: MultisigMember = {
      index,
      scheme,
      weight: entry.weight,
      signed_source_tx: signedSourceTx,
    };

    if (scheme === "zklogin") {
      // A zkLogin member is a ZkLoginPublicIdentifier (issuer + address seed),
      // not a key. Unobserved in a live committee so far — the shape is taken
      // from the protobuf definition, and the address stays absent unless the
      // derivation actually succeeds.
      const zk = raw as { iss?: string; addressSeed?: string } | undefined;
      if (zk?.iss && zk.addressSeed) {
        member.zklogin = { iss: zk.iss, address_seed: String(zk.addressSeed) };
        const addr = zkLoginAddress(zk.addressSeed, zk.iss);
        if (addr) member.address = addr;
      }
    } else if (raw instanceof Uint8Array || Array.isArray(raw)) {
      const bytes = Uint8Array.from(raw as ArrayLike<number>);
      member.public_key = Buffer.from(bytes).toString("base64");
      const pk = publicKeyFor(sdkScheme, bytes);
      if (pk) member.address = normalize(pk.toSuiAddress());
    }

    members.push(member);
  }

  const committee: MultisigCommittee = {
    threshold: multisig_pk.threshold,
    members,
    total_weight: members.reduce((n, m) => n + m.weight, 0),
    signed_weight: members.filter((m) => m.signed_source_tx).reduce((n, m) => n + m.weight, 0),
    bitmap,
  };
  return { committee, address: deriveMultisigAddress(members, multisig_pk.threshold) };
}

/**
 * Decode every signature on a transaction into the identity it proves.
 *
 * Positional and total: the result has one entry per input, so a caller can
 * line signatures up with `[sender, sponsor]` ordering. A signature we cannot
 * decode comes back as `unknown` with no address rather than being dropped,
 * because a missing entry would silently shift that alignment.
 */
export function describeSignatures(signatures: string[]): SignatureIdentity[] {
  return signatures.map((serialized): SignatureIdentity => {
    const flag = flagOf(serialized);
    let parsed;
    try {
      parsed = parseSerializedSignature(serialized);
    } catch {
      // A flag-3 signature that will not decode is still a multisig. Saying
      // "unknown" here would let a legacy-encoded committee — same flag, same
      // address derivation, different wire format — read as an ordinary
      // wallet, which is a downgrade of a real finding rather than an absence
      // of one.
      return { scheme: flag === FLAG_MULTISIG ? "multisig" : "unknown" };
    }

    const scheme = SCHEME_NAMES[parsed.signatureScheme] ?? "unknown";

    if (parsed.signatureScheme === "MultiSig") {
      const read = readCommittee(parsed as never);
      if (!read) return { scheme: "multisig" };
      return {
        scheme: "multisig",
        ...(read.address ? { address: read.address } : {}),
        multisig: read.committee,
      };
    }

    if (parsed.signatureScheme === "ZkLogin") {
      const { iss, addressSeed } = parsed.zkLogin;
      const zklogin: ZkLoginIdentity = { iss, address_seed: String(addressSeed) };
      const address = zkLoginAddress(addressSeed, iss);
      return { scheme, ...(address ? { address } : {}), zklogin };
    }

    // Passkey and the three plain schemes all expose a public key directly.
    const pk = publicKeyFor(
      parsed.signatureScheme === "Passkey" ? "Secp256r1" : parsed.signatureScheme,
      parsed.publicKey,
    );
    return { scheme, ...(pk ? { address: normalize(pk.toSuiAddress()) } : {}) };
  });
}

/**
 * How one address authenticates, given the signatures of a transaction it
 * sent. Null when none of them belong to it.
 *
 * The signature is picked by **re-deriving each one and matching**, not by
 * position. A gas-sponsored transaction carries the sender's signature and the
 * sponsor's, and position happens to distinguish them today — but a match
 * against the address is a fact the caller can check, and a position is a
 * convention we would be trusting.
 */
export function readAuthentication(address: string, signatures: string[]): Authentication | null {
  const want = normalize(address);
  for (const sig of describeSignatures(signatures)) {
    if (!sig.address || normalize(sig.address) !== want) continue;
    return {
      scheme: sig.scheme,
      verified: true,
      ...(sig.multisig ? { multisig: sig.multisig } : {}),
      ...(sig.zklogin ? { zklogin: sig.zklogin } : {}),
    };
  }
  return null;
}

/**
 * What zkLogin does and does not reveal, stated once so a report cannot
 * overclaim it.
 *
 * The address is `blake2b(0x05 ‖ len(iss) ‖ iss ‖ addressSeed)` and the seed is
 * `poseidon(sub, aud, salt)` — the OAuth subject, the application's client id,
 * and a salt held off chain. So:
 *
 * - The **issuer is disclosed**. "This wallet authenticates through Google" is
 *   a real, chain-derived attribution fact.
 * - The **seed discloses nothing by itself**. It is one-to-one with the
 *   address, so it cannot link two zkLogin addresses to one person: a
 *   different application means a different `aud`, hence a different seed and
 *   a different address. It is an identifier for the address, not for the
 *   human.
 * - It *can* confirm a guess. Anyone who already holds a candidate
 *   `(sub, aud, salt)` can derive the address and check. That is confirmation
 *   of a hypothesis formed elsewhere, never enumeration from chain data.
 */
export function zkLoginNote(zk: ZkLoginIdentity): string {
  return `This wallet authenticates with zkLogin through ${zk.iss}. That names the identity provider; it does not reveal the account, and the address seed cannot be linked to this person's other wallets.`;
}

/**
 * A one-line reading for a reader scanning results, or undefined when there is
 * nothing worth saying.
 *
 * An ordinary single-key wallet is the default case and gets no note — the
 * same reason `identityNote` stays quiet for `kind: "wallet"`.
 */
export function authenticationNote(auth: Authentication): string | undefined {
  if (auth.scheme === "multisig" && auth.multisig) {
    const c = auth.multisig;
    const named = c.members.filter((m) => m.address).length;
    const uniform = c.members.every((m) => m.weight === 1);
    const shape = uniform
      ? `${c.threshold}-of-${c.members.length}`
      : `threshold ${c.threshold} of ${c.total_weight} total weight across ${c.members.length} members`;
    return (
      `This is a MULTISIG wallet (${shape}). Its ${c.members.length} committee members are ` +
      `chain-derived, not inferred${named < c.members.length ? `, though ${c.members.length - named} could not be resolved to an address` : ""}. ` +
      `Committee membership is fixed for the life of the address — it is part of the address hash — but a member key is not by itself evidence of a separate person.`
    );
  }
  if (auth.scheme === "zklogin" && auth.zklogin) return zkLoginNote(auth.zklogin);
  if (auth.scheme === "passkey") {
    return "This wallet authenticates with a passkey (WebAuthn), so its key lives in a device or platform keystore.";
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Reverse enumeration: from known keys to the multisig they may share
 * ------------------------------------------------------------------ */

/**
 * Candidate committees are capped here.
 *
 * The search is a permutation, not a combination, because member ORDER is
 * hashed — the same two keys in the other order are a different wallet. That
 * makes the space factorial and it stops being enumerable fast: 4 keys is 192
 * candidates, 5 is 1,560, 6 is over 13,000. The cap refuses rather than
 * silently truncating, because a truncated search that reports "no shared
 * multisig" is worse than one that declines to answer.
 */
export const MAX_COMMITTEE_CANDIDATES = 2000;

export interface CandidateCommittee {
  /** The address this committee would hash to. */
  address: string;
  /** Member addresses in committee order. */
  members: string[];
  threshold: number;
}

interface CandidateKey {
  address: string;
  publicKey: PublicKey;
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

/** Every subset of size >= 2, as index lists. */
function* subsets<T>(items: T[]): Generator<T[]> {
  const n = items.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const picked = items.filter((_, i) => mask & (1 << i));
    if (picked.length >= 2) yield picked;
  }
}

/**
 * Every multisig address a set of known keys could form, to be checked for
 * existence on chain.
 *
 * **Weight 1 only.** Weights are unbounded, so admitting them makes the space
 * infinite rather than merely large. A committee using non-uniform weights is
 * therefore invisible to this search, and the caller must say so — reporting
 * "no shared multisig found" without that caveat would state a negative the
 * search never tested. No non-uniform committee has been observed on mainnet,
 * but that is an absence of evidence, not a guarantee.
 *
 * Subsets of size 2 and up, every ordering of each, every threshold from 1 to
 * the subset size. Deduplicated, because different orderings of a symmetric
 * arrangement can collide.
 *
 * Throws once the candidate count would exceed
 * {@link MAX_COMMITTEE_CANDIDATES}. A partial search answering a negative
 * question is the one outcome worth refusing outright.
 */
export function enumerateCommittees(keys: CandidateKey[]): CandidateCommittee[] {
  const unique = [...new Map(keys.map((k) => [normalize(k.address), k])).values()];
  if (unique.length < 2) return [];

  let projected = 0;
  for (const subset of subsets(unique)) {
    let orderings = 1;
    for (let i = 2; i <= subset.length; i++) orderings *= i;
    projected += orderings * subset.length;
  }
  if (projected > MAX_COMMITTEE_CANDIDATES) {
    throw new Error(
      `${unique.length} keys would generate ${projected} candidate committees, over the ${MAX_COMMITTEE_CANDIDATES} cap. ` +
        "Member order is part of a multisig's address, so the search is factorial in committee size. " +
        "Narrow the key set — a partial search cannot support a negative answer.",
    );
  }

  const out = new Map<string, CandidateCommittee>();
  for (const subset of subsets(unique)) {
    for (const ordering of permutations(subset)) {
      for (let threshold = 1; threshold <= ordering.length; threshold++) {
        let address: string;
        try {
          address = normalize(
            MultiSigPublicKey.fromPublicKeys({
              threshold,
              publicKeys: ordering.map((k) => ({ publicKey: k.publicKey, weight: 1 })),
            }).toSuiAddress(),
          );
        } catch {
          continue;
        }
        if (!out.has(address)) {
          out.set(address, {
            address,
            members: ordering.map((k) => normalize(k.address)),
            threshold,
          });
        }
      }
    }
  }
  return [...out.values()];
}

/**
 * Recover the public key an address signs with, from one of its signatures.
 *
 * The precondition this imposes is worth stating at the call site: an address
 * that has never SENT a transaction has published no public key, so it cannot
 * take part in this search at all. Being funded is not enough.
 */
export function publicKeyFromSignatures(address: string, signatures: string[]): PublicKey | null {
  const want = normalize(address);
  for (const serialized of signatures) {
    try {
      const parsed = parseSerializedSignature(serialized);
      if (parsed.signatureScheme === "MultiSig" || parsed.signatureScheme === "ZkLogin") continue;
      const pk = publicKeyFor(
        parsed.signatureScheme === "Passkey" ? "Secp256r1" : parsed.signatureScheme,
        parsed.publicKey,
      );
      if (pk && normalize(pk.toSuiAddress()) === want) return pk;
    } catch {
      // Next signature.
    }
  }
  return null;
}
