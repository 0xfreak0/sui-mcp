/**
 * Capture real mainnet signatures as offline test fixtures.
 *
 * Re-run after an @mysten/sui bump to confirm the parse + derive path still
 * agrees with the chain: `node scripts/probe/dump-fixtures.mjs`.
 */
import fs from "node:fs";
const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());

const targets = {
  ms_2of3:  "0xa1eb94d1700652aa85b417b46fa6775575b8b98d3352d864fb5146eb45d335fb",
  ms_4of7:  "0x045dadba87e5ad53f12075a1f0fa94bd94550a3bcf2abbe316e2d3b16ceb9440",
  ms_3of6:  "0x088e69d25fdcd212e70085e7560585789c8eea8d4df5a17817827c4e44847b07",
  ms_1of2:  "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7",
  ed25519:  "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777",
  zklogin:  "0xdeee14aade14eb6cf9c1cbca831216774d3e098db67c2e1550a561796d9f46f5",
};

const out = {};
for (const [k, address] of Object.entries(targets)) {
  const r = await ask(`query($a:SuiAddress!){ transactions(filter:{sentAddress:$a}, first:1){ nodes{ digest signatures{signatureBytes} } } }`, { a: address });
  const n = r.data.transactions.nodes[0];
  out[k] = { address, digest: n.digest, signatures: n.signatures.map(s => s.signatureBytes) };
  console.log(k, address, n.digest, `${n.signatures.length} sig(s)`, n.signatures.map(s => "flag" + Buffer.from(s.signatureBytes,"base64")[0]).join(","));
}
fs.writeFileSync("test/fixtures/signatures.json", JSON.stringify(out, null, 2));
console.log("wrote test/fixtures/signatures.json");
