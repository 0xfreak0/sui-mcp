const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
console.log("TransactionEffects fields:", JSON.stringify(
  (await ask(`{ __type(name:"TransactionEffects"){ fields{ name } } }`)).data?.__type?.fields?.map(f=>f.name)));
const r = await ask(`query($d:String!){ transaction(digest:$d){ effects{ status errors } } }`,
  { d: "6rbfmByTyP4k7EREQBV9XZNhaG4RPm2ExT5bhVDfhGpu" });
console.log("\nsample:", JSON.stringify(r).slice(0,500));
