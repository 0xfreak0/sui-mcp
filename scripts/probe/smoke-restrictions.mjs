import { registerRestrictionTools } from "../../dist/tools/restrictions.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; registerRestrictionTools({tool:(n,_d,_s,h)=>{tools[n]=h;}});
const call=async(a)=>JSON.parse((await tools["check_coin_restrictions"](a)).content[0].text);
await runWithNetwork("mainnet", async () => {
  const COIN="0x20042e47b0169e3c411b053033a48144ba30fde68394c2ddc28b5522c2c42fc8::bluebirdy::BLUEBIRDY";
  const DENIED="0x0da83d0a41509fdc91bea1ee7a46d422179571ac4daa5e570c190218d868338b";

  let t=Date.now();
  const a = await call({ coin_type: COIN });
  console.log(`by coin (${Date.now()-t}ms): regulated=${a.regulated} denied=${a.denied_count} paused=${a.globally_paused}`);
  for (const d of (a.denied??[]).slice(0,3)) console.log(`   ${d.address.slice(0,18)}… active=${d.active} after=${d.effective_after_epoch}`);

  t=Date.now();
  const b = await call({ coin_type: COIN, address: DENIED });
  console.log(`\nby coin+address (${Date.now()-t}ms): denied=${b.queried_address_denied}`);
  console.log("   note:", (b.note??"").slice(0,130));

  t=Date.now();
  const c = await call({ coin_type: "0x2::sui::SUI" });
  console.log(`\nSUI (${Date.now()-t}ms): regulated=${c.regulated} | ${(c.result??"").slice(0,80)}`);

  t=Date.now();
  const d = await call({ address: DENIED });
  console.log(`\nby address (${Date.now()-t}ms): held=${d.coins_held_checked} regulated=${d.regulated_coins_held} restricted=${d.restricted_count}`);
  for (const r of (d.restricted??[]).slice(0,3)) console.log(`   ${r.coin_type.slice(0,50)}… denied=${r.denied} pending=${r.pending}`);
});
