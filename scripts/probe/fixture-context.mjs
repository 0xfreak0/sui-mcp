const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());
const MS = {
  "0x045dadba87e5ad53f12075a1f0fa94bd94550a3bcf2abbe316e2d3b16ceb9440": "4-of-7",
  "0xa1eb94d1700652aa85b417b46fa6775575b8b98d3352d864fb5146eb45d335fb": "2-of-3",
  "0x088e69d25fdcd212e70085e7560585789c8eea8d4df5a17817827c4e44847b07": "3-of-6",
  "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7": "1-of-2 (hot)",
};
for (const [addr, shape] of Object.entries(MS)) {
  // What UpgradeCaps does it hold, and for which packages?
  const caps = await ask(`query($a:SuiAddress!){ objects(filter:{type:"0x2::package::UpgradeCap", owner:$a, ownerKind:ADDRESS}, first:10){ nodes{ address asMoveObject{ contents{ json } } } } }`, { a: addr });
  const pkgs = (caps.data?.objects?.nodes ?? []).map(n => n.asMoveObject?.contents?.json?.package).filter(Boolean);
  // Sent-tx count proxy + first/last
  const sent = await ask(`query($a:SuiAddress!){ transactions(filter:{sentAddress:$a}, first:1){ nodes{ digest effects{ timestamp } } } }`, { a: addr });
  console.log(`${shape}  ${addr}`);
  console.log(`   upgrade caps: ${pkgs.length}`, pkgs.slice(0,3));
  console.log(`   sample sent tx:`, sent.data?.transactions?.nodes?.[0]?.digest, sent.data?.transactions?.nodes?.[0]?.effects?.timestamp);
}
