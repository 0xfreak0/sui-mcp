import { findCoinConfig } from "../../dist/utils/deny-list-probe.js";
import { runWithNetwork } from "../../dist/config.js";
const cands = {
  USDC: ["0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
         "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
         "0x94e7a8e71830d2b34b3edaa195dc24c45d142584f06fa257b73af753d766e690::celer_usdc_coin::CELER_USDC_COIN"],
  USDT: ["0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT",
         "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN",
         "0x94e7a8e71830d2b34b3edaa195dc24c45d142584f06fa257b73af753d766e690::celer_usdt_coin::CELER_USDT_COIN"],
  WBTC: ["0x0041f9f9344cac094454cd574e333c4fdb132d7bcc9379bcd4aab485b2a63942::wbtc::WBTC",
         "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN"],
};
await runWithNetwork("mainnet", async () => {
  for (const [sym, list] of Object.entries(cands)) {
    console.log(`\n${sym}:`);
    for (const t of list) {
      const cfg = await findCoinConfig(t);
      console.log(`   deny_config=${cfg? "YES" : "no "}  ${t.slice(0,66)}`);
    }
  }
});
