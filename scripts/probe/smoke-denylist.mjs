import { listConfiguredCoins, readCoinRestrictions, currentEpoch } from "../../dist/utils/deny-list-probe.js";
import { runWithNetwork } from "../../dist/config.js";
await runWithNetwork("mainnet", async () => {
  const t0=Date.now();
  const epoch = await currentEpoch();
  const coins = await listConfiguredCoins();
  console.log(`epoch ${epoch} | ${coins.size} coin types with a deny config | ${Date.now()-t0}ms`);
  let withDenied=0, paused=0, totalDenied=0; const examples=[];
  let i=0;
  for (const [coin, cfg] of coins) {
    if (i++ >= 25) break;
    const r = await readCoinRestrictions(coin, cfg, epoch, 3);
    if (r.globally_paused) paused++;
    if (r.denied.length) { withDenied++; totalDenied+=r.denied.length; if(examples.length<3) examples.push(r); }
  }
  console.log(`of first 25 coins: ${withDenied} have denied addresses (${totalDenied} total), ${paused} globally paused`);
  for (const e of examples) {
    console.log(`\n${e.coin_type.slice(0,54)}…`);
    for (const d of e.denied.slice(0,3))
      console.log(`   ${d.address.slice(0,20)}…  active=${d.active}  after_epoch=${d.effective_after_epoch}`);
  }
});
