const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
console.log("Object fields with 'dynamic':", JSON.stringify(
  (await ask(`{ __type(name:"Object"){ fields{ name args{ name type{ kind name ofType{name} } } } } }`)).data
    ?.__type?.fields?.filter(f=>/dynamic/i.test(f.name)).map(f=>({n:f.name,args:f.args.map(a=>a.name)}))));
// Try a keyed lookup: AddressKey under a coin config.
const r = await ask(`query{ object(address:"0xf314b4f85cfb7282dcb1aa08ccf4328056c37bfbf3cbb8adce27b6ce8b38339d"){
  dynamicField(name:{ type:"0x2::deny_list::AddressKey", bcs:"" }){ name{json} } } }`,{});
console.log("\nkeyed lookup shape:", JSON.stringify(r).slice(0,300));
