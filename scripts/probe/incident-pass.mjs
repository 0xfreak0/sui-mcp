#!/usr/bin/env node
/**
 * Incident pass: the investigation tools, replayed on two public exploits.
 *
 * Unit tests cover these tools' pure logic, and every bug found after 1.19.0
 * shipped was outside it: arguments, service shapes, and the seams between
 * tools. This drives the built server over stdio, the way a client does, and
 * checks what it says about the Cetus (2025-05-22) and Nemo (2025-09-07)
 * exploits. Each check compares the tool's answer with a raw chain read taken
 * in the same run, or pins a historical fact that cannot change. Values that
 * move (prices, deny lists) are compared with a second source read seconds
 * apart.
 *
 * Every call's latency and output size is recorded. A call over 60s, or over
 * 100k characters when the tool declares no larger limit, is a failure.
 */
import { startServer, gql, rawNet, checker, short, SUI } from "./lib/mcp-client.mjs";

const NEMO_ATTACKER = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
const NEMO_EXPLOIT = "19Zkat1xArMTMvPCB4e4QtM5HstpYiKvgPjbvkLUAw9";
const NEMO_ROOT = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const NEMO_V5 = "0xef9cb9a0fefb8d304e793ab029d4a6b3f08877aac2d1a848f2dc3b2578d1c66f";
const NEMO_V10 = "0x0f286ad004ea93ea6ad3a953b5d4f3c7306378b0dcc354c3f4ebb1d506d3b47f";
const NEMO_UPGRADER = "0xf55cc609b13e87470d3da78d39ad6f84458a8059eb06aa66f94103d775e8a663";
const NEMO_MULTISIG = "0xaa71d7166a7f7df65cd0e33b5adc2c53028f31605864a76887180415d604ac8e";
const NEMO_CCTP_DEST = "0x135477aa627a3bcc3223bde10dd8e7c55a1f645c";
// The attacker's first funding (39.45 SUI from 0x1f7b…) and the 39.2 SUI from
// the one-shot wallet 0x9e55…, per the Nemo report's fund tracing.
const NEMO_FUNDING = "FjkAurXTGnmq4uiMr1yWETvRCtYWmVpFbrD9MGSyUc3S";
const NEMO_FUNDER = "0x1f7b27844f2c4a0262b2c481f7ab956d10ace524c5a7b06c3742cfb8701db714";
const NEMO_ONE_SHOT_FUNDING = "AgicqTF1VBy9uvkakh99hu9Hxi1EVF1obybpcyCuPxuB";
const NEMO_ONE_SHOT = "0x9e5590502b03b0172d0b78f4ddbaebd48dcaf7e2a7778ba18c0de2110bd6aacb";
const CETUS_ATTACKER = "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06";
const CETUS_SECOND = "0xcd8962dad278d8b50fa0f9eb0186bfa4cbdecc6d59377214c88d0286a0ac9562";
const CETUS_EXPLOIT = "DVMG3B2kocLEnVMDuQzTYRgjwuuFSfciawPvXXheB3x";
const CETUS_POOL = "0x871d8a227114f375170f149f7e9d45be822dd003eba225e83c05ac80828596bc";
const HASUI = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI";
const CETUS_CLMM = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
const INTEGER_MATE = "0x714a63a0dba6da4f017b42d5d0fb78867f18bcde904868e51d951a5a6f5b7f57";
const CETUS_BENEFICIARY = "0x89012a55cd6b88e407c9d4ae9b3425f55924919b";
// Cetus attacker's exits, one per bridge (SlowMist names the EVM wallet above).
const CETUS_MAYAN_EXIT = "6jMEFeap2GqxedFJPrQckmPwC78FeFodmkdCCjnFRWWb";
const CETUS_CCTP_EXIT = "2bzu8xPvgF4R9fBqspHVweZx2y55whVQcCwb2qxfxV3D";
const CETUS_NATIVE_EXIT = "3brjQxB6XLsr4GrRtYU4ffDfHAwz63PuiBzdvJ4Euesg";
const CETUS_WORMHOLE_EXIT = "7oiD7oNkH1mEFLKQZunHiqdsqjfYJpnVCJL2LQsTgnrP";
// The first claim on Sui's native bridge: Ethereum transfer 10/0.
const NATIVE_INBOUND = "AdBSV92wdrW49Fv1mvk6afyP6SN15mYk5MwB3X8DtnY5";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
// A regulated coin whose issuer has frozen addresses (seven deny_list_v2_add
// calls on 2026-03-04).
const JDSG = "0x9e7418ee528d661e13ab50c65ccb12350e3f18c934e5205a929a2a8df3ec7031::jdsg::JDSG";
const BINANCE_DEPOSIT = "0x01740e57b294476b0ea72ead41ea91689c280b9277e0dcde98024c779f3a4efe";
const BINANCE_HOT = "0x935029ca5219502a47ac9b69f556ccf6e2198b5e7815cf50f68846f723739cbd";

const { callRaw, rpc, stop } = await startServer({ name: "incident-pass" });
const { ck, finish } = checker();

// ---- per-call latency and size ---------------------------------------------
const listed = await rpc("tools/list", {});
const declaredLimit = new Map(
  (listed.result?.tools ?? []).map((t) => [t.name, t._meta?.["anthropic/maxResultSizeChars"] ?? null]),
);
const stats = [];

/** Call a tool; return its first JSON object (or `{_text}`), and record time and size. */
async function call(tool, args, timeoutMs) {
  const msg = await callRaw(tool, args, timeoutMs);
  const texts = (msg.result?.content ?? []).map((c) => c.text ?? "");
  stats.push({ tool, ms: msg.ms, chars: texts.reduce((n, t) => n + t.length, 0) });
  if (msg.error) return { _error: msg.error.message, _ms: msg.ms };
  const json = texts.find((t) => t.trim().startsWith("{"));
  const out = json ? JSON.parse(json) : {};
  out._text = texts.join("\n");
  if (msg.result.isError) out._isError = true;
  return out;
}

