#!/usr/bin/env node
/**
 * Second consistency pass: the features shipped since 1.13.0 that the first
 * pass only checked shallowly.
 *
 * Each of these compares a value this server produces against an INDEPENDENT
 * source of the same fact — the chain itself, or the other transport. A tool
 * agreeing with itself proves nothing.
 */
import { registerTransactionTools } from "../../dist/tools/transactions.js";
import { registerAnalyzePackageTools } from "../../dist/tools/analyze-package.js";
import { registerFundingTools } from "../../dist/tools/funding.js";
import { registerHistoryTools } from "../../dist/tools/history.js";
import { runWithNetwork } from "../../dist/config.js";
import { coinScale, displayCoin } from "../../dist/utils/valuation.js";
import { isDigest } from "../../dist/utils/digest.js";
import { SuiGrpcClient } from "@mysten/sui/grpc";

const sui = new SuiGrpcClient({ network: "mainnet", baseUrl: "https://fullnode.mainnet.sui.io" });
const ask = async (q, v) =>
  (await (
    await fetch("https://graphql.mainnet.sui.io/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q, variables: v }),
    })
  ).json());

const tools = {};
const collect = { tool: (n, _d, _s, h) => { tools[n] = h; } };
[registerTransactionTools, registerAnalyzePackageTools, registerFundingTools, registerHistoryTools].forEach((f) => f(collect));
const call = async (n, a) => {
  const r = await tools[n](a);
  const parts = r.content.map((c) => c.text);
  const j = parts.find((t) => t.trim().startsWith("{"));
  return j ? JSON.parse(j) : { _text: parts[0] };
};

const bad = [];
const ck = (n, ok, d = "") => {
  console.log(`   ${ok ? "ok  " : "!!  "}${n}${d ? `  ${d}` : ""}`);
  if (!ok) bad.push(`${n}${d ? ` — ${d}` : ""}`);
};

