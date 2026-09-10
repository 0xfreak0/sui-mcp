const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
// A coin config found earlier off 0x403.
for (const id of ["0xf314b4f85cfb7282dcb1aa08ccf4328056c37bfbf3cbb8adce27b6ce8b38339d"]) {
  const r = await ask(`query($id:SuiAddress!){ object(address:$id){ dynamicFields(first:20){ nodes{
    name{ type{repr} json } value{ __typename ... on MoveValue{ type{repr} json } ... on MoveObject{ address contents{type{repr} json} } } } } } }`, {id});
  const nodes = r.data?.object?.dynamicFields?.nodes ?? [];
  console.log("config entries:", nodes.length, r.errors?JSON.stringify(r.errors[0].message).slice(0,120):"");
  for (const n of nodes) {
    console.log("\n  name.type:", n.name?.type?.repr?.slice(0,120));
    console.log("  name.json:", JSON.stringify(n.name?.json).slice(0,220));
    console.log("  val.type :", (n.value?.type?.repr ?? n.value?.contents?.type?.repr ?? "").slice(0,120));
    console.log("  val.json :", JSON.stringify(n.value?.json ?? n.value?.contents?.json).slice(0,300));
  }
}
