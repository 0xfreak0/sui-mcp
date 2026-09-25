#!/usr/bin/env node
/**
 * Incident pass: the 1.19 investigation tools, replayed on two public exploits.
 *
 * Unit tests cover these tools' pure logic, and every bug found after 1.19.0
 * shipped was outside it: arguments, service shapes, and the seams between
 * tools. This drives the built server over stdio, the way a client does, and
 * checks what it says about the Cetus (2025-05-22) and Nemo (2025-09-07)
 * exploits. Where the chain can answer the same question directly, the tool's
 * answer is compared with a raw read; the rest pin facts that cannot change,
 * because both incidents are history.
 */
import { startServer, gql, rawNet, checker, short, SUI } from "./lib/mcp-client.mjs";

const NEMO_ATTACKER = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
const NEMO_EXPLOIT = "19Zkat1xArMTMvPCB4e4QtM5HstpYiKvgPjbvkLUAw9";
const NEMO_ROOT = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const NEMO_V5 = "0xef9cb9a0fefb8d304e793ab029d4a6b3f08877aac2d1a848f2dc3b2578d1c66f";
const NEMO_UPGRADER = "0xf55cc609b13e87470d3da78d39ad6f84458a8059eb06aa66f94103d775e8a663";
const NEMO_CCTP_DEST = "0x135477aa627a3bcc3223bde10dd8e7c55a1f645c";
const CETUS_ATTACKER = "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06";
const CETUS_MAYAN_EXIT = "6jMEFeap2GqxedFJPrQckmPwC78FeFodmkdCCjnFRWWb";
const CETUS_BENEFICIARY = "0x89012a55cd6b88e407c9d4ae9b3425f55924919b";
const BINANCE_DEPOSIT = "0x01740e57b294476b0ea72ead41ea91689c280b9277e0dcde98024c779f3a4efe";
const BINANCE_HOT = "0x935029ca5219502a47ac9b69f556ccf6e2198b5e7815cf50f68846f723739cbd";

const { call, callRaw, stop } = await startServer({ name: "incident-pass" });
const { ck, finish } = checker();

