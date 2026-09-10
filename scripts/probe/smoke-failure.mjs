import { registerTransactionTools } from "../../dist/tools/transactions.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; registerTransactionTools({tool:(n,_d,_s,h)=>{tools[n]=h;}});
const call=async(n,a)=>JSON.parse((await tools[n](a)).content[0].text);
await runWithNetwork("mainnet", async () => {
  for (const d of ["6rbfmByTyP4k7EREQBV9XZNhaG4RPm2ExT5bhVDfhGpu",
                   "CBjycKjVXizZ2VcxVjE2u6xBhP8YJgSgLziZA7N7crXK"]) {
    const j = await call("get_transaction", { digest: d });
    console.log(`\n${d.slice(0,14)}…  status=${j.status}`);
    console.log("  failure:", JSON.stringify(j.failure, null, 1).replace(/\n/g,"\n  ").slice(0,600));
  }
  // batch path
  const b = await call("get_transactions", { digests: ["6rbfmByTyP4k7EREQBV9XZNhaG4RPm2ExT5bhVDfhGpu"] });
  const t = b.transactions?.[0] ?? b.found?.[0];
  console.log("\nbatch path failure.kind:", t?.failure?.kind, "| abort_code:", t?.failure?.abort_code);
});
