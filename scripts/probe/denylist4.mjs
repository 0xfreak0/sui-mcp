const ask = async (q,v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const r = await ask(`query{ object(address:"0x0000000000000000000000000000000000000000000000000000000000000403"){
  dynamicFields(first:5){ nodes{ name{type{repr} json} value{ __typename
    ... on MoveObject { address contents{ type{repr} json } } } } } } }`, {});
const nodes = r.data?.object?.dynamicFields?.nodes ?? [];
console.log("entries:", nodes.length, r.errors ? JSON.stringify(r.errors[0].message).slice(0,150) : "");
for (const n of nodes.slice(0,3)) {
  console.log("\nname.json  :", JSON.stringify(n.name?.json));
  console.log("value type :", n.value?.contents?.type?.repr?.slice(0,90));
  console.log("value addr :", n.value?.address);
  console.log("value json :", JSON.stringify(n.value?.contents?.json).slice(0,240));
}
