const ask = async (q, v) => {
  const r = await fetch("https://graphql.mainnet.sui.io/graphql", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q, variables: v }),
  });
  return r.json();
};
console.log(JSON.stringify((await ask(`{ __type(name:"SignatureScheme"){ kind fields { name type { kind name ofType { name } } } } }`)).data));
const t = await ask(`query($d:String!){ transaction(digest:$d){ digest sender { address } signatures { signatureBytes } } }`, { d: "F2o6xiYX5CDquFcxsPNgtii4SSqH327keWhj7a1KfeTv" });
console.log(JSON.stringify(t).slice(0, 800));
