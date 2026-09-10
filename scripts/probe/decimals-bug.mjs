import { symbolOf, decimalsForCoinType, toHumanAmount } from "../../dist/utils/valuation.js";
const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const coins = {
  "real USDC":     "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  "impostor USDC": "0x006e09c3c3ebb8c4670e0320da7efe926d35347608f964b4625dd47bae40a664::usdc::USDC",
};
console.log("coin              symbolOf  assumed  actual  amount 1e9 raw reads as");
for (const [label,t] of Object.entries(coins)) {
  const r = await ask(`query($t:String!){ coinMetadata(coinType:$t){ decimals symbol } }`,{t});
  const actual = r.data?.coinMetadata?.decimals;
  const assumed = decimalsForCoinType(t);
  console.log(`${label.padEnd(17)} ${symbolOf(t).padEnd(9)} ${String(assumed).padEnd(8)} ${String(actual).padEnd(7)} ${toHumanAmount(1000000000n, assumed).toLocaleString()}  (truth: ${toHumanAmount(1000000000n, actual ?? assumed).toLocaleString()})`);
}
