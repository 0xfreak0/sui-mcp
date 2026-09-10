const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
console.log("Object fields:", JSON.stringify((await ask(`{ __type(name:"Object"){ fields{ name } } }`))
  .data?.__type?.fields?.map(f=>f.name)));
// Find an UpgradeCap owned by an address.
const caps = await ask(`{ objects(filter:{type:"0x2::package::UpgradeCap"}, first:5){ nodes{
  address version owner{ __typename ... on AddressOwner{ address{address} } }
  previousTransactionBlock{ digest } } } }`);
console.log("\nsample caps:", JSON.stringify(caps).slice(0,400));
