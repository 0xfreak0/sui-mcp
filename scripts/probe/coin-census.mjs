/** How many coins on Sui, and how bad is symbol collision? */
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const Q=`query($after:String){ objects(filter:{type:"0x2::coin::CoinMetadata"}, first:50, after:$after){
  pageInfo{hasNextPage endCursor}
  nodes{ asMoveObject{ contents{ type{repr} json } } } } }`;
let after=null, pages=0, total=0;
const bySymbol=new Map();
const t0=Date.now();
const MAX = Number(process.env.PAGES ?? 300);
while (pages < MAX) {
  const r = await ask(Q,{after});
  const c = r.data?.objects;
  if(!c){ console.log("err:", JSON.stringify(r.errors?.[0]?.message).slice(0,120)); break; }
  pages++;
  for (const n of c.nodes) {
    const j = n.asMoveObject?.contents?.json; if(!j) continue;
    total++;
    const s=String(j.symbol??"").toUpperCase();
    const repr = n.asMoveObject?.contents?.type?.repr ?? "";
    const inner = repr.match(/CoinMetadata<(.+)>/)?.[1] ?? repr;
    if(!bySymbol.has(s)) bySymbol.set(s,[]);
    bySymbol.get(s).push({ type: inner, name: j.name });
  }
  if(!c.pageInfo.hasNextPage) { console.log("(reached end of coin metadata)"); break; }
  after=c.pageInfo.endCursor;
}
const dupes=[...bySymbol.entries()].filter(([,v])=>v.length>1).sort((a,b)=>b[1].length-a[1].length);
console.log(`coins: ${total} over ${pages} pages in ${((Date.now()-t0)/1000).toFixed(1)}s`);
console.log(`distinct symbols: ${bySymbol.size} | colliding symbols: ${dupes.length} (${(100*dupes.length/bySymbol.size).toFixed(1)}%)`);
console.log(`coins sharing a symbol with another: ${dupes.reduce((n,[,v])=>n+v.length,0)}`);
console.log("\nworst collisions:");
for (const [s,v] of dupes.slice(0,10)) console.log(`  ${s.padEnd(14)} x${v.length}`);
for (const s of ["USDC","USDT","SUI","DEEP","CETUS"]) {
  const v=bySymbol.get(s); if(!v) continue;
  console.log(`\n${s}: ${v.length}`);
  v.slice(0,5).forEach(t=>console.log(`   ${t.type.slice(0,60)}  "${String(t.name).slice(0,34)}"`));
}
