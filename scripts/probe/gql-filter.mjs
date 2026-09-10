const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: q, variables: v }),
})).json());
console.log("TransactionFilter:", JSON.stringify((await ask(`{ __type(name:"TransactionFilter"){ inputFields { name type { kind name ofType { name } } } } }`)).data?.__type?.inputFields?.map(f=>f.name)));
const t = await ask(`query($d:String!){ transaction(digest:$d){ gasInput { gasSponsor { address } gasPayment { address } } } }`, { d: "F2o6xiYX5CDquFcxsPNgtii4SSqH327keWhj7a1KfeTv" });
console.log("gasInput:", JSON.stringify(t).slice(0,400));
