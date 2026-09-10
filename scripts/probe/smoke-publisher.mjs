import { registerIdentifyTools } from "../../dist/tools/identify.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; registerIdentifyTools({tool:(n,_d,_s,h)=>{tools[n]=h;}});
const call=async(n,a)=>JSON.parse((await tools[n](a)).content[0].text);
await runWithNetwork("mainnet", async () => {
  for (const [label,pkg] of [
    ["obfuscated (from a real abort)", "0xc72126457c84430ad439c8daf19679cfe87c84fc70912ba9b1df3060b64a5c50"],
    ["deepbook balance_manager",       "0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a"],
    ["sui framework 0x2",              "0x0000000000000000000000000000000000000000000000000000000000000002"],
  ]) {
    const j = await call("identify_address", { address: pkg });
    console.log(`\n${label}`);
    console.log("  type:", j.type, "| protocol:", j.protocol?.name ?? "-", "| root:", (j.lineage?.root_package_id??"-").slice(0,18)+"…");
    console.log("  publisher:", j.publisher?.publisher ?? "(unresolved)");
    console.log("  published:", j.publisher?.published_at ?? "-", "| tx:", (j.publisher?.publish_tx??"-").slice(0,16)+"…");
    if (j.publisher?.unresolved) console.log("  why      :", j.publisher.unresolved.slice(0,110));
  }
});
