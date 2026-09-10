import { cachedConfiguredCoins, currentEpoch, addressKeyBcs } from "../../dist/utils/deny-list-probe.js";
import { runWithNetwork } from "../../dist/config.js";
const ask=async(q)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q})})).json());
await runWithNetwork("mainnet", async () => {
  const coins=await cachedConfiguredCoins();
  console.log("config map size:", coins.size);
  const entries=[...coins.entries()].slice(0,20);
  const bcs=addressKeyBcs("0x0da83d0a41509fdc91bea1ee7a46d422179571ac4daa5e570c190218d868338b");
  const query="query {\n"+entries.map((_,j)=>
    `  c${j}: object(address: $cfg${j}) { dynamicField(name: { type: "0x2::deny_list::AddressKey", bcs: $bcs }) { value { ... on MoveValue { json } } } }`
  ).join("\n")+"\n}";
  const inlined=entries.reduce((q,[,cfg],j)=>q.replace(`$cfg${j}`,JSON.stringify(cfg)),query).replaceAll("$bcs",JSON.stringify(bcs));
  console.log("\nunreplaced placeholders left:", (inlined.match(/\$cfg\d+/g)||[]).length);
  const r=await ask(inlined);
  console.log("errors:", r.errors? JSON.stringify(r.errors[0].message).slice(0,200):"none");
  console.log("aliases returned:", Object.keys(r.data??{}).length);
});
