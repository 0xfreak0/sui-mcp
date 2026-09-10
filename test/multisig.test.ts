import { describe, it, expect } from "vitest";
import {
  describeSignatures,
  readAuthentication,
  deriveMultisigAddress,
  authenticationNote,
  enumerateCommittees,
  publicKeyFromSignatures,
  type MultisigMember,
} from "../src/utils/multisig.js";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import fixtures from "./fixtures/signatures.json" with { type: "json" };

/**
 * Every fixture is a real mainnet signature, captured by
 * `scripts/probe/dump-fixtures.mjs`. They are pinned rather than synthesised
 * because the property under test is that our parse agrees with what the chain
 * actually holds — a hand-built committee would only test our own encoder.
 *
 * Re-run the probe after an SDK bump; if a fixture stops deriving to its own
 * address, the parse has drifted and the tool is silently lying.
 */

describe("readAuthentication — multisig committees", () => {
  it("reads a 2-of-3 and verifies it against its own address", () => {
    const f = fixtures.ms_2of3;
    const auth = readAuthentication(f.address, f.signatures);
    expect(auth).not.toBeNull();
    expect(auth!.scheme).toBe("multisig");
    // The derivation matching the address is the whole basis for the claim.
    expect(auth!.verified).toBe(true);
    expect(auth!.multisig!.threshold).toBe(2);
    expect(auth!.multisig!.members).toHaveLength(3);
    expect(auth!.multisig!.members.map((m) => m.weight)).toEqual([1, 1, 1]);
  });

  it("reads a 4-of-7 and names which members signed", () => {
    const f = fixtures.ms_4of7;
    const auth = readAuthentication(f.address, f.signatures);
    expect(auth!.verified).toBe(true);
    expect(auth!.multisig!.threshold).toBe(4);
    expect(auth!.multisig!.members).toHaveLength(7);
    // bitmap 0b0011011
    expect(auth!.multisig!.members.filter((m) => m.signed_source_tx).map((m) => m.index)).toEqual([0, 1, 3, 4]);
  });

  it("reads a 3-of-6", () => {
    const f = fixtures.ms_3of6;
    const auth = readAuthentication(f.address, f.signatures);
    expect(auth!.verified).toBe(true);
    expect(auth!.multisig!.threshold).toBe(3);
    expect(auth!.multisig!.members).toHaveLength(6);
    // bitmap 0b010110
    expect(auth!.multisig!.members.filter((m) => m.signed_source_tx).map((m) => m.index)).toEqual([1, 2, 4]);
  });

  it("derives member addresses that match their own single-sig wallets", () => {
    const f = fixtures.ms_1of2;
    const auth = readAuthentication(f.address, f.signatures);
    expect(auth!.multisig!.members.map((m) => m.address)).toEqual([
      "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777",
      "0xc848c5cc29fdff135650156194a27442b6c8cada58fab5ba9123d635754ae66f",
    ]);
    // Member 0 is the only key that has ever signed for this wallet; member 1
    // is a dormant backup. The bitmap is the only thing that says so.
    expect(auth!.multisig!.members.map((m) => m.signed_source_tx)).toEqual([true, false]);
  });

  it("counts signers against the threshold", () => {
    const auth = readAuthentication(fixtures.ms_4of7.address, fixtures.ms_4of7.signatures);
    expect(auth!.multisig!.signed_weight).toBe(4);
    expect(auth!.multisig!.total_weight).toBe(7);
  });
});

describe("readAuthentication — picking the right signature", () => {
  /**
   * A gas-sponsored transaction carries two signatures, and only one of them
   * belongs to the sender. Position alone would work today, but re-deriving
   * each one and matching is what makes the answer checkable.
   */
  it("ignores the sponsor's signature when reading the sender", () => {
    const f = fixtures.ms_1of2;
    expect(f.signatures).toHaveLength(2);
    const auth = readAuthentication(f.address, f.signatures);
    expect(auth!.scheme).toBe("multisig");
    expect(auth!.verified).toBe(true);
  });

  it("describes every signature in the transaction, sponsor included", () => {
    const all = describeSignatures(fixtures.ms_1of2.signatures);
    expect(all.map((s) => s.scheme)).toEqual(["multisig", "ed25519"]);
    expect(all[0].address).toBe(fixtures.ms_1of2.address);
    // The sponsor is a plain wallet, and its address falls out of the pubkey.
    expect(all[1].address).toMatch(/^0x[0-9a-f]{64}$/);
    expect(all[1].address).not.toBe(fixtures.ms_1of2.address);
  });

  it("returns null when no signature derives to the address asked about", () => {
    const other = "0x" + "9".repeat(64);
    expect(readAuthentication(other, fixtures.ms_2of3.signatures)).toBeNull();
  });
});

