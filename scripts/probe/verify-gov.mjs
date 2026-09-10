import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { MultiSigPublicKey } from "@mysten/sui/multisig";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1PublicKey } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1PublicKey } from "@mysten/sui/keypairs/secp256r1";
const PK = { ED25519: Ed25519PublicKey, Secp256k1: Secp256k1PublicKey, Secp256r1: Secp256r1PublicKey };
const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());

for (const a of ["0x045dadba87e5ad53f12075a1f0fa94bd94550a3bcf2abbe316e2d3b16ceb9440",
                 "0xa1eb94d1700652aa85b417b46fa6775575b8b98d3352d864fb5146eb45d335fb",
                 "0x088e69d25fdcd212e70085e7560585789c8eea8d4df5a17817827c4e44847b07"]) {
  const r = await ask(`query($a:SuiAddress!){ transactions(filter:{sentAddress:$a}, first:1){ nodes{ digest signatures{signatureBytes} } } }`, { a });
  const n = r.data.transactions.nodes[0];
  const s = n.signatures.find(x => Buffer.from(x.signatureBytes, "base64")[0] === 3);
  const p = parseSerializedSignature(s.signatureBytes);
  const members = p.multisig.multisig_pk.pk_map.map(m => { const [sc] = Object.keys(m.pubKey); return { sc, pk: new PK[sc](Uint8Array.from(m.pubKey[sc])), w: m.weight }; });
  const msp = MultiSigPublicKey.fromPublicKeys({ threshold: p.multisig.multisig_pk.threshold, publicKeys: members.map(m => ({ publicKey: m.pk, weight: m.w })) });
  const bm = p.multisig.bitmap;
  console.log(`${a}\n  ${p.multisig.multisig_pk.threshold}-of-${members.length}  derives-to-self: ${msp.toSuiAddress() === a}  bitmap=${bm.toString(2).padStart(members.length,"0")} popcount=${members.filter((_,i)=>bm&(1<<i)).length}`);
  for (const [i, m] of members.entries()) {
    const addr = m.pk.toSuiAddress();
    const act = await ask(`query($a:SuiAddress!){ transactions(filter:{sentAddress:$a}, first:1){ nodes{ digest } } }`, { a: addr });
    const sent = act.data?.transactions?.nodes?.length ? "has own txs" : "never sent";
    console.log(`    [${i}] ${addr} w=${m.w} ${(bm >> i) & 1 ? "SIGNED" : "-     "} ${sent}`);
  }
}
