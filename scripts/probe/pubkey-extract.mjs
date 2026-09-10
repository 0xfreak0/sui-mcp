import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());
for (const a of process.argv.slice(2)) {
  const r = await ask(`query($a:SuiAddress!){ transactions(filter:{sentAddress:$a}, first:1){ nodes{ digest signatures{signatureBytes} } } }`, { a });
  const n = r.data.transactions.nodes[0];
  const p = parseSerializedSignature(n.signatures[0].signatureBytes);
  const pk = new Ed25519PublicKey(p.publicKey);
  console.log(a);
  console.log("  scheme", p.signatureScheme, "pubkey(b64)", pk.toBase64(), "-> addr", pk.toSuiAddress(), "MATCH:", pk.toSuiAddress() === a);
}
