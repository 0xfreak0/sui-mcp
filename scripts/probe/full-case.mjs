#!/usr/bin/env node
/**
 * A full investigation across every tool added since 1.13.0, built around
 * CROSS-TOOL CONSISTENCY rather than "did it return something".
 *
 * Each tool answering plausibly on its own proves little. The failures worth
 * finding are two tools disagreeing about the same fact — a committee that
 * differs between `identify_address` and `analyze_multisig`, a publisher that
 * differs between `identify_address` and `analyze_package`, a coin marked
 * verified in one place and not another. Those are invisible to a smoke test
 * and fatal to a report.
 */
import { registerIdentifyTools } from "../../dist/tools/identify.js";
import { registerTransactionTools } from "../../dist/tools/transactions.js";
import { registerMultisigTools } from "../../dist/tools/multisig.js";
import { registerRestrictionTools } from "../../dist/tools/restrictions.js";
import { registerAnalyzePackageTools } from "../../dist/tools/analyze-package.js";
import { registerAnalyzeTokenTools } from "../../dist/tools/analyze-token.js";
import { registerFundingTools } from "../../dist/tools/funding.js";
import { registerTraceTools } from "../../dist/tools/trace.js";
import { runWithNetwork } from "../../dist/config.js";

const tools = {};
const collect = { tool: (n, _d, _s, h) => { tools[n] = h; } };
[
  registerIdentifyTools, registerTransactionTools, registerMultisigTools,
  registerRestrictionTools, registerAnalyzePackageTools, registerAnalyzeTokenTools,
  registerFundingTools, registerTraceTools,
].forEach((f) => f(collect));

const call = async (name, args) => {
  const r = await tools[name](args);
  const parts = r.content.map((c) => c.text);
  const json = parts.find((t) => t.trim().startsWith("{"));
  return json ? JSON.parse(json) : { _text: parts[0] };
};

