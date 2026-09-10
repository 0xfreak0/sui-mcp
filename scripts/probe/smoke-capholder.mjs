import { registerAnalyzePackageTools } from "../../dist/tools/analyze-package.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; registerAnalyzePackageTools({tool:(n,_d,_s,h)=>{tools[n]=h;}});
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
await runWithNetwork("mainnet", async () => {
  // One known burned (holder 0x2) and a couple of ordinary ones.
  const caps=(await ask(`{ objects(filter:{type:"0x2::package::UpgradeCap"}, first:14){ nodes{
    asMoveObject{contents{json}} owner{ __typename ... on AddressOwner{ address{address} } } } } }`)).data.objects.nodes;
  // Include the burned one specifically, not just the first few.
  const burned = caps.filter(c=>{const h=c.owner?.address?.address; return h && /^0x0*[0-9a-f]{0,2}$/.test(h);})
                     .map(c=>c.asMoveObject?.contents?.json?.package).filter(Boolean);
  const pkgs=[...new Set([...burned, ...caps.map(c=>c.asMoveObject?.contents?.json?.package).filter(Boolean)])].slice(0,4);
  for (const p of pkgs) {
    const j=JSON.parse((await tools["analyze_package"]({package_id:p})).content[0].text);
    const up=(j.capabilities?.capabilities??[]).find(c=>c.kind==="upgrade");
    console.log(`${p.slice(0,16)}…  publisher=${(j.publisher?.publisher??"-").slice(0,12)}…  holder_status=${up?.holder_status ?? "-"}  owner=${(up?.owner_address??"-").slice(0,12)}…`);
    if (up?.holder_status && up.holder_status!=="publisher")
      console.log(`     note: ${up.note.slice(-150)}`);
  }
});
