/** Can we check one address against EVERY configured coin, affordably? */
import { listConfiguredCoins, currentEpoch, addressKeyBcs } from "../../dist/utils/deny-list-probe.js";
import { runWithNetwork } from "../../dist/config.js";
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const ADDR="0x0da83d0a41509fdc91bea1ee7a46d422179571ac4daa5e570c190218d868338b";
await runWithNetwork("mainnet", async () => {
  let t=Date.now();
  const coins=await listConfiguredCoins();
  const epoch=await currentEpoch();
  console.log(`config map: ${coins.size} coins in ${Date.now()-t}ms`);
  const entries=[...coins.entries()];
  const bcs=addressKeyBcs(ADDR);
  t=Date.now(); let reqs=0; const denied=[];
  for (let i=0;i<entries.length;i+=20) {
    const chunk=entries.slice(i,i+20);
    const q="query {\n"+chunk.map(([,cfg],j)=>
      `  c${j}: object(address:${JSON.stringify(cfg)}){ dynamicField(name:{type:"0x2::deny_list::AddressKey", bcs:${JSON.stringify(bcs)}}){ value{ ... on MoveValue{ json } } } }`
    ).join("\n")+"\n}";
    const r=await ask(q,{}); reqs++;
    if (r.errors) { console.log("  chunk err:", JSON.stringify(r.errors[0].message).slice(0,90)); break; }
    chunk.forEach(([coin],j)=>{ if (r[`c${j}`]?.dynamicField || r.data?.[`c${j}`]?.dynamicField) denied.push(coin); });
  }
  console.log(`exhaustive scan: ${reqs} requests, ${Date.now()-t}ms, ${denied.length} coins deny this address`);
  denied.slice(0,4).forEach(c=>console.log("   ", c.slice(0,60)));
});
