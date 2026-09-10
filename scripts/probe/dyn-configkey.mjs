const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const DENY="0x0000000000000000000000000000000000000000000000000000000000000403";
const COIN="0x20042e47b0169e3c411b053033a48144ba30fde68394c2ddc28b5522c2c42fc8::bluebirdy::BLUEBIRDY";
function uleb(n){const o=[];do{let b=n&0x7f;n>>>=7;if(n)b|=0x80;o.push(b);}while(n);return Buffer.from(o);}
// ConfigKey { per_type_index: u64, per_type_key: vector<u8> }
function configKeyBcs(coinType){
  const s = coinType.replace(/^0x/,"");
  const idx = Buffer.alloc(8); // per_type_index = 0 (COIN_INDEX), little-endian
  const bytes = Buffer.from(s,"utf8");
  return Buffer.concat([idx, uleb(bytes.length), bytes]).toString("base64");
}
for (const [fn,label] of [["dynamicObjectField","object field"],["dynamicField","plain field"]]) {
  const r = await ask(`query($id:SuiAddress!,$b:Base64!){ object(address:$id){
    ${fn}(name:{ type:"0x2::deny_list::ConfigKey", bcs:$b }){ name{json} value{ __typename ... on MoveObject{ address } } } } }`,
    { id: DENY, b: configKeyBcs(COIN) });
  const f = r.data?.object?.[fn];
  console.log(`${label.padEnd(13)} -> ${f? "FOUND config " + f.value?.address : "null"}`, r.errors?JSON.stringify(r.errors[0].message).slice(0,90):"");
}
console.log("\nexpected config: 0xf314b4f85cfb7282dcb1aa08ccf4328056c37bfbf3cbb8adce27b6ce8b38339d");
