import { measureFanout } from "../../dist/utils/fanout.js";
import { runWithNetwork } from "../../dist/config.js";
await runWithNetwork("mainnet", async () => {
  for (const [label,a] of [
    ["known sponsor",   "0xdca840bf8889485caa9ba956798ca230c34c7528a2bff5380daa89a7cab58cc6"],
    ["ordinary wallet", "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777"],
    ["multisig treasury","0xa1eb94d1700652aa85b417b46fa6775575b8b98d3352d864fb5146eb45d335fb"],
  ]) {
    const t=Date.now();
    const r = await measureFanout(a, 400, false);
    console.log(`${label.padEnd(19)} ${Date.now()-t}ms  counterparties=${String(r.counterparty_count).padStart(4)} flow=${r.flow_shape.padEnd(9)} sponsored_for=${String(r.sponsored_address_count).padStart(3)} sponsor_txs=${String(r.sponsored_transaction_count).padStart(4)} shape=${r.sponsor_shape}`);
  }
});