const problems = [];
const check = (name, ok, detail = "") => {
  console.log(`   ${ok ? "ok  " : "!!  "}${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

/** The 4-of-7 governance treasury and its package, both real mainnet. */
const TREASURY = "0x045dadba87e5ad53f12075a1f0fa94bd94550a3bcf2abbe316e2d3b16ceb9440";
const HOT_MULTISIG = "0xcf4e7b88a5a0d2026026b7356c23d2c03281f8a84dc2a2e55597b4464d767cc7";
const SWAP_TX = "85Q9FLPMegjZ4ymZ1TfbFT9haP71HYedE1hUFVn1uC9y";
const FAILED_TX = "CBjycKjVXizZ2VcxVjE2u6xBhP8YJgSgLziZA7N7crXK";

await runWithNetwork("mainnet", async () => {
  // ---------------------------------------------------------------- 1
  console.log("\n1. the treasury: two tools, one committee");
  const id = await call("identify_address", { address: TREASURY });
  const ms = await call("analyze_multisig", { address: TREASURY, max_transactions: 200 });

  const idCommittee = id.authentication?.multisig;
  check("identify_address sees a multisig", idCommittee?.threshold === 4, `threshold=${idCommittee?.threshold}`);
  check(
    "analyze_multisig agrees on the threshold",
    ms.committee?.threshold === idCommittee?.threshold,
    `${ms.committee?.threshold} vs ${idCommittee?.threshold}`,
  );
  check(
    "both list the same members in the same order",
    JSON.stringify(ms.members?.map((m) => m.address)) ===
      JSON.stringify(idCommittee?.members?.map((m) => m.address)),
  );
  // committee_members is the fan-out; it must line up positionally with the
  // committee itself or a reader attributes a name to the wrong key.
  check(
    "committee_members aligns with the committee",
    JSON.stringify(id.committee_members?.map((m) => m.address)) ===
      JSON.stringify(idCommittee?.members?.map((m) => m.address)),
  );

  // ---------------------------------------------------------------- 2
  console.log("\n2. per-transaction signers vs the wallet-level picture");
  const sample = ms.signer_sets?.[0]?.members ?? [];
  check("analyze_multisig found signer sets", (ms.signer_sets?.length ?? 0) > 0, `${ms.signer_sets?.length} sets`);
  check(
    "dormant members appear in no signer set",
    (ms.dormant_members ?? []).every((d) => !(ms.signer_sets ?? []).some((s) => s.members.includes(d))),
    `dormant=${JSON.stringify(ms.dormant_members)}`,
  );
  check(
    "always_present members appear in every set",
    (ms.always_present ?? []).every((a) => (ms.signer_sets ?? []).every((s) => s.members.includes(a))),
    `always=${JSON.stringify(ms.always_present)}`,
  );
  check("signed weight never exceeds the committee", (ms.committee?.total_weight ?? 0) >= (ms.committee?.threshold ?? 0));

  // ---------------------------------------------------------------- 3
  console.log("\n3. the package behind an abort: failure -> publisher -> capability");
  const failed = await call("get_transaction", { digest: FAILED_TX });
  const pkg = failed.failure?.location?.package;
  check("failure names the package that aborted", !!pkg, `${failed.failure?.kind} code=${failed.failure?.abort_code}`);

  const pkgId = await call("identify_address", { address: pkg });
  const pkgAnalysis = await call("analyze_package", { package_id: pkg });
  check(
    "identify_address and analyze_package agree on the publisher",
    pkgId.publisher?.publisher === pkgAnalysis.publisher?.publisher,
    `${String(pkgId.publisher?.publisher).slice(0, 14)} vs ${String(pkgAnalysis.publisher?.publisher).slice(0, 14)}`,
  );
  const upgradeCap = (pkgAnalysis.capabilities?.capabilities ?? []).find((c) => c.kind === "upgrade");
  check("upgrade cap classified", !!upgradeCap?.holder_status, `status=${upgradeCap?.holder_status}`);
  if (upgradeCap?.holder_status === "publisher") {
    check(
      "a 'publisher' status really does match the publisher",
      upgradeCap.owner_address?.toLowerCase() === pkgAnalysis.publisher?.publisher?.toLowerCase(),
    );
  }

  // ---------------------------------------------------------------- 4
  console.log("\n4. a swap: coin verification must agree across tools");
  const swap = await call("get_transaction", { digest: SWAP_TX });
  const trace = await call("trace_funds", { digest: SWAP_TX, direction: "backward", hops: 2 });
  const traced = (trace.hops ?? []).flatMap((h) => h.balance_changes ?? []);
  check("trace produced balance changes", traced.length > 0, `${traced.length}`);

  const byType = new Map();
  for (const bc of traced) if (bc.coin_type) byType.set(bc.coin_type, bc.coin_verified);
  let agree = true;
  const details = [];
  for (const [type, verified] of byType) {
    const tok = await call("analyze_token", { query: type, include_holders: false });
    if (tok.verified !== verified) {
      agree = false;
      details.push(`${type.slice(0, 24)} trace=${verified} analyze_token=${tok.verified}`);
    }
  }
  check("trace_funds and analyze_token agree on every coin", agree, details.join("; "));
  check("every traced coin carries a verification flag", traced.every((b) => typeof b.coin_verified === "boolean"));

  // ---------------------------------------------------------------- 5
  console.log("\n5. deny list: by-coin and by-address must not contradict");
  const coins = [...byType.keys()];
  for (const coin of coins.slice(0, 2)) {
    const byCoin = await call("check_coin_restrictions", { coin_type: coin });
    if (!byCoin.regulated) { check(`${coin.slice(0, 18)} unregulated`, true); continue; }
    const someone = byCoin.denied?.[0]?.address;
    if (!someone) { check(`${coin.slice(0, 18)} regulated, nobody denied`, true); continue; }
    const targeted = await call("check_coin_restrictions", { coin_type: coin, address: someone });
    check(
      `${coin.slice(0, 18)}: listed address confirms as denied`,
      targeted.queried_address_denied === true,
      `queried=${targeted.queried_address_denied}`,
    );
  }

  // ---------------------------------------------------------------- 6
  console.log("\n6. reverse search must find the multisig its own members form");
  const hot = await call("identify_address", { address: HOT_MULTISIG });
  const members = (hot.authentication?.multisig?.members ?? []).map((m) => m.address).filter(Boolean);
  const found = await call("find_shared_multisig", { addresses: members });
  check(
    "find_shared_multisig recovers the wallet",
    (found.found ?? []).some((f) => f.address === HOT_MULTISIG),
    `checked=${found.candidates_checked} found=${found.found_count}`,
  );

  // ---------------------------------------------------------------- 7
  console.log("\n7. sponsorship travels with fan-out");
  const fan = await call("get_address_fanout", { address: HOT_MULTISIG, max_transactions: 200 });
  check("sponsor fields present", typeof fan.sponsored_address_count === "number", `shape=${fan.sponsor_shape}`);
  // Present whenever there is something to say: it sponsors, or it does not
  // and the scan was cut short — absence off a truncated scan is not absence.
  // Silent only when a COMPLETE scan saw no sponsorship.
  const shouldSpeak = fan.sponsor_shape !== "not_a_sponsor" || fan.truncated;
  check(
    "sponsor_interpretation present exactly when there is something to say",
    shouldSpeak === (fan.sponsor_interpretation !== undefined),
    `shape=${fan.sponsor_shape} truncated=${fan.truncated} note=${fan.sponsor_interpretation ? "yes" : "no"}`,
  );
  // Provisional whenever the scan was cut short and the reading is one that
  // more history could overturn. `relayer` is the exception — 21 distinct
  // payees stay 21 however much further you look.
  const shouldBeProvisional = fan.truncated && fan.sponsor_shape !== "relayer";
  check(
    "a reading more history could overturn is marked provisional",
    shouldBeProvisional === (fan.sponsor_shape_provisional === true),
    `shape=${fan.sponsor_shape} truncated=${fan.truncated} provisional=${fan.sponsor_shape_provisional}`,
  );

  console.log(`\n${"=".repeat(64)}`);
  console.log(problems.length ? `${problems.length} PROBLEM(S):` : "no inconsistencies found");
  problems.forEach((p) => console.log(`  - ${p}`));
  if (problems.length) process.exitCode = 1;
});
