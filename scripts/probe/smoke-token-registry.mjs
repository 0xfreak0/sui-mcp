import { registerAnalyzeTokenTools } from "../../dist/tools/analyze-token.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; registerAnalyzeTokenTools({tool:(n,_d,_s,h)=>{tools[n]=h;}});
const call=async(q)=>JSON.parse((await tools["analyze_token"]({query:q,include_holders:false})).content[0].text);
await runWithNetwork("mainnet", async () => {
  for (const q of ["USDC","SUI","DEEP",
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    "0x006e09c3c3ebb8c4670e0320da7efe926d35347608f964b4625dd47bae40a664::usdc::USDC"]) {
    const j = await call(q);
    if (j.status === "ambiguous_symbol") {
      console.log(`${q.slice(0,20).padEnd(22)} AMBIGUOUS (${j.candidates.length}) -> ${j.candidates.slice(0,2).map(c=>c.coin_type.slice(0,22)+"…").join(", ")}`);
    } else {
      console.log(`${q.slice(0,20).padEnd(22)} ${(j.symbol??"?").padEnd(7)} ${j.coin_type?.slice(0,26)}…  verified=${j.verified} by=${j.verified_by??"-"}`);
    }
  }
});
