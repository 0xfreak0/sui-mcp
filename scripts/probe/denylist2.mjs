const ask = async (q,v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const Q = `query($id:SuiAddress!,$c:String){ object(address:$id){ dynamicFields(first:20, after:$c){
  pageInfo{hasNextPage endCursor}
  nodes{ name{ type{repr} json } value{ __typename
    ... on MoveValue { type{repr} json }
    ... on MoveObject { address contents{ type{repr} json } } } } } } }`;

const walk = async (id, label) => {
  const r = await ask(Q, { id, c: null });
  if (r.errors) { console.log(label, "ERR", JSON.stringify(r.errors[0].message).slice(0,120)); return []; }
  const n = r.data?.object?.dynamicFields?.nodes ?? [];
  console.log(`\n${label} (${id.slice(0,12)}…): ${n.length} field(s)`);
  for (const f of n) {
    console.log("  name.type:", f.name?.type?.repr);
    console.log("  name.json:", JSON.stringify(f.name?.json));
    console.log("  value:", f.value?.__typename, f.value?.type?.repr ?? f.value?.contents?.type?.repr);
    console.log("  value.json:", JSON.stringify(f.value?.json ?? f.value?.contents?.json).slice(0,300));
    if (f.value?.address) console.log("  -> nested object:", f.value.address);
  }
  return n;
};
await walk("0xb2345f5fc26fe5044dd03537aaf970a6b9d36f8d84e26a81a4134bd8234aa431", "DenyList.lists bag");
