/** Paths the first pass did not actually exercise. */
import { registerRestrictionTools } from "../../dist/tools/restrictions.js";
import { registerMultisigTools } from "../../dist/tools/multisig.js";
import { registerAnalyzeTokenTools } from "../../dist/tools/analyze-token.js";
import { registerAllowanceTools } from "../../dist/tools/allowances.js";
import { registerBridgeTools } from "../../dist/tools/bridge.js";
import { gqlQuery } from "../../dist/clients/graphql.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; const c={tool:(n,_d,_s,h)=>{tools[n]=h;}};
[registerRestrictionTools,registerMultisigTools,registerAnalyzeTokenTools,registerAllowanceTools,registerBridgeTools].forEach(f=>f(c));
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
    ck("caveat says a frozen address may hold none of the coin",/frozen address may have no balance of that coin/i.test(String(byAddr.caveat??"")));
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

  console.log("\nC. list_allowances against a raw read of an Allowance object");
  // Truth: the newest Allowance objects, read straight from the type filter.
  const raw=await gqlQuery(`query { objects(filter:{type:"0x2::allowance::Allowance"}, last: 5) { nodes { address asMoveObject { contents { json } } } } }`);
  const subject=(raw.objects?.nodes??[]).find(n=>n.asMoveObject?.contents?.json?.settings?.funder);
  if(!subject){
    console.log("   --  no Allowance object on chain to check against; skipped");
  } else {
    const norm=a=>"0x"+String(a).replace(/^0x/,"").toLowerCase().padStart(64,"0");
    const j=subject.asMoveObject.contents.json; const id=norm(subject.address);
    const f=await call("list_allowances",{address:j.settings.funder,role:"funder"});
    const row=(f.as_funder?.allowances??[]).find(a=>a.allowance_id===id);
    ck("funder side lists the allowance",!!row,`count=${f.as_funder?.count} complete=${f.as_funder?.complete}`);
    if(row){
      ck("spender matches the object",row.spender===norm(j.settings.spender),`${row.spender}`);
      ck("current_spend matches the object",row.current_spend===String(BigInt(j.current_spend)),`${row.current_spend} vs ${j.current_spend}`);
      ck("funder row names its cap",typeof row.cap_id==="string"&&row.cap_id.length===66,`${row.cap_id}`);
    }
    const sp=await call("list_allowances",{address:j.settings.spender,role:"spender"});
    const found=(sp.as_spender?.allowances??[]).some(a=>a.allowance_id===id);
    ck("spender scan finds it, or says it stopped",found||sp.as_spender?.scan?.status!=="complete",`status=${sp.as_spender?.scan?.status} scanned=${sp.as_spender?.scan?.scanned}`);
  }

  console.log("\nD. a CCTP V2 burn against its own event and message bytes");
  // Truth: the burn event and MessageSent read raw. A V2 message is version 1.
  const V2_TX="95NbYXyiVud9o5vVPtS2XiBg7toghAZNYYtUnNrjNkzd";
  const ev=await gqlQuery(`query($d:String!){ transaction(digest:$d){ effects { events(first:20){ nodes { contents { type { repr } json } } } } } }`,{d:V2_TX});
  const nodes=ev.transaction?.effects?.events?.nodes??[];
  const burn=nodes.find(n=>n.contents.type.repr.endsWith("::deposit_for_burn::DepositForBurn"))?.contents.json;
  const msg=nodes.find(n=>n.contents.type.repr.endsWith("::send_message::MessageSent"))?.contents.json?.message;
  const bytes=msg?Buffer.from(msg,"base64"):null;
  ck("raw message is CCTP V2 (version 1)",bytes?.readUInt32BE(0)===1,`version=${bytes?.readUInt32BE(0)}`);
  const r=await call("resolve_bridge_transfer",{digest:V2_TX});
  const c=r.circle_cctp?.[0];
  ck("tool reports cctp_version 2",c?.cctp_version===2,`${c?.cctp_version}`);
  ck("no transfer id from a zero nonce",c?.transfer_id===null&&c?.nonce===null,`${c?.transfer_id}/${c?.nonce}`);
  ck("destination domain matches the event",c?.destination_domain===burn?.destination_domain,`${c?.destination_domain} vs ${burn?.destination_domain}`);
  ck("amount matches the event",c?.amount===burn?.amount,`${c?.amount}`);
  ck("attestation lookup names this digest",c?.attestation_lookup?.transaction_hash===V2_TX);

  console.log("\n=== "+(bad.length?bad.length+" PROBLEM(S)":"clean")+" ===");
  bad.forEach(b=>console.log("  - "+b));
});
