/** Does the signer set vary per transaction? The committee cannot, but the bitmap can. */
import { parseSerializedSignature } from "@mysten/sui/cryptography";
const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());
const addr = process.argv[2];
let after = null, page = 0;
const sets = new Map(); let n = 0;
while (page++ < 4) {
  const r = await ask(`query($a:SuiAddress!,$c:String){ transactions(filter:{sentAddress:$a}, first:50, after:$c){ pageInfo{hasNextPage endCursor} nodes{ digest effects{timestamp} signatures{signatureBytes} } } }`, { a: addr, c: after });
  const conn = r.data?.transactions; if (!conn) break;
  for (const tx of conn.nodes) {
    const s = tx.signatures.find(x => Buffer.from(x.signatureBytes,"base64")[0] === 3);
    if (!s) continue;
    const p = parseSerializedSignature(s.signatureBytes);
    const size = p.multisig.multisig_pk.pk_map.length;
    const key = [...Array(size).keys()].filter(i => (p.multisig.bitmap >> i) & 1).join(",");
    if (!sets.has(key)) sets.set(key, { count: 0, first: tx.effects?.timestamp, last: tx.effects?.timestamp });
    const e = sets.get(key); e.count++; e.last = tx.effects?.timestamp ?? e.last;
    n++;
  }
  if (!conn.pageInfo.hasNextPage) break;
  after = conn.pageInfo.endCursor;
}
console.log(`${addr.slice(0,14)}…  ${n} multisig txs, ${sets.size} distinct signer sets`);
for (const [k, v] of [...sets.entries()].sort((a,b)=>b[1].count-a[1].count))
  console.log(`   members [${k}]  x${v.count}   ${String(v.first).slice(0,10)} → ${String(v.last).slice(0,10)}`);
