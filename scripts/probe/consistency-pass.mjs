#!/usr/bin/env node
/**
 * Compare overlapping built-tool answers on a seeded recent transaction and
 * public case subjects. `--seed N --tip CHECKPOINT` reproduces the draw.
 * A different scope is reported as a skip, never credited as agreement.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, gql, ROOT, SUI } from "./lib/mcp-client.mjs";
import { attributedCredits, custodyRows, directRootOut, equal, externalCredits, firstHop, fundingAgreement, moveCallTargets, norm, rawNet, suiToMist, transactionAgreement } from "./lib/consistency.mjs";

const argv = process.argv.slice(2);
const arg = (key) => { const i = argv.indexOf(`--${key}`); return i < 0 ? undefined : argv[i + 1]; };
const SEED = arg("seed") === undefined ? Math.floor(Math.random() * 2 ** 32) : Number(arg("seed"));
if (!Number.isInteger(SEED) || SEED < 0 || SEED > 0xffffffff) throw Error("--seed must be a uint32");
const tip = arg("tip") === undefined ? Number((await gql("{ checkpoint { sequenceNumber } }")).checkpoint.sequenceNumber) : Number(arg("tip"));
if (!Number.isSafeInteger(tip) || tip < 10000) throw Error("--tip must be a checkpoint number");
const recent = Math.max(1, tip - 10000 - (SEED % 5000));
const caseFile = JSON.parse(readFileSync(join(ROOT, "cases/incidents/suisses-drainer-2024-04.json"), "utf8"));
const publicTx = caseFile.subjects.first_drain_tx;
const publicWallet = caseFile.subjects.test_wallet;
const publicObject = caseFile.subjects.kit_package_a;
const d = await gql("query($s:UInt53){ checkpoint(sequenceNumber:$s){ transactions(first:50){ nodes{ digest sender{address} kind{__typename} } } } }", { s: recent });
const candidate = d.checkpoint?.transactions?.nodes?.filter((n) => n.sender?.address && n.kind?.__typename === "ProgrammableTransaction") ?? [];
if (!candidate.length) throw Error(`No programmable transaction sampled at checkpoint ${recent}`);
const picked = candidate[SEED % candidate.length];
console.log(`consistency-pass seed=${SEED} tip=${tip} checkpoint=${recent} tx=${picked.digest}`);

/** A defect marker must identify one comparison, subject and reason. Stale markers fail. */
const KNOWN_DEFECTS = [];
const used = new Set();
const counts = new Map();
const failures = [];
function record(name, subject, left, right) {
 const c = counts.get(name) ?? { agree: 0, disagree: 0, skip: 0 };
 counts.set(name, c);
 if (equal(left, right)) { c.agree++; return; }
 c.disagree++;
 const known = KNOWN_DEFECTS.find((k) => k.name === name && k.subject === subject);
 if (known) used.add(known);
 else failures.push({ name, subject, left, right });
 console.log(`${known ? "KNOWN" : "DISAGREE"} ${name} ${subject}: ${JSON.stringify({ left, right, reason: known?.reason }).slice(0, 900)}`);
}
function skip(name, reason) {
 const c = counts.get(name) ?? { agree: 0, disagree: 0, skip: 0 };
 counts.set(name, c); c.skip++;
 console.log(`SKIP ${name}: ${reason}`);
}
const server = await startServer({ name: "consistency-pass", entry: arg("dist") ? join(arg("dist"), "index.js") : undefined });
async function call(tool, args) {
 const r = await server.call(tool, args);
 if (r._error || r._isError || r.error) throw Error(`${tool} ${JSON.stringify(args)}: ${r._error ?? r.error ?? JSON.stringify(r).slice(0, 220)}`);
 return r;
}
async function run(name, work) { try { await work(); } catch (err) { failures.push({ name, error: String(err) }); console.log(`ERROR ${name}: ${err}`); } }
try {
 for (const digest of [picked.digest, publicTx, caseFile.subjects.victim_tx, "8eHgw5hBnALFJKPstXWcPgKjeh1av1CzFAz8n85Primr"]) await run(`transaction ${digest}`, async () => {
  const [one, many, ptb] = await Promise.all([
   call("get_transaction", { digest, detail: "full" }),
   call("get_transactions", { digests: [digest], detail: "full" }),
   call("decode_ptb", { digest }),
  ]);
  const batch = many.transactions?.find((t) => t.digest === digest);
  if (!batch) throw Error("Batch omitted requested digest");
  const shared = transactionAgreement(one, batch);
  if (!batch.balance_changes_truncated)
   record("transaction identity and balance changes", digest, shared.single, shared.batch);
  else skip("transaction identity and balance changes", "the batch could not complete all nested balance changes");
  record("PTB command count", digest, one.command_count, ptb.command_count);
  const shown = new Map(one.commands?.map((command) => [command.index, command]) ?? []);
  const common = ptb.commands?.filter((command) => shown.has(command.index)) ?? [];
  if (common.length) record("resolved PTB commands", digest,
   common.map((command) => shown.get(command.index)), common);
  else skip("resolved PTB commands", "the two independently capped command pages have no shared indices");
  record("PTB sender", digest, norm(one.sender), norm(ptb.sender));
  // The batch's move_calls come from GraphQL commands; decode_ptb resolves the
  // transaction's own BCS. Compared only when both list every call.
  if (!batch.move_calls_truncated && ptb.commands?.length === ptb.command_count)
   record("Move call targets", digest, batch.move_calls.map(norm), moveCallTargets(ptb.commands));
  else skip("Move call targets", "the batch command read or the decode_ptb command page is incomplete");
  if (!batch.object_changes_truncated &&
   (one.object_transfer_count == null || one.object_transfer_count === (one.object_transfers?.length ?? 0)) &&
   batch.object_transfer_count === (batch.object_transfers?.length ?? 0) &&
   (one.created_for_count == null || one.created_for_count === (one.created_for?.length ?? 0)) &&
   batch.created_for_count === (batch.created_for?.length ?? 0)) {
   record("object custody transfers", digest, custodyRows(one.object_transfers), custodyRows(batch.object_transfers));
   record("objects created for others", digest, custodyRows(one.created_for), custodyRows(batch.created_for));
  } else {
   skip("object custody transfers", "the object-change scan or displayed custody rows are incomplete");
   skip("objects created for others", "the object-change scan or displayed custody rows are incomplete");
  }
  // Event fields are absent on the batch archive path, but event types and
  // emitting packages still identify protocols there.
  if (!batch.events_truncated && !many.protocols_unchecked && !one.protocols_unchecked)
   record("transaction protocols", digest, [...one.protocols].sort(), [...batch.protocols].sort());
  else skip("transaction protocols", "bounded events or unread protocol publishers");
 });

 for (const address of [picked.sender.address, publicWallet]) await run(`wallet ${address}`, async () => {
  const [one, many, edges] = await Promise.all([
   call("find_funding_source", { address, max_hops: 1, measure_fanout: false }),
   call("find_funding_sources", { addresses: [address], depth: "first_hop", measure_fanout: false, detail: "full" }),
   call("build_wallet_edges", { addresses: [address], expand: false }),
  ]);
  const f = fundingAgreement(one, many, edges, address);
  if (f.unavailable || one.prices_unavailable_at || many.prices_unavailable_at || one.origin_unread_at || many.origin_unread_at) skip("first funder", f.unavailable ?? "funding price or origin read unavailable");
  else {
   record("first funding transaction", address, firstHop(one), f.batch);
   record("first funding source", address, f.single?.funder ?? null, f.edge);
  }
  const balance = await call("get_balance", { owner: address });
  const overview = await call("get_wallet_overview", { address });
  const later = await call("get_balance", { owner: address });
  // Current gRPC and GraphQL reads are not pinned to one checkpoint. When
  // payments land while these three calls run, no same-state equality follows.
  const sui = overview.holdings?.find((b) => norm(b.coin_type) === norm(SUI));
  if (balance.balance !== later.balance) skip("overview liquid SUI", "wallet changed during the two balance reads");
  else if (sui) record("overview liquid SUI", address, balance.balance, sui.balance);
  else if (!overview.holdings_truncated)
   record("overview liquid SUI", address, balance.balance, "0");
  else skip("overview liquid SUI", "the SUI holding may be beyond the listed page");
  const history = await call("get_transaction_history", { address, limit: 50, detail: "full" });
  for (const row of history.transactions ?? []) {
   if (history.incomplete_transactions?.some((x) => x.digest === row.digest)) continue;
   const batch = await call("get_transactions", { digests: [row.digest], detail: "full" });
   const tx = batch.transactions?.[0];
   if (!tx || tx.balance_changes_truncated) continue;
   const want = row.subject_flow.map((x) => `${norm(x.raw_type)}|${BigInt(x.amount)}`).sort();
   const got = tx.balance_changes.filter((x) => norm(x.address) === norm(address)).map((x) => `${norm(x.coin_type)}|${BigInt(x.amount)}`).sort();
   record("history subject balance flow", `${address} ${row.digest}`, want, got);
   break;
  }
  if (address === publicWallet) await run("historical balance", async () => {
   const checkpoint = Number((await call("get_transaction", { digest: publicTx })).checkpoint);
   const older = await call("get_balance", { owner: address, at_checkpoint: checkpoint, max_transactions: 1000 });
   if (!older.complete || history.has_next_page || history.incomplete_transactions?.length)
    return skip("reconstructed SUI balance", "past read or address history is incomplete");
   const txs = await call("get_transactions", { digests: history.transactions.map((r) => r.digest) });
   const at = new Map(txs.transactions.map((t) => [t.digest, Number(t.checkpoint)]));
   if (at.size !== history.transactions.length || txs.transactions.some((t) => t.balance_changes_truncated))
    return skip("reconstructed SUI balance", "history transaction checkpoint or balance changes missing");
   const laterRows = history.transactions.filter((r) => at.get(r.digest) > checkpoint);
   const gained = BigInt(rawNet(laterRows)[norm(SUI)] ?? "0");
   // A mutable current balance is bracketed by two gRPC reads. A third-party
   // payment between them makes reconciliation inapplicable.
   if (balance.balance === later.balance)
    record("reconstructed SUI balance", address, (BigInt(older.balance) + gained).toString(), balance.balance);
   else skip("reconstructed SUI balance", "wallet balance changed during probe");
  });
  if (address === publicWallet) await run("flow totals and history", async () => {
   const flows = await call("summarize_address_flows", { address, max_transactions: 50, detail: "full" });
   if (flows.coverage?.complete && !flows.coverage?.incomplete_transactions?.length && !flows.gas?.transactions_gas_unread &&
    !history.has_next_page && !history.incomplete_transactions?.length) {
    // The history includes gas in the payer's signed SUI change; flows remove
    // that gas before summing, so SUI can be absent from flows.coins while the
    // history nets to the gas alone. Zero nets carry no amount on either side.
    const scanNet = new Map(flows.coins.map((c) => [norm(c.coin_type), BigInt(c.raw.net)]));
    scanNet.set(norm(SUI), (scanNet.get(norm(SUI)) ?? 0n) - suiToMist(flows.gas.paid_sui));
    const nonzero = (entries) => Object.fromEntries(entries.filter(([, n]) => BigInt(n) !== 0n).map(([c, n]) => [c, String(n)]).sort());
    record("history vs flow coin net", address, nonzero(Object.entries(rawNet(history.transactions))), nonzero([...scanNet]));
    const listed = new Set(history.transactions.map((r) => r.digest));
    for (const source of flows.inflow_sources.filter((r) => !r.more_digests && r.coins?.length))
     record("inflow source digests in history", `${address} ${source.address}`,
      source.digests.every((digest) => listed.has(digest)), true);
    // In a self-sent receipt the history subject_flow includes gas and nets
    // outgoing legs; source rows split inbound value by counterparty. For an
    // exclusively external-credit window the raw inflows must sum exactly.
    const selfCredit = history.transactions.some((row) => norm(row.sender) === norm(address)
     && row.subject_flow.some((item) => BigInt(item.amount) > 0n));
    if (!selfCredit && !flows.unattributed_inflows?.length &&
     flows.inflow_sources.length === flows.inflow_source_count &&
     flows.inflow_sources.every((s) => !s.more_digests))
     record("inflow source amounts vs history credits", address,
      externalCredits(history.transactions, address), attributedCredits(flows.inflow_sources));
    else skip("inflow source amounts vs history credits", "self-paid gas, unattributed credit, or incomplete source rows");
   } else skip("history vs flow coin net", "one list is bounded, incomplete, or has different scope");
   const graph = await call("trace_flow_graph", { address, direction: "forward", max_depth: 1, max_nodes: 1, min_share: 0, detail: "full" });
   if (flows.coverage?.complete && !flows.coverage?.incomplete_transactions?.length && !graph.coverage?.partial) {
    const direct = directRootOut(graph, address);
    if (direct) {
     const out = Object.fromEntries(flows.coins.filter((c) => BigInt(c.raw.out)).map((c) => [norm(c.coin_type), c.raw.out]).sort());
     record("flow vs graph direct root outflows", address, out, direct);
    } else skip("flow vs graph direct root outflows", "conversion, bridge, deposit or root move cap; an edge is not a direct coin send");
   } else skip("flow vs graph direct root outflows", "bounded or incomplete transaction scan");
   const screen = await call("screen_address", { address, direction: "out", hops: 1, max_transactions: 300 });
   if (flows.coverage?.complete && flows.coverage.scanned_transactions <= 300 && screen.windows?.every((w) => !w.truncated && !w.incomplete_transactions?.length))
    record("screen vs flow bridge exits", address, screen.bridge_exits_seen, flows.bridge_exits.transaction_count);
   else skip("screen vs flow bridge exits", "the screen reads recent sent transactions and the flow scan reads affected transactions; one side did not cover the full history");
  });
 });

 await run("positive bridge carrier", async () => {
  const address = caseFile.subjects.consolidator;
  const [flows, screen] = await Promise.all([
   call("summarize_address_flows", { address, max_transactions: 50, detail: "full" }),
   call("screen_address", { address, direction: "out", hops: 1, max_transactions: 300 }),
  ]);
  if (!flows.coverage?.complete || flows.coverage.incomplete_transactions?.length ||
   screen.windows?.some((window) => window.truncated || window.incomplete_transactions?.length))
   return skip("positive bridge carrier", "one bridge scan did not cover the complete address history");
  const screened = screen.exposures.filter((e) => e.category === "bridge" && e.evidence?.startsWith("bridge call or event marker"))
   .map((e) => [e.label, e.exit_count]).sort();
  const scanned = flows.bridge_exits.by_bridge.map((e) => [e.bridge, e.transactions]).sort();
  record("positive bridge carrier", address, { count: screen.bridge_exits_seen, carriers: screened },
   { count: flows.bridge_exits.transaction_count, carriers: scanned });
  record("positive bridge presence", address, screen.bridge_exits_seen > 0, true);
 });

 await run("object classification", async () => {
  const [identity, object] = await Promise.all([call("identify_address", { address: publicObject }), call("get_object", { object_id: publicObject })]);
  record("package identity", publicObject, identity.type, object.object_type === "package" ? "package" : "object");
  const [shared, state] = await Promise.all([call("identify_address", { address: "0x5" }), call("get_object", { object_id: "0x5" })]);
  record("shared object classification", "0x5", { type: shared.type, owner: shared.owner, object_type: norm(shared.object_type) },
   { type: state.owner?.startsWith("shared") ? "shared_object" : "object", owner: state.owner, object_type: norm(state.object_type) });
 });
 await run("single-transaction profit", async () => {
  const attacker = caseFile.subjects.collector_1;
  const digest = publicTx;
  const tx = await call("get_transaction", { digest });
  const [attack, losses] = await Promise.all([
   call("analyze_attack_tx", { digest, attacker }),
   call("summarize_incident_losses", { digests: [digest], attacker, price_at: tx.timestamp }),
  ]);
  if (losses.transactions_read !== 1 || losses.window_truncated || losses.totals?.objects_partial)
   return skip("single-transaction profit", "incident read or object valuation incomplete");
  // One transaction priced at its timestamp uses the same historical quote.
  // With no outgoing transfer by the named beneficiary, the incident's
  // transfers_out exclusion cannot change its USD net.
  if (losses.transfers_out?.length)
   return skip("single-transaction profit", "incident excludes the named party's onward transfers");
  const single = { net: attack.profit?.usd_net ?? null, gained: attack.profit?.usd_gained ?? null };
  const incident = { net: losses.totals?.usd_net ?? null, gained: losses.totals?.usd_gained ?? null };
  // Two unpriced answers agree on nothing.
  if (single.net === null && incident.net === null)
   return skip("single-transaction profit", "no historical price on either side");
  record("single-transaction profit", digest, single, incident);
 });
} finally { server.stop(); }
for (const [name, count] of counts) console.log(`${name}: ${count.agree} agree, ${count.disagree} disagree, ${count.skip} skipped`);
for (const k of KNOWN_DEFECTS) if (!used.has(k)) failures.push({ name: k.name, error: `stale KNOWN_DEFECTS entry for ${k.subject}` });
if (failures.length) { console.log(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
