#!/usr/bin/env node
/**
 * Surface pass: the stateful tools, the prompts and resources, and the core,
 * market and developer tools no other probe reaches, driven over stdio.
 *
 * Each check compares a tool's answer with an independent raw read of the
 * same fact (GraphQL, taken in the same run where the value can move), with a
 * pinned historical fact, or with an invariant the answer must satisfy. Every
 * tool also gets one malformed call that must be refused. Latency and output
 * size are recorded per call; a call over 60s, or over 100k characters for a
 * tool that does not declare a larger result, fails the run.
 */
import { startServer, gql, rawNet, checker, short, SUI, ROOT } from "./lib/mcp-client.mjs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const NEMO_ATTACKER = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
const NEMO_EXPLOIT = "19Zkat1xArMTMvPCB4e4QtM5HstpYiKvgPjbvkLUAw9";
const NEMO_ROOT = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const NEMO_FUNDER = "0x1f7b27844f2c4a0262b2c481f7ab956d10ace524c5a7b06c3742cfb8701db714";
const CETUS_EXPLOIT = "DVMG3B2kocLEnVMDuQzTYRgjwuuFSfciawPvXXheB3x";
const CETUS_TAUNT_NAME = "give-the-funds-back-you-maniac-yngmi.sui";
const BINANCE_HOT = "0x935029ca5219502a47ac9b69f556ccf6e2198b5e7815cf50f68846f723739cbd";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const FAKE_USDC = "0x006e09c3c3ebb8c4670e0320da7efe926d35347608f964b4625dd47bae40a664::usdc::USDC";
const STAKER = "0xd30018ec3f5ff1a3c75656abf927a87d7f0529e6dc89c7ddd1bd27ecb05e3db2";
const KIOSK_WALLET = "0x7b2b3d0354c04e126a9faedd8becc8d02853b491060bd145b8964951dc99c4fc";
const KIOSK = "0x993ca6e7e5dba21b613f7e5df86ab65d75552150a59dd29e181e7ce87a9074d9";
const TURBOS_QUIET_POOL = "0xbf20413c194a4cdf944dbb56f57999f94f78bfec66134f2911ab2df7549b3f6e";
const CETUS_SUI_USDC = "0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab";
const TURBOS_POOL_CONFIG = "0xc294552b2765353bcafa7c359cd28fd6bc237662e5db8f09877558d81669170c";
const VALIDATOR = "0x8f8ea04f3b751533db8b8da0a40eba1ca8332a92680f058d83b9459d061aaa54";
const pad = (h) => `0x${h.replace(/^0x/, "").padStart(64, "0")}`;
const SUI_FULL = SUI;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { ck, finish } = checker();
const calls = [];

/** Wraps a server's call: retries transient service errors, records latency and size, flags outliers. */
function instrument(server, declared) {
  return async function call(tool, args) {
    for (let attempt = 0; ; attempt++) {
      const msg = await server.callRaw(tool, args, 300_000);
      const texts = (msg.result?.content ?? []).map((c) => c.text ?? "");
      const chars = texts.reduce((n, t) => n + t.length, 0);
      let out;
      if (msg.error) out = { _error: msg.error.message };
      else {
        const json = texts.find((t) => t.trim().startsWith("{"));
        out = json ? JSON.parse(json) : { _text: texts.join("\n") };
        if (msg.result.isError) out._isError = true;
      }
      out._ms = msg.ms;
      const transient = out._isError && /Unknown error|RESOURCE_EXHAUSTED|Rate-limited|HTTP 429|UNAVAILABLE/.test(out.error ?? "");
      if (transient && attempt < 3) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      calls.push({ tool, ms: msg.ms, chars });
      if (msg.ms > 60_000) ck(`${tool} answers within 60s`, false, `${msg.ms}ms`);
      const limit = declared.get(tool) ?? 100_000;
      if (chars > limit) ck(`${tool} stays under ${limit} characters`, false, `${chars}`);
      return out;
    }
  };
}

