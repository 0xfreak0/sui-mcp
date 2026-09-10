import { parseSerializedSignature } from "@mysten/sui/cryptography";
const ask = async (q, v) => (await (await fetch("https://graphql.mainnet.sui.io/graphql", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: v }),
})).json());

// Collect UpgradeCap owners.
const owners = new Set();
let after = null, pages = 0;
while (pages++ < Number(process.env.PAGES ?? 12)) {
  const r = await ask(`query($c:String){ objects(filter:{type:"0x2::package::UpgradeCap"}, first:50, after:$c){ pageInfo{hasNextPage endCursor} nodes{ address owner{ __typename ... on AddressOwner { address { address } } } } } }`, { c: after });
  const conn = r.data?.objects; if (!conn) { console.error(JSON.stringify(r.errors).slice(0,300)); break; }
  for (const n of conn.nodes) if (n.owner?.__typename === "AddressOwner" && n.owner.address?.address) owners.add(n.owner.address.address);
  if (!conn.pageInfo.hasNextPage) break;
  after = conn.pageInfo.endCursor;
}
console.log("distinct UpgradeCap address-owners:", owners.size);

// Classify each by the flag byte of its first sent signature.
const counts = new Map(); const multisigs = [];
const list = [...owners];
const CONC = 6; let i = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < list.length) {
    const a = list[i++];
    try {
      const r = await ask(`query($a:SuiAddress!){ transactions(filter:{sentAddress:$a}, first:1){ nodes{ digest signatures{ signatureBytes } } } }`, { a });
      const n = r.data?.transactions?.nodes?.[0];
      if (!n) { counts.set("never_sent", (counts.get("never_sent") ?? 0) + 1); continue; }
      for (const s of n.signatures) {
        const flag = Buffer.from(s.signatureBytes, "base64")[0];
        if (flag !== 3) continue;
        const p = parseSerializedSignature(s.signatureBytes);
        multisigs.push({ address: a, digest: n.digest,
          threshold: p.multisig.multisig_pk.threshold,
          weights: p.multisig.multisig_pk.pk_map.map(m => m.weight),
          schemes: p.multisig.multisig_pk.pk_map.map(m => Object.keys(m.pubKey)[0]),
          bitmap: p.multisig.bitmap });
      }
      const f = Buffer.from(n.signatures[0].signatureBytes, "base64")[0];
      counts.set("flag" + f, (counts.get("flag" + f) ?? 0) + 1);
    } catch (e) { counts.set("error", (counts.get("error") ?? 0) + 1); }
  }
}));
console.log("first-signature flags:", [...counts.entries()].sort());
console.log("multisig owners found:", multisigs.length);
for (const m of multisigs) console.log("  ", m.address, `t=${m.threshold}`, `weights=[${m.weights}]`, `schemes=[${m.schemes}]`, "bitmap=" + m.bitmap);
