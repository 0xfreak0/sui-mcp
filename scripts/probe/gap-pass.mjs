/** Paths the first pass did not actually exercise. */
import { registerRestrictionTools } from "../../dist/tools/restrictions.js";
import { registerMultisigTools } from "../../dist/tools/multisig.js";
import { registerAnalyzeTokenTools } from "../../dist/tools/analyze-token.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; const c={tool:(n,_d,_s,h)=>{tools[n]=h;}};
[registerRestrictionTools,registerMultisigTools,registerAnalyzeTokenTools].forEach(f=>f(c));
const call=async(n,a)=>{const r=await tools[n](a);const t=r.content.map(x=>x.text);
  const j=t.find(x=>x.trim().startsWith("{")); return j?JSON.parse(j):{_text:t[0]};};
const bad=[]; const ck=(n,ok,d="")=>{console.log(`   ${ok?"ok  ":"!!  "}${n}${d?"  "+d:""}`); if(!ok)bad.push(n);};

const REG_COIN="0x20042e47b0169e3c411b053033a48144ba30fde68394c2ddc28b5522c2c42fc8::bluebirdy::BLUEBIRDY";
const HOT="0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7";

await runWithNetwork("mainnet", async () => {
  console.log("\nA. deny list on a coin that IS regulated");
  const byCoin=await call("check_coin_restrictions",{coin_type:REG_COIN});
  ck("regulated",byCoin.regulated===true,`denied=${byCoin.denied_count}`);
  const who=byCoin.denied?.[0]?.address;
  ck("has a denied address",!!who,String(who).slice(0,20));
  if(who){
    const t=await call("check_coin_restrictions",{coin_type:REG_COIN,address:who});
    ck("by-coin+address confirms",t.queried_address_denied===true,`=${t.queried_address_denied}`);
    const byAddr=await call("check_coin_restrictions",{address:who});
    const hit=(byAddr.denied_by??[]).includes(REG_COIN);
    ck("by-address finds the same restriction",hit,
       `checked=${byAddr.coins_checked} complete=${byAddr.scan_complete} denied_by=${byAddr.denied_by_count}`);
    ck("scan reports completeness",byAddr.scan_complete===true,`=${byAddr.scan_complete}`);
    ck("caveat explains the anti-correlation",String(byAddr.caveat??"").includes("anti-correlated"));
  }
  const tok=await call("analyze_token",{query:REG_COIN,include_holders:false});
  ck("analyze_token agrees the coin is regulated",tok.deny_list?.regulated===true,`=${JSON.stringify(tok.deny_list?.regulated)}`);
  ck("deny counts agree",tok.deny_list?.denied_address_count===byCoin.denied_count,
     `${tok.deny_list?.denied_address_count} vs ${byCoin.denied_count}`);

  console.log("\nB. analyze_multisig history completeness");
  const capped=await call("analyze_multisig",{address:HOT,max_transactions:5});
  const full=await call("analyze_multisig",{address:HOT,max_transactions:200});
  ck("capped run reports it hit the cap",capped.history_complete===false,
     `examined=${capped.transactions_examined} complete=${capped.history_complete}`);
  ck("a capped run never claims MORE dormancy than a fuller one",
     (capped.dormant_members??[]).length>=(full.dormant_members??[]).length,
     `capped=${JSON.stringify(capped.dormant_members)} full=${JSON.stringify(full.dormant_members)}`);
  ck("note carries the count it rests on",String(capped.note??"").includes(String(capped.transactions_examined)),
     String(capped.note??"").slice(0,70));

  console.log("\n=== "+(bad.length?bad.length+" PROBLEM(S)":"clean")+" ===");
  bad.forEach(b=>console.log("  - "+b));
});
