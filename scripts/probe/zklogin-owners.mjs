import { parseSerializedSignature } from "@mysten/sui/cryptography";
const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());
let after=null, pages=0; const owners=new Set();
while (pages++ < 12) {
  const r = await ask(`query($c:String){ objects(filter:{type:"0x2::package::UpgradeCap"}, first:50, after:$c){ pageInfo{hasNextPage endCursor} nodes{ owner{ __typename ... on AddressOwner { address { address } } } } } }`, { c: after });
  const conn=r.data?.objects; if(!conn) break;
  for (const n of conn.nodes) if (n.owner?.address?.address) owners.add(n.owner.address.address);
  if(!conn.pageInfo.hasNextPage) break; after=conn.pageInfo.endCursor;
}
let found=0;
for (const a of owners) {
  if (found >= 4) break;
  try {
    const r = await ask(`query($a:SuiAddress!){ transactions(filter:{sentAddress:$a}, first:1){ nodes{ signatures{signatureBytes} } } }`, { a });
    const n=r.data?.transactions?.nodes?.[0]; if(!n) continue;
    const s=n.signatures.find(x=>Buffer.from(x.signatureBytes,"base64")[0]===5); if(!s) continue;
    const p=parseSerializedSignature(s.signatureBytes);
    console.log(a, "iss:", p.zkLogin.iss, "addressSeed:", String(p.zkLogin.addressSeed).slice(0,20)+"...", "maxEpoch:", p.zkLogin.maxEpoch);
    found++;
  } catch(e){}
}
