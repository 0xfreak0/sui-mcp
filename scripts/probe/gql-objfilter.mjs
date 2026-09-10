const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());
console.log("ObjectFilter:", JSON.stringify((await ask(`{ __type(name:"ObjectFilter"){ inputFields{ name } } }`)).data?.__type?.inputFields?.map(f=>f.name)));
const r = await ask(`{ objects(filter:{type:"0x2::package::UpgradeCap"}, first:5){ nodes{ address owner{ __typename ... on AddressOwner { owner { address } } } } } }`);
console.log(JSON.stringify(r).slice(0,700));
