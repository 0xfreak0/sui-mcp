import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { MultiSigPublicKey } from "@mysten/sui/multisig";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1PublicKey } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1PublicKey } from "@mysten/sui/keypairs/secp256r1";
const PK = { ED25519: Ed25519PublicKey, Secp256k1: Secp256k1PublicKey, Secp256r1: Secp256r1PublicKey };
const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());

const addr = process.argv[2] ?? "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7";
let after = null, page = 0, seen = 0;
const committees = new Map(); const bitmaps = new Map();
while (page++ < 4) {
  const r = await ask(`query($a:SuiAddress!,$c:String){ transactions(filter:{sentAddress:$a}, first:50, after:$c){ pageInfo{hasNextPage endCursor} nodes{ digest signatures{ signatureBytes } } } }`, { a: addr, c: after });
  const conn = r.data?.transactions; if (!conn) { console.error(JSON.stringify(r.errors)); break; }
  for (const tx of conn.nodes) {
    for (const s of tx.signatures) {
      const p = parseSerializedSignature(s.signatureBytes);
      if (p.signatureScheme !== "MultiSig") continue;
      const members = p.multisig.multisig_pk.pk_map.map(m => { const [sc] = Object.keys(m.pubKey); return { sc, pk: new PK[sc](Uint8Array.from(m.pubKey[sc])), w: m.weight }; });
      const msp = MultiSigPublicKey.fromPublicKeys({ threshold: p.multisig.multisig_pk.threshold, publicKeys: members.map(m => ({ publicKey: m.pk, weight: m.w })) });
      if (msp.toSuiAddress() !== addr) continue;
      seen++;
      const key = members.map(m => `${m.pk.toSuiAddress()}:${m.w}`).join(",") + `|t=${p.multisig.multisig_pk.threshold}`;
      committees.set(key, (committees.get(key) ?? 0) + 1);
      bitmaps.set(p.multisig.bitmap, (bitmaps.get(p.multisig.bitmap) ?? 0) + 1);
    }
  }
  if (!conn.pageInfo.hasNextPage) break;
  after = conn.pageInfo.endCursor;
}
console.log("multisig txs examined:", seen);
console.log("distinct committees:", committees.size);
for (const [k, n] of committees) console.log("  ", n, k);
console.log("bitmap distribution (which members signed):", [...bitmaps.entries()].sort((a,b)=>b[1]-a[1]));