// ---- raw chain reads --------------------------------------------------------
/** gql with a retry: four probes share the public endpoint. */
async function q(query, vars) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gql(query, vars);
    } catch (err) {
      if (attempt >= 5 || !/429|Too Many|rate|fetch failed|Unexpected token|ECONNRESET|timed out/i.test(String(err.message))) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

const OWNER = `owner { __typename ... on AddressOwner { address { address } } ... on ObjectOwner { address { address } } }`;
const TX_FIELDS = `digest sender { address } gasInput { gasSponsor { address } }
  effects { status timestamp checkpoint { sequenceNumber }
    gasEffects { gasSummary { computationCost storageCost storageRebate } }
    events(first: 50) { nodes { transactionModule { package { address } } contents { type { repr } json } } }
    balanceChanges(first: 50) { pageInfo { hasNextPage } nodes { owner { address } coinType { repr } amount } }
    objectChanges(first: 50) { nodes { address inputState { ${OWNER} } outputState { ${OWNER} } } } }`;

const txCache = new Map();
/** One transaction, raw. */
async function rawTx(digest) {
  if (!txCache.has(digest)) {
    const d = await q(`query($d:String!){ transaction(digest:$d){ ${TX_FIELDS} } }`, { d: digest });
    const t = d.transaction;
    if (t?.effects?.balanceChanges?.pageInfo?.hasNextPage) throw new Error(`${digest} has more than 50 balance changes`);
    txCache.set(digest, t);
  }
  return txCache.get(digest);
}

/** Every transaction matching a filter, oldest first, raw. */
async function rawTxs(filter, max = 2000) {
  const out = [];
  let after = null;
  for (;;) {
    const d = await q(
      `query($f:TransactionFilter,$a:String){ transactions(first:50, after:$a, filter:$f){ pageInfo { hasNextPage endCursor } nodes { ${TX_FIELDS} } } }`,
      { f: filter, a: after },
    );
    for (const t of d.transactions.nodes) {
      if (t.effects?.balanceChanges?.pageInfo?.hasNextPage) throw new Error(`${t.digest} has more than 50 balance changes`);
      txCache.set(t.digest, t);
      out.push(t);
    }
    if (!d.transactions.pageInfo.hasNextPage || out.length >= max) return out;
    after = d.transactions.pageInfo.endCursor;
  }
}

const gasOf = (t) => {
  const g = t.effects.gasEffects.gasSummary;
  return BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
};
const payerOf = (t) => t.gasInput?.gasSponsor?.address ?? t.sender?.address;
/** Per-coin balance change of one address in one transaction. */
const changesOf = (t, address) => {
  const m = new Map();
  for (const n of t.effects.balanceChanges.nodes) {
    if (n.owner?.address === address) m.set(n.coinType.repr, (m.get(n.coinType.repr) ?? 0n) + BigInt(n.amount));
  }
  return m;
};
/** The same, with the gas this address paid added back to its SUI. */
const changesNetOfGas = (t, address) => {
  const m = changesOf(t, address);
  if (payerOf(t) === address) m.set(SUI, (m.get(SUI) ?? 0n) + gasOf(t));
  return m;
};
const eventsOf = (t, suffix) => t.effects.events.nodes.filter((e) => e.contents.type.repr.split("<")[0].endsWith(suffix));
const ownerOf = (state) => state?.owner?.address?.address ?? null;
const evm = (hex32) => `0x${hex32.replace(/^0x/, "").slice(-40).toLowerCase()}`;
const b64hex = (s) => Buffer.from(s, "base64").toString("hex");
const near = (a, b, rel) => Math.abs(a - b) <= Math.abs(b) * rel;

async function packageVersions(address) {
  const d = await q(
    `query($a:SuiAddress!){ packageVersions(address:$a, first:50){ nodes { address version previousTransaction { digest sender { address } } } } }`,
    { a: address },
  );
  return d.packageVersions.nodes;
}
// GraphQL's package(address:) answers with the lineage's newest version;
// object(address:) { asMovePackage } reads the version at that address.
async function disassembly(pkg, module) {
  const d = await q(`query($p:SuiAddress!,$m:String!){ object(address:$p){ asMovePackage { module(name:$m){ disassembly } } } }`, { p: pkg, m: module });
  return d.object?.asMovePackage?.module?.disassembly ?? null;
}
async function moduleNames(pkg) {
  const d = await q(`query($p:SuiAddress!){ object(address:$p){ asMovePackage { modules(first:50){ nodes { name } } } } }`, { p: pkg });
  return d.object.asMovePackage.modules.nodes.map((n) => n.name);
}
async function linkage(pkg) {
  const d = await q(`query($p:SuiAddress!){ object(address:$p){ asMovePackage { linkage { originalId upgradedId version } } } }`, { p: pkg });
  return d.object.asMovePackage.linkage;
}

/** Changed lines between two texts: common head and tail stripped, LCS over the rest. */
function lineDiff(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail);
  const ys = y.slice(head, y.length - tail);
  const L = Array.from({ length: xs.length + 1 }, () => new Uint32Array(ys.length + 1));
  for (let i = xs.length - 1; i >= 0; i--)
    for (let j = ys.length - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < xs.length && j < ys.length) {
    if (xs[i] === ys[j]) (i++, j++);
    else if (L[i + 1][j] >= L[i][j + 1]) removed.push(xs[i++]);
    else added.push(ys[j++]);
  }
  removed.push(...xs.slice(i));
  added.push(...ys.slice(j));
  return { removed, added };
}

/** DefiLlama's price for a coin at a moment (seconds), or now. */
async function llama(coinType, at) {
  const key = `sui:${coinType}`;
  const url = at ? `https://coins.llama.fi/prices/historical/${at}/${key}` : `https://coins.llama.fi/prices/current/${key}`;
  const r = await fetch(url);
  return (await r.json()).coins?.[key]?.price ?? null;
}

