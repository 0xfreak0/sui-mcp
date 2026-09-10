/**
 * End-to-end investigation exercising every multisig feature against mainnet.
 * The scenario: you are handed a treasury address and must say who runs it.
 */
import { registerMultisigTools } from "../../dist/tools/multisig.js";
import { registerTransactionTools } from "../../dist/tools/transactions.js";
import { registerIdentifyTools } from "../../dist/tools/identify.js";
import { runWithNetwork } from "../../dist/config.js";

const tools = {};
const collect = { tool: (n, _d, _s, h) => { tools[n] = h; } };
registerMultisigTools(collect);
registerTransactionTools(collect);
registerIdentifyTools(collect);
const call = async (n, args) => JSON.parse((await tools[n](args)).content[0].text);

const GOV = "0x045dadba87e5ad53f12075a1f0fa94bd94550a3bcf2abbe316e2d3b16ceb9440"; // 4-of-7
const HOT = "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7"; // 1-of-2

await runWithNetwork("mainnet", async () => {
  console.log("STEP 1 — identify_address on the treasury");
  const id = await call("identify_address", { address: GOV });
  console.log("  auth:", id.authentication.scheme, id.authentication.multisig.threshold + "-of-" + id.authentication.multisig.members.length, "verified:", id.authentication.verified);
  console.log("  members:", id.committee_members.length);

  console.log("\nSTEP 2 — analyze_multisig: who actually runs it");
  const a = await call("analyze_multisig", { address: GOV, max_transactions: 200 });
  console.log("  shape:", a.committee.shape, "| txs examined:", a.transactions_examined, "| complete:", a.history_complete);
  console.log("  dormant:", a.dormant_members, "| always present:", a.always_present);
  console.log("  signer sets:");
  for (const s of a.signer_sets) console.log(`     [${s.members}] x${s.count}  ${String(s.first_seen).slice(0,10)} → ${String(s.last_seen).slice(0,10)}`);
  console.log("  note:", a.note);

  console.log("\nSTEP 3 — get_transaction: who signed ONE specific transaction");
  const digest = "oxrJ3BppuktPAXg47X71Y3RGUkWNAo1fECuwdcEt6Ac";
  const tx = await call("get_transaction", { digest });
  for (const auth of tx.authorization ?? []) {
    console.log(`  ${auth.role}: ${auth.scheme}${auth.multisig ? " " + auth.multisig.shape : ""}`);
    if (auth.multisig) {
      console.log("     signed_by:", auth.multisig.signed_by.map(m => m.index));
      console.log("     did_not_sign:", auth.multisig.did_not_sign.map(m => m.index));
    }
  }

  console.log("\nSTEP 4 — analyze_multisig on the hot 1-of-2");
  const h = await call("analyze_multisig", { address: HOT, max_transactions: 200 });
  console.log("  shape:", h.committee.shape, "| txs:", h.transactions_examined);
  console.log("  dormant:", h.dormant_members, "| always present:", h.always_present);
  console.log("  note:", h.note);

  console.log("\nSTEP 5 — find_shared_multisig from the two member keys");
  const f = await call("find_shared_multisig", {
    addresses: [
      "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777",
      "0xc848c5cc29fdff135650156194a27442b6c8cada58fab5ba9123d635754ae66f",
    ],
  });
  console.log("  candidates checked:", f.candidates_checked, "| found:", f.found_count);
  for (const x of f.found) console.log(`     ${x.address}  ${x.shape}  tier=${x.evidence_tier}`);
});
