import { SuiGrpcClient } from "@mysten/sui/grpc";
const sui = new SuiGrpcClient({ network:"mainnet", baseUrl:"https://fullnode.mainnet.sui.io" });
const ask = async (q,v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());

let after=null, page=0, total=0; const coins=[];
while (page++ < 6) {
  const r = await ask(`query($c:String){ object(address:"0x0000000000000000000000000000000000000000000000000000000000000403"){
    dynamicFields(first:50, after:$c){ pageInfo{hasNextPage endCursor}
      nodes{ name{json} value{ ... on MoveObject { address } } } } } }`, { c: after });
  const d=r.data?.object?.dynamicFields; if(!d) break;
  for (const n of d.nodes) {
    total++;
    const key = n.name?.json?.per_type_key;
    if (key) coins.push({ coin: Buffer.from(key,"base64").toString("utf8"), config: n.value?.address });
  }
  if (!d.pageInfo.hasNextPage) break;
  after = d.pageInfo.endCursor;
}
console.log("coin types with a deny config:", total, "(scanned", page, "pages)");
console.log("\nsample:");
for (const c of coins.slice(0,6)) console.log("  0x" + c.coin);

// Drill into one config for the denied addresses.
const target = coins[0];
const df = await sui.listDynamicFields({ parentId: target.config, limit: 20, cursor: null });
console.log(`\nconfig for 0x${target.coin.slice(0,40)}… -> ${df.dynamicFields.length} entries`);
for (const f of df.dynamicFields.slice(0,3)) console.log("   ", f.type?.slice(0,150));
