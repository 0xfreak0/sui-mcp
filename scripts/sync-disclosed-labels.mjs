#!/usr/bin/env node
/**
 * Regenerate `src/data/disclosed-labels.json`: address labels taken only from a
 * first-party disclosure, each with the document it came from.
 *
 * Three kinds of source, and nothing else:
 *
 *   - proof-of-reserves-listed: an exchange's own proof-of-reserves wallet list
 *     (Binance, OKX, Bybit, KuCoin). A listing is the exchange saying "this is
 *     ours"; it is not a verified ownership proof. OKX attaches a signature to
 *     each address, but its scheme has not been reproduced here, so OKX rows
 *     make no stronger claim than the others.
 *   - official-docs: a bridge's own deployment documentation.
 *   - victim-postmortem: the exploited protocol's own incident report naming
 *     the attacker's addresses.
 *
 * Every address is checked against the text of its source document before it
 * is written, and every Sui address is looked up on mainnet. A manifest entry
 * whose address is missing from its document is dropped, not shipped.
 *
 * Keys are CAIP-10 `sui:mainnet:0x…`: the documents describe mainnet, and a
 * package or object id means nothing on another network.
 *
 * Needs `unzip` (Binance, OKX) and `pdftotext` (Bybit, KuCoin) on PATH. A
 * source that cannot be read keeps its entries from the previous file and is
 * reported as stale, so one exchange being down does not delete another's
 * labels.
 *
 *   node scripts/sync-disclosed-labels.mjs
 *
 * Env overrides: BINANCE_AUDIT_ID (e.g. PR01SEP26), OKX_POR_ZIP_URL,
 * BYBIT_POR_PDF_URL, KUCOIN_POR_PDF_URL.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addressesInPdfText,
  extractNotionText,
  htmlToText,
  mentionsAddress,
} from "./lib/disclosure-parse.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "src/data/disclosed-labels.json");
const GRAPHQL = "https://graphql.mainnet.sui.io/graphql";
const TIMEOUT_MS = 180_000;
const UA = { "user-agent": "Mozilla/5.0 (sui-analytics-mcp sync-disclosed-labels)" };
const TODAY = new Date().toISOString().slice(0, 10);
const SUI_HEX = /^0x[0-9a-f]{64}$/;

const work = mkdtempSync(join(tmpdir(), "disclosed-labels-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

async function fetchOk(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}
const fetchText = async (url, init) => (await fetchOk(url, init)).text();
const fetchJson = async (url, init) => (await fetchOk(url, init)).json();
async function download(url, name) {
  const path = join(work, name);
  writeFileSync(path, Buffer.from(await (await fetchOk(url)).arrayBuffer()));
  return path;
}
/** One member of a zip, by glob, as text. */
const unzipMember = (zip, glob) =>
  execFileSync("unzip", ["-p", zip, glob], { maxBuffer: 1 << 30 }).toString("utf8");
const pdfText = (pdf) => execFileSync("pdftotext", ["-layout", pdf, "-"], { maxBuffer: 1 << 28 }).toString("utf8");

function suiKey(address) {
  const a = address.toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(a)) throw new Error(`not a Sui address: ${address}`);
  return `sui:mainnet:0x${a.slice(2).padStart(64, "0")}`;
}
function evmKey(chain, address) {
  const a = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`not an EVM address: ${address}`);
  return `${chain}:${a}`;
}

/** Minimal CSV row split: the PoR files quote nothing that contains a comma. */
const csvRows = (text) =>
  text.split(/\r?\n/).filter(Boolean).map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "")));

// ---------------------------------------------------------------------------
// Exchanges
// ---------------------------------------------------------------------------

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