/** Every page of a GraphQL connection reached by `path` from the query root. */
async function allNodes(query, vars, path) {
  const out = [];
  let after = null;
  for (;;) {
    const d = await gql(query, { ...vars, after });
    const conn = path(d);
    out.push(...(conn?.nodes ?? []));
    if (!conn?.pageInfo?.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

const server = await startServer({ name: "surface-pass" });
const listed = (await server.rpc("tools/list", {})).result.tools;
const toolNames = new Set(listed.map((t) => t.name));
const declared = new Map(listed.filter((t) => t._meta?.["anthropic/maxResultSizeChars"]).map((t) => [t.name, t._meta["anthropic/maxResultSizeChars"]]));
const call = instrument(server, declared);

try {
  // ======================================================================
  // manage_labels: a session label changes identify_address and trace_funds
  // ======================================================================
  console.log("\nmanage_labels");
  const before = await call("manage_labels", { action: "list" });
  const added = await call("manage_labels", { action: "add", address: NEMO_FUNDER.toUpperCase().replace("0X", "0x"), label: "Surface probe exchange", category: "cex" });
  ck("an upper-case address is stored under its canonical account", added.added?.account === `sui:mainnet:${NEMO_FUNDER}`, short(added.added?.account));
  const after = await call("manage_labels", { action: "list" });
  ck("list grows by exactly the added label", after.count === before.count + 1, `${before.count} -> ${after.count}`);
  const looked = await call("manage_labels", { action: "lookup", address: NEMO_FUNDER });
  ck("lookup returns the session label, as a sink", looked.label?.label === "Surface probe exchange" && looked.is_sink === true, short(looked.label));
  const idFunder = await call("identify_address", { address: NEMO_FUNDER });
  ck("identify_address shows the session label", idFunder.label?.label === "Surface probe exchange" && idFunder.label?.source === "session", short(idFunder.label));

  // The disclosed Nemo attacker label is malicious: traces follow it, so it is not a sink.
  const malicious = await call("manage_labels", { action: "lookup", address: NEMO_ATTACKER });
  ck("a malicious label is not a sink", malicious.label?.category === "malicious" && malicious.is_sink === false, short(malicious));
  await call("manage_labels", { action: "add", address: NEMO_ATTACKER, label: "Surface probe desk", category: "cex" });
  const stopped = await call("trace_funds", { digest: NEMO_EXPLOIT, direction: "forward", hops: 3 });
  ck("a session cex label on the attacker stops trace_funds at hop 1", stopped.hops?.length === 1 && /Surface probe desk \(cex\)/.test(stopped.stop_reason ?? ""), short(stopped.stop_reason));
  const removed = await call("manage_labels", { action: "remove", address: NEMO_ATTACKER });
  const idAttacker = await call("identify_address", { address: NEMO_ATTACKER });
  ck("remove restores the disclosed label", removed.removed === true && idAttacker.label?.category === "malicious" && idAttacker.label?.is_sink === false, short(idAttacker.label));
  const imp = await call("manage_labels", { action: "import", labels: [
    { address: BINANCE_HOT, label: "Surface probe import", category: "cex" },
    { address: "0xZZ", label: "bad", category: "cex" },
  ] });
  const impLook = await call("manage_labels", { action: "lookup", address: BINANCE_HOT });
  ck("import keeps the valid entry and reports the malformed one", imp.imported === 1 && imp.skipped_count === 1 && impLook.label?.label === "Surface probe import", `${imp.imported}/${imp.skipped_count}`);

  // ======================================================================
  // Findings: save, list, export in four formats, the case resource, delete
  // ======================================================================
  console.log("\nfindings");
  const CASE = "surface-pass";
  const f1 = await call("save_finding", { case_name: CASE, title: "Exploit proceeds", detail: "SUI out of the Nemo markets", confidence: "high", evidence_tier: "chain-derived", addresses: [NEMO_ATTACKER], digests: [NEMO_EXPLOIT] });
  const f2 = await call("save_finding", { case_name: CASE, title: "Funder", evidence_tier: "heuristic", addresses: [NEMO_FUNDER, "eip155:1:0x135477aa627a3bcc3223bde10dd8e7c55a1f645c"] });
  const listedF = await call("list_findings", { case_name: CASE });
  ck("list_findings holds both, addresses as CAIP-10 accounts", listedF.finding_count === 2 && listedF.findings?.[0]?.addresses?.[0] === `sui:mainnet:${NEMO_ATTACKER}`, short(listedF.findings?.[0]?.addresses));
  const cases = await call("list_findings", {});
  ck("the case appears in the case list with its count", cases.cases?.some((c) => c.case_name === CASE && c.finding_count === 2), short(cases.cases));
  const md = (await call("export_case", { case_name: CASE }))._text ?? "";
  ck("markdown carries both titles and every full address", /### Exploit proceeds/.test(md) && /### Funder/.test(md) && md.includes(NEMO_ATTACKER) && md.includes(NEMO_FUNDER));
  const resource = await server.rpc("resources/read", { uri: `sui://case/${CASE}` });
  const stripGenerated = (t) => t.replace(/_Generated by .* at [^_]*\._/g, "");
  ck("sui://case/{name} equals export_case markdown", stripGenerated(resource.result?.contents?.[0]?.text ?? "") === stripGenerated(md));
  const mermaid = (await call("export_case", { case_name: CASE, format: "mermaid" }))._text ?? "";
  ck("mermaid export carries a diagram", mermaid.includes("```mermaid"));
  const graph = await call("export_case", { case_name: CASE, format: "graph_json" });
  const edge = (graph.edges ?? []).find((e) => e.target === NEMO_ATTACKER && e.coin_type === SUI_FULL);
  const gas = (await gql(`query($d:String!){ transaction(digest:$d){ effects{ gasEffects{ gasSummary{ computationCost storageCost storageRebate } } } } }`, { d: NEMO_EXPLOIT })).transaction.effects.gasEffects.gasSummary;
  const netGas = BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
  const net = await rawNet([NEMO_EXPLOIT], NEMO_ATTACKER, SUI_FULL);
  ck("graph edge into the attacker = raw SUI net + gas paid", edge && BigInt(edge.amount) === net + netGas, `${edge?.amount} vs ${net}+${netGas}`);
  const csv = (await call("export_case", { case_name: CASE, format: "csv" }))._text ?? "";
  ck("csv has a header and one row per finding", csv.trim().split("\n").length === 3 && csv.startsWith("id,evidence_tier"));
  const del = await call("delete_finding", { finding_id: f2.finding_id });
  const delAgain = await call("delete_finding", { finding_id: f2.finding_id });
  const afterDel = await call("list_findings", { case_name: CASE });
  ck("delete removes one finding, a second delete finds none", del.deleted === true && delAgain.deleted === false && afterDel.finding_count === 1 && afterDel.findings[0].id === f1.finding_id);

  // ======================================================================
  // watch_addresses / poll_watch
  // ======================================================================
  console.log("\nwatch");
  const cpBefore = Number((await gql(`{ checkpoint { sequenceNumber } }`)).checkpoint.sequenceNumber);
  const w = await call("watch_addresses", { action: "add", addresses: [BINANCE_HOT, NEMO_ATTACKER], label: "probe" });
  const cpAfter = Number((await gql(`{ checkpoint { sequenceNumber } }`)).checkpoint.sequenceNumber);
  ck("watching starts at the current checkpoint", w.added === 2 && w.from_checkpoint >= cpBefore - 5 && w.from_checkpoint <= cpAfter + 5, `${cpBefore} <= ${w.from_checkpoint} <= ${cpAfter}`);
  const p1 = await call("poll_watch", {});
  ck("the first poll reports nothing older than the watch", (p1.hits ?? []).every((h) => Number(h.checkpoint) > w.from_checkpoint), `${p1.hits?.length} hits`);
  // The hot wallet moves every minute or so. Wait for the chain to show one
  // of its transactions after the watch began, then that one must be a hit.
  let firstRaw = null;
  for (let i = 0; i < 20 && !firstRaw; i++) {
    await sleep(10_000);
    firstRaw = (await gql(`query($a:SuiAddress!,$cp:UInt53!){ transactions(first:1, filter:{affectedAddress:$a, afterCheckpoint:$cp}){ nodes{ digest effects{ checkpoint{ sequenceNumber } } } } }`, { a: BINANCE_HOT, cp: w.from_checkpoint })).transactions.nodes[0] ?? null;
  }
  const p2 = await call("poll_watch", { max_per_address: 10 });
  const hits = [...(p1.hits ?? []), ...(p2.hits ?? [])].filter((h) => h.address === BINANCE_HOT);
  ck("poll_watch reports the watched address's first raw transaction after the watch began", !!firstRaw && hits.some((h) => h.digest === firstRaw.digest && Number(h.checkpoint) === Number(firstRaw.effects.checkpoint.sequenceNumber)), `${firstRaw?.digest} in ${hits.length} hits`);
  const wr = await call("watch_addresses", { action: "remove", addresses: [NEMO_ATTACKER] });
  const wl = await call("watch_addresses", { action: "list" });
  ck("remove leaves one watch", wr.removed === 1 && wl.watched === 1 && wl.watches[0].address === BINANCE_HOT);

  // ======================================================================
  // Prompts name only tools that exist
  // ======================================================================
  console.log("\nprompts");
  const verbs = new Set([...toolNames].map((t) => t.split("_")[0]));
  const promptArgs = { investigate_address: { address: NEMO_ATTACKER }, trace_incident: { subject: NEMO_EXPLOIT }, attribute_cluster: { addresses: `${NEMO_ATTACKER},${NEMO_FUNDER}` } };
  for (const [name, args] of Object.entries(promptArgs)) {
    const r = await server.rpc("prompts/get", { name, arguments: args });
    const text = (r.result?.messages ?? []).map((m) => m.content?.text ?? "").join("\n");
    const tokens = [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])];
    const unknown = tokens.filter((t) => !toolNames.has(t) && verbs.has(t.split("_")[0]));
    ck(`${name} renders and names only existing tools`, text.length > 1000 && tokens.some((t) => toolNames.has(t)) && unknown.length === 0, unknown.join(","));
  }

  // ======================================================================
  // Tokens
  // ======================================================================
  console.log("\ntokens");
  const rawMeta = async (t) => (await gql(`query($t:String!){ coinMetadata(coinType:$t){ decimals symbol supply } }`, { t })).coinMetadata;
  const real = await call("analyze_token", { query: USDC, include_holders: false });
  const realRaw = await rawMeta(USDC);
  ck("analyze_token: Circle USDC is verified, decimals from chain", real.verified === true && real.decimals === realRaw.decimals, `${real.decimals} vs ${realRaw.decimals}`);
  const fake = await call("analyze_token", { query: FAKE_USDC, include_holders: false });
  const fakeRaw = await rawMeta(FAKE_USDC);
  ck("analyze_token: the usdv2 impostor is unverified and blocklisted", fake.verified === false && fake.decimals === fakeRaw.decimals && fake.symbol === fakeRaw.symbol && (fake.flagged_by ?? []).length > 0, short(fake.flagged_by?.[0]?.list));
  const none = await call("analyze_token", { query: "0x1::nope::NOPE" });
  ck("analyze_token refuses a coin type that does not exist", none._isError === true && (await rawMeta(pad("1") + "::nope::NOPE")) === null, short(none.error));
  const info = await call("get_coin_info", { coin_type: USDC });
  const infoRaw = await rawMeta(USDC);
  ck("get_coin_info matches raw CoinMetadata", info.decimals === infoRaw.decimals && info.symbol === infoRaw.symbol && info.total_supply === infoRaw.supply, `${info.total_supply} vs ${infoRaw.supply}`);
  const search = await call("search_token", { query: "USDC", limit: 20 });
  const circle = (search.results ?? []).find((r) => r.coin_type === USDC);
  const firstUnverified = (search.results ?? []).findIndex((r) => !r.verified);
  ck("search_token lists Circle USDC as verified, before any unverified match", circle?.verified === true && (firstUnverified === -1 || firstUnverified > search.results.indexOf(circle)), short(circle));
  ck("search_token marks no scan result as verified", (search.results ?? []).every((r) => r.source !== "discovery" || r.verified === false));

  // ======================================================================
  // NFTs, DeFi, staking
  // ======================================================================
  console.log("\nholdings");
  const rawNftIds = new Set();
  const kiosks = [];
  for (const n of await allNodes(`query($a:SuiAddress!,$after:String){ address(address:$a){ objects(first:50, after:$after){ pageInfo{hasNextPage endCursor} nodes{ address contents{ type{repr} json } } } } }`, { a: KIOSK_WALLET }, (d) => d.address.objects)) {
    const t = n.contents.type.repr;
    if (/::kiosk::KioskOwnerCap$/.test(t)) kiosks.push(n.contents.json.for);
    else if (/::personal_kiosk::PersonalKioskCap$/.test(t)) kiosks.push(n.contents.json.cap?.for);
    else if (!/::coin::Coin</.test(t) && !/::staking_pool::StakedSui$/.test(t)) rawNftIds.add(n.address);
  }
  for (const k of kiosks) {
    for (const n of await allNodes(`query($a:SuiAddress!,$after:String){ address(address:$a){ dynamicFields(first:50, after:$after){ pageInfo{hasNextPage endCursor} nodes{ name{ type{repr} } value{ ... on MoveObject{ address } } } } } }`, { a: k }, (d) => d.address.dynamicFields)) {
      if (/::kiosk::Item$/.test(n.name.type.repr)) rawNftIds.add(n.value.address);
    }
  }
  const nfts = await call("list_nfts", { address: KIOSK_WALLET, limit: 50 });
  ck("list_nfts = owned non-coin objects plus kiosk items", !nfts.next_cursor && sameSet((nfts.nfts ?? []).map((n) => n.object_id), [...rawNftIds]), `${nfts.nfts?.length} vs ${rawNftIds.size}`);
  const cols = await call("list_nft_collections", { address: KIOSK_WALLET });
  ck("list_nft_collections counts the same NFTs, and its collections sum to the total", cols.total_nfts === rawNftIds.size && (cols.collections ?? []).reduce((s, c) => s + c.count, 0) === cols.total_nfts, `${cols.total_nfts}`);

  const stakes = await allNodes(`query($a:SuiAddress!,$after:String){ address(address:$a){ objects(filter:{type:"0x3::staking_pool::StakedSui"}, first:50, after:$after){ pageInfo{hasNextPage endCursor} nodes{ contents{ json } } } } }`, { a: STAKER }, (d) => d.address.objects);
  const rawPrincipal = stakes.reduce((s, n) => s + BigInt(n.contents.json.principal), 0n);
  const staking = await call("get_staking_summary", { address: STAKER });
  ck("get_staking_summary total = sum of raw StakedSui principal", staking.total_staked_mist === rawPrincipal.toString() && staking.position_count === stakes.length, `${staking.total_staked_mist} vs ${rawPrincipal} (${stakes.length})`);
  const defi = await call("get_defi_positions", { address: STAKER });
  ck("get_defi_positions lists every StakedSui", (defi.positions?.staked_sui ?? []).length === stakes.length && !defi.truncated_protocols, `${defi.positions?.staked_sui?.length}`);

  // ======================================================================
  // Pools
  // ======================================================================
  console.log("\npools");
  const pools = await call("find_pools", { token_a: "0x2::sui::SUI", token_b: USDC });
  const feeMap = (await gql(`query($id:SuiAddress!){ object(address:$id){ asMoveObject{ contents{ json } } } }`, { id: TURBOS_POOL_CONFIG })).object.asMoveObject.contents.json.fee_map.contents.map((e) => `0x${e.key}`);
  const templates = [
    "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::Pool<{A}, {B}>",
    "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::pool::Pool<{A}, {B}>",
    "0x158f2027f60c89bb91526d9bf08831d27f5a0fcb0f74e6698b9f0e1fb2be5d05::clob_v2::Pool<{A}, {B}>",
    ...feeMap.map((f) => `0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::pool::Pool<{A}, {B}, ${f}>`),
  ];
  const rawPools = [];
  for (const t of templates) {
    for (const [a, b] of [[SUI_FULL, USDC], [USDC, SUI_FULL]]) {
      const nodes = await allNodes(`query($t:String!,$after:String){ objects(filter:{type:$t}, first:50, after:$after){ pageInfo{hasNextPage endCursor} nodes{ address asMoveObject{ contents{ type{ repr } } } } } }`, { t: t.replace("{A}", a).replace("{B}", b) }, (d) => d.objects);
      rawPools.push(...nodes.map((n) => ({ id: n.address, first: a })));
    }
  }
  ck("find_pools returns exactly the raw pools of every protocol and fee tier", sameSet((pools.pools ?? []).map((p) => p.pool_id), rawPools.map((p) => p.id)), `${pools.total} vs ${rawPools.length}`);
  ck("find_pools gives each pool's own token order", rawPools.every((r) => pools.pools?.find((p) => p.pool_id === r.id)?.token_a === r.first));

  const rawObj = async (id) => (await gql(`query($id:SuiAddress!){ object(address:$id){ version asMoveObject{ contents{ json } } } }`, { id })).object;
  const tBefore = await rawObj(TURBOS_QUIET_POOL);
  const tStats = await call("get_pool_stats", { pool_id: TURBOS_QUIET_POOL });
  const tAfter = await rawObj(TURBOS_QUIET_POOL);
  if (tBefore.version === tAfter.version) {
    const j = tAfter.asMoveObject.contents.json;
    ck("get_pool_stats (Turbos) reserves and fee = raw object", tStats.reserves?.coin_a === j.coin_a && tStats.reserves?.coin_b === j.coin_b && tStats.fee_info?.fee === j.fee, `${tStats.reserves?.coin_a} vs ${j.coin_a}`);
  }
  const cStats = await call("get_pool_stats", { pool_id: CETUS_SUI_USDC });
  // Pool<USDC, SUI>: sqrt price is sqrt(SUI per USDC) in Q64, scaled by 10^(6-9).
  const suiPerUsdc = (Number(BigInt(cStats.extra?.current_sqrt_price ?? 0)) / 2 ** 64) ** 2 * 1e-3;
  const priceSui = cStats.prices?.[SUI_FULL];
  ck("get_pool_stats (Cetus): the pool's own price agrees with the quoted SUI price within 3%", priceSui > 0 && Math.abs(1 / suiPerUsdc / priceSui - 1) < 0.03, `${(1 / suiPerUsdc).toFixed(4)} vs ${priceSui}`);

  // ======================================================================
  // Names, chain, checkpoints, validators
  // ======================================================================
  console.log("\nchain");
  const regs = (await gql(`{ objects(filter:{type:"0xd22b24490e0bae52676651b4f56660a5ff8022a2576e0089f79b3c88d44e08f0::suins_registration::SuinsRegistration"}, last:30){ nodes{ owner{ ... on AddressOwner{ address{ address defaultNameRecord{ domain } } } } } } }`)).objects.nodes;
  const holder = regs.map((n) => n.owner?.address).find((a) => a?.defaultNameRecord?.domain);
  if (holder) {
    const domain = holder.defaultNameRecord.domain;
    const fwdRaw = (await gql(`query($n:String!){ address(name:$n){ address } }`, { n: domain })).address?.address ?? null;
    const both = await call("resolve_name", { name: domain, address: holder.address });
    ck("resolve_name forward and reverse = raw SuiNS reads", both.address === fwdRaw && both.name === domain, `${domain}`);
  } else {
    ck("found a live SuiNS reverse record to check", false);
  }
  const expired = await call("resolve_name", { name: CETUS_TAUNT_NAME });
  const expiredRaw = (await gql(`query($n:String!){ address(name:$n){ address } }`, { n: CETUS_TAUNT_NAME })).address;
  ck("an expired name resolves to null and says it expired", expired.address === null && /expired/.test(expired.name_note ?? "") && expiredRaw === null, short(expired.name_note));

  const chain = await call("get_chain_info", {});
  const chainRaw = await gql(`{ chainIdentifier epoch{ epochId referenceGasPrice } }`);
  ck("get_chain_info = raw chain id, epoch and reference gas price", chain.chain_id === chainRaw.chainIdentifier && Number(chain.epoch) === chainRaw.epoch.epochId && chain.reference_gas_price === String(chainRaw.epoch.referenceGasPrice), `${chain.reference_gas_price} vs ${chainRaw.epoch.referenceGasPrice}`);
  const ep = await call("get_chain_info", { epoch: "800" });
  const epRaw = (await gql(`{ epoch(epochId:800){ referenceGasPrice startTimestamp endTimestamp } }`)).epoch;
  ck("get_chain_info epoch 800 = raw epoch", ep.reference_gas_price === String(epRaw.referenceGasPrice) && Date.parse(ep.start) === Date.parse(epRaw.startTimestamp) && Date.parse(ep.end) === Date.parse(epRaw.endTimestamp), `${ep.start} vs ${epRaw.startTimestamp}`);

  const cpRaw = (await gql(`{ checkpoint(sequenceNumber:187415930){ digest timestamp } prev: checkpoint(sequenceNumber:187415929){ timestamp } }`));
  const byNum = await call("get_checkpoint", { sequence_number: "187415930" });
  ck("get_checkpoint by number = raw digest (the Nemo exploit's checkpoint)", byNum.digest === cpRaw.checkpoint.digest && Date.parse(byNum.timestamp) === Date.parse(cpRaw.checkpoint.timestamp), byNum.digest);
  const byDigest = await call("get_checkpoint", { digest: cpRaw.checkpoint.digest });
  ck("get_checkpoint by digest returns that checkpoint", byDigest.sequence_number === "187415930");
  const at = "2025-09-07T16:05:11.400Z";
  const byTime = await call("get_checkpoint", { timestamp: at });
  ck("get_checkpoint by time returns the first checkpoint at or after it", Date.parse(byTime.timestamp) >= Date.parse(at) && Date.parse(cpRaw.prev.timestamp) < Date.parse(at) && byTime.sequence_number === "187415930", `${byTime.sequence_number} ${byTime.timestamp}`);

  const vals = await call("get_validators", { limit: 150 });
  const rawVals = await allNodes(`query($after:String){ epoch{ validatorSet{ activeValidators(first:50, after:$after){ pageInfo{hasNextPage endCursor} nodes{ contents{ json } } } } } }`, {}, (d) => d.epoch.validatorSet.activeValidators);
  const top = rawVals.map((v) => v.contents.json).sort((a, b) => (BigInt(b.staking_pool.sui_balance) > BigInt(a.staking_pool.sui_balance) ? 1 : -1))[0];
  ck("get_validators = raw active set: count and top validator by stake", vals.active_validator_count === rawVals.length && vals.validators?.[0]?.address === top.metadata.sui_address, `${vals.active_validator_count} vs ${rawVals.length}, ${vals.validators?.[0]?.name} vs ${top.metadata.name}`);

  // ======================================================================
  // DeepBook
  // ======================================================================
  console.log("\ndeepbook");
  const book = await call("deepbook_orderbook", { pool_name: "SUI_USDC", depth: 5 });
  const bookType = (await gql(`query($id:SuiAddress!){ object(address:$id){ asMoveObject{ contents{ type{ repr } } } } }`, { id: book.pool_id })).object.asMoveObject.contents.type.repr;
  ck("deepbook_orderbook's pool is DeepBook v3 Pool<SUI, Circle USDC> on chain", bookType === `0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::pool::Pool<${SUI_FULL},${USDC}>`, short(bookType));
  const bidsDesc = (book.bids ?? []).every((b, i, a) => i === 0 || a[i - 1].price >= b.price);
  const asksAsc = (book.asks ?? []).every((b, i, a) => i === 0 || a[i - 1].price <= b.price);
  ck("the book is ordered and not crossed", bidsDesc && asksAsc && book.summary?.best_bid < book.summary?.best_ask && book.summary.best_bid === book.bids[0].price, `${book.summary?.best_bid} < ${book.summary?.best_ask}`);
  const trades = await call("deepbook_trades", { pool_name: "SUI_USDC", limit: 3 });
  const tr = trades.trades?.[0];
  if (tr) {
    const events = (await gql(`query($d:String!){ transaction(digest:$d){ effects{ events(first:50){ nodes{ contents{ json } } } } } }`, { d: tr.digest })).transaction.effects.events.nodes.map((n) => n.contents.json);
    const fills = events.flatMap((e) => (e.pool_id === book.pool_id ? (e.fills ?? [e]) : []));
    const match = fills.some((f) => Number(f.base_quantity) / 1e9 === tr.base_volume && Number(f.quote_quantity) / 1e6 === tr.quote_volume);
    ck("deepbook_trades' first trade is a raw fill in that pool", match, short(tr));
  } else {
    ck("deepbook_trades returned a trade", false);
  }

  // ======================================================================
  // Developer: decode, build, simulate, fields, dependencies, MVR, decompile
  // ======================================================================
  console.log("\ndeveloper");
  const rawTx = (await gql(`query($d:String!){ transaction(digest:$d){ transactionBcs sender{ address } gasInput{ gasBudget } kind{ ... on ProgrammableTransaction{ inputs(first:50){ nodes{ __typename } } commands(first:50){ nodes{ __typename ... on MoveCallCommand{ function{ name module{ name package{ address } } } arguments{ __typename ... on Input{ ix } ... on TxResult{ cmd ix } } } } } } } } }`, { d: CETUS_EXPLOIT })).transaction;
  const decoded = await call("decode_ptb", { transaction_bcs: rawTx.transactionBcs });
  const rawCmds = rawTx.kind.commands.nodes;
  const cmdsMatch = rawCmds.length === decoded.commands?.length && rawCmds.every((c, i) => {
    const d = decoded.commands[i];
    if (c.__typename !== "MoveCallCommand") return true;
    const target = `${c.function.module.package.address}::${c.function.module.name}::${c.function.name}`;
    const args = c.arguments.map((a) => (a.__typename === "Input" ? `I${a.ix}` : a.ix == null ? `R${a.cmd}` : `N${a.cmd}.${a.ix}`));
    const dargs = d.arguments.map((a) => (a.type === "Input" ? `I${a.index}` : a.type === "Result" ? `R${a.index}` : `N${a.result}.${a.subresult}`));
    return d.target === target && args.join() === dargs.join();
  });
  ck("decode_ptb on the Cetus exploit's BCS = raw sender, inputs and commands", decoded.sender === rawTx.sender.address && decoded.input_count === rawTx.kind.inputs.nodes.length && decoded.gas_budget === String(rawTx.gasInput.gasBudget) && cmdsMatch, `${decoded.command_count} cmds`);

  const AMOUNT = 1_000_000_000n;
  const built = await call("build_transfer", { sender: NEMO_FUNDER, recipient: BINANCE_HOT, amount: AMOUNT.toString() });
  const sim = await call("simulate_transaction", { transaction_bcs: built.transaction_bcs });
  const bc = (a) => BigInt(sim.balance_changes?.find((c) => c.address === a && c.coin_type === SUI_FULL)?.amount ?? "0");
  const simGas = BigInt(sim.gas?.computation_cost ?? 0) + BigInt(sim.gas?.storage_cost ?? 0) - BigInt(sim.gas?.storage_rebate ?? 0);
  ck("a simulated build_transfer moves exactly the amount, the sender also paying gas", sim.status?.success && bc(BINANCE_HOT) === AMOUNT && bc(NEMO_FUNDER) === -AMOUNT - simGas, `${bc(NEMO_FUNDER)} = -${AMOUNT} - ${simGas}`);
  const builtDecoded = await call("decode_ptb", { transaction_bcs: built.transaction_bcs });
  ck("decode_ptb reads the built transfer back", builtDecoded.sender === NEMO_FUNDER && (builtDecoded.commands ?? []).some((c) => /Transfer/.test(c.type)), short(builtDecoded.commands?.map((c) => c.type)));
  const stake = await call("build_staking", { action: "stake", sender: NEMO_FUNDER, validator_address: VALIDATOR, amount_mist: "2000000000" });
  const simStake = await call("simulate_transaction", { transaction_bcs: stake.transaction_bcs });
  const stakeGas = BigInt(simStake.gas?.computation_cost ?? 0) + BigInt(simStake.gas?.storage_cost ?? 0) - BigInt(simStake.gas?.storage_rebate ?? 0);
  const stakeDelta = BigInt(simStake.balance_changes?.find((c) => c.address === NEMO_FUNDER)?.amount ?? "0");
  ck("a simulated build_staking stakes the amount and emits a staking request", simStake.status?.success && stakeDelta === -2_000_000_000n - stakeGas && (simStake.events ?? []).some((e) => /StakingRequestEvent/.test(e.event_type)), `${stakeDelta}`);

  const fields = await call("list_dynamic_fields", { parent_id: KIOSK });
  const rawFields = await allNodes(`query($a:SuiAddress!,$after:String){ address(address:$a){ dynamicFields(first:50, after:$after){ pageInfo{hasNextPage endCursor} nodes{ address } } } }`, { a: KIOSK }, (d) => d.address.dynamicFields);
  ck("list_dynamic_fields = raw dynamic fields", sameSet((fields.dynamic_fields ?? []).map((f) => f.field_id), rawFields.map((f) => f.address)), `${fields.dynamic_fields?.length} vs ${rawFields.length}`);

  const deps = await call("get_package_dependency_graph", { package_id: NEMO_ROOT });
  const linkage = (await gql(`query($a:SuiAddress!){ object(address:$a){ asMovePackage{ linkage{ upgradedId version } } } }`, { a: NEMO_ROOT })).object.asMovePackage.linkage;
  const rootNode = deps.graph?.find((n) => n.package_id === NEMO_ROOT);
  ck("get_package_dependency_graph = Nemo v1's raw linkage, with versions", sameSet((rootNode?.dependencies ?? []).map((d) => `${d.package_id}@${d.linked_version}`), linkage.map((l) => `${l.upgradedId}@${l.version}`)), `${rootNode?.dependencies?.length} vs ${linkage.length}`);

  const NAME = "@deepbook/core";
  const resolved = (await call("mvr_resolve", { names: [NAME] })).resolution?.[NAME]?.package_id;
  const reverse = (await call("mvr_reverse_resolve", { package_ids: [resolved] })).resolution?.[resolved]?.name;
  ck("mvr_resolve then mvr_reverse_resolve round-trips", !!resolved && reverse === NAME, `${resolved} -> ${reverse}`);
  const pkgInfo = await call("mvr_get_package_info", { name: NAME });
  const struct = (await call("mvr_resolve_struct", { types: [`${NAME}::pool::Pool`] })).resolution?.[`${NAME}::pool::Pool`]?.type_tag;
  const infoObj = (await gql(`query($id:SuiAddress!){ object(address:$id){ asMoveObject{ contents{ json } } } }`, { id: pkgInfo.package_info?.id })).object.asMoveObject.contents.json;
  const pkgRaw = (await gql(`query($a:SuiAddress!){ object(address:$a){ asMovePackage{ version typeOrigins{ module struct definingId } } } }`, { a: resolved })).object.asMovePackage;
  const poolOrigin = pkgRaw.typeOrigins.find((o) => o.module === "pool" && o.struct === "Pool")?.definingId;
  ck("MVR's PackageInfo on chain names this package, and the struct's defining package matches", infoObj.metadata.contents.some((e) => e.key === "default" && e.value === NAME) && struct === `${poolOrigin}::pool::Pool` && infoObj.package_address === poolOrigin && pkgInfo.package_address === resolved, short(struct));
  ck("mvr_get_package_info's version is the resolved package's on-chain version", pkgInfo.version === pkgRaw.version, `${pkgInfo.version} vs ${pkgRaw.version}`);
  const mvrSearch = await call("mvr_search", { search: "deepbook", limit: 50 });
  ck("mvr_search finds the name with the same PackageInfo", (mvrSearch.data ?? []).some((d) => d.name === NAME && d.mainnet_package_info_id === pkgInfo.package_info.id));

  const dec = await call("decompile_module", { package_id: "0x2", module_name: "coin" });
  ck("decompile_module without a binary returns the documented fix, with no network hint", dec._isError && /SUI_DECOMPILER_PATH/.test(dec.error) && /disassemble_module/.test(dec.error) && !/looked up on/.test(dec.error), short(dec.error));

  // ======================================================================
  // Malformed input: every tool above refuses a bad argument
  // ======================================================================
  console.log("\nmalformed input");
  const hostile = [
    ["manage_labels", { action: "add", address: "0x1", label: "x", category: "villain" }],
    ["save_finding", { case_name: "c", title: "t", evidence_tier: "rumour" }],
    ["list_findings", { case_name: 5 }],
    ["export_case", { case_name: CASE, format: "pdf" }],
    ["delete_finding", { finding_id: "abc" }],
    ["watch_addresses", { action: "add", addresses: ["0xZZ"] }],
    ["poll_watch", { max_per_address: "abc" }],
    ["enable_tools", { profile: "nope" }],
    ["analyze_token", { query: "0xZZ::coin::COIN" }],
    ["list_nfts", { address: "0xZZ" }],
    ["list_nft_collections", { address: "nope" }],
    ["get_defi_positions", { address: "0xZZ" }],
    ["get_staking_summary", { address: "0xZZ" }],
    ["find_pools", { token_a: "0x2::sui::SUI", token_b: USDC, protocol: "uniswap" }],
    ["get_pool_stats", { pool_id: "0xZZ" }],
    ["resolve_name", { name: "bad name!!" }],
    ["get_chain_info", { epoch: "abc" }],
    ["get_checkpoint", { timestamp: "not a date" }],
    ["get_coin_info", { coin_type: "notacoin" }],
    ["search_token", { query: "USDC", limit: 0 }],
    ["get_validators", { sort_by: "age" }],
    ["deepbook_orderbook", { pool_name: "NOPE_NOPE" }],
    ["deepbook_trades", { pool_name: "NOPE_NOPE" }],
    ["decode_ptb", { transaction_bcs: "notbase64!!" }],
    ["simulate_transaction", { transaction_bcs: "AAAA" }],
    ["build_transfer", { sender: NEMO_FUNDER, recipient: BINANCE_HOT, amount: "-5" }],
    ["build_staking", { action: "stake", sender: NEMO_FUNDER }],
    ["list_dynamic_fields", { parent_id: "0xZZ" }],
    ["get_package_dependency_graph", { package_id: "0x6" }],
    ["mvr_reverse_resolve", { package_ids: ["0xZZ"] }],
    ["mvr_get_package_info", { name: "@nope/definitely-not-registered-xyz" }],
    ["mvr_search", { limit: 0 }],
    ["mvr_resolve_struct", { types: ["@nope/none::m::S"] }],
    ["decompile_module", { package_id: "0xZZ" }],
  ];
  for (const [tool, args] of hostile) {
    const r = await call(tool, args);
    ck(`${tool} refuses ${short(args).slice(0, 60)}`, r._isError === true || !!r._error, short(r));
  }
  const badPrompt = await server.rpc("prompts/get", { name: "investigate_address", arguments: {} });
  ck("a prompt without its required argument is refused", !!badPrompt.error);
  const badName = await call("mvr_resolve", { names: ["not a name"] });
  ck("mvr_resolve of a malformed name resolves to nothing", badName.resolution?.["not a name"]?.package_id === null || badName._isError === true, short(badName));
} finally {
  server.stop();
}

// ======================================================================
// enable_tools on the core profile
// ======================================================================
console.log("\nenable_tools");
const core = await startServer({ name: "surface-core", env: { SUI_TOOLS: "core" } });
try {
  const { PROFILES } = await import(pathToFileURL(join(ROOT, "dist", "tools", "profiles.js")).href);
  const coreCall = instrument(core, new Map());
  const names = async () => new Set((await core.rpc("tools/list", {})).result.tools.map((t) => t.name));
  const beforeTools = await names();
  const disabled = await coreCall("get_validators", {});
  ck("a market tool is off under core, and the refusal names enable_tools", !beforeTools.has("get_validators") && disabled._isError && /enable_tools/.test(JSON.stringify(disabled)), short(disabled));
  const en = await coreCall("enable_tools", { profile: "market" });
  const afterTools = await names();
  const missing = PROFILES.market.filter((t) => !afterTools.has(t));
  ck("enable_tools adds every market tool to tools/list", missing.length === 0 && PROFILES.market.every((t) => beforeTools.has(t) || en.newly_available_tools?.includes(t)), missing.join(","));
} finally {
  core.stop();
}

const slow = [...calls].sort((a, b) => b.ms - a.ms).slice(0, 5);
const big = [...calls].sort((a, b) => b.chars - a.chars).slice(0, 5);
console.log(`\n${calls.length} calls; slowest: ${slow.map((c) => `${c.tool} ${(c.ms / 1000).toFixed(1)}s`).join(", ")}`);
console.log(`largest: ${big.map((c) => `${c.tool} ${c.chars}`).join(", ")}`);
finish();
