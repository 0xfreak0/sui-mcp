import { registerAnalyzeTokenTools } from "../../dist/tools/analyze-token.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; registerAnalyzeTokenTools({tool:(n,_d,_s,h)=>{tools[n]=h;}});
await runWithNetwork("mainnet", async () => {
  for (const q of ["SUI","0x20042e47b0169e3c411b053033a48144ba30fde68394c2ddc28b5522c2c42fc8::bluebirdy::BLUEBIRDY"]) {
    const j = JSON.parse((await tools["analyze_token"]({ query: q, include_holders: false })).content[0].text);
    console.log(`${(j.symbol??q).slice(0,12).padEnd(12)} deny_list=`, JSON.stringify(j.deny_list));
  }
});