async function binance() {
  let auditId = process.env.BINANCE_AUDIT_ID;
  if (!auditId) {
    // Snapshot dates come back as "01/09/26 00:00:00 UTC | …" (dd/mm/yy), newest
    // first, and the download id is PR + dd + MON + yy.
    const cond = await fetchJson("https://www.binance.com/bapi/apex/v1/public/apex/market/query/auditProofSnapshotCondition");
    const m = /^(\d\d)\/(\d\d)\/(\d\d)/.exec(cond?.data?.[0] ?? "");
    if (!m) throw new Error("could not read Binance's latest snapshot date");
    auditId = `PR${m[1]}${MONTHS[Number(m[2]) - 1]}${m[3]}`;
  }
  const dl = await fetchJson(
    `https://www.binance.com/bapi/apex/v1/public/apex/market/por/getDownloadUrl?auditId=${encodeURIComponent(auditId)}`,
  );
  const url = dl?.data;
  if (typeof url !== "string" || !url.startsWith("https://")) throw new Error(`no download url for ${auditId}`);
  const zip = await download(url, "binance.zip");
  const rows = csvRows(unzipMember(zip, "*_HotCold.csv"));
  const header = rows.shift();
  const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const [cCoin, cNet, cAddr, cCust] = [col("coin"), col("network"), col("address"), col("third party custodian name")];
  const byAddress = new Map();
  for (const r of rows) {
    if (r[cNet] !== "SUI" || !SUI_HEX.test((r[cAddr] ?? "").toLowerCase())) continue;
    const a = r[cAddr].toLowerCase();
    const e = byAddress.get(a) ?? { coins: new Set(), custodian: "" };
    e.coins.add(r[cCoin]);
    if (r[cCust]) e.custodian = r[cCust];
    byAddress.set(a, e);
  }
  const entries = [...byAddress].map(([address, e]) => ({
    key: suiKey(address),
    label: e.custodian ? `Binance reserve wallet (custodian: ${e.custodian})` : "Binance reserve wallet",
    notes: `Listed in Binance's proof-of-reserves hot/cold wallet file ${auditId} on the SUI network, holding ${[...e.coins].sort().join(", ")}.${e.custodian ? ` Custodian named in the file: ${e.custodian}.` : ""}`,
  }));
  return { document_url: url, page_url: "https://www.binance.com/en/proof-of-reserves", snapshot: auditId, entries };
}

async function okx() {
  let url = process.env.OKX_POR_ZIP_URL;
  if (!url) {
    const page = await fetchText("https://www.okx.com/en-us/proof-of-reserves/download");
    const names = [...new Set(page.match(/por_csv_\d+_V\d+\.zip/g) ?? [])].sort();
    if (names.length === 0) throw new Error("no por_csv zip linked from OKX's download page");
    url = `https://static.okx.com/cdn/okx/por/chain/${names.at(-1)}`;
  }
  const zip = await download(url, "okx.zip");
  const rows = csvRows(unzipMember(zip, "*.csv"));
  // The file opens with a coin/amount summary; the address table has its own header.
  const h = rows.findIndex((r) => r.includes("address") && r.includes("Network"));
  if (h < 0) throw new Error("OKX csv has no address table");
  const header = rows[h];
  const [cCoin, cNet, cAddr, cMsg] = ["coin", "Network", "address", "message"].map((n) => header.indexOf(n));
  const byAddress = new Map();
  for (const r of rows.slice(h + 1)) {
    // The same file lists ~100k Aptos addresses of the same 0x+64-hex shape,
    // so the network column is the only thing that makes a row a Sui address.
    if (r[cNet] !== "SUI" || !SUI_HEX.test((r[cAddr] ?? "").toLowerCase())) continue;
    const a = r[cAddr].toLowerCase();
    const e = byAddress.get(a) ?? new Set();
    e.add(r[cCoin]);
    byAddress.set(a, e);
    if (r[cMsg] && r[cMsg] !== "I am an OKX address") {
      console.warn(`okx: unexpected ownership message for ${a}: ${r[cMsg]}`);
    }
  }
  const snapshot = /por_csv_(\d+)_V\d+/.exec(url)?.[1] ?? null;
  const entries = [...byAddress].map(([address, coins]) => ({
    key: suiKey(address),
    label: "OKX reserve wallet",
    notes: `Listed in OKX's proof-of-reserves file (snapshot ${snapshot}) on the SUI network, holding ${[...coins].sort().join(", ")}. OKX publishes an "I am an OKX address" message and signature for it; this repository has not verified that signature, so the label rests on the listing.`,
  }));
  return { document_url: url, page_url: "https://www.okx.com/en-us/proof-of-reserves", snapshot, entries };
}

async function fromPdf(entity, url, pageUrl, snapshot) {
  const text = pdfText(await download(url, `${entity}.pdf`));
  const found = addressesInPdfText(text, "sui");
  const entries = found.map((address) => ({
    key: suiKey(address),
    label: `${entity} reserve wallet`,
    notes: `Listed under the Sui network in ${entity}'s proof-of-reserves audit report${snapshot ? ` (${snapshot})` : ""}.`,
  }));
  return { document_url: url, page_url: pageUrl, snapshot, entries };
}

