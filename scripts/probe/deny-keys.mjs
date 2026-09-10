const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
// Scan several coin configs for the distinct key types used (AddressKey vs global pause).
const r = await ask(`query{ object(address:"0x0000000000000000000000000000000000000000000000000000000000000403"){
  dynamicFields(first:30){ nodes{ name{json} value{ ... on MoveObject { address } } } } } }`,{});
const cfgs = (r.data?.object?.dynamicFields?.nodes ?? []).map(n=>n.value?.address).filter(Boolean);
const kinds = new Map();
for (const c of cfgs.slice(0,12)) {
  const d = await ask(`query($id:SuiAddress!){ object(address:$id){ dynamicFields(first:30){ nodes{ name{type{repr} json} value{ ... on MoveValue{json} } } } } }`,{id:c});
  for (const n of d.data?.object?.dynamicFields?.nodes ?? []) {
    const t = (n.name?.type?.repr ?? "").split("::").pop();
    kinds.set(t, (kinds.get(t) ?? 0) + 1);
    if (t && t !== "AddressKey" && kinds.get(t) === 1)
      console.log("non-address key:", t, "name.json:", JSON.stringify(n.name?.json), "value:", JSON.stringify(n.value?.json).slice(0,140));
  }
}
console.log("\nkey types across 12 configs:", [...kinds.entries()]);
