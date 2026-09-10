const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
const CFG="0x7ad047a32091"; // prefix only; resolve full id first
import { findCoinConfig } from "../../dist/utils/deny-list-probe.js";
import { runWithNetwork } from "../../dist/config.js";
await runWithNetwork("mainnet", async () => {
  const cfg = await findCoinConfig("0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC");
  console.log("native USDC config:", cfg);
  const r = await ask(`query($id:SuiAddress!){ object(address:$id){ dynamicFields(first:30){ pageInfo{hasNextPage} nodes{
    name{type{repr} json} value{ ... on MoveValue{ json } } } } } }`, { id: cfg });
  const nodes = r.data?.object?.dynamicFields?.nodes ?? [];
  console.log("raw entries:", nodes.length, "| hasNextPage:", r.data?.object?.dynamicFields?.pageInfo?.hasNextPage);
  for (const n of nodes.slice(0,8)) {
    console.log("  ", (n.name?.type?.repr??"").split("::").pop(), JSON.stringify(n.name?.json), "->", JSON.stringify(n.value?.json));
  }
});
