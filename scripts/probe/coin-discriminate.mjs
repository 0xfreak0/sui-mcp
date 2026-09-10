/** Do on-chain properties separate a real coin from an impostor, without names? */
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const Q=`query($t:String!){ coinMetadata(coinType:$t){ decimals symbol supply } }`;
const groups = {
  "USDC (7 verified)": [
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
    "0x94e7a8e71830d2b34b3edaa195dc24c45d142584f06fa257b73af753d766e690::celer_usdc_coin::CELER_USDC_COIN",
  ],
  "USDC impostor (from scan)": [
    "0x006e09c3c3ebb8c4670e0320da7efe926d35347608f964b4625dd47bae40a664::usdc::USDC",
  ],
  "SUI real vs fake": [
    "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    "0x00231a437dcefb8b25cf779b2c76e65fa7724ee617b4733d4e6076cd47000000::sui::SUI",
  ],
};
for (const [label, list] of Object.entries(groups)) {
  console.log("\n" + label);
  for (const t of list) {
    const r = await ask(Q,{t});
    const m = r.data?.coinMetadata;
    console.log(`  supply=${String(m?.supply ?? "null").padStart(22)}  sym=${(m?.symbol??"?").padEnd(6)} ${t.slice(0,54)}`);
  }
}
