#!/usr/bin/env node
/**
 * Attribution pass: the funding, clustering, multisig, event, history and
 * holder tools, each checked against a raw mainnet read of the same fact.
 *
 * Most facts are pinned to the Nemo exploit (2025-09-07), which is history.
 * Where a value moves (a current balance, the newest page of an address), the
 * raw read is taken in the same run. Every call's latency and size is recorded;
 * a call over 60s, or over 100k characters for a tool that does not declare a
 * larger result on purpose, fails the run. Each tool also gets one malformed
 * input and must refuse it with a message.
 */
import { startServer, gql as gqlOnce, checker, short, SUI } from "./lib/mcp-client.mjs";

/** Raw GraphQL, retried: four probes share the public endpoint, and it answers bursts with an HTML 429. */
async function gql(query, variables) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await gqlOnce(query, variables);
    } catch (err) {
      if (attempt >= 6 || !/429|Unexpected token|fetch failed/.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/** One address's net change in one coin across the digests, read straight from the chain. */
async function rawNet(digests, address, coinType) {
  let net = 0n;
  for (const digest of digests) {
    for (let after = null; ; ) {
      const d = await gql(
        `query($d:String!,$a:String){ transaction(digest:$d){ effects { balanceChanges(first:50, after:$a){ pageInfo { hasNextPage endCursor } nodes { owner { address } coinType { repr } amount } } } } }`,
        { d: digest, a: after },
      );
      const conn = d?.transaction?.effects?.balanceChanges;
      for (const n of conn?.nodes ?? []) if (n.owner?.address === address && n.coinType?.repr === coinType) net += BigInt(n.amount);
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  }
  return net;
}

const NEMO = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
const FUNDER = "0x1f7b27844f2c4a0262b2c481f7ab956d10ace524c5a7b06c3742cfb8701db714";
const PAYER = "0x9e5590502b03b0172d0b78f4ddbaebd48dcaf7e2a7778ba18c0de2110bd6aacb";
const NEMO_ROOT = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const NEMO_EXPLOIT = "19Zkat1xArMTMvPCB4e4QtM5HstpYiKvgPjbvkLUAw9";
const NEMO_MULTISIG = "0xaa71d7166a7f7df65cd0e33b5adc2c53028f31605864a76887180415d604ac8e";
const FIRST_FUNDING = "FjkAurXTGnmq4uiMr1yWETvRCtYWmVpFbrD9MGSyUc3S";
const PAYMENTS = ["AgicqTF1VBy9uvkakh99hu9Hxi1EVF1obybpcyCuPxuB", "GmQYqgkALQKkSgZqjobfVxy1hsGqDDThXpi58MNgpmty"];
const BINANCE_DEPOSIT = "0x01740e57b294476b0ea72ead41ea91689c280b9277e0dcde98024c779f3a4efe";
const BINANCE_HOT = "0x935029ca5219502a47ac9b69f556ccf6e2198b5e7815cf50f68846f723739cbd";
const MS_2OF3 = "0xa1eb94d1700652aa85b417b46fa6775575b8b98d3352d864fb5146eb45d335fb";
const VALIDATOR = "0x8f8ea04f3b751533db8b8da0a40eba1ca8332a92680f058d83b9459d061aaa54";
// A USDC coin the attacker burned through CCTP in 9ZzZ6C8m… (deleted there).
const DELETED_COIN = "0x7498926d5be30eef3f0369b928b00476d67102caefdc441613d912f917d3d857";
const DELETED_COIN_VERSION = "632502608";
const XAGM = "0x64bddec0f898ccaa022b8a6e0a5f75d80f53177b87a9795dd15aefe9ac12ee6c::xagm::XAGM";
const XAGM_ADDRESS_BALANCE_HOLDER = "0xd70a55ed5e308536775e6504ada347d650782a77e6d269716fd38101c03be880";
const GNOME = "0xe81341eba87d19f8d53ee237b3666cff6a74c9fd7a960cf5753af69bc7c6a221::gnomes::Gnome";
const SWAP_EVENT = `${NEMO_ROOT}::market::SwapEvent`;
const SWAP_FROM = "2025-09-07T15:30:00Z";
const SWAP_TO = "2025-09-07T17:00:00Z";
const WIN_FROM = "2025-09-07T16:00:00Z";
const WIN_TO = "2025-09-07T16:30:00Z";

const server = await startServer({ name: "attribution-pass" });
const { ck, finish } = checker();

// ---- the call wrapper: latency and size for every call --------------------
const listed = await server.rpc("tools/list", {});
const declaredSize = new Map(
  (listed.result?.tools ?? []).map((t) => [t.name, t._meta?.["anthropic/maxResultSizeChars"] ?? 100_000]),
);
const calls = [];
async function call(tool, args, timeoutMs) {
  const msg = await server.callRaw(tool, args, timeoutMs);
  const texts = (msg.result?.content ?? []).map((c) => c.text ?? "");
  const size = texts.reduce((n, t) => n + t.length, 0);
  calls.push({ tool, ms: msg.ms, size });
  if (msg.error) return { _error: msg.error.message, _ms: msg.ms };
  const json = texts.find((t) => t.trim().startsWith("{"));
  const out = json ? JSON.parse(json) : { _text: texts.join("\n") };
  if (msg.result.isError) out._isError = true;
  out._ms = msg.ms;
  return out;
}

// ---- raw reads ------------------------------------------------------------
/** Every transaction touching `address` in (after, before), oldest first. */
async function rawTxs(address, { after = null, before = null, limit = 5000 } = {}) {
  const out = [];
  let cursor = null;
  for (;;) {
    const d = await gql(
      `query($a:SuiAddress!,$c:String,$af:UInt53,$bf:UInt53){ transactions(first:50, after:$c, filter:{affectedAddress:$a, afterCheckpoint:$af, beforeCheckpoint:$bf}){ pageInfo{hasNextPage endCursor} nodes{ digest sender{address} effects{ timestamp checkpoint{sequenceNumber} } } } }`,
      { a: address, c: cursor, af: after, bf: before },
    );
    out.push(...d.transactions.nodes);
    if (!d.transactions.pageInfo.hasNextPage || out.length >= limit) return out;
    cursor = d.transactions.pageInfo.endCursor;
  }
}
const rawSender = async (digest) =>
  (await gql(`query($d:String!){ transaction(digest:$d){ sender{address} } }`, { d: digest })).transaction?.sender?.address;
const rawBalance = async (owner, coinType = SUI) =>
  (await gql(`query($a:SuiAddress!,$t:String!){ address(address:$a){ balance(coinType:$t){ totalBalance } } }`, { a: owner, t: coinType }))
    .address?.balance?.totalBalance;
const checkpointMs = async (seq) =>
  Date.parse((await gql(`query($s:UInt53!){ checkpoint(sequenceNumber:$s){ timestamp } }`, { s: seq })).checkpoint.timestamp);
/** A window's exclusive checkpoints hold exactly the checkpoints stamped inside [from, to]. */
async function bracketsExactly(after, before, from, to) {
  const [a, a1, b1, b] = await Promise.all([checkpointMs(after), checkpointMs(after + 1), checkpointMs(before - 1), checkpointMs(before)]);
  return a < Date.parse(from) && a1 >= Date.parse(from) && b1 <= Date.parse(to) && b > Date.parse(to);
}
/** Every event of `type` in (after, before), oldest first. */
async function rawEvents(type, after, before) {
  const out = [];
  let cursor = null;
  for (;;) {
    const d = await gql(
      `query($t:String!,$c:String,$af:UInt53,$bf:UInt53){ events(first:50, after:$c, filter:{type:$t, afterCheckpoint:$af, beforeCheckpoint:$bf}){ pageInfo{hasNextPage endCursor} nodes{ sender{address} timestamp transaction{ digest } } } }`,
      { t: type, c: cursor, af: after, bf: before },
    );
    out.push(...d.events.nodes);
    if (!d.events.pageInfo.hasNextPage) return out;
    cursor = d.events.pageInfo.endCursor;
  }
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

try {
  // ---- find_funding_source ------------------------------------------------
  console.log("\nfind_funding_source on the Nemo attacker");
  const ffs = await call("find_funding_source", { address: NEMO });
  const hop1 = ffs.chain?.[0];
  const firstTx = (await rawTxs(NEMO, { limit: 1 }))[0];
  ck("the first funder is the sender of the address's first transaction", hop1?.funded_by === FUNDER && firstTx?.digest === FIRST_FUNDING && firstTx?.sender?.address === FUNDER, `${short(hop1?.funding_tx)} vs ${firstTx?.digest}`);
  const firstIn = await rawNet([FIRST_FUNDING], NEMO, SUI);
  ck("the funding amount is the attacker's balance change in it", hop1?.amount === `${Number(firstIn) / 1e9} SUI`, `${hop1?.amount} vs ${firstIn}`);

  // ---- find_funding_sources -----------------------------------------------
  console.log("\nfind_funding_sources on the attacker and its two funders");
  const batch = await call("find_funding_sources", { addresses: [NEMO, FUNDER, PAYER] });
  const paid = (batch.subject_paid_subject ?? []).filter((p) => p.payer === PAYER && p.payee === NEMO).map((p) => p.digest);
  ck("0x9e55 paid the attacker in exactly the two known transactions", sameSet(paid, PAYMENTS), short(paid));
  for (const d of PAYMENTS) {
    const [sender, net] = [await rawSender(d), await rawNet([d], NEMO, SUI)];
    const row = batch.subject_paid_subject?.find((p) => p.digest === d);
    ck(`${d.slice(0, 8)}: signed by 0x9e55, and the attacker's gain matches`, sender === PAYER && row?.received?.[0] === `${Number(net) / 1e9} SUI`, `${sender?.slice(0, 8)} ${row?.received} vs ${net}`);
  }

  // ---- get_address_fanout -------------------------------------------------
  console.log("\nget_address_fanout on the attacker, against a raw scan of its history");
  const fan = await call("get_address_fanout", { address: NEMO });
  const history = await rawTxs(NEMO);
  const recipients = new Set();
  const senders = new Set();
  for (const t of history) {
    let after = null;
    const changes = [];
    for (;;) {
      const d = await gql(
        `query($d:String!,$a:String){ transaction(digest:$d){ gasInput{ gasSponsor{address} } effects{ balanceChanges(first:50, after:$a){ pageInfo{hasNextPage endCursor} nodes{ owner{address} coinType{repr} amount } } } } }`,
        { d: t.digest, a: after },
      );
      const conn = d.transaction.effects.balanceChanges;
      changes.push(...conn.nodes.map((n) => ({ ...n, sponsor: d.transaction.gasInput?.gasSponsor?.address })));
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    const sender = t.sender?.address;
    const gasOnly = (c) => c.sponsor && c.sponsor !== sender && c.owner?.address === c.sponsor && c.coinType?.repr === SUI;
    const own = BigInt(changes.find((c) => c.owner?.address === NEMO && !gasOnly(c))?.amount ?? "0");
    for (const c of changes) {
      if (!c.owner?.address || c.owner.address === NEMO || gasOnly(c)) continue;
      if (own < 0n && BigInt(c.amount) > 0n) recipients.add(c.owner.address);
      if (own > 0n && BigInt(c.amount) < 0n) senders.add(c.owner.address);
    }
  }
  ck("scanned every transaction the address has", fan.scanned_transactions === history.length && fan.truncated === false, `${fan.scanned_transactions} vs ${history.length}`);
  ck("recipient and sender counts match the raw scan", fan.recipient_count === recipients.size && fan.sender_count === senders.size, `${fan.recipient_count}/${fan.sender_count} vs ${recipients.size}/${senders.size}`);
  ck("both known funders are among its senders", senders.has(FUNDER) && senders.has(PAYER));

  // ---- classify_deposit_address -------------------------------------------
  console.log("\nclassify_deposit_address");
  const dep = await call("classify_deposit_address", { address: BINANCE_DEPOSIT });
  const sweep = dep.sweeps?.[0]?.digest;
  const swept = sweep ? await rawNet([sweep], BINANCE_HOT, dep.sweeps[0].coins?.[0]?.coin_type ?? SUI) : 0n;
  ck("a Binance deposit address is likely, sweeping to the hot wallet", dep.verdict === "likely" && (dep.hot_wallet === BINANCE_HOT || dep.hot_wallet?.address === BINANCE_HOT), short(dep.verdict));
  ck("its newest sweep credits the hot wallet on chain", swept > 0n, `${sweep} +${swept}`);
  const notDep = await call("classify_deposit_address", { address: NEMO });
  ck("the attacker's own wallet is not a deposit address", notDep.verdict !== "likely", notDep.verdict);

  // ---- screen_address -----------------------------------------------------
  console.log("\nscreen_address on the attacker");
  const screen = await call("screen_address", { address: NEMO, hops: 1 });
  const cctp = (screen.exposures ?? []).find((e) => e.category === "bridge" && /CCTP/.test(e.label ?? ""));
  const cctpSenders = await Promise.all((cctp?.digests ?? []).map(rawSender));
  ck("eight CCTP exits, each signed by the attacker", cctp?.exit_count === 8 && cctpSenders.length === 8 && cctpSenders.every((s) => s === NEMO), short(cctp?.exit_count));
  ck("the subject's own label is malicious and cited", screen.subject?.label?.category === "malicious" && /^https:/.test(screen.subject?.label?.source_url ?? ""));

  // ---- build_wallet_edges -------------------------------------------------
  console.log("\nbuild_wallet_edges on the attacker and 0x9e55");
  const edges = await call("build_wallet_edges", { addresses: [NEMO, PAYER], expand: false });
  const excluded = (edges.excluded_intermediaries ?? []).find((x) => x.address === FUNDER);
  ck("0x1f7b is discarded as a hub, at the count find_funding_source measured", excluded?.observed_counterparties > 50 && excluded.observed_counterparties === hop1?.funder_popularity?.observed_recipients, `${excluded?.observed_counterparties} vs ${hop1?.funder_popularity?.observed_recipients}`);
  // The attacker never paid 0x9e55 (raw: no attacker-sent transaction credits it), so the payments are one-way.
  const backFlow = await rawNet(history.filter((t) => t.sender?.address === NEMO).map((t) => t.digest), PAYER, SUI);
  ck("one-way payments make no reciprocal edge", backFlow === 0n && !(edges.edges ?? []).some((e) => /reciprocal/.test(JSON.stringify(e))), `${backFlow}`);

  // ---- aggregate_events, plain and group_pnl -------------------------------
  console.log("\naggregate_events on Nemo's SwapEvent, 15:30-17:00");
  const agg = await call("aggregate_events", { event_type: SWAP_EVENT, from: SWAP_FROM, to: SWAP_TO, group_pnl: true });
  const w = agg.window ?? {};
  ck("the window is exactly the checkpoints stamped inside it", await bracketsExactly(w.after_checkpoint, w.before_checkpoint, SWAP_FROM, SWAP_TO), `${w.after_checkpoint}-${w.before_checkpoint}`);
  const events = await rawEvents(SWAP_EVENT, w.after_checkpoint, w.before_checkpoint);
  const bySender = new Map();
  for (const e of events) bySender.set(e.sender.address, (bySender.get(e.sender.address) ?? 0) + 1);
  ck("event and sender counts match a raw scan", agg.events_scanned === events.length && agg.distinct_keys === bySender.size && agg.truncated === false, `${agg.events_scanned}/${agg.distinct_keys} vs ${events.length}/${bySender.size}`);
  const top = agg.groups?.[0];
  ck("the top sender is the attacker, at the raw count", top?.key === NEMO && top.event_count === bySender.get(NEMO), `${top?.event_count} vs ${bySender.get(NEMO)}`);
  const attackerTxs = [...new Set(events.filter((e) => e.sender.address === NEMO).map((e) => e.transaction.digest))];
  const pnl = agg.pnl?.senders?.find((s) => s.sender === NEMO);
  const pnlSui = pnl?.net?.find((c) => c.coin_type === SUI)?.amount;
  const rawSui = await rawNet(attackerTxs, NEMO, SUI);
  ck("group_pnl: the attacker's transactions and SUI net equal rawNet over them", pnl?.transactions === attackerTxs.length && Math.abs(pnlSui - Number(rawSui) / 1e9) < 1e-6, `${pnl?.transactions} tx, ${pnlSui} vs ${Number(rawSui) / 1e9}`);

  // ---- sample_control_addresses -------------------------------------------
  console.log("\nsample_control_addresses from the same population");
  const control = await call("sample_control_addresses", { event_type: SWAP_EVENT, from: SWAP_FROM, to: SWAP_TO, size: 5, seed: 7, exclude: [NEMO] });
  ck("drawn over the same window as aggregate_events", control.window?.after_checkpoint === w.after_checkpoint && control.window?.before_checkpoint === w.before_checkpoint, short(control.window));
  ck("population is every raw sender but the cohort", control.population_size === bySender.size - 1, `${control.population_size} vs ${bySender.size - 1}`);
  ck("every drawn address is in the population, none is the cohort", control.addresses?.length === 5 && control.addresses.every((a) => bySender.has(a) && a !== NEMO));

  // ---- query_events -------------------------------------------------------
  console.log("\nquery_events over the same window");
  const qNew = await call("query_events", { event_type: SWAP_EVENT, after_checkpoint: SWAP_FROM, before_checkpoint: SWAP_TO, limit: 20 });
  const qOld = await call("query_events", { event_type: SWAP_EVENT, after_checkpoint: SWAP_FROM, before_checkpoint: SWAP_TO, limit: 20, order: "oldest" });
  const sig = (e) => `${e.sender?.address ?? e.sender}@${e.timestamp}`;
  ck("newest page is the last 20 raw events, newest first", sameSet((qNew.events ?? []).map((e) => e.sender), events.slice(-20).map((e) => e.sender.address)) && qNew.newest_shown === events.at(-1).timestamp, `${qNew.newest_shown} vs ${events.at(-1).timestamp}`);
  ck("oldest page is the first 20 raw events", qOld.oldest_shown === events[0].timestamp && qOld.newest_shown === events[19].timestamp, `${qOld.oldest_shown} vs ${sig(events[0])}`);

  // ---- build_timeline -----------------------------------------------------
  console.log("\nbuild_timeline: ISO window and checkpoint window");
  const tlIso = await call("build_timeline", { addresses: [NEMO], from: WIN_FROM, to: WIN_TO, per_address: 50, limit: 100 });
  const tw = tlIso.window ?? {};
  const tlCp = await call("build_timeline", { addresses: [NEMO], from: String(tw.after_checkpoint), to: String(tw.before_checkpoint), per_address: 50, limit: 100 });
  const rawWin = await rawTxs(NEMO, { after: tw.after_checkpoint, before: tw.before_checkpoint });
  const isoDigests = (tlIso.timeline ?? []).map((e) => e.digest);
  ck("the ISO window is exactly the checkpoints stamped inside it", await bracketsExactly(tw.after_checkpoint, tw.before_checkpoint, WIN_FROM, WIN_TO));
  ck("ISO and checkpoint windows return the same transactions", isoDigests.join() === (tlCp.timeline ?? []).map((e) => e.digest).join(), `${isoDigests.length} vs ${tlCp.timeline?.length}`);
  ck("and they are every raw transaction in the window", sameSet(isoDigests, rawWin.map((t) => t.digest)) && tlIso.coverage?.[0]?.truncated === false, `${isoDigests.length} vs ${rawWin.length}`);
  const exploitRow = tlIso.timeline?.find((e) => e.digest === NEMO_EXPLOIT);
  const exploitSui = exploitRow?.subject_flow?.[NEMO]?.find((c) => c.raw_type === SUI)?.amount;
  ck("the exploit row's subject_flow is the raw SUI change", exploitSui === (await rawNet([NEMO_EXPLOIT], NEMO, SUI)).toString(), short(exploitSui));

  // ---- query_transactions -------------------------------------------------
  console.log("\nquery_transactions");
  const all = history.map((t) => t.digest);
  const qtNew = await call("query_transactions", { affected_address: NEMO, limit: 5 });
  const qtOld = await call("query_transactions", { affected_address: NEMO, limit: 5, order: "oldest" });
  ck("newest first: the last 5 raw transactions, newest first", (qtNew.transactions ?? []).map((t) => t.digest).join() === all.slice(-5).reverse().join());
  ck("oldest first: the first 5 raw transactions", (qtOld.transactions ?? []).map((t) => t.digest).join() === all.slice(0, 5).join());
  const qtWin = await call("query_transactions", { affected_address: NEMO, after_checkpoint: WIN_FROM, before_checkpoint: WIN_TO, limit: 50, include_functions: true });
  ck("ISO bounds: every raw transaction in the window", sameSet((qtWin.transactions ?? []).map((t) => t.digest), rawWin.map((t) => t.digest)));
  const cmds = [];
  for (let after = null; ; ) {
    const d = await gql(
      `query($d:String!,$a:String){ transaction(digest:$d){ kind{ ... on ProgrammableTransaction { commands(first:50, after:$a){ pageInfo{hasNextPage endCursor} nodes{ __typename ... on MoveCallCommand { function { name module { name package { address } } } } } } } } } }`,
      { d: NEMO_EXPLOIT, a: after },
    );
    const conn = d.transaction.kind.commands;
    cmds.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  const rawCalls = cmds.filter((c) => c.function).map((c) => `${c.function.module.package.address}::${c.function.module.name}::${c.function.name}`);
  const counted = new Map();
  for (const c of rawCalls) counted.set(c, (counted.get(c) ?? 0) + 1);
  const expected = [...counted].map(([c, n]) => (n > 1 ? `${c} ×${n}` : c));
  const row = qtWin.transactions?.find((t) => t.digest === NEMO_EXPLOIT);
  ck("include_functions: the exploit's Move calls, each with its raw count", row?.move_calls?.join() === expected.join(), `${row?.move_calls?.length} vs ${expected.length}`);
  const marketCall = rawCalls.find((c) => /::market::/.test(c));
  const [pkg, , fn] = marketCall.split("::");
  const withV = await call("query_transactions", { function: `${NEMO_ROOT}::market::${fn}`, after_checkpoint: "2025-09-07T16:05:00Z", before_checkpoint: "2025-09-07T16:05:30Z", all_versions: true, limit: 50 });
  const rootOnly = await call("query_transactions", { function: `${NEMO_ROOT}::market::${fn}`, after_checkpoint: "2025-09-07T16:05:00Z", before_checkpoint: "2025-09-07T16:05:30Z", limit: 50 });
  ck(`all_versions finds the exploit, which called ${pkg.slice(0, 10)}… (not the root)`, pkg !== NEMO_ROOT && (withV.transactions ?? []).some((t) => t.digest === NEMO_EXPLOIT) && !(rootOnly.transactions ?? []).some((t) => t.digest === NEMO_EXPLOIT));

  // ---- check_activity -----------------------------------------------------
  console.log("\ncheck_activity");
  const since = await call("check_activity", { address: NEMO, since_timestamp: "2025-09-07T16:20:00Z", limit: 50 });
  const rawSince = history.filter((t) => Date.parse(t.effects.timestamp) > Date.parse("2025-09-07T16:20:00Z"));
  ck("since a time: every later raw transaction, oldest first", (since.transactions ?? []).map((t) => t.digest).join() === rawSince.map((t) => t.digest).join(), `${since.transactions?.length} vs ${rawSince.length}`);
  const latest = await call("check_activity", { address: NEMO, limit: 3 });
  ck("no baseline: the newest 3, newest first", (latest.transactions ?? []).map((t) => t.digest).join() === all.slice(-3).reverse().join());

  // ---- get_transaction_history --------------------------------------------
  console.log("\nget_transaction_history");
  const hist = await call("get_transaction_history", { address: NEMO, limit: 10 });
  ck("the newest page is the raw last 10, newest first", (hist.transactions ?? []).map((t) => t.digest).join() === all.slice(-10).reverse().join());
  const histOld = await call("get_transaction_history", { address: NEMO, limit: 3, order: "oldest" });
  const firstRow = histOld.transactions?.[0];
  ck("subject_flow of the first funding equals rawNet", firstRow?.digest === FIRST_FUNDING && firstRow.subject_flow?.[0]?.amount === firstIn.toString(), short(firstRow?.subject_flow));

  // ---- get_transaction / get_transactions ---------------------------------
  console.log("\nget_transaction and get_transactions");
  const tx = await call("get_transaction", { digest: NEMO_EXPLOIT });
  const txSui = tx.balance_changes?.find((b) => b.address === NEMO && b.coin_type === SUI)?.amount;
  ck("command count and the attacker's SUI change match the chain", tx.command_count === cmds.length && txSui === (await rawNet([NEMO_EXPLOIT], NEMO, SUI)).toString(), `${tx.command_count} vs ${cmds.length}`);
  const txs = await call("get_transactions", { digests: [FIRST_FUNDING, ...PAYMENTS] });
  const got = Object.fromEntries((txs.transactions ?? []).map((t) => [t.digest, t.sender]));
  ck("each digest's sender is the chain's", got[FIRST_FUNDING] === FUNDER && PAYMENTS.every((d) => got[d] === PAYER), short(got));

  // ---- get_balance --------------------------------------------------------
  console.log("\nget_balance: current, consistent read, reconstructed");
  const [cur, curRaw] = [await call("get_balance", { owner: NEMO }), await rawBalance(NEMO)];
  ck("current balance equals the raw read", cur.balance === curRaw, `${cur.balance} vs ${curRaw}`);
  const cons = await call("get_balance", { owner: NEMO, at: new Date(Date.now() - 10 * 60_000).toISOString() });
  ck("a point ten minutes ago is a consistent read of the same balance", cons.method === "consistent_read" && cons.balance === curRaw, `${cons.method} ${cons.balance}`);
  const recon = await call("get_balance", { owner: NEMO, at: "2025-09-07T16:10:00Z" });
  const before = history.filter((t) => Number(t.effects.checkpoint.sequenceNumber) <= Number(recon.at_checkpoint)).map((t) => t.digest);
  const sum = await rawNet(before, NEMO, SUI);
  ck("reconstructed balance is the sum of every earlier change", recon.method === "reconstructed" && recon.balance === sum.toString(), `${recon.balance} vs ${sum}`);

  // ---- get_wallet_overview ------------------------------------------------
  console.log("\nget_wallet_overview");
  const ov = await call("get_wallet_overview", { address: NEMO });
  const rawBals = (await gql(`query($a:SuiAddress!){ address(address:$a){ balances(first:50){ nodes{ coinType{repr} totalBalance } } } }`, { a: NEMO })).address.balances.nodes;
  ck("holdings match the raw balances", sameSet((ov.holdings ?? []).map((h) => `${h.coin_type}=${h.balance}`), rawBals.map((b) => `${b.coinType.repr}=${b.totalBalance}`)));

  // ---- get_object / list_owned_objects ------------------------------------
  console.log("\nget_object and list_owned_objects");
  const obj = await call("get_object", { object_id: DELETED_COIN, version: DELETED_COIN_VERSION });
  const rawObj = (await gql(`query($a:SuiAddress!,$v:UInt53!){ object(address:$a, version:$v){ asMoveObject{ contents{ type{repr} json } } } }`, { a: DELETED_COIN, v: Number(DELETED_COIN_VERSION) })).object;
  ck("a past version of a burned coin: type and balance match", obj.object_type === rawObj?.asMoveObject?.contents?.type?.repr && JSON.stringify(obj.content ?? obj).includes(rawObj?.asMoveObject?.contents?.json?.balance), short(obj.object_type));
  const owned = await call("list_owned_objects", { owner: NEMO, limit: 50 });
  const rawOwned = (await gql(`query($a:SuiAddress!){ address(address:$a){ objects(first:50){ nodes{ address } } } }`, { a: NEMO })).address.objects.nodes.map((n) => n.address);
  ck("owned objects equal the raw list", sameSet((owned.objects ?? []).map((o) => o.object_id), rawOwned), `${owned.objects?.length} vs ${rawOwned.length}`);

  // ---- identify_address ---------------------------------------------------
  console.log("\nidentify_address on each kind of address");
  const idW = await call("identify_address", { address: NEMO });
  ck("wallet: ed25519, with the raw SUI balance", idW.type === "wallet" && idW.authentication?.scheme === "ed25519" && idW.sui_balance === curRaw);
  const idP = await call("identify_address", { address: NEMO_ROOT });
  // `package(address:)` resolves to the newest version; the object at the address is the version itself.
  const rawPkg = (await gql(`query($a:SuiAddress!){ object(address:$a){ version } }`, { a: NEMO_ROOT })).object;
  ck("package: version 1 of its own lineage", idP.type === "package" && rawPkg?.version === 1 && idP.lineage?.root_package_id === NEMO_ROOT && idP.lineage?.version === 1);
  const idV = await call("identify_address", { address: VALIDATOR });
  const vals = (await gql(`{ epoch { validatorSet { activeValidators(first: 50) { nodes { contents { json } } } } } }`)).epoch.validatorSet.activeValidators.nodes.map((n) => n.contents.json.metadata);
  ck("validator: named as the validator set names it", idV.type === "validator" && vals.some((m) => m.sui_address === VALIDATOR && m.name === idV.name), short(idV.name));
  const idO = await call("identify_address", { address: "0x5" });
  const rawO = (await gql(`{ object(address:"0x5"){ asMoveObject{ contents{ type{repr} } } } }`)).object.asMoveObject.contents.type.repr;
  ck("object: the system state, shared", idO.type === "shared_object" && idO.object_type === rawO);
  const idM = await call("identify_address", { address: NEMO_MULTISIG });
  ck("multisig: 3-of-4", idM.authentication?.scheme === "multisig" && idM.authentication.multisig?.threshold === 3 && idM.authentication.multisig.members?.length === 4);
  const idD = await call("identify_address", { address: DELETED_COIN });
  const live = (await gql(`query($a:SuiAddress!){ object(address:$a){ version } }`, { a: DELETED_COIN })).object;
  ck("deleted object: no live object, and called wrapped_or_deleted", live === null && idD.type === "wrapped_or_deleted_object", idD.type);

  // ---- analyze_multisig / find_shared_multisig ----------------------------
  console.log("\nanalyze_multisig and find_shared_multisig");
  const ms = await call("analyze_multisig", { address: NEMO_MULTISIG });
  const newestSent = (await gql(`query($a:SuiAddress!){ transactions(last:1, filter:{sentAddress:$a}){ nodes{ effects{ timestamp } } } }`, { a: NEMO_MULTISIG })).transactions.nodes[0].effects.timestamp;
  const signers = (ms.members ?? []).filter((m) => m.signed_count > 0);
  ck("3-of-4 with one key that never signed", ms.committee?.threshold === 3 && ms.committee?.member_count === 4 && (ms.dormant_members ?? []).length === 1);
  ck("the signers were read up to the newest sent transaction", signers.length === 3 && signers.every((m) => m.last_signed === newestSent), `${signers[0]?.last_signed} vs ${newestSent}`);
  const notMs = await call("analyze_multisig", { address: NEMO });
  ck("an ed25519 wallet is refused promptly as not a multisig", notMs._isError === true && /not a multisig/.test(notMs.error ?? "") && notMs._ms < 10_000, `${notMs._ms}ms`);
  const idMs2 = await call("identify_address", { address: MS_2OF3 });
  const members = idMs2.authentication?.multisig?.members?.map((m) => m.address) ?? [];
  const shared = await call("find_shared_multisig", { addresses: members });
  const neverSent = [];
  for (const m of members) {
    const d = await gql(`query($a:SuiAddress!){ transactions(first:1, filter:{sentAddress:$a}){ nodes{ digest } } }`, { a: m });
    if (!d.transactions.nodes.length) neverSent.push(m);
  }
  ck("a member that never sent is skipped, as the chain shows", sameSet((shared.addresses_skipped ?? []).map((s) => s.address), neverSent), short(neverSent));
  ck("so the 2-of-3 cannot be rebuilt from the rest", neverSent.length > 0 && shared.found_count === 0);

  // ---- get_top_holders ----------------------------------------------------
  console.log("\nget_top_holders, token and NFT");
  const th = await call("get_top_holders", { type: XAGM, mode: "token", limit: 10 });
  const holders = th.top_holders ?? th.sampled_holders ?? [];
  ck("XAGM's address-balance holder is in the result", holders.some((h) => h.address === XAGM_ADDRESS_BALANCE_HOLDER));
  let mismatched = 0;
  for (const h of holders.slice(0, 5)) if (h.balance !== (await rawBalance(h.address, XAGM))) mismatched++;
  ck("each of the first five balances equals the raw read", mismatched === 0, `${mismatched} differ`);
  const nft = await call("get_top_holders", { type: GNOME, mode: "nft", limit: 10 });
  let gnomes = 0;
  for (let cursor = null; ; ) {
    const d = await gql(`query($t:String!,$c:String){ objects(first:50, after:$c, filter:{type:$t}){ pageInfo{hasNextPage endCursor} nodes{ address } } }`, { t: GNOME, c: cursor });
    gnomes += d.objects.nodes.length;
    if (!d.objects.pageInfo.hasNextPage) break;
    cursor = d.objects.pageInfo.endCursor;
  }
  const nftHolders = nft.top_holders ?? nft.sampled_holders ?? [];
  ck("NFT mode scanned every Gnome on chain", nft.complete_ranking === true && nft.total_scanned === gnomes, `${nft.total_scanned} vs ${gnomes}`);
  ck("holder counts are ranked and fit inside the collection", nftHolders.every((h, i) => i === 0 || h.count <= nftHolders[i - 1].count) && nftHolders.reduce((n, h) => n + h.count, 0) <= gnomes);

  // ---- get_nft_sales ------------------------------------------------------
  console.log("\nget_nft_sales over 24 hours");
  const sales = await call("get_nft_sales", { hours: 24, include_sales: true });
  const records = sales.sale_records ?? [];
  const types = [...new Set(records.map((r) => r.event_type))];
  let raw = 0;
  for (const t of types) raw += (await rawEvents(t, sales.from_checkpoint - 1, sales.to_checkpoint + 1)).length;
  ck("every sale of each seen event type in the window is reported", sales.truncated === false && records.length === raw, `${records.length} vs ${raw}`);
  const volume = records.filter((r) => r.price).reduce((n, r) => n + BigInt(r.price), 0n);
  ck("volume is the sum of priced sales", sales.volume_mist === volume.toString() && sales.priced_sales === records.filter((r) => r.price).length);

  // ---- malformed input: every tool refuses with a message -------------------
  console.log("\nmalformed input");
  const bad = [
    ["find_funding_source", { address: "0xnothex" }],
    ["find_funding_sources", { addresses: ["0xnothex"] }],
    ["get_address_fanout", { address: "0xnothex" }],
    ["classify_deposit_address", { address: "0xnothex" }],
    ["screen_address", { address: "0xnothex" }],
    ["build_wallet_edges", { addresses: ["0xnothex"] }],
    ["sample_control_addresses", { event_type: SWAP_EVENT, from: "yesterday-ish" }],
    ["analyze_multisig", { address: "0xnothex" }],
    ["find_shared_multisig", { addresses: [NEMO] }],
    ["build_timeline", { addresses: [NEMO], from: "not a time" }],
    ["aggregate_events", { event_type: SWAP_EVENT, from: "not a time" }],
    ["query_events", { event_type: SWAP_EVENT, after_checkpoint: "not a time" }],
    ["query_transactions", { affected_address: NEMO, function: "0x2::coin::transfer" }],
    ["check_activity", {}],
    ["get_top_holders", {}],
    ["get_nft_sales", { hours: -5 }],
    ["identify_address", { address: "0xnothex" }],
    ["get_wallet_overview", { address: "0xnothex" }],
    ["get_transaction_history", { address: "0xnothex" }],
    ["get_transaction", { digest: "1".repeat(44) }],
    ["get_balance", { owner: NEMO, at: "not a time" }],
    ["get_object", { object_id: "0xnothex" }],
    ["list_owned_objects", { owner: "0xnothex" }],
  ];
  // A batch reports a malformed digest instead of refusing, so the valid ones still come back.
  const badBatch = await call("get_transactions", { digests: ["not-a-digest", FIRST_FUNDING] });
  ck("get_transactions names a malformed digest and still reads the rest", badBatch.invalid_digests?.includes("not-a-digest") && badBatch.transactions?.[0]?.digest === FIRST_FUNDING);
  for (const [tool, args] of bad) {
    const r = await call(tool, args, 60_000);
    const msg = r.error ?? r._error ?? r._text ?? "";
    ck(`${tool} refuses ${short(JSON.stringify(args)).slice(0, 50)}`, (r._isError || r._error) && msg.length > 0 && !/^Unknown error$/.test(msg), short(msg));
  }
} finally {
  server.stop();
}

// ---- latency and size -------------------------------------------------------
console.log("\nlatency and size per tool (slowest call, largest result)");
const byTool = new Map();
for (const c of calls) {
  const t = byTool.get(c.tool) ?? { n: 0, ms: 0, size: 0 };
  byTool.set(c.tool, { n: t.n + 1, ms: Math.max(t.ms, c.ms), size: Math.max(t.size, c.size) });
}
for (const [tool, t] of [...byTool].sort()) {
  console.log(`   ${tool.padEnd(28)} ${String(t.n).padStart(2)} calls  ${String((t.ms / 1000).toFixed(1)).padStart(5)}s  ${String(t.size).padStart(7)} chars`);
}
for (const c of calls) {
  if (c.ms > 60_000) ck(`${c.tool} answers within 60s`, false, `${(c.ms / 1000).toFixed(1)}s`);
  if (c.size > declaredSize.get(c.tool)) ck(`${c.tool} stays within its result size`, false, `${c.size} chars`);
}
finish();
