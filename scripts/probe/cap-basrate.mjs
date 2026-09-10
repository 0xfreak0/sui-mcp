import { resolvePublisher } from "../../dist/utils/publisher.js";
import { runWithNetwork } from "../../dist/config.js";
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
await runWithNetwork("mainnet", async () => {
  let after=null, checked=0, moved=0, unresolved=0, same=0, pages=0;
  const dests=new Map();
  while (pages++ < 3) {
    const r=await ask(`query($c:String){ objects(filter:{type:"0x2::package::UpgradeCap"}, first:50, after:$c){
      pageInfo{hasNextPage endCursor}
      nodes{ address asMoveObject{contents{json}} owner{ __typename ... on AddressOwner{ address{address} } } } } }`,{c:after});
    const conn=r.data?.objects; if(!conn) break;
    for (const c of conn.nodes) {
      const j=c.asMoveObject?.contents?.json; if(!j?.package) continue;
      const holder=c.owner?.address?.address ?? c.owner?.__typename;
      const p=await resolvePublisher(j.package);
      checked++;
      if(!p.publisher){unresolved++;continue;}
      if(String(holder).toLowerCase()===p.publisher.toLowerCase()) same++;
      else { moved++; dests.set(holder,(dests.get(holder)??0)+1); }
    }
    if(!conn.pageInfo.hasNextPage) break; after=conn.pageInfo.endCursor;
  }
  console.log(`checked ${checked} UpgradeCaps`);
  console.log(`  still with publisher : ${same}`);
  console.log(`  moved                : ${moved}  (${(100*moved/(same+moved)).toFixed(1)}%)`);
  console.log(`  publisher unresolved : ${unresolved}`);
  console.log("\nwhere the moved ones went:");
  for (const [d,n] of [...dests.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8)) console.log(`   x${n}  ${d}`);
});
