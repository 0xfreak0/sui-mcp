import { MultiSigPublicKey } from "@mysten/sui/multisig";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());

const pks = [
  new Ed25519PublicKey(Buffer.from("zKVjBVK4lCZOYOboq4+U3AudO2STrceo4HK5vHGxV4I=", "base64")),
  new Ed25519PublicKey(Buffer.from("+x5KLRu40AVqvOVyktmj0sRNYHeMYwxLMz8gG2RRaGo=", "base64")),
];
function* perms(a) { if (a.length <= 1) { yield a; return; } for (let i = 0; i < a.length; i++) for (const rest of perms([...a.slice(0,i), ...a.slice(i+1)])) yield [a[i], ...rest]; }

const cands = [];
for (const order of perms(pks)) for (let t = 1; t <= order.length; t++) {
  const ms = MultiSigPublicKey.fromPublicKeys({ threshold: t, publicKeys: order.map(p => ({ publicKey: p, weight: 1 })) });
  cands.push({ addr: ms.toSuiAddress(), t, order: order.map(p => p.toSuiAddress().slice(0,10)).join(">") });
}
const uniq = [...new Map(cands.map(c => [c.addr, c])).values()];
console.log("candidate addresses:", uniq.length);
for (const c of uniq) {
  const r = await ask(`query($a:SuiAddress!){ transactions(filter:{sentAddress:$a}, first:1){ nodes{ digest } } }`, { a: c.addr });
  const n = r.data?.transactions?.nodes?.length ?? 0;
  console.log(`  ${c.addr}  t=${c.t} order=${c.order}  ${n ? "EXISTS (sent txs)" : "no activity"}`);
}
