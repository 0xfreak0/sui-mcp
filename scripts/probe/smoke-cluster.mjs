/** Drives build_wallet_edges against a known multisig seed. */
import { registerClusterTools } from "../../dist/tools/cluster.js";
import { runWithNetwork } from "../../dist/config.js";

let handler;
registerClusterTools({ tool: (_n, _d, _s, h) => { handler = h; } });

const seed = process.argv[2] ?? "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7";
await runWithNetwork("mainnet", async () => {
  const r = await handler({ addresses: [seed], expand: true, query_budget: 60 });
  const j = JSON.parse(r.content[0].text);
  console.log("seeds:", j.seeds.map(s => s.slice(0,14)+"…"));
  console.log("queries:", j.queries_used, "truncated:", j.truncated, "edges:", j.edge_count);
  console.log("top-level evidence_tier:", j.evidence_tier);
  console.log("\n-- edges --");
  for (const e of j.edges.slice(0, 8))
    console.log(`  ${e.wallet_a.slice(0,12)}… ~ ${e.wallet_b.slice(0,12)}…  w=${e.weight}  [${e.signal_types}]`);
  console.log("\n-- clusters --");
  for (const c of j.clusters) {
    console.log(`  size=${c.size} tier=${c.evidence_tier} confidence=${c.confidence} minW=${c.min_edge_weight} intermediaries=${c.independent_intermediaries}`);
    for (const m of c.members) console.log(`     ${m.address.slice(0,14)}… ${m.name ?? ""} ${m.label ?? ""} ${m.note ? "| " + m.note.slice(0,60) : ""}`);
    if (c.basis) console.log("     basis:", c.basis.slice(0, 110));
  }
});
