/** Do impostors of well-known symbols carry different decimals? */
import { KNOWN_DECIMALS, symbolOf } from "../../dist/utils/valuation.js";
import { isVerifiedCoin } from "../../dist/utils/coin-registry.js";
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const Q=`query($after:String){ objects(filter:{type:"0x2::coin::CoinMetadata"}, first:50, after:$after){
  pageInfo{hasNextPage endCursor} nodes{ asMoveObject{ contents{ type{repr} json } } } } }`;
let after=null, pages=0, checked=0, mismatched=0; const examples=[];
while (pages++ < Number(process.env.PAGES ?? 120)) {
  const r=await ask(Q,{after}); const c=r.data?.objects; if(!c) break;
  for (const n of c.nodes) {
    const j=n.asMoveObject?.contents?.json; if(!j) continue;
    const repr=n.asMoveObject?.contents?.type?.repr ?? "";
    const inner=repr.match(/CoinMetadata<(.+)>/)?.[1]; if(!inner) continue;
    const sym=symbolOf(inner).toUpperCase();
    const assumed=KNOWN_DECIMALS[sym];
    if (assumed===undefined) continue;          // not a symbol we hardcode
    if (isVerifiedCoin(inner)) continue;         // the real one
    checked++;
    const actual=Number(j.decimals);
    if (Number.isFinite(actual) && actual!==assumed) {
      mismatched++;
      if (examples.length<6) examples.push({inner,sym,assumed,actual,name:String(j.name??"").slice(0,30)});
    }
  }
  if(!c.pageInfo.hasNextPage) break; after=c.pageInfo.endCursor;
}
console.log(`unverified coins whose STRUCT name matches a hardcoded symbol: ${checked}`);
console.log(`of those, decimals differ from what we would assume: ${mismatched} (${checked?(100*mismatched/checked).toFixed(1):0}%)`);
for (const e of examples)
  console.log(`  ${e.sym.padEnd(6)} assumed=${e.assumed} actual=${e.actual}  off by 10^${Math.abs(e.assumed-e.actual)}  "${e.name}"  ${e.inner.slice(0,44)}`);
