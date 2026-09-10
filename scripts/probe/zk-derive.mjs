import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { computeZkLoginAddressFromSeed } from "@mysten/sui/zklogin";
const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());
for (const a of ["0xdeee14aade14eb6cf9c1cbca831216774d3e098db67c2e1550a561796d9f46f5",
                 "0x8f68a88a4e351b9ff7546112a2b847664fa59f2861db0eaef6babcf243676816"]) {
  const r = await ask(`query($a:SuiAddress!){ transactions(filter:{sentAddress:$a}, first:1){ nodes{ signatures{signatureBytes} } } }`, { a });
  const s = r.data.transactions.nodes[0].signatures.find(x => Buffer.from(x.signatureBytes,"base64")[0] === 5);
  const p = parseSerializedSignature(s.signatureBytes);
  const derived = computeZkLoginAddressFromSeed(p.zkLogin.addressSeed, p.zkLogin.iss, false);
  console.log(a, "\n  derived:", derived, "MATCH:", derived === a);
}