async function bybit() {
  const url =
    process.env.BYBIT_POR_PDF_URL ??
    "https://www.bybit.com/common-static/cht-static/por/Bybit_PoR_Audit_2026_Apr_22.pdf";
  return fromPdf("Bybit", url, "https://www.bybit.com/en/proof-of-reserve", /Audit_(\d{4}_\w{3}_\d+)/.exec(url)?.[1] ?? null);
}

async function kucoin() {
  let url = process.env.KUCOIN_POR_PDF_URL;
  let snapshot = null;
  if (!url) {
    const meta = await fetchJson("https://www.kucoin.com/_api/asset-front/current/por/monthly?lang=en_US");
    url = meta?.data?.auditReportUrl;
    if (typeof url !== "string") throw new Error("KuCoin returned no audit report url");
    if (meta?.data?.auditDate) snapshot = new Date(meta.data.auditDate).toISOString().slice(0, 10);
  }
  return fromPdf("KuCoin", url, "https://www.kucoin.com/proof-of-reserves", snapshot);
}

const EXCHANGES = [
  { id: "binance", entity: "Binance", run: binance },
  { id: "okx", entity: "OKX", run: okx },
  { id: "bybit", entity: "Bybit", run: bybit },
  { id: "kucoin", entity: "KuCoin", run: kucoin },
];

// ---------------------------------------------------------------------------
// Bridges: official deployment docs. Each address must appear in its page.
// ---------------------------------------------------------------------------

