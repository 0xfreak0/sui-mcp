import { registerObjectHistoryTools } from "../../dist/tools/object-history.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; registerObjectHistoryTools({tool:(n,_d,_s,h)=>{tools[n]=h;}});
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
await runWithNetwork("mainnet", async () => {
  const caps=(await ask(`{ objects(filter:{type:"0x2::package::UpgradeCap"}, first:6){ nodes{ address version } } }`))
    .data?.objects?.nodes ?? [];
  for (const c of caps.slice(0,4)) {
    const j=JSON.parse((await tools["trace_object_history"]({object_id:c.address})).content[0].text);
    console.log(`${c.address.slice(0,16)}…  versions=${j.versions?.length ?? 0} transitions=${j.ownership_transitions?.length ?? 0} ${j.note? "| "+j.note.slice(0,50):""}`);
    for (const t of (j.ownership_transitions??[]).slice(0,2))
      console.log(`    ${JSON.stringify(t).slice(0,140)}`);
  }
});
