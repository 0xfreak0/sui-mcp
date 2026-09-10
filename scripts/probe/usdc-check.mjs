import { findCoinConfig, currentEpoch, readCoinRestrictions } from "../../dist/utils/deny-list-probe.js";
import { registerAnalyzeTokenTools } from "../../dist/tools/analyze-token.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; registerAnalyzeTokenTools({tool:(n,_d,_s,h)=>{tools[n]=h;}});
await runWithNetwork("mainnet", async () => {
  // What did analyze_token actually resolve "USDC" to?
  const j = JSON.parse((await tools["analyze_token"]({ query:"USDC", include_holders:false })).content[0].text);
  console.log("analyze_token resolved USDC ->", j.coin_type);
  console.log("  symbol:", j.symbol, "| name:", j.name);

  const epoch = await currentEpoch();
  const candidates = [
    j.coin_type,
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", // native USDC
    "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN", // wormhole USDC
  ];
  for (const ct of [...new Set(candidates)]) {
    const cfg = await findCoinConfig(ct);
    let n = "-";
    if (cfg) { const r = await readCoinRestrictions(ct, cfg, epoch, 4); n = `${r.denied.length} denied, paused=${r.globally_paused}`; }
    console.log(`  ${ct.slice(0,58)}…  config=${cfg? cfg.slice(0,14)+"…" : "NONE"}  ${n}`);
  }
});