try {

  // ---- analyze_attack_tx: the attacker's net against the raw balance change
  console.log("\nanalyze_attack_tx on the Nemo exploit");
  const attack = await call("analyze_attack_tx", { digest: NEMO_EXPLOIT });
  const row = (attack.addresses ?? []).find((a) => a.address === NEMO_ATTACKER);
  const reported = row?.coins?.find((c) => c.coin_type === SUI)?.amount;
  const raw = await rawNet([NEMO_EXPLOIT], NEMO_ATTACKER, SUI);
  ck("attacker's SUI net matches the chain", reported !== undefined && BigInt(reported) === raw, `${reported} vs ${raw}`);
  ck("profit is priced in USD", typeof attack.profit?.usd_net === "number" && attack.profit.usd_net > 0, short(attack.profit?.usd_net));

  // ---- summarize_address_flows: the CCTP exits against the raw debits ------
  console.log("\nsummarize_address_flows on the Nemo attacker, 2025-09-07");
  const flows = await call("summarize_address_flows", {
    address: NEMO_ATTACKER,
    from: "2025-09-07T00:00:00Z",
    to: "2025-09-08T00:00:00Z",
  });
  const cctp = (flows.bridge_exits?.by_bridge ?? []).find((b) => /CCTP/i.test(b.bridge));
  const dest = cctp?.destinations?.find((d) => d.address?.toLowerCase() === NEMO_CCTP_DEST);
  ck("the CCTP exits pay the address Nemo's report names", !!dest, short(JSON.stringify(cctp?.destinations?.map((d) => d.address))));
  const exitDigests = (flows.bridge_exits?.transactions ?? []).filter((t) => /CCTP/i.test(t.bridge)).map((t) => t.digest);
  ck("eight CCTP exits", exitDigests.length === 8, `${exitDigests.length}`);
  ck("the scan covered the whole day", flows.coverage?.complete === true, short(JSON.stringify(flows.coverage)));

  // ---- trace_funds: a malicious label is followed, and the exit is reached --
  console.log("\ntrace_funds forward from the Nemo exploit");
  const trace = await call("trace_funds", { digest: NEMO_EXPLOIT, direction: "forward", hops: 10 });
  ck("the trace goes past the attacker", (trace.hops?.length ?? 0) >= 2, `${trace.hops?.length} hops`);
  ck("it stops at the CCTP exit", /CCTP/.test(trace.stop_reason ?? ""), short(trace.stop_reason));

  // ---- trace_flow_graph: the same exit, with its beneficiary ---------------
  console.log("\ntrace_flow_graph forward from the Nemo exploit");
  const graph = await call("trace_flow_graph", { digest: NEMO_EXPLOIT });
  const exits = (graph.terminals ?? []).filter((t) => t.reason === "bridge_exit");
  const graphText = JSON.stringify(exits);
  ck("a bridge exit pays the Nemo CCTP destination", graphText.toLowerCase().includes(NEMO_CCTP_DEST), `${exits.length} exit groups`);

  // ---- find_funding_source: the walk stops at the exchange-scale funder ----
  console.log("\nfind_funding_source on the Nemo attacker");
  const funding = await call("find_funding_source", { address: NEMO_ATTACKER });
  ck("the walk stops at a high-fanout funder", /high-fanout/.test(funding.stop_reason ?? ""), short(funding.stop_reason));

  // ---- get_balance: the reconstruction against a raw sum -------------------
  console.log("\nget_balance reconstructed before the Nemo exploit");
  const bal = await call("get_balance", { owner: NEMO_ATTACKER, at: "2025-09-07T16:00:00Z" });
  ck("reconstructed and complete", bal.method === "reconstructed" && bal.complete === true, `${bal.method} ${bal.complete}`);
  // The wallet was created that morning; everything it had at 16:00 arrived
  // in the transactions before then.
  const early = await gql(
    `query($a:SuiAddress!,$cp:UInt53!){ transactions(first:50, filter:{affectedAddress:$a, beforeCheckpoint:$cp}){ nodes { digest } } }`,
    { a: NEMO_ATTACKER, cp: Number(bal.at_checkpoint) + 1 },
  );
  const sum = await rawNet((early?.transactions?.nodes ?? []).map((n) => n.digest), NEMO_ATTACKER, SUI);
  ck("equals the sum of every earlier balance change", bal.balance === sum.toString(), `${bal.balance} vs ${sum}`);

  // ---- get_upgrade_history: who could upgrade at the exploit ---------------
  console.log("\nget_upgrade_history as of the Nemo exploit");
  const up = await call("get_upgrade_history", { package: NEMO_ROOT, as_of: "2025-09-07T16:03:00Z" });
  ck("the single key held the UpgradeCap", up.as_of?.holder?.address === NEMO_UPGRADER || up.as_of?.holder === NEMO_UPGRADER, short(JSON.stringify(up.as_of?.holder)));
  ck("version 10 was the newest", up.as_of?.newest_version?.version === 10, `${up.as_of?.newest_version?.version}`);
  ck("the v10 cap round trip is flagged", (up.flags ?? []).some((f) => f.kind === "cap_round_trip"), (up.flags ?? []).map((f) => f.kind).join(","));

  // ---- disassemble_module: each version's own bytecode ---------------------
  console.log("\ndisassemble_module per version");
  const v1 = await call("disassemble_module", { package_id: NEMO_ROOT, module_name: "py" });
  const v5 = await call("disassemble_module", { package_id: NEMO_V5, module_name: "py" });
  ck("v1 has no redeem_pt, which v5 added", !String(v1.disassembly).includes("redeem_pt") && String(v5.disassembly).includes("redeem_pt"));

  // ---- export_case: value out of the Nemo markets has an arrow -------------
  console.log("\nexport_case diagram");
  await call("save_finding", {
    case_name: "incident-pass",
    title: "Exploit proceeds",
    evidence_tier: "chain-derived",
    addresses: [NEMO_ATTACKER],
    digests: [NEMO_EXPLOIT],
  });
  const report = await call("export_case", { case_name: "incident-pass", format: "mermaid" });
  const text = report._text ?? "";
  ck("the diagram draws Nemo's shared objects paying the attacker", /Nemo[^\n]*shared objects/.test(text) && /-->\|"[\d.]+ SUI"\|/.test(text));

  // ---- Cetus: the Mayan beneficiary, and the attacker's screen -------------
  console.log("\nCetus");
  const mayan = await call("resolve_bridge_transfer", { digest: CETUS_MAYAN_EXIT });
  ck("Mayan exit names the attacker's Ethereum wallet", JSON.stringify(mayan.beneficiaries ?? []).toLowerCase().includes(CETUS_BENEFICIARY));
  const screen = await call("screen_address", { address: CETUS_ATTACKER });
  const subject = screen.subject?.label;
  ck("the attacker's label cites its source", subject?.category === "malicious" && /^https:/.test(subject?.source_url ?? ""), short(JSON.stringify(subject)));

  // ---- classify_deposit_address: a Binance deposit address -----------------
  console.log("\nclassify_deposit_address");
  const dep = await call("classify_deposit_address", { address: BINANCE_DEPOSIT });
  ck("a Binance deposit address is likely", dep.verdict === "likely", dep.verdict);
  ck("it sweeps to the Binance hot wallet", dep.hot_wallet === BINANCE_HOT || dep.hot_wallet?.address === BINANCE_HOT, short(JSON.stringify(dep.hot_wallet)));

  // ---- size: the summary default holds --------------------------------------
  const pkg = await callRaw("analyze_package", { package_id: "0x2" });
  const chars = (pkg.result?.content ?? []).reduce((n, c) => n + (c.text?.length ?? 0), 0);
  ck("analyze_package 0x2 stays under 60k characters", chars > 0 && chars < 60_000, `${chars}`);
} finally {
  stop();
}
finish();