const BRIDGE_DOCS = [
  {
    id: "wormhole",
    entity: "Wormhole",
    url: "https://wormhole.com/docs/reference/contract-addresses/",
    entries: [
      { address: "0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c", label: "Wormhole core bridge state (Sui)" },
      { address: "0xc57508ee0d4595e5a8728974a4a93a787d38f339757230d441e895422c07aba9", label: "Wormhole token bridge state (Sui)" },
    ],
  },
  {
    id: "circle-cctp",
    entity: "Circle CCTP",
    url: "https://developers.circle.com/cctp/v1/sui-packages",
    entries: [
      { address: "0x08d87d37ba49e785dde270a83f8e979605b03dc552b5548f26fdf2f49bf7ed1b", label: "Circle CCTP MessageTransmitter package (Sui)" },
      { address: "0x2aa6c5d56376c371f88a6cc42e852824994993cb9bab8d3e6450cbe3cb32b94e", label: "Circle CCTP TokenMessengerMinter package (Sui)" },
      { address: "0xf68268c3d9b1df3215f2439400c1c4ea08ac4ef4bb7d6f3ca6a2a239e17510af", label: "Circle CCTP MessageTransmitterState (Sui)" },
      { address: "0x45993eecc0382f37419864992c12faee2238f5cfe22b98ad3bf455baf65c8a2f", label: "Circle CCTP TokenMessengerMinterState (Sui)" },
    ],
  },
  {
    id: "sui-bridge",
    entity: "Sui Bridge",
    url: "https://docs.sui.io/concepts/tokenomics/sui-bridging",
    entries: [
      { address: "0xb", label: "Sui Bridge package (0xb)" },
      { address: "0x9", label: "Sui Bridge object (0x9)" },
      { address: "0xda3bD1fE1973470312db04551B65f401Bc8a92fD", chain: "eip155:1", label: "Sui Bridge contract on Ethereum" },
    ],
  },
  {
    id: "mayan",
    entity: "Mayan",
    url: "https://docs.mayan.finance/resources/chains-contracts",
    entries: [
      { address: "0x7ac01a7c14c53098a41593c7623823bb677b5201fb3ee35b75b47cfc6c6c6f40", label: "Mayan Swift state (Sui)" },
      { address: "0xe42174b6d742f40bd2b67b967542b21e6d7433f2d277a80bb59866ac73ff3f52", label: "Mayan Swift fee manager state (Sui)" },
      { address: "0xb787fe0f7530b4fd2162fa0cc92f4f6c5a97c54b4c5c55eb04ab29f4b803ac9c", label: "Mayan MCTP state (Sui)" },
      { address: "0xa1b4a96ce93d36dd0bbce0adc39533a07d2f32928918c80cd6fe7868320978f2", label: "Mayan MCTP fee manager state (Sui)" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Attackers: named in the exploited protocol's own incident report.
// ---------------------------------------------------------------------------

const POSTMORTEMS = [
  {
    id: "cetus-2025-05-22",
    entity: "Cetus exploit attacker (2025-05-22)",
    url: "https://cetusprotocol.notion.site/Cetus-Incident-Report-May-22-2025-Attack-Disclosure-1ff1dbf3ac8680d7a98de6158597d416",
    notion: { host: "cetusprotocol.notion.site", pageId: "1ff1dbf3-ac86-80d7-a98d-e6158597d416" },
    entries: [
      { address: "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06", role: "Attacker Address (on Sui); Attacker Sui Wallet 2 (Frozen)" },
      { address: "0xcd8962dad278d8b50fa0f9eb0186bfa4cbdecc6d59377214c88d0286a0ac9562", role: "Attacker Sui Wallet 1 (Frozen)" },
      { address: "0x0251536bfcf144b88e1afa8fe60184ffdb4caf16", chain: "eip155:1", role: "Attacker Ethereum Wallet 1" },
      { address: "0x89012a55cd6b88e407c9d4ae9b3425f55924919b", chain: "eip155:1", role: "Attacker Ethereum Wallet 2" },
    ],
  },
  {
    id: "nemo-2025-09-07",
    entity: "Nemo exploit attacker (2025-09-07)",
    url: "https://olivine-hydrofoil-637.notion.site/Nemo-Security-Incident-Cause-Process-and-Fund-Tracing-Report-V1-1-26a6b8723d8a80e29cb8cb48fe1390f2",
    notion: { host: "olivine-hydrofoil-637.notion.site", pageId: "26a6b872-3d8a-80e2-9cb8-cb48fe1390f2" },
    entries: [
      { address: "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724", role: "Primary Attacker Wallets" },
      { address: "0x135477aa627a3bcc3223bde10dd8e7c55a1f645c", chain: "eip155:1", role: "Intermediate Address: the first stop after bridging via CCTP" },
      { address: "0x41b1906c4bcded607c6b02861ce15c2e49ff7576", chain: "eip155:1", role: "Fund Aggregation Address" },
    ],
  },
];

async function notionText({ host, pageId }) {
  const body = { page: { id: pageId }, limit: 100, cursor: { stack: [] }, verticalColumns: false };
  const json = await fetchJson(`https://${host}/api/v3/loadCachedPageChunkV2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return extractNotionText(json);
}

// ---------------------------------------------------------------------------
// Collection, and the mainnet existence check (batched, validated before interpolation).
// ---------------------------------------------------------------------------

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { labels: {}, sources: [] };
const labels = {};
const sources = [];

function keepPrevious(sourceId, reason) {
  const kept = Object.entries(previous.labels ?? {}).filter(([, v]) => v.source_id === sourceId);
  for (const [k, v] of kept) labels[k] = v;
  const prev = (previous.sources ?? []).find((s) => s.id === sourceId);
  sources.push({ ...(prev ?? { id: sourceId }), stale: true, stale_reason: reason });
  console.warn(`${sourceId}: FAILED (${reason}); kept ${kept.length} entries from the previous file`);
}

async function onChain(suiAddresses) {
  const found = new Set();
  const list = suiAddresses.filter((a) => SUI_HEX.test(a));
  for (let i = 0; i < list.length; i += 10) {
    const chunk = list.slice(i, i + 10);
    // `address.transactions` is only what the address SENT; a reserve wallet
    // that has only ever received would read as absent. affectedAddress is
    // any involvement.
    const fields = chunk
      .map(
        (a, j) =>
          `o${j}: object(address: "${a}") { address }\n t${j}: transactions(last: 1, filter: { affectedAddress: "${a}" }) { nodes { digest } }`,
      )
      .join("\n");
    const res = await fetchJson(GRAPHQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `{ ${fields} }` }),
    });
    if (res?.errors?.length) console.warn(`on-chain check: ${JSON.stringify(res.errors).slice(0, 300)}`);
    chunk.forEach((a, j) => {
      const d = res?.data ?? {};
      if (d[`o${j}`]?.address || d[`t${j}`]?.nodes?.length) found.add(a);
    });
  }
  return found;
}

for (const ex of EXCHANGES) {
  try {
    const r = await ex.run();
    if (r.entries.length === 0) throw new Error("source parsed but listed no Sui addresses");
    for (const e of r.entries) {
      labels[e.key] = {
        label: e.label,
        category: "cex",
        entity: ex.entity,
        evidence: "proof-of-reserves-listed",
        source_url: r.document_url,
        retrieved_at: TODAY,
        confidence: "high",
        notes: e.notes,
        source_id: ex.id,
      };
    }
    sources.push({
      id: ex.id,
      entity: ex.entity,
      evidence: "proof-of-reserves-listed",
      source_url: r.document_url,
      page_url: r.page_url,
      snapshot: r.snapshot,
      retrieved_at: TODAY,
      count: r.entries.length,
    });
    console.log(`${ex.id}: ${r.entries.length} Sui addresses`);
  } catch (err) {
    keepPrevious(ex.id, err.message);
  }
}

for (const doc of BRIDGE_DOCS) {
  try {
    const text = htmlToText(await fetchText(doc.url));
    let count = 0;
    for (const e of doc.entries) {
      if (!mentionsAddress(text, e.address)) {
        console.warn(`${doc.id}: ${e.address} is not in ${doc.url}; dropped`);
        continue;
      }
      const key = e.chain ? evmKey(e.chain, e.address) : suiKey(e.address);
      labels[key] = {
        label: e.label,
        category: "bridge",
        entity: doc.entity,
        evidence: "official-docs",
        source_url: doc.url,
        retrieved_at: TODAY,
        confidence: "high",
        source_id: doc.id,
      };
      count++;
    }
    sources.push({ id: doc.id, entity: doc.entity, evidence: "official-docs", source_url: doc.url, retrieved_at: TODAY, count });
    console.log(`${doc.id}: ${count}/${doc.entries.length} addresses confirmed in the docs`);
  } catch (err) {
    keepPrevious(doc.id, err.message);
  }
}

for (const pm of POSTMORTEMS) {
  try {
    const text = await notionText(pm.notion);
    let count = 0;
    for (const e of pm.entries) {
      if (!mentionsAddress(text, e.address)) {
        console.warn(`${pm.id}: ${e.address} is not in the report; dropped`);
        continue;
      }
      const key = e.chain ? evmKey(e.chain, e.address) : suiKey(e.address);
      labels[key] = {
        label: pm.entity,
        category: "malicious",
        entity: pm.entity,
        evidence: "victim-postmortem",
        source_url: pm.url,
        retrieved_at: TODAY,
        confidence: "high",
        notes: `Named in the protocol's own incident report as: ${e.role}.`,
        source_id: pm.id,
      };
      count++;
    }
    sources.push({ id: pm.id, entity: pm.entity, evidence: "victim-postmortem", source_url: pm.url, retrieved_at: TODAY, count });
    console.log(`${pm.id}: ${count}/${pm.entries.length} addresses confirmed in the report`);
  } catch (err) {
    keepPrevious(pm.id, err.message);
  }
}

// Mainnet check for every Sui key. A miss is reported, not dropped: a cold
// wallet that has never transacted is still what its owner says it is.
const suiAddrs = Object.keys(labels)
  .filter((k) => k.startsWith("sui:mainnet:"))
  .map((k) => k.slice("sui:mainnet:".length));
const seen = await onChain(suiAddrs);
for (const s of sources) {
  const mine = Object.entries(labels).filter(([k, v]) => v.source_id === s.id && k.startsWith("sui:mainnet:"));
  s.sui_addresses_seen_on_chain = mine.filter(([k]) => seen.has(k.slice("sui:mainnet:".length))).length;
  s.sui_addresses = mine.length;
}
const missing = suiAddrs.filter((a) => !seen.has(a));
console.log(`on chain: ${seen.size}/${suiAddrs.length} Sui addresses have an object or a transaction`);
if (missing.length) console.warn(`not seen on chain: ${missing.join(", ")}`);

const sorted = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(
  OUT,
  JSON.stringify(
    {
      _comment:
        "GENERATED by scripts/sync-disclosed-labels.mjs; do not edit by hand. First-party disclosed labels only: exchange proof-of-reserves wallet lists (evidence proof-of-reserves-listed, a listing and not a verified ownership proof), bridge deployment docs (official-docs), and attacker addresses named in the exploited protocol's own incident report (victim-postmortem). Every address was found in the text of its source_url on retrieved_at. Keys are CAIP-10: sui:mainnet for Sui, eip155:1 for Ethereum.",
      generated_at: TODAY,
      sources,
      labels: sorted,
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${Object.keys(sorted).length} labels to ${OUT}`);
