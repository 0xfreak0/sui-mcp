import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
for (const s of ["AAAA", "", "AA", "bm90LWJhc2U2NA=="]) {
  try {
    const p = parseSerializedSignature(s);
    let addr = "n/a";
    try { addr = new Ed25519PublicKey(p.publicKey).toSuiAddress(); } catch (e) { addr = "pk-reject: " + e.message.slice(0,50); }
    console.log(JSON.stringify(s), "->", p.signatureScheme, "pkLen", p.publicKey?.length, "sigLen", p.signature?.length, "addr", addr);
  } catch (e) { console.log(JSON.stringify(s), "-> THREW:", e.message.slice(0, 70)); }
}