try {
  // =========================================================================
  // analyze_attack_tx
  // =========================================================================
  console.log("\nanalyze_attack_tx on the Nemo exploit");
  const attack = await call("analyze_attack_tx", { digest: NEMO_EXPLOIT });
  const row = (attack.addresses ?? []).find((a) => a.address === NEMO_ATTACKER);
  const reported = row?.coins?.find((c) => c.coin_type === SUI)?.amount;
  const raw = await rawNet([NEMO_EXPLOIT], NEMO_ATTACKER, SUI);
  ck("attacker's SUI net matches the chain", reported !== undefined && BigInt(reported) === raw, `${reported} vs ${raw}`);
  ck("profit is priced in USD", typeof attack.profit?.usd_net === "number" && attack.profit.usd_net > 0, short(attack.profit?.usd_net));

  console.log("\nanalyze_attack_tx on the Cetus exploit");
  const cetus = await call("analyze_attack_tx", { digest: CETUS_EXPLOIT });
  const cetusTx = await rawTx(CETUS_EXPLOIT);
  const cetusNet = changesOf(cetusTx, CETUS_ATTACKER);
  const gain = (ct) => cetus.profit?.gains?.find((g) => g.coin_type === ct)?.amount;
  ck("haSUI gain equals the attacker's raw balance change", gain(HASUI) === String(cetusNet.get(HASUI)), `${gain(HASUI)} vs ${cetusNet.get(HASUI)}`);
  ck("SUI gain equals the attacker's raw balance change", gain(SUI) === String(cetusNet.get(SUI)), `${gain(SUI)} vs ${cetusNet.get(SUI)}`);
  // SlowMist: 10,024,321.28 haSUI plus 5,765,124.79 SUI out of the pool.
  ck("the gains are SlowMist's 10,024,321 haSUI and 5,765,124 SUI", Math.floor(Number(gain(HASUI)) / 1e9) === 10024321 && Math.floor(Number(gain(SUI)) / 1e9) === 5765124);
  const swapEv = eventsOf(cetusTx, "::pool::SwapEvent")[0]?.contents.json;
  const swap = (cetus.swaps ?? []).find((s) => s.pool === CETUS_POOL);
  const priceOf = (sqrt) => (Number(BigInt(sqrt)) / 2 ** 64) ** 2;
  ck("swap amount_out is the SwapEvent's", swap?.amount_out === swapEv?.amount_out, `${swap?.amount_out} vs ${swapEv?.amount_out}`);
  ck("price before is the event's sqrt price squared", swap && near(swap.price_before, priceOf(swapEv.before_sqrt_price), 1e-9), `${swap?.price_before} vs ${priceOf(swapEv.before_sqrt_price)}`);
  ck("price after is the event's sqrt price squared", swap && near(swap.price_after, priceOf(swapEv.after_sqrt_price), 1e-9), `${swap?.price_after} vs ${priceOf(swapEv.after_sqrt_price)}`);
  const poolFlow = (cetus.pool_flows ?? []).find((p) => p.pool === CETUS_POOL);
  const poolDelta = (ct) => BigInt(poolFlow?.deltas?.find((d) => d.coin_type === ct)?.amount ?? 0);
  // The transaction moves value only between the pool and the attacker, so the
  // pool's loss is the attacker's gain, plus the gas the attacker paid in SUI.
  ck("pool's haSUI loss is the attacker's haSUI gain", poolDelta(HASUI) === -cetusNet.get(HASUI), `${poolDelta(HASUI)}`);
  ck("pool's SUI loss is the attacker's SUI gain plus gas", poolDelta(SUI) === -(cetusNet.get(SUI) + gasOf(cetusTx)), `${poolDelta(SUI)} vs ${-(cetusNet.get(SUI) + gasOf(cetusTx))}`);
  ck("the flash swap is paired to its repay", (cetus.flash_legs ?? []).some((l) => /flash_swap$/.test(l.borrow?.target ?? "") && /repay_flash_swap$/.test(l.repay?.target ?? "")));

  // =========================================================================
  // summarize_incident_losses
  // =========================================================================
  console.log("\nsummarize_incident_losses: the Cetus attacker, 10:30 to 10:46 UTC");
  const START = Date.parse("2025-05-22T10:30:00Z");
  const END = Date.parse("2025-05-22T10:46:00Z");
  const losses = await call("summarize_incident_losses", { sender: CETUS_ATTACKER, start: new Date(START).toISOString(), end: new Date(END).toISOString() });
  // Wide checkpoint bounds (10:27 to 10:49), then the window applied by each
  // transaction's own timestamp.
  const sent = (await rawTxs({ sentAddress: CETUS_ATTACKER, afterCheckpoint: 148114000, beforeCheckpoint: 148119500 })).filter((t) => {
    const ms = Date.parse(t.effects.timestamp);
    return ms >= START && ms <= END;
  });
  ck("reads every transaction the attacker sent in the window", losses.transactions_read === sent.length, `${losses.transactions_read} vs ${sent.length} on chain`);
  const failedRaw = sent.filter((t) => t.effects.status !== "SUCCESS").length;
  ck("failed transactions counted", (losses.failed_transactions ?? []).length === failedRaw, `${losses.failed_transactions?.length} vs ${failedRaw}`);
  const rawTotals = new Map();
  for (const t of sent) for (const [ct, v] of changesOf(t, CETUS_ATTACKER)) rawTotals.set(ct, (rawTotals.get(ct) ?? 0n) + v);
  const rows = [...(losses.priced_coins ?? []), ...(losses.unpriced_remainder ?? [])];
  const mismatched = rows.filter((r) => BigInt(r.attacker_net_raw) !== (rawTotals.get(r.coin_type) ?? 0n));
  ck("every coin's net equals the raw sum over those transactions", rows.length > 0 && mismatched.length === 0, mismatched.length ? short(mismatched.slice(0, 2).map((m) => [m.coin_type, m.attacker_net_raw, String(rawTotals.get(m.coin_type))])) : `${rows.length} coins`);
  const rawCoins = [...rawTotals.values()].filter((v) => v !== 0n).length;
  ck("coin count equals the coins whose raw net is not zero", losses.totals?.coins === rawCoins, `${losses.totals?.coins} vs ${rawCoins}`);
  // Public reports: 265 successful exploit transactions, one per pool.
  ck("265 pools drained, per the public count", (losses.groups ?? []).length === 265, `${losses.groups?.length}`);
  const pricedSum = (losses.priced_coins ?? []).reduce((s, c) => s + (c.usd ?? 0), 0);
  ck("total USD is the sum of the priced coins", near(losses.totals?.usd_net ?? NaN, pricedSum, 1e-6), `${losses.totals?.usd_net} vs ${pricedSum.toFixed(2)}`);
  const top = (losses.groups ?? [])[0];
  ck("the largest pool is the haSUI/SUI pool analyze_attack_tx values the same", top?.pools?.includes(CETUS_POOL) && near(top.attacker_usd, cetus.profit?.usd_net ?? NaN, 1e-4), `${top?.attacker_usd} vs ${cetus.profit?.usd_net}`);

  // =========================================================================
  // trace_funds, forward
  // =========================================================================
  console.log("\ntrace_funds forward from the Nemo exploit");
  const trace = await call("trace_funds", { digest: NEMO_EXPLOIT, direction: "forward", hops: 10 });
  const hops = trace.hops ?? [];
  ck("it stops at the CCTP exit", /CCTP/.test(trace.stop_reason ?? ""), short(trace.stop_reason));
  const after = (await rawTxs({ sentAddress: NEMO_ATTACKER, afterCheckpoint: 187415929, beforeCheckpoint: 187430000 }));
  // Forward rule: the recipient's next transaction that moves the coin. The
  // exploit paid the attacker SUI; the first later debit of SUI (gas aside) is
  // hop 2, and hop 2 swapped into USDC, whose first later debit is hop 3.
  const nextDebit = (fromDigest, coin) => {
    const i = after.findIndex((t) => t.digest === fromDigest);
    return after.slice(i + 1).find((t) => (changesNetOfGas(t, NEMO_ATTACKER).get(coin) ?? 0n) < 0n)?.digest;
  };
  ck("hop 1 credits the attacker what the chain says", hops[0]?.balance_changes?.some((b) => b.address === NEMO_ATTACKER && b.coin_type === SUI && BigInt(b.amount) === raw));
  const hop2 = nextDebit(NEMO_EXPLOIT, SUI);
  ck("hop 2 is the attacker's next SUI debit", hops[1]?.digest === hop2, `${hops[1]?.digest} vs ${hop2}`);
  const hop3 = nextDebit(hop2, USDC);
  ck("hop 3 is the next USDC debit after the swap", hops[2]?.digest === hop3, `${hops[2]?.digest} vs ${hop3}`);
  const exitTx = await rawTx(hop3);
  ck("hop 3 is a CCTP burn on chain", eventsOf(exitTx, "::deposit_for_burn::DepositForBurn").length === 1);
  const exitUsdc = -(changesOf(exitTx, NEMO_ATTACKER).get(USDC) ?? 0n);
  ck("hop 3 is valued at the USDC it sent off chain", near(hops[2]?.usd_total ?? 0, Number(exitUsdc) / 1e6, 0.01), `$${hops[2]?.usd_total} for ${Number(exitUsdc) / 1e6} USDC`);

  // =========================================================================
  // trace_funds, backward
  // =========================================================================
  console.log("\ntrace_funds backward from the attacker's first funding");
  const back = await call("trace_funds", { digest: NEMO_FUNDING, direction: "backward", hops: 3 });
  const fundTx = await rawTx(NEMO_FUNDING);
  const payer = fundTx.effects.balanceChanges.nodes.find((n) => n.coinType.repr === SUI && BigInt(n.amount) < 0n)?.owner?.address;
  ck("hop 1 names the address that paid on chain", back.hops?.[0]?.sender === payer && payer === NEMO_FUNDER, `${back.hops?.[0]?.sender} vs ${payer}`);
  ck("it stops at that funder, a high-fanout distributor", (back.hop_count ?? 0) === 1 && (back.stop_reason ?? "").includes(NEMO_FUNDER), short(back.stop_reason));

  console.log("\ntrace_funds backward through the one-shot wallet");
  const back2 = await call("trace_funds", { digest: NEMO_ONE_SHOT_FUNDING, direction: "backward", hops: 4 });
  const oneShotTx = await rawTx(NEMO_ONE_SHOT_FUNDING);
  // Backward rule: the payer's most recent earlier inflow of the coin.
  const oneShotHistory = await rawTxs({ affectedAddress: NEMO_ONE_SHOT, beforeCheckpoint: Number(oneShotTx.effects.checkpoint.sequenceNumber) });
  const lastInflow = oneShotHistory.filter((t) => (changesNetOfGas(t, NEMO_ONE_SHOT).get(SUI) ?? 0n) > 0n).at(-1);
  const inflowPayer = lastInflow?.effects.balanceChanges.nodes.find((n) => n.coinType.repr === SUI && BigInt(n.amount) < 0n)?.owner?.address;
  ck("hop 1 is paid by the one-shot wallet", back2.hops?.[0]?.sender === NEMO_ONE_SHOT);
  ck("hop 2 is that wallet's most recent earlier inflow", back2.hops?.[1]?.digest === lastInflow?.digest, `${back2.hops?.[1]?.digest} vs ${lastInflow?.digest}`);
  ck("hop 2 names who paid it", back2.hops?.[1]?.sender === inflowPayer, `${back2.hops?.[1]?.sender} vs ${inflowPayer}`);

  // =========================================================================
  // trace_flow_graph
  // =========================================================================
  console.log("\ntrace_flow_graph forward from the Nemo exploit");
  const graph = await call("trace_flow_graph", { digest: NEMO_EXPLOIT });
  const exitNode = `exit:Circle CCTP:eip155:1:${NEMO_CCTP_DEST}`;
  const exitEdges = (graph.edges ?? []).filter((e) => e.to === exitNode);
  ck("a bridge exit pays the Nemo CCTP destination", (graph.terminals ?? []).some((t) => t.reason === "bridge_exit" && t.entries?.some((e) => e.node === exitNode)));
  // Gas is not a flow: the exploit's edge is the attacker's SUI change with
  // the gas it paid added back.
  const exploitEdge = (graph.edges ?? []).find((e) => e.from === `tx:${NEMO_EXPLOIT}` && e.to.startsWith(NEMO_ATTACKER) && e.coin_type === SUI);
  const exploitTx = await rawTx(NEMO_EXPLOIT);
  ck("the exploit's edge is the attacker's raw SUI change, gas apart", exploitEdge && BigInt(exploitEdge.amount) === changesNetOfGas(exploitTx, NEMO_ATTACKER).get(SUI), `${exploitEdge?.amount}`);
  let burnedTo = 0n;
  let edgeTotal = 0n;
  let edgeDigestsOk = exitEdges.length > 0;
  for (const e of exitEdges) {
    edgeTotal += BigInt(e.amount);
    for (const d of e.digests ?? []) {
      const burn = eventsOf(await rawTx(d), "::deposit_for_burn::DepositForBurn")[0]?.contents.json;
      if (!burn || evm(burn.mint_recipient) !== NEMO_CCTP_DEST) edgeDigestsOk = false;
      else burnedTo += BigInt(burn.amount);
    }
  }
  ck("every exit edge's digest burns to that destination on chain", edgeDigestsOk);
  ck("the graph sends no more to the exit than those burns carried", edgeTotal > 0n && edgeTotal <= burnedTo, `${edgeTotal} of ${burnedTo}`);
  const shares = (graph.terminals ?? []).reduce((s, t) => s + t.share, 0) + (graph.coverage?.pruned_share ?? 0);
  ck("terminal shares and pruned share add up to what was accounted", Math.abs(shares - (graph.coverage?.share_accounted ?? 0)) < 0.002, `${shares.toFixed(4)} vs ${graph.coverage?.share_accounted}`);

  console.log("\ntrace_flow_graph backward from the Nemo attacker before the exploit");
  const bgraph = await call("trace_flow_graph", { address: NEMO_ATTACKER, direction: "backward", to: "2025-09-07T16:00:00Z" });
  const edgeFrom = (from, to) => (bgraph.edges ?? []).find((e) => e.from.startsWith(from) && e.to.startsWith(to));
  const e1 = edgeFrom(NEMO_FUNDER, NEMO_ATTACKER);
  const e2 = edgeFrom(NEMO_ONE_SHOT, NEMO_ATTACKER);
  ck("0x1f7b… paid what FjkAur… credited", e1 && BigInt(e1.amount) === changesOf(fundTx, NEMO_ATTACKER).get(SUI), `${e1?.amount}`);
  ck("0x9e55… paid what Agicq… credited", e2 && BigInt(e2.amount) === changesOf(oneShotTx, NEMO_ATTACKER).get(SUI), `${e2?.amount}`);
  const e3 = edgeFrom(inflowPayer ?? "none", NEMO_ONE_SHOT);
  ck("the one-shot wallet's own funder is the payer of its last inflow", e3 && BigInt(e3.amount) === changesOf(lastInflow, NEMO_ONE_SHOT).get(SUI), `${e3?.from?.slice(0, 12)} ${e3?.amount}`);

  // =========================================================================
  // find_flow_path
  // =========================================================================
  console.log("\nfind_flow_path: Nemo attacker to its CCTP destination");
  const path = await call("find_flow_path", { from: NEMO_ATTACKER, to: `eip155:1:${NEMO_CCTP_DEST}`, window_start: "2025-09-07T16:00:00Z" });
  const step = path.paths?.[0]?.steps?.at(-1);
  ck("a path is found", path.found === true, short(path._text?.split("\n")[0]));
  let pathOk = (step?.digests ?? []).length > 0;
  for (const d of step?.digests ?? []) {
    const burn = eventsOf(await rawTx(d), "::deposit_for_burn::DepositForBurn")[0]?.contents.json;
    if (!burn || evm(burn.mint_recipient) !== NEMO_CCTP_DEST || burn.depositor !== NEMO_ATTACKER) pathOk = false;
  }
  ck("each digest on the path is the attacker's burn to that address", pathOk);

  console.log("\nfind_flow_path: Cetus attacker to the second attacker wallet");
  const cpath = await call("find_flow_path", { from: CETUS_ATTACKER, to: CETUS_SECOND, window_start: "2025-05-22T10:30:00Z" });
  const cstep = cpath.paths?.[0]?.steps?.[0];
  const moveTx = cstep?.digests?.[0] ? await rawTx(cstep.digests[0]) : null;
  const received = moveTx ? changesOf(moveTx, CETUS_SECOND).get(SUI) : undefined;
  ck("a one-transfer path is found", cpath.found === true && cpath.paths?.[0]?.hops === 1, short(cpath._text?.split("\n")[0]));
  ck("the transfer's amount is what the second wallet received on chain", received !== undefined && BigInt(cstep.amount) === received, `${cstep?.amount} vs ${received}`);
  // SlowMist: 13,317,645.17 and 10,705,250 SUI to 0xcd8962.
  ck("it is one of SlowMist's two transfers", received !== undefined && [13317645n, 10705250n].includes(received / 1_000_000_000n), `${received}`);

  // =========================================================================
  // resolve_bridge_transfer
  // =========================================================================
  console.log("\nresolve_bridge_transfer");
  const mayan = await call("resolve_bridge_transfer", { digest: CETUS_MAYAN_EXIT });
  const order = eventsOf(await rawTx(CETUS_MAYAN_EXIT), "::init_order::OrderCreated")[0]?.contents.json;
  const mayanBen = (mayan.beneficiaries ?? []).find((b) => /Mayan/.test(b.protocol));
  ck("Mayan: the beneficiary is OrderCreated.addr_dest", mayanBen?.address === evm(order.addr_dest) && mayanBen.address === CETUS_BENEFICIARY, `${mayanBen?.address} vs ${evm(order.addr_dest)}`);
  const mayanBurn = eventsOf(await rawTx(CETUS_MAYAN_EXIT), "::deposit_for_burn::DepositForBurn")[0]?.contents.json;
  ck("Mayan: the CCTP leg's mint recipient, Mayan's contract, is not named a beneficiary", !(mayan.beneficiaries ?? []).some((b) => b.address === evm(mayanBurn.mint_recipient)));

  const cctp = await call("resolve_bridge_transfer", { digest: CETUS_CCTP_EXIT });
  const cburn = eventsOf(await rawTx(CETUS_CCTP_EXIT), "::deposit_for_burn::DepositForBurn")[0]?.contents.json;
  const c0 = cctp.circle_cctp?.[0];
  ck("CCTP: destination is the burn's mint_recipient", c0?.destination_address === evm(cburn.mint_recipient), `${c0?.destination_address}`);
  ck("CCTP: domain, nonce and amount are the burn's", c0?.destination_domain === cburn.destination_domain && c0?.nonce === cburn.nonce && c0?.amount === cburn.amount);

  const native = await call("resolve_bridge_transfer", { digest: CETUS_NATIVE_EXIT });
  const dep = eventsOf(await rawTx(CETUS_NATIVE_EXIT), "::bridge::TokenDepositedEvent")[0]?.contents.json;
  const n0 = native.sui_native_bridge?.[0];
  ck("Sui bridge: destination is the deposit's target_address", n0?.destination_address === `0x${b64hex(dep.target_address)}`, `${n0?.destination_address}`);
  ck("Sui bridge: sequence and amount are the deposit's; chain 10 is Ethereum", n0?.sequence === dep.seq_num && n0?.amount === dep.amount && dep.target_chain === 10 && n0?.destination_chain === "eip155:1");

  const wh = await call("resolve_bridge_transfer", { digest: CETUS_WORMHOLE_EXIT });
  const whMsg = eventsOf(await rawTx(CETUS_WORMHOLE_EXIT), "::publish_message::WormholeMessage")[0]?.contents.json;
  // Token Bridge transfer with payload (id 3): amount[1..33) to[67..99)
  // to_chain[99..101) from[101..133) payload[133..]; the Token Bridge Relayer's
  // payload ends with the 32-byte target recipient.
  const p = Buffer.from(whMsg.payload, "base64");
  const whAmount = BigInt(`0x${p.subarray(1, 33).toString("hex")}`);
  const whToChain = p.readUInt16BE(99);
  const whRecipient = evm(p.subarray(p.length - 32).toString("hex"));
  const whBen = (wh.beneficiaries ?? [])[0];
  ck("Wormhole: VAA sequence is the message's", wh.wormhole_messages?.[0]?.sequence === whMsg.sequence);
  ck("Wormhole relayer: beneficiary is the payload's target recipient", p[0] === 3 && whBen?.address === whRecipient && whBen?.wormhole_chain_id === whToChain, `${whBen?.address} vs ${whRecipient}`);
  // SlowMist: 1,771 SOL bridged through Wormhole.
  ck("Wormhole: the amount is SlowMist's 1,771 SOL", whBen?.amount === String(whAmount) && whAmount / 100_000_000n === 1771n, `${whBen?.amount}`);

  const inbound = await call("resolve_bridge_transfer", { digest: NATIVE_INBOUND });
  const claim = eventsOf(await rawTx(NATIVE_INBOUND), "::bridge::TokenTransferClaimed")[0]?.contents.json.message_key;
  const cl = inbound.sui_native_bridge_inbound?.claims?.[0];
  ck("inbound: the claim is read as an entry, not an exit", inbound.sui_native_bridge_inbound?.direction === "inbound" && !inbound.sui_native_bridge && !inbound.beneficiaries);
  ck("inbound: transfer id is the claimed message key", cl?.transfer_id === `${claim.source_chain}/${claim.bridge_seq_num}` && cl?.origin_chain === "eip155:1", short(cl));

  // =========================================================================
  // summarize_address_flows
  // =========================================================================
  console.log("\nsummarize_address_flows on the Nemo attacker, 2025-09-07");
  const flows = await call("summarize_address_flows", { address: NEMO_ATTACKER, from: "2025-09-07T00:00:00Z", to: "2025-09-08T00:00:00Z" });
  const day = (await rawTxs({ affectedAddress: NEMO_ATTACKER, beforeCheckpoint: 187540000 })).filter(
    (t) => t.effects.timestamp >= "2025-09-07T00:00:00Z" && t.effects.timestamp < "2025-09-08T00:00:00Z",
  );
  ck("scans every transaction the address took part in that day", flows.coverage?.scanned_transactions === day.length && flows.coverage?.complete === true, `${flows.coverage?.scanned_transactions} vs ${day.length}`);
  const io = new Map();
  let gasPaid = 0n;
  for (const t of day) {
    if (payerOf(t) === NEMO_ATTACKER) gasPaid += gasOf(t);
    for (const [ct, v] of changesNetOfGas(t, NEMO_ATTACKER)) {
      const r = io.get(ct) ?? { in: 0n, out: 0n };
      if (v > 0n) r.in += v;
      else r.out -= v;
      io.set(ct, r);
    }
  }
  const coinRows = flows.coins ?? [];
  const bad = coinRows.filter((c) => c.raw.in !== String(io.get(c.coin_type)?.in ?? 0n) || c.raw.out !== String(io.get(c.coin_type)?.out ?? 0n));
  ck("every coin's in and out equal the raw per-transaction sums, gas apart", coinRows.length === [...io.values()].filter((r) => r.in || r.out).length && bad.length === 0, bad.length ? short(bad.map((c) => [c.symbol, c.raw, io.get(c.coin_type)])) : `${coinRows.length} coins`);
  ck("gas paid equals the raw gas of the transactions it paid for", Math.round(flows.gas?.paid_sui * 1e9) === Number(gasPaid), `${flows.gas?.paid_sui} vs ${Number(gasPaid) / 1e9}`);
  const burns = day.filter((t) => eventsOf(t, "::deposit_for_burn::DepositForBurn").some((e) => e.contents.json.depositor === NEMO_ATTACKER));
  const exitDigests = (flows.bridge_exits?.transactions ?? []).filter((t) => /CCTP/i.test(t.bridge)).map((t) => t.digest);
  ck("the CCTP exits are the attacker's burns on chain", exitDigests.length === burns.length && burns.every((b) => exitDigests.includes(b.digest)), `${exitDigests.length} vs ${burns.length}`);
  ck("eight CCTP exits, as Nemo's report says", burns.length === 8);
  const dests = new Set(burns.map((b) => evm(eventsOf(b, "::deposit_for_burn::DepositForBurn")[0].contents.json.mint_recipient)));
  const cctpRow = (flows.bridge_exits?.by_bridge ?? []).find((b) => /CCTP/i.test(b.bridge));
  ck("they all pay the address Nemo's report names", dests.size === 1 && dests.has(NEMO_CCTP_DEST) && cctpRow?.destinations?.some((d) => d.address?.toLowerCase() === NEMO_CCTP_DEST));
  const burnSum = burns.reduce((s, b) => s + BigInt(eventsOf(b, "::deposit_for_burn::DepositForBurn")[0].contents.json.amount), 0n);
  ck("find_flow_path's amount is those burns, to the unit per transfer", step && BigInt(step.amount) <= burnSum && burnSum - BigInt(step.amount) <= BigInt(burns.length), `${step?.amount} vs ${burnSum}`);

  // =========================================================================
  // find_funding_source, get_balance (earlier checks)
  // =========================================================================
  console.log("\nfind_funding_source on the Nemo attacker");
  const funding = await call("find_funding_source", { address: NEMO_ATTACKER });
  ck("the walk stops at a high-fanout funder", /high-fanout/.test(funding.stop_reason ?? ""), short(funding.stop_reason));

  console.log("\nget_balance reconstructed before the Nemo exploit");
  const bal = await call("get_balance", { owner: NEMO_ATTACKER, at: "2025-09-07T16:00:00Z" });
  ck("reconstructed and complete", bal.method === "reconstructed" && bal.complete === true, `${bal.method} ${bal.complete}`);
  const early = await q(
    `query($a:SuiAddress!,$cp:UInt53!){ transactions(first:50, filter:{affectedAddress:$a, beforeCheckpoint:$cp}){ nodes { digest } } }`,
    { a: NEMO_ATTACKER, cp: Number(bal.at_checkpoint) + 1 },
  );
  const sum = await rawNet((early?.transactions?.nodes ?? []).map((n) => n.digest), NEMO_ATTACKER, SUI);
  ck("equals the sum of every earlier balance change", bal.balance === sum.toString(), `${bal.balance} vs ${sum}`);

  // =========================================================================
  // get_upgrade_history, trace_object_history, analyze_package
  // =========================================================================
  console.log("\nget_upgrade_history on Nemo");
  const up = await call("get_upgrade_history", { package: NEMO_ROOT, as_of: "2025-09-07T16:03:00Z" });
  const versions = await packageVersions(NEMO_ROOT);
  const vbad = versions.filter((v) => {
    const t = (up.versions ?? []).find((x) => x.version === v.version);
    return !t || t.package_id !== v.address || t.tx !== v.previousTransaction.digest || t.sender !== v.previousTransaction.sender.address;
  });
  ck("every version's id, publish transaction and sender match the chain", up.version_count === versions.length && vbad.length === 0, `${up.version_count} vs ${versions.length}; ${vbad.map((v) => v.version)}`);
  ck("the single key held the UpgradeCap at the exploit", up.as_of?.holder?.address === NEMO_UPGRADER || up.as_of?.holder === NEMO_UPGRADER, short(JSON.stringify(up.as_of?.holder)));
  ck("version 10 was the newest", up.as_of?.newest_version?.version === 10, `${up.as_of?.newest_version?.version}`);
  ck("the v10 cap round trip is flagged", (up.flags ?? []).some((f) => f.kind === "cap_round_trip" && f.versions?.includes(10)), (up.flags ?? []).map((f) => f.kind).join(","));

  console.log("\ntrace_object_history on Nemo's UpgradeCap");
  const capId = up.upgrade_cap?.object_id;
  const toh = await call("trace_object_history", { object_id: capId });
  const capNow = await q(`query($a:SuiAddress!){ object(address:$a){ ${OWNER} asMoveObject { contents { json } } } }`, { a: capId });
  ck("the current holder is the object's owner on chain", toh.current?.owner?.address === ownerOf(capNow.object) && ownerOf(capNow.object) === NEMO_MULTISIG, `${toh.current?.owner?.address}`);
  let changesOk = (toh.owner_changes ?? []).length > 0;
  for (const c of toh.owner_changes ?? []) {
    const ch = (await rawTx(c.tx)).effects.objectChanges.nodes.find((n) => n.address === capId);
    if (ownerOf(ch?.inputState) !== c.from?.address || ownerOf(ch?.outputState) !== c.to?.address) changesOk = false;
  }
  ck("each owner change is the cap's input and output owner in that transaction", changesOk, `${toh.owner_changes?.length} changes`);
  const custodyTxs = (up.cap_custody ?? []).slice(1).map((c) => `${c.from.tx}>${c.holder.address}`);
  const changeTxs = (toh.owner_changes ?? []).map((c) => `${c.tx}>${c.to.address}`);
  ck("the owner changes are the custody transfers get_upgrade_history reports", custodyTxs.join() === changeTxs.join() && up.upgrade_cap?.owner_change_count === toh.owner_change_count, `${changeTxs.length} vs ${custodyTxs.length}`);

  console.log("\nanalyze_package on Nemo v10");
  const ap = await call("analyze_package", { package_id: NEMO_V10 });
  const v10 = versions.find((v) => v.version === 10);
  const v1 = versions.find((v) => v.version === 1);
  ck("version publisher is the v10 publish transaction's sender", ap.version_publisher?.publisher === v10.previousTransaction.sender.address && ap.version_publisher?.publish_tx === v10.previousTransaction.digest, short(ap.version_publisher));
  ck("root publisher is the v1 publish transaction's sender", ap.root_publisher?.publisher === v1.previousTransaction.sender.address && ap.root_publisher?.publish_tx === v1.previousTransaction.digest);
  const capRow = (ap.capabilities?.capabilities ?? []).find((c) => c.kind === "upgrade");
  const capJson = capNow.object.asMoveObject.contents.json;
  ck("UpgradeCap holder and policy are the object's", capRow?.object_id === capId && capRow?.owner_address === ownerOf(capNow.object) && (capJson.policy === 0) === /^compatible/.test(capRow?.upgrade_policy ?? ""), short(capRow));

  // =========================================================================
  // get_package, get_move_function, disassemble_module
  // =========================================================================
  console.log("\nget_package / get_move_function / disassemble_module on Nemo v1 and v5");
  const FN = `query($p:SuiAddress!,$m:String!){ object(address:$p){ asMovePackage { module(name:$m){ functions(first:50){ pageInfo { hasNextPage } nodes { name visibility isEntry typeParameters { constraints } parameters { repr } return { repr } } } } } } }`;
  const rawFns = async (pkg) => (await q(FN, { p: pkg, m: "py" })).object.asMovePackage.module.functions.nodes;
  const fnsV5 = await rawFns(NEMO_V5);
  const fnsV1 = await rawFns(NEMO_ROOT);
  const sig = (s) => s.repr.replace(/\$(\d+)/g, "T$1");
  const gp5 = await call("get_package", { package_id: NEMO_V5, modules: ["py"] });
  const gp1 = await call("get_package", { package_id: NEMO_ROOT, modules: ["py"] });
  const py5 = gp5.modules?.find((m) => m.name === "py");
  const py1 = gp1.modules?.find((m) => m.name === "py");
  const names = (list) => (list ?? []).map((s) => s.split("(")[0]).sort().join();
  const rawNames = (fns, vis) => fns.filter((f) => f.visibility === vis).map((f) => f.name).sort().join();
  ck("v5 py: public and friend functions are the module's", names(py5?.public_functions) === rawNames(fnsV5, "PUBLIC") && names(py5?.friend_functions) === rawNames(fnsV5, "FRIEND") && py5?.private_function_count === fnsV5.filter((f) => f.visibility === "PRIVATE").length);
  ck("v1 has no redeem_pt, which v5 added", !fnsV1.some((f) => f.name === "redeem_pt") && fnsV5.some((f) => f.name === "redeem_pt") && !names(py1?.public_functions).includes("redeem_pt") && names(py5?.public_functions).includes("redeem_pt"));
  const redeem = fnsV5.find((f) => f.name === "redeem_pt");
  const listedSig = (py5?.public_functions ?? []).find((s) => s.startsWith("redeem_pt("));
  const wantSig = `redeem_pt(${redeem.parameters.map(sig).join(", ")}) -> ${redeem.return.map(sig).join(", ")}`;
  ck("get_package's redeem_pt signature is the chain's, references included", listedSig === wantSig, `${short(listedSig)}`);
  ck("get_package counts v5's modules", gp5.summary?.module_count === (await moduleNames(NEMO_V5)).length);

  const gmf = await call("get_move_function", { package_id: NEMO_V5, module_name: "py", function_name: "redeem_pt" });
  ck("get_move_function: parameters are the chain's", JSON.stringify(gmf.parameters) === JSON.stringify(redeem.parameters.map(sig)), short(gmf.parameters));
  ck("get_move_function: returns are the chain's", JSON.stringify(gmf.returns) === JSON.stringify(redeem.return.map(sig)), short(gmf.returns));
  ck("get_move_function: visibility, entry and constraints are the chain's", gmf.visibility === redeem.visibility.toLowerCase() && gmf.is_entry === redeem.isEntry && JSON.stringify(gmf.type_parameters?.map((t) => t.constraints.map((c) => c.toUpperCase()))) === JSON.stringify(redeem.typeParameters.map((t) => t.constraints)));
  const gmf1 = await call("get_move_function", { package_id: NEMO_ROOT, module_name: "py", function_name: "redeem_pt" });
  ck("get_move_function on v1 says redeem_pt does not exist", gmf1._isError === true && /not found/i.test(gmf1._text));

  const d1 = await call("disassemble_module", { package_id: NEMO_ROOT, module_name: "py" });
  const d5 = await call("disassemble_module", { package_id: NEMO_V5, module_name: "py" });
  ck("each version's disassembly is that version's bytecode on chain", d5.disassembly === (await disassembly(NEMO_V5, "py")) && d1.disassembly === (await disassembly(NEMO_ROOT, "py")));
  ck("v1's py has no redeem_pt; v5's does", !String(d1.disassembly).includes("redeem_pt") && String(d5.disassembly).includes("redeem_pt"));

  // =========================================================================
  // diff_package_upgrade
  // =========================================================================
  console.log("\ndiff_package_upgrade: Nemo v9 to v10");
  const diff = await call("diff_package_upgrade", { package: NEMO_ROOT, from_version: 9, to_version: 10, max_sample_lines: 2000 });
  const v9 = versions.find((v) => v.version === 9);
  const mods = await moduleNames(NEMO_V10);
  const changedRaw = [];
  const rawDiffs = new Map();
  for (const m of mods) {
    const [a, b] = [await disassembly(v9.address, m), await disassembly(NEMO_V10, m)];
    if (a !== b) {
      changedRaw.push(m);
      rawDiffs.set(m, lineDiff(a, b));
    }
  }
  const changed = diff.diff?.changed_modules ?? [];
  ck("the changed modules are the ones whose bytecode differs on chain", changed.map((c) => c.module).join() === changedRaw.join() && changedRaw.join() === "sy", `${changed.map((c) => c.module)} vs ${changedRaw}`);
  const sy = changed.find((c) => c.module === "sy");
  const syRaw = rawDiffs.get("sy");
  ck("sy: added and removed line counts are the raw diff's", sy?.added_lines === syRaw?.added.length && sy?.removed_lines === syRaw?.removed.length, `+${sy?.added_lines}/-${sy?.removed_lines} vs +${syRaw?.added.length}/-${syRaw?.removed.length}`);
  const plus = (sy?.sample ?? []).filter((l) => l.startsWith("+ ")).map((l) => l.slice(2));
  const minus = (sy?.sample ?? []).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  ck("sy: the hunk's lines are the raw changed lines", plus.join("\n") === syRaw?.added.join("\n") && minus.join("\n") === syRaw?.removed.join("\n"));

  console.log("\ndiff_package_upgrade: the Cetus fix");
  const im = await call("diff_package_upgrade", { package: INTEGER_MATE, from_version: 3, to_version: 5 });
  const imSample = (im.diff?.changed_modules ?? []).find((c) => c.module === "math_u256")?.sample ?? [];
  const MASK = ((1n << 64n) - 1n) << 192n;
  const ONE = 1n << 192n;
  // BlockSec and Cyfrin: checked_shlw's mask went from 0xffffffffffffffff << 192
  // to 1 << 192, and its comparison from > to >=.
  ck("integer-mate: only math_u256 changed", (im.diff?.changed_modules ?? []).map((c) => c.module).join() === "math_u256");
  ck("integer-mate: the mask and comparison change as BlockSec reports", imSample.some((l) => l.startsWith("- ") && l.includes(`LdU256(${MASK})`)) && imSample.some((l) => l.startsWith("+ ") && l.includes(`LdU256(${ONE})`)) && imSample.some((l) => /^- .*: Gt$/.test(l)) && imSample.some((l) => /^\+ .*: Ge$/.test(l)));
  const clmm = await call("diff_package_upgrade", { package: CETUS_CLMM, from_version: 10, to_version: 11 });
  const clmmVersions = await packageVersions(CETUS_CLMM);
  const imVersions = await packageVersions(INTEGER_MATE);
  const linkOf = async (v) => (await linkage(clmmVersions.find((x) => x.version === v).address)).find((l) => l.originalId === INTEGER_MATE);
  const [l10, l11] = [await linkOf(10), await linkOf(11)];
  const relink = (clmm.linkage_changes ?? []).find((l) => l.package === INTEGER_MATE);
  ck("CLMM v11 relinks integer-mate as each version's linkage table says", relink?.from?.address === l10.upgradedId && relink?.to?.address === l11.upgradedId && relink?.from?.version === imVersions.find((v) => v.address === l10.upgradedId)?.version && relink?.to?.version === 5, short(relink));

  // =========================================================================
  // resolve_protocol_packages
  // =========================================================================
  console.log("\nresolve_protocol_packages on Nemo since the exploit day");
  const rpp = await call("resolve_protocol_packages", { package_id: NEMO_ROOT, since: "2025-09-07T00:00:00Z" });
  const newest8 = versions.slice().sort((a, b) => b.version - a.version).slice(0, 8);
  ck("probes the eight newest versions on chain", (rpp.versions ?? []).map((v) => v.address).join() === newest8.map((v) => v.address).join());
  const exploitCalls = new Set(((await rawTx(NEMO_EXPLOIT)).effects.events.nodes ?? []).map((e) => e.transactionModule?.package?.address));
  ck("the exploit emitted events from v10, so v10 is emitting", exploitCalls.has(NEMO_V10) && rpp.versions?.find((v) => v.address === NEMO_V10)?.emitting === true);
  let dormantOk = true;
  for (const v of (rpp.versions ?? []).filter((x) => !x.emitting)) {
    const hit = await q(
      `query($f:String!,$cp:UInt53!){ transactions(first:5, filter:{function:$f, afterCheckpoint:$cp}){ nodes { effects { events(first:50){ nodes { transactionModule { package { address } } } } } } } }`,
      { f: v.address, cp: rpp.probe_window.after_checkpoint },
    );
    if (hit.transactions.nodes.some((t) => t.effects.events.nodes.some((e) => e.transactionModule?.package?.address === v.address))) dormantOk = false;
  }
  ck("no version reported dormant has a transaction calling it that emitted from it", dormantOk);

  // =========================================================================
  // get_token_prices, compare_oracle_price
  // =========================================================================
  console.log("\nget_token_prices");
  const CETUS_S = Math.floor(Date.parse("2025-05-22T10:30:50Z") / 1000);
  const pAt = await call("get_token_prices", { coin_types: ["0x2::sui::SUI", USDC], at: "2025-05-22T10:30:50Z" });
  const suiAt = pAt.prices?.find((p) => p.symbol === "SUI");
  // SUI traded near $4.16 at the Cetus exploit (DeepBook's 10:00 candle closed at 4.19).
  ck("SUI at the Cetus exploit is about $4.16", suiAt && suiAt.price_usd > 4.1 && suiAt.price_usd < 4.25 && Math.abs(suiAt.price_offset_sec) < 300, `${suiAt?.price_usd} (${suiAt?.source}, ${suiAt?.price_offset_sec}s)`);
  const llamaAt = await llama(SUI, CETUS_S);
  ck("and agrees with DefiLlama read directly", suiAt && near(suiAt.price_usd, llamaAt, 0.005), `${suiAt?.price_usd} vs ${llamaAt}`);
  const pNow = await call("get_token_prices", { coin_types: ["0x2::sui::SUI"] });
  const suiNow = pNow.prices?.[0];
  const nowS = Math.floor(Date.now() / 1000);
  const [llamaNow, llamaDayAgo] = [await llama(SUI), await llama(SUI, nowS - 86400)];
  ck("current SUI is within 3% of DefiLlama now", suiNow && near(suiNow.price_usd, llamaNow, 0.03), `${suiNow?.price_usd} (${suiNow?.source}) vs ${llamaNow}`);
  const change = (llamaNow / llamaDayAgo - 1) * 100;
  ck("the 24h change is the move between DefiLlama's price a day ago and now", suiNow && typeof suiNow.price_change_24h_percent === "number" && Math.abs(suiNow.price_change_24h_percent - change) < 1, `${suiNow?.price_change_24h_percent} vs ${change.toFixed(2)}`);

  console.log("\ncompare_oracle_price on SUI_USDC before the Cetus exploit");
  const END_S = Math.floor(Date.parse("2025-05-22T10:40:00Z") / 1000);
  const oracle = await call("compare_oracle_price", { pool_name: "SUI_USDC", interval: "1h", limit: 24, end_time: END_S });
  const pts = oracle.points ?? [];
  ck("24 hourly candles", pts.length === 24, `${pts.length}`);
  // A candle's close is the last trade before the next candle opens, or the window end.
  const closeS = (pt) => Math.min(pt.timestamp_ms / 1000 + 3600, END_S);
  let marketOk = pts.length > 0;
  for (const pt of [pts[0], pts[Math.floor(pts.length / 2)], pts.at(-1)].filter(Boolean)) {
    const ref = await llama(SUI, closeS(pt));
    if (!near(pt.market_price, ref, 0.02)) marketOk = false;
  }
  ck("each sampled candle's close is within 2% of DefiLlama at the close time", marketOk);
  if (process.env.PYTH_API_KEY) {
    ck("the oracle is sampled at the candle's close", pts.every((pt) => pt.oracle_publish_time === null || Math.abs(pt.oracle_publish_time - closeS(pt)) <= 60));
  } else {
    ck("without PYTH_API_KEY it says the oracle side is unavailable, and flags nothing", /PYTH_API_KEY/.test(oracle.oracle_unavailable ?? "") && oracle.flagged_count === null, short(oracle.oracle_unavailable));
  }

  // =========================================================================
  // check_coin_restrictions
  // =========================================================================
  console.log("\ncheck_coin_restrictions on JDSG's deny list");
  const ccr = await call("check_coin_restrictions", { coin_type: JDSG });
  // DenyList (0x403) keys each coin's Config by ConfigKey { per_type_index: 0,
  // per_type_key: the type's bytes without 0x }, BCS-encoded here.
  const typeBytes = Buffer.from(JDSG.slice(2), "utf8");
  const configKey = Buffer.concat([Buffer.alloc(8), Buffer.from([typeBytes.length]), typeBytes]).toString("base64");
  const cfg = await q(
    `query($b:Base64!){ object(address:"0x403"){ dynamicObjectField(name:{ type:"0x2::deny_list::ConfigKey", bcs:$b }){ value { ... on MoveObject { address } } } } }`,
    { b: configKey },
  );
  ck("the config is the one DenyList keys to JDSG", ccr.regulated === true && ccr.config_id === cfg.object.dynamicObjectField?.value?.address, ccr.config_id);
  const epoch = (await q(`{ epoch { epochId } }`)).epoch.epochId;
  const fields = [];
  for (let after = null; ; ) {
    const d = await q(
      `query($a:SuiAddress!,$c:String){ object(address:$a){ dynamicFields(first:50, after:$c){ pageInfo { hasNextPage endCursor } nodes { name { type { repr } json } value { ... on MoveValue { json } } } } } }`,
      { a: ccr.config_id, c: after },
    );
    fields.push(...d.object.dynamicFields.nodes);
    if (!d.object.dynamicFields.pageInfo.hasNextPage) break;
    after = d.object.dynamicFields.pageInfo.endCursor;
  }
  // config::Setting: newer_value applies once the epoch passes newer_value_epoch.
  const active = fields
    .filter((f) => f.name.type.repr.endsWith("::deny_list::AddressKey"))
    .filter((f) => {
      const s = f.value.json.data;
      return (epoch > Number(s.newer_value_epoch) ? s.newer_value : s.older_value_opt) === true;
    })
    .map((f) => f.name.json.pos0)
    .sort();
  const listedDenied = (ccr.denied ?? []).filter((d) => d.active).map((d) => d.address).sort();
  ck("the denied addresses are the config's active AddressKey settings", active.length > 0 && listedDenied.join() === active.join(), `${listedDenied.length} vs ${active.length}`);
  const pauseField = fields.find((f) => f.name.type.repr.endsWith("::deny_list::GlobalPauseKey"));
  const pausedRaw = pauseField ? (epoch > Number(pauseField.value.json.data.newer_value_epoch) ? pauseField.value.json.data.newer_value : pauseField.value.json.data.older_value_opt) === true : false;
  ck("the whole-coin pause is the config's GlobalPauseKey setting, false when there is none", ccr.globally_paused === pausedRaw, `${ccr.globally_paused} vs ${pausedRaw}`);
  const byAddr = await call("check_coin_restrictions", { address: active[0] });
  ck("checking one of them by address finds JDSG among the coins that froze it", byAddr.scan_complete === true && (byAddr.denied_by ?? []).includes(JDSG), `${byAddr.denied_by_count} coins, complete=${byAddr.scan_complete}`);

  // =========================================================================
  // screen_address, classify_deposit_address, export_case (earlier checks)
  // =========================================================================
  console.log("\nexport_case diagram");
  await call("save_finding", {
    case_name: "incident-pass",
    title: "Exploit proceeds",
    evidence_tier: "chain-derived",
    addresses: [NEMO_ATTACKER],
    digests: [NEMO_EXPLOIT],
  });
  const report = await call("export_case", { case_name: "incident-pass", format: "mermaid" });
  ck("the diagram draws Nemo's shared objects paying the attacker", /Nemo[^\n]*shared objects/.test(report._text) && /-->\|"[\d.]+ SUI"\|/.test(report._text));

  console.log("\nscreen_address and classify_deposit_address");
  const screen = await call("screen_address", { address: CETUS_ATTACKER });
  const subject = screen.subject?.label;
  ck("the Cetus attacker's label cites its source", subject?.category === "malicious" && /^https:/.test(subject?.source_url ?? ""), short(JSON.stringify(subject)));
  const depo = await call("classify_deposit_address", { address: BINANCE_DEPOSIT });
  ck("a Binance deposit address is likely", depo.verdict === "likely", depo.verdict);
  ck("it sweeps to the Binance hot wallet", depo.hot_wallet === BINANCE_HOT || depo.hot_wallet?.address === BINANCE_HOT, short(JSON.stringify(depo.hot_wallet)));

  await call("analyze_package", { package_id: "0x2" });
  ck("analyze_package 0x2 stays under 60k characters", stats.at(-1).chars > 0 && stats.at(-1).chars < 60_000, `${stats.at(-1).chars}`);
} finally {
  stop();
}

// ---- latency and size --------------------------------------------------------
console.log("\nlatency and size per call");
for (const s of stats) {
  const limit = declaredLimit.get(s.tool) ?? 100_000;
  const slow = s.ms > 60_000;
  const big = s.chars > limit;
  console.log(`   ${slow || big ? "!!  " : "    "}${s.tool.padEnd(28)} ${(s.ms / 1000).toFixed(1).padStart(6)}s ${String(s.chars).padStart(8)} ch${declaredLimit.get(s.tool) ? ` (declares ${limit})` : ""}`);
  if (slow) ck(`${s.tool} answered within 60s`, false, `${s.ms}ms`);
  if (big) ck(`${s.tool} stayed within ${limit} characters`, false, `${s.chars}`);
}
finish();