describe("readAuthentication — non-multisig schemes", () => {
  it("reads a plain ed25519 wallet", () => {
    const f = fixtures.ed25519;
    const auth = readAuthentication(f.address, f.signatures);
    expect(auth!.scheme).toBe("ed25519");
    expect(auth!.verified).toBe(true);
    expect(auth!.multisig).toBeUndefined();
  });

  it("reads a zkLogin wallet and names its issuer", () => {
    const f = fixtures.zklogin;
    const auth = readAuthentication(f.address, f.signatures);
    expect(auth!.scheme).toBe("zklogin");
    expect(auth!.verified).toBe(true);
    expect(auth!.zklogin!.iss).toBe("https://accounts.google.com");
    expect(auth!.zklogin!.address_seed).toMatch(/^\d+$/);
  });
});

describe("describeSignatures — malformed input", () => {
  /**
   * These run over addresses sourced from anywhere an investigation reaches.
   * One unparseable signature must not abort the read, for the same reason
   * `getLabel` returns null instead of throwing.
   */
  it("does not throw on garbage", () => {
    expect(() => describeSignatures(["not-base64-at-all", "", "AAAA"])).not.toThrow();
  });

  it("reports a signature with an unrecognised scheme as unknown", () => {
    // Not decodable as any scheme: the parser rejects it outright.
    const out = describeSignatures(["bm90LWJhc2U2NA=="]);
    expect(out).toHaveLength(1);
    expect(out[0].scheme).toBe("unknown");
    expect(out[0].address).toBeUndefined();
  });

  /**
   * The parser reads the scheme from the leading flag byte without checking
   * that the body is long enough, so a truncated signature still comes back
   * typed. The guarantee that matters is downstream: the key constructor
   * rejects the short pubkey, so no address is invented for it. An address we
   * emit is one that a real key produced.
   */
  it("never derives an address from a truncated signature", () => {
    const out = describeSignatures(["AAAA"]);
    expect(out).toHaveLength(1);
    expect(out[0].scheme).toBe("ed25519");
    expect(out[0].address).toBeUndefined();
  });

  it("matches no address when every signature is malformed", () => {
    expect(readAuthentication("0x" + "1".repeat(64), ["AAAA", "bm90LWJhc2U2NA=="])).toBeNull();
  });

  it("keeps a flag-3 signature it cannot decode labelled as multisig", () => {
    // Flag 0x03 with a truncated body: this is what a legacy-encoded multisig
    // would look like if the SDK's BCS reader rejects it. Calling it
    // "not multisig" would silently downgrade a real finding, so the scheme
    // survives even when the committee does not.
    const truncated = Buffer.from([0x03, 0x01, 0x00, 0x00]).toString("base64");
    const out = describeSignatures([truncated]);
    expect(out[0].scheme).toBe("multisig");
    expect(out[0].address).toBeUndefined();
  });

  it("returns an empty list for no signatures", () => {
    expect(describeSignatures([])).toEqual([]);
  });
});

describe("deriveMultisigAddress", () => {
  const members: MultisigMember[] = [
    {
      index: 0,
      scheme: "ed25519",
      weight: 1,
      public_key: "zKVjBVK4lCZOYOboq4+U3AudO2STrceo4HK5vHGxV4I=",
      address: "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777",
      signed_source_tx: false,
    },
    {
      index: 1,
      scheme: "ed25519",
      weight: 1,
      public_key: "+x5KLRu40AVqvOVyktmj0sRNYHeMYwxLMz8gG2RRaGo=",
      address: "0xc848c5cc29fdff135650156194a27442b6c8cada58fab5ba9123d635754ae66f",
      signed_source_tx: false,
    },
  ];

  it("reproduces a known committee's address", () => {
    expect(deriveMultisigAddress(members, 1)).toBe(fixtures.ms_1of2.address);
  });

  /**
   * Member order is hashed, so it is part of the identity — the same two keys
   * in the other order are a different wallet. This is what makes the reverse
   * search a permutation over members rather than a single derivation.
   */
  it("gives a different address when the members are reordered", () => {
    const swapped = [
      { ...members[1], index: 0 },
      { ...members[0], index: 1 },
    ];
    expect(deriveMultisigAddress(swapped, 1)).not.toBe(fixtures.ms_1of2.address);
  });

  it("gives a different address for a different threshold", () => {
    expect(deriveMultisigAddress(members, 2)).not.toBe(fixtures.ms_1of2.address);
  });

  it("returns null for a member whose scheme has no plain public key", () => {
    const zk: MultisigMember[] = [
      { index: 0, scheme: "zklogin", weight: 1, signed: false },
      members[1],
    ];
    expect(deriveMultisigAddress(zk, 1)).toBeNull();
  });
});

