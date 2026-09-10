const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());
for (const a of process.argv.slice(2)) {
  const sent = await ask(`query($a:SuiAddress!){ transactions(filter:{sentAddress:$a}, first:3){ nodes{ digest signatures{signatureBytes} } } }`, { a });
  const aff  = await ask(`query($a:SuiAddress!){ transactions(filter:{affectedAddress:$a}, first:3){ nodes{ digest } } }`, { a });
  console.log(a);
  console.log("  sent:", sent.data?.transactions?.nodes?.map(n=>n.digest + " sigflag=" + Buffer.from(n.signatures[0].signatureBytes,"base64")[0]) ?? sent.errors);
  console.log("  affected:", aff.data?.transactions?.nodes?.map(n=>n.digest) ?? aff.errors);
}
