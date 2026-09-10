const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const caps = await ask(`{ objects(filter:{type:"0x2::package::UpgradeCap"}, first:8){ nodes{
  address version owner{ __typename ... on AddressOwner{ address{address} } } } } }`);
const list = caps.data?.objects?.nodes ?? [];
console.log("caps:", list.length, "| versions:", list.map(c=>c.version).join(","));
const target = list.find(c=>Number(c.version)>1) ?? list[0];
console.log("\nwalking", target.address, "current version", target.version);
const h = await ask(`query($id:SuiAddress!){ object(address:$id){
  objectVersionsBefore(last:10){ nodes{ version
    owner{ __typename ... on AddressOwner{ address{address} } ... on Immutable{ __typename } }
    previousTransaction{ digest effects{ timestamp } } } } } }`, { id: target.address });
console.log(JSON.stringify(h, null, 1).slice(0, 1100));
