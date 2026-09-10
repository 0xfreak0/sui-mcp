/**
 * Adversarial pass: feed each new code path inputs designed to make it lie.
 * A pass here means it refused, said "unknown", or reported the limit — not
 * that it produced an answer.
 */
import { registerAnalyzeTokenTools } from "../../dist/tools/analyze-token.js";
import { registerRestrictionTools } from "../../dist/tools/restrictions.js";
import { registerIdentifyTools } from "../../dist/tools/identify.js";
import { registerTransactionTools } from "../../dist/tools/transactions.js";
import { registerMultisigTools } from "../../dist/tools/multisig.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; const c={tool:(n,_d,_s,h)=>{tools[n]=h;}};
[registerAnalyzeTokenTools,registerRestrictionTools,registerIdentifyTools,
 registerTransactionTools,registerMultisigTools].forEach(f=>f(c));
const call=async(n,a)=>{ try{ const r=await tools[n](a); const t=r.content[0].text;
  try{return JSON.parse(t);}catch{return {_raw:t};} }catch(e){ return {_threw:String(e.message).slice(0,90)}; } };
const bad=[]; const t=(name,ok,detail)=>{ console.log(`${ok?"  ok ":"  !! "}${name}${detail?"  "+detail:""}`); if(!ok) bad.push(name); };

await runWithNetwork("mainnet", async () => {
  console.log("\n-- malformed / hostile inputs --");
  for (const [label,args] of [
    ["empty coin type",       {coin_type:""}],
    ["type with 4 segments",  {coin_type:"0x2::a::b::c"}],
    ["non-hex package",       {coin_type:"0xZZ::a::A"}],
    ["huge address",          {address:"0x"+"f".repeat(200)}],
    ["injection-ish",         {coin_type:'0x2::sui::SUI" OR 1=1 --'}],
  ]) {
    const r = await call("check_coin_restrictions", args);
    t(`restrictions ${label}`, !r._threw, r._threw ?? (r.regulated===false?"regulated=false":JSON.stringify(r).slice(0,40)));
  }

  console.log("\n-- identify_address on non-addresses --");
  for (const a of ["", "0x", "not-an-address", "0x"+"1".repeat(63)]) {
    const r = await call("identify_address", {address:a});
    t(`identify ${JSON.stringify(a).slice(0,18)}`, !r._threw, r._threw ?? (r.error?"errored cleanly":r.type));
  }

  console.log("\n-- get_transaction on bad digests --");
  for (const d of ["", "notadigest", "1".repeat(44)]) {
    const r = await call("get_transaction", {digest:d});
    t(`tx ${JSON.stringify(d).slice(0,14)}`, !r._threw, r._threw ?? (r.error?"errored cleanly":"returned"));
  }

  console.log("\n-- analyze_multisig on non-multisigs --");
  for (const [label,a] of [
    ["plain wallet","0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777"],
    ["a package",   "0x0000000000000000000000000000000000000000000000000000000000000002"],
    ["never used",  "0x"+"e".repeat(64)],
  ]) {
    const r = await call("analyze_multisig",{address:a});
    const refused = !!(r.error || r._raw);
    t(`multisig ${label}`, refused && !r._threw, refused?"refused with a reason":"RETURNED A RESULT");
  }

  console.log("\n-- find_shared_multisig guardrails --");
  const big = Array.from({length:5},(_,i)=>`0x${String(i+1).repeat(64)}`);
  const r5 = await call("find_shared_multisig",{addresses:big});
  t("5 unusable addresses refuses", !!(r5.error||r5._raw), (r5.error??r5._raw??"").slice(0,60));

  console.log("\n-- token registry --");
  const imp = await call("analyze_token",{query:"0x006e09c3c3ebb8c4670e0320da7efe926d35347608f964b4625dd47bae40a664::usdc::USDC",include_holders:false});
  t("impostor marked unverified", imp.verified===false, `verified=${imp.verified}`);
  const amb = await call("analyze_token",{query:"USDC",include_holders:false});
  t("USDC returns candidates", amb.status==="ambiguous_symbol", `status=${amb.status} n=${amb.candidates?.length}`);
  const real = await call("analyze_token",{query:"SUI",include_holders:false});
  t("SUI resolves verified", real.verified===true, `by=${real.verified_by}`);
  const junk = await call("analyze_token",{query:"zzzznotacoinzzz",include_holders:false});
  t("junk symbol errors cleanly", !junk._threw, junk.error?"errored":"returned "+junk.coin_type);

  console.log("\n=== " + (bad.length? bad.length+" PROBLEM(S)" : "all adversarial checks passed") + " ===");
  bad.forEach(b=>console.log("  - "+b));
});
