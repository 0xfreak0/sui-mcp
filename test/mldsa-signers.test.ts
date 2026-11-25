import { describe, it, expect } from "vitest";
import { MLDSA65Keypair } from "@mysten/sui/keypairs/mldsa65";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MultiSigPublicKey } from "@mysten/sui/multisig";
import {
  authenticationNote,
  deriveMultisigAddress,
  describeSignatures,
  publicKeyFromSignatures,
  readAuthentication,
} from "../src/utils/multisig.js";

/**
 * ML-DSA-65 signatures (flag 7) are built with the SDK's own keypair, since
 * mainnet has not enabled `mldsa65_auth`. The checks are the ones a real
 * signature meets: the scheme is named and the address re-derives from the
 * key the signature carries.
 */
const BYTES = new TextEncoder().encode("intent message bytes");

describe("ML-DSA-65 signers", () => {
  const key = MLDSA65Keypair.generate();

  it("names the scheme and re-derives the signer's address", async () => {
    const { signature } = await key.signTransaction(BYTES);
    const [sig] = describeSignatures([signature]);
    expect(sig).toMatchObject({ scheme: "mldsa65", address: key.toSuiAddress() });
    const auth = readAuthentication(key.toSuiAddress(), [signature]);
    expect(auth?.scheme).toBe("mldsa65");
    expect(authenticationNote(auth!)).toMatch(/post-quantum/);
    expect(publicKeyFromSignatures(key.toSuiAddress(), [signature])?.toSuiAddress()).toBe(key.toSuiAddress());
  });

  it("reads an ML-DSA-65 committee member and derives the committee's address", async () => {
    const other = Ed25519Keypair.generate();
    const msPk = MultiSigPublicKey.fromPublicKeys({
      threshold: 1,
      publicKeys: [
        { publicKey: key.getPublicKey(), weight: 1 },
        { publicKey: other.getPublicKey(), weight: 1 },
      ],
    });
    const { signature } = await key.signTransaction(BYTES);
    const combined = msPk.combinePartialSignatures([signature]);
    const [sig] = describeSignatures([combined]);
    expect(sig.scheme).toBe("multisig");
    expect(sig.address).toBe(msPk.toSuiAddress());
    const members = sig.multisig!.members;
    expect(members.map((m) => m.scheme)).toEqual(["mldsa65", "ed25519"]);
    expect(members[0]).toMatchObject({ address: key.toSuiAddress(), signed_source_tx: true });
    expect(deriveMultisigAddress(members, 1)).toBe(msPk.toSuiAddress());
  });
});

describe("unsignable keys of any length", () => {
  it("states the chance for the key's own length and names no curve problem as the only reason", async () => {
    const { unsignableKeyReason } = await import("../src/utils/multisig.js");
    const bytes = MLDSA65Keypair.generate().getPublicKey().toRawBytes().slice();
    bytes.fill(0, 100, 120);
    const reason = unsignableKeyReason(bytes)!;
    expect(reason).toMatch(/generated 1952-byte key has with probability below 3e-14/);
    expect(reason).toMatch(/no signature scheme lets one be computed/);
    expect(unsignableKeyReason(MLDSA65Keypair.generate().getPublicKey().toRawBytes())).toBeNull();
  });
});
