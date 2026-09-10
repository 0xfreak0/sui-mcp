/** If the cap holder is not the publisher, the cap moved — no history needed. */
import { resolvePublisher } from "../../dist/utils/publisher.js";
import { runWithNetwork } from "../../dist/config.js";
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
await runWithNetwork("mainnet", async () => {
  const caps=(await ask(`{ objects(filter:{type:"0x2::package::UpgradeCap"}, first:14){ nodes{
    address asMoveObject{ contents{ json } }
    owner{ __typename ... on AddressOwner{ address{address} } } } } }`)).data?.objects?.nodes ?? [];
  let moved=0, same=0, unknown=0;
  for (const c of caps) {
    const pkg = c.asMoveObject?.contents?.json?.package;
    const holder = c.owner?.address?.address ?? c.owner?.__typename;
    if (!pkg) continue;
    const p = await resolvePublisher(pkg);
    const pub = p.publisher;
    const verdict = !pub ? "unknown" : (String(holder).toLowerCase()===pub.toLowerCase() ? "same" : "MOVED");
    if(verdict==="MOVED") moved++; else if(verdict==="same") same++; else unknown++;
    if (verdict!=="unknown")
      console.log(`  ${verdict.padEnd(7)} pkg=${pkg.slice(0,12)}… publisher=${String(pub).slice(0,12)}… holder=${String(holder).slice(0,12)}…`);
  }
  console.log(`\nof ${caps.length}: ${moved} moved, ${same} still with publisher, ${unknown} publisher unresolved`);
});
