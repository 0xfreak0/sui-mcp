const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const CONFIG="0xf314b4f85cfb7282dcb1aa08ccf4328056c37bfbf3cbb8adce27b6ce8b38339d";
const DENIED="0x0da83d0a41509fdc91bea1ee7a46d422179571ac4daa5e570c190218d868338b";
const NOTDENIED="0x"+"9".repeat(64);
// AddressKey is a newtype over address: BCS is the raw 32 bytes.
const bcsOf = a => Buffer.from(a.replace(/^0x/,""),"hex").toString("base64");
for (const [label,a] of [["denied",DENIED],["not denied",NOTDENIED]]) {
  const r = await ask(`query($id:SuiAddress!,$b:Base64!){ object(address:$id){
    dynamicField(name:{ type:"0x2::deny_list::AddressKey", bcs:$b }){ name{json} value{ ... on MoveValue{ json } } } } }`,
    { id: CONFIG, b: bcsOf(a) });
  const f = r.data?.object?.dynamicField;
  console.log(`${label.padEnd(11)} -> ${f ? "FOUND " + JSON.stringify(f.value?.json) : "null"}`, r.errors?JSON.stringify(r.errors[0].message).slice(0,100):"");
}