await runWithNetwork("mainnet", async () => {
  // ---- #91 coin scale: registry decimals vs the chain ---------------------
  // The riskiest of the lot. Every amount this server renders is divided by
  // these. If the curated registry disagrees with on-chain CoinMetadata, every
  // number is wrong and nothing looks wrong.
  console.log("\n#91 registry decimals must match on-chain CoinMetadata");
  const registry = (await import("../../dist/data/coins.json", { with: { type: "json" } })).default;
  const sample = registry.coins.slice(0, 40);
  let mismatch = 0;
  const details = [];
  for (const c of sample) {
    const r = await ask(`query($t:String!){ coinMetadata(coinType:$t){ decimals symbol } }`, { t: c.coin_type });
    const chain = r.data?.coinMetadata;
    if (chain?.decimals == null) continue;
    const ours = coinScale(c.coin_type);
    if (ours.decimals !== chain.decimals) {
      mismatch++;
      details.push(`${c.symbol} registry=${ours.decimals} chain=${chain.decimals}`);
    }
  }
  ck(`decimals agree across ${sample.length} verified coins`, mismatch === 0, details.slice(0, 4).join("; "));

  // A verified coin must never be scaled by a guess.
  const guessed = sample.filter((c) => coinScale(c.coin_type).source !== "registry");
  ck("no verified coin falls back to an assumed scale", guessed.length === 0, guessed.slice(0, 3).map((c) => c.symbol).join(","));
  ck("every verified coin reports verified", sample.every((c) => displayCoin(c.coin_type).verified));

  // ---- #86 failure detail: gRPC vs GraphQL --------------------------------
  console.log("\n#86 both transports must report the same abort");
  const FAILED = "CBjycKjVXizZ2VcxVjE2u6xBhP8YJgSgLziZA7N7crXK";
  const single = await call("get_transaction", { digest: FAILED });        // gRPC
  const batch = await call("get_transactions", { digests: [FAILED] });     // GraphQL
  const b = (batch.transactions ?? batch.found ?? [])[0];
  ck("abort code agrees", single.failure?.abort_code === b?.failure?.abort_code,
     `grpc=${single.failure?.abort_code} gql=${b?.failure?.abort_code}`);
  ck("module agrees", single.failure?.location?.module === b?.failure?.location?.module,
     `grpc=${single.failure?.location?.module} gql=${b?.failure?.location?.module}`);
  ck("function agrees", single.failure?.location?.function === b?.failure?.location?.function,
     `grpc=${single.failure?.location?.function} gql=${b?.failure?.location?.function}`);
  ck("package agrees", single.failure?.location?.package === b?.failure?.location?.package);

  // ---- #90 digest validation: consistent across tools ---------------------
  console.log("\n#90 a malformed digest is rejected the same way everywhere");
  const BAD = "0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a"; // an object ID
  ck("isDigest rejects an object ID", !isDigest(BAD));
  const one = await call("get_transaction", { digest: BAD });
  const many = await call("get_transactions", { digests: [BAD] });
  ck("get_transaction errors rather than throwing", !!one.error, String(one.error).slice(0, 46));
  ck("get_transactions also refuses it", !!(many.error || (many.invalid_digests ?? many.not_found ?? []).length),
     JSON.stringify(many).slice(0, 60));

  // ---- #88 sponsorship: our count vs an independent count -----------------
  console.log("\n#88 sponsored_address_count must match a direct count");
  const SPONSOR = "0xdca840bf8889485caa9ba956798ca230c34c7528a2bff5380daa89a7cab58cc6";
  const fan = await call("get_address_fanout", { address: SPONSOR, max_transactions: 200 });
  let after = null, scanned = 0;
  const payees = new Set();
  while (scanned < 200) {
    const r = await ask(
      `query($a:SuiAddress!,$c:String){ transactions(filter:{affectedAddress:$a}, last:50, before:$c){
        pageInfo{hasPreviousPage startCursor} nodes{ sender{address} gasInput{ gasSponsor{address} } } } }`,
      { a: SPONSOR, c: after });
    const conn = r.data?.transactions; if (!conn?.nodes?.length) break;
    for (const n of conn.nodes) {
      scanned++;
      const sp = n.gasInput?.gasSponsor?.address, s = n.sender?.address;
      if (sp === SPONSOR && s && s !== SPONSOR) payees.add(s);
    }
    if (!conn.pageInfo.hasPreviousPage) break;
    after = conn.pageInfo.startCursor;
  }
  ck("sponsored address count matches an independent scan",
     fan.sponsored_address_count === payees.size,
     `tool=${fan.sponsored_address_count} direct=${payees.size} (scanned ${scanned})`);
  ck("shape follows the count",
     (fan.sponsored_address_count > 20) === (fan.sponsor_shape === "relayer"),
     `count=${fan.sponsored_address_count} shape=${fan.sponsor_shape}`);

  // ---- #92 upgrade cap: burned must classify as burned --------------------
  console.log("\n#92 a cap sent somewhere unspendable reads as burned");
  const caps = (await ask(`{ objects(filter:{type:"0x2::package::UpgradeCap"}, first:40){ nodes{
    asMoveObject{contents{json}} owner{ __typename ... on AddressOwner{ address{address} } } } } }`))
    .data?.objects?.nodes ?? [];
  const burnedCap = caps.find((c) => {
    const h = c.owner?.address?.address;
    return h && /^0x0*[0-9a-f]{0,2}$/.test(h);
  });
  if (!burnedCap) { ck("found a burned cap to test", false, "none in sample"); }
  else {
    const pkg = burnedCap.asMoveObject?.contents?.json?.package;
    const a = await call("analyze_package", { package_id: pkg });
    const up = (a.capabilities?.capabilities ?? []).find((c) => c.kind === "upgrade");
    ck("classified burned", up?.holder_status === "burned", `status=${up?.holder_status} owner=${String(up?.owner_address).slice(0, 12)}`);
    ck("burn note calls it a risk reduction", String(up?.note ?? "").includes("rather than a warning"));
    ck("owner really is the unspendable address",
       up?.owner_address === burnedCap.owner?.address?.address);
  }

  // ---- address poisoning: the tool's pair vs a raw scan of the same page ----
  // A pinned real case. The victim received 0.001 SUI from an address grinding
  // three leading and four trailing characters of one it actually deals with.
  // Everything here is public mainnet data.
  console.log("\naddress poisoning: a pinned mainnet case must still be flagged");
  const POISON_VICTIM = "0xb95db6b2ec5b953cc522296bd70bc5f245a878bd548ecfbd6b84efb52c581125";
  const POISON_REAL = "0xd649a4d5b492c0e6b715c0b7cbe2f13386d905a423c7464e3364322f57127127";
  const POISON_FAKE = "0xd642ef27e58a3a69b92284da03a3a5c2e60500e96a765029f08df81ac75d7127";

  const hist = await call("get_transaction_history", { address: POISON_VICTIM, limit: 50 });
  const flagged = hist.address_poisoning?.pairs ?? [];
  ck("the pinned lookalike pair is reported", flagged.length === 1, `pairs=${flagged.length}`);
  ck("the grinding address is named as the suspect", flagged[0]?.suspect === POISON_FAKE,
     String(flagged[0]?.suspect).slice(0, 14));
  ck("the address it imitates is named as established", flagged[0]?.established === POISON_REAL,
     String(flagged[0]?.established).slice(0, 14));
  ck("match length agrees with a direct comparison",
     flagged[0]?.prefix_chars === 3 && flagged[0]?.suffix_chars === 4,
     `${flagged[0]?.prefix_chars}+${flagged[0]?.suffix_chars}`);

  // Both addresses must really be on the page the tool read — otherwise the
  // pair proves the detector works on data it invented.
  const onPage = new Set();
  for (const t of hist.transactions ?? []) {
    if (t.sender) onPage.add(t.sender);
    for (const c of t.counterparties ?? []) onPage.add(c.address);
  }
  ck("both addresses really appear in this page", onPage.has(POISON_REAL) && onPage.has(POISON_FAKE),
     `real=${onPage.has(POISON_REAL)} fake=${onPage.has(POISON_FAKE)}`);

  // A control: an address with ordinary counterparties must not be flagged.
  // The detector is worth nothing if it fires on everybody.
  const control = await call("get_transaction_history", { address: SPONSOR, limit: 50 });
  ck("a busy unrelated wallet is not flagged", control.address_poisoning === undefined,
     JSON.stringify(control.address_poisoning ?? {}).slice(0, 60));

  console.log(`\n${"=".repeat(64)}`);
  console.log(bad.length ? `${bad.length} PROBLEM(S):` : "no inconsistencies found");
  bad.forEach((p) => console.log(`  - ${p}`));
  if (bad.length) process.exitCode = 1;
});
