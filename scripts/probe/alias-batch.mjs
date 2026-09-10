const ask = async (q) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }),
})).json());
// Known-good addresses padded out by reusing a few; the point is the request shape.
const base = [
 "0xa1eb94d1700652aa85b417b46fa6775575b8b98d3352d864fb5146eb45d335fb",
 "0x045dadba87e5ad53f12075a1f0fa94bd94550a3bcf2abbe316e2d3b16ceb9440",
 "0x088e69d25fdcd212e70085e7560585789c8eea8d4df5a17817827c4e44847b07",
 "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7",
 "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777",
 "0xdeee14aade14eb6cf9c1cbca831216774d3e098db67c2e1550a561796d9f46f5",
];
for (const n of [6, 10, 20, 25, 50]) {
  const addrs = Array.from({ length: n }, (_, i) => base[i % base.length]);
  const q = `query {\n` + addrs.map((a, i) =>
    `  a${i}: transactions(filter:{sentAddress:"${a}"}, first:1){ nodes{ digest signatures{signatureBytes} } }`
  ).join("\n") + `\n}`;
  const t0 = Date.now();
  const r = await ask(q);
  const ms = Date.now() - t0;
  const bytes = JSON.stringify(r).length;
  console.log(`n=${String(n).padStart(2)}  ${r.errors ? "ERR: " + JSON.stringify(r.errors[0]?.message).slice(0,90) : `ok  ${ms}ms  ${(bytes/1024).toFixed(1)}KB`}`);
}