describe("authenticationNote", () => {
  it("says nothing for an ordinary single-key wallet", () => {
    const auth = readAuthentication(fixtures.ed25519.address, fixtures.ed25519.signatures);
    expect(authenticationNote(auth!)).toBeUndefined();
  });

  it("calls out a multisig with its shape", () => {
    const auth = readAuthentication(fixtures.ms_2of3.address, fixtures.ms_2of3.signatures);
    expect(authenticationNote(auth!)).toContain("2-of-3");
  });

  it("names the identity provider for a zkLogin wallet", () => {
    const auth = readAuthentication(fixtures.zklogin.address, fixtures.zklogin.signatures);
    expect(authenticationNote(auth!)).toContain("accounts.google.com");
  });
});

describe("enumerateCommittees", () => {
  const keyOf = (b64: string, address: string) => ({
    address,
    publicKey: new Ed25519PublicKey(Buffer.from(b64, "base64")),
  });
  const k0 = keyOf(
    "zKVjBVK4lCZOYOboq4+U3AudO2STrceo4HK5vHGxV4I=",
    "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777",
  );
  const k1 = keyOf(
    "+x5KLRu40AVqvOVyktmj0sRNYHeMYwxLMz8gG2RRaGo=",
    "0xc848c5cc29fdff135650156194a27442b6c8cada58fab5ba9123d635754ae66f",
  );

  it("generates the real multisig these two keys actually form", () => {
    const found = enumerateCommittees([k0, k1]).find((c) => c.address === fixtures.ms_1of2.address);
    expect(found).toBeDefined();
    expect(found!.threshold).toBe(1);
    expect(found!.members).toEqual([k0.address, k1.address]);
  });

  /** 2 keys: 2 orderings x 2 thresholds. Order is hashed, so both are searched. */
  it("covers every ordering and threshold", () => {
    expect(enumerateCommittees([k0, k1])).toHaveLength(4);
  });

  it("needs at least two keys", () => {
    expect(enumerateCommittees([k0])).toEqual([]);
    expect(enumerateCommittees([])).toEqual([]);
  });

  it("ignores a repeated key", () => {
    expect(enumerateCommittees([k0, k1, k0])).toHaveLength(4);
  });

  /**
   * Refusing beats truncating. This search is asked to support a NEGATIVE —
   * "these keys share no multisig" — and a partial search cannot.
   */
  it("refuses rather than truncating when the space is too large", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      keyOf(Buffer.alloc(32, i + 1).toString("base64"), `0x${(i + 1).toString().repeat(64)}`),
    );
    expect(() => enumerateCommittees(many)).toThrow(/cap/);
  });

  it("stays under the cap for four keys", () => {
    const four = Array.from({ length: 4 }, (_, i) =>
      keyOf(Buffer.alloc(32, i + 1).toString("base64"), `0x${String(i).repeat(64)}`),
    );
    // C(4,2)*2!*2 + C(4,3)*3!*3 + C(4,4)*4!*4 = 24 + 72 + 96
    expect(enumerateCommittees(four).length).toBe(192);
  });
});

describe("publicKeyFromSignatures", () => {
  it("recovers the key a plain wallet signs with", () => {
    const pk = publicKeyFromSignatures(fixtures.ed25519.address, fixtures.ed25519.signatures);
    expect(pk).not.toBeNull();
    expect(pk!.toSuiAddress()).toBe(fixtures.ed25519.address);
  });

  /**
   * A multisig has no single key of its own, and a zkLogin address has no
   * plain public key at all — neither can take part in the reverse search.
   */
  it("returns null for a multisig's own signature", () => {
    expect(publicKeyFromSignatures(fixtures.ms_1of2.address, fixtures.ms_1of2.signatures)).toBeNull();
  });

  it("returns null for a zkLogin wallet", () => {
    expect(publicKeyFromSignatures(fixtures.zklogin.address, fixtures.zklogin.signatures)).toBeNull();
  });

  it("ignores a signature belonging to someone else", () => {
    // The sponsor's signature rides along on the multisig's transaction.
    expect(publicKeyFromSignatures("0x" + "7".repeat(64), fixtures.ms_1of2.signatures)).toBeNull();
  });
});
