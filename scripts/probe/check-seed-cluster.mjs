import { registerClusterTools } from "../../dist/tools/cluster.js";
import { runWithNetwork } from "../../dist/config.js";
let handler;
registerClusterTools({ tool: (_n, _d, _s, h) => { handler = h; } });
const seed = "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7";
await runWithNetwork("mainnet", async () => {
  const j = JSON.parse((await handler({ addresses: [seed], expand: true, query_budget: 60 })).content[0].text);
  console.log("excluded_co_signers:", JSON.stringify(j.excluded_co_signers));
  console.log("\nnote:", (j.excluded_co_signer_note ?? "").slice(0, 200));
  const mine = j.clusters.find(c => c.members.some(m => m.address === seed));
  console.log("\nseed's cluster:", mine ? `size=${mine.size} tier=${mine.evidence_tier} conf=${mine.confidence}` : "NONE");
  for (const m of mine?.members ?? []) console.log("   ", m.address.slice(0,16)+"…", m.name ?? "");
  console.log("\ntotal clusters:", j.clusters.length, "| sizes:", [...new Set(j.clusters.map(c=>c.size))]);
});
