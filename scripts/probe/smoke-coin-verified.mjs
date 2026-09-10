import { registerTraceTools } from "../../dist/tools/trace.js";
import { runWithNetwork } from "../../dist/config.js";
import { displayCoin, coinScale } from "../../dist/utils/valuation.js";
const tools={}; registerTraceTools({tool:(n,_d,_s,h)=>{tools[n]=h;}});
await runWithNetwork("mainnet", async () => {
  console.log("-- helper on real vs fake --");
  for (const [l,t] of [
    ["real SUI","0x2::sui::SUI"],
    ["fake SUI","0x00a3017cc5fd396c38263ec57c8f2266507ce1a737000000000000000000000f::sui::SUI"],
    ["real USDC","0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"],
    ["fake USDC","0x006e09c3c3ebb8c4670e0320da7efe926d35347608f964b4625dd47bae40a664::usdc::USDC"],
  ]) {
    const d=displayCoin(t), s=coinScale(t);
    console.log(`  ${l.padEnd(10)} symbol=${d.symbol.padEnd(5)} verified=${String(d.verified).padEnd(5)} scale=${s.decimals}/${s.source}`);
  }
  console.log("\n-- a real trace, checking every hop's coins --");
  const res = await tools["trace_funds"]({
    digest:"85Q9FLPMegjZ4ymZ1TfbFT9haP71HYedE1hUFVn1uC9y", direction:"backward", hops:3 });
  const parts = res.content.map(c=>c.text);
  const jsonPart = parts.find(t=>t.trim().startsWith("{"));
  console.log("   (text summary lines shown below use the same formatter)");
  for (const line of (parts[0]||"").split("\n").filter(l=>/[+-][0-9]/.test(l)).slice(0,4)) console.log("   "+line.trim().slice(0,64));
  const j = jsonPart? JSON.parse(jsonPart) : {};
  let seen=0, unver=0;
  for (const h of j.hops ?? []) for (const bc of h.balance_changes ?? []) {
    seen++; if (bc.coin_verified === false) unver++;
    if (seen<=4) console.log(`   ${bc.formatted?.slice(0,44).padEnd(46)} verified=${bc.coin_verified}`);
  }
  console.log(`   ${seen} balance changes, ${unver} on unverified coins`);
});
