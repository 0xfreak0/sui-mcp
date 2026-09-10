/** The realistic malformed-digest paths, not invented ones. */
import { registerTransactionTools } from "../../dist/tools/transactions.js";
import { runWithNetwork } from "../../dist/config.js";
const tools={}; registerTransactionTools({tool:(n,_d,_s,h)=>{tools[n]=h;}});
const call=async(d)=>{ try{ const r=await tools["get_transaction"]({digest:d});
  const j=JSON.parse(r.content[0].text); return j.error? "ERROR: "+j.error.slice(0,72) : "returned tx"; }
  catch(e){ return "THREW: "+String(e.message).slice(0,72); } };
const REAL="6rbfmByTyP4k7EREQBV9XZNhaG4RPm2ExT5bhVDfhGpu";
await runWithNetwork("mainnet", async () => {
  for (const [why,d] of [
    ["an object ID passed by mistake", "0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a"],
    ["trailing whitespace from a paste", REAL+" "],
    ["truncated in transit",            REAL.slice(0,40)],
    ["one character transposed",        REAL.slice(0,-2)+"0"+REAL.slice(-1)],
    ["the real thing",                  REAL],
  ]) console.log(`  ${why.padEnd(34)} ${await call(d)}`);
});
