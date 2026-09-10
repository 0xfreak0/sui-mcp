const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
console.log("ExecutionError fields:", JSON.stringify(
  (await ask(`{ __type(name:"ExecutionError"){ kind fields{ name type{name kind ofType{name}} } } }`)).data));
const r = await ask(`query($d:String!){ transaction(digest:$d){ effects{ status executionError{ abortCode sourceLineNumber instruction identifier } } } }`,
  { d: "6rbfmByTyP4k7EREQBV9XZNhaG4RPm2ExT5bhVDfhGpu" });
console.log("\nsample:", JSON.stringify(r).slice(0,600));
