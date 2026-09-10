const ask = async (q, v) => {
  const r = await fetch("https://graphql.mainnet.sui.io/graphql", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q, variables: v }),
  });
  return r.json();
};
let j = await ask(`{ __type(name: "Transaction") { fields { name type { name kind ofType { name } } } } }`);
console.log("Transaction fields:", JSON.stringify(j.data?.__type?.fields?.map(f=>f.name) ?? j));
let k = await ask(`{ __type(name: "UserSignature") { kind fields { name } } }`);
console.log("UserSignature:", JSON.stringify(k.data ?? k));
let t = await ask(`query($d:String!){ transaction(digest:$d){ digest sender { address } signatures } }`, { d: "F2o6xiYX5CDquFcxsPNgtii4SSqH327keWhj7a1KfeTv" });
console.log("tx:", JSON.stringify(t).slice(0, 900));
