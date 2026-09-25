#!/usr/bin/env node
/**
 * Adversarial pass: malformed and hostile input for every tool the server
 * lists, generated from each tool's `inputSchema`.
 *
 * For every field it sends: the field left out when required, the wrong JSON
 * type, null, an empty or blank string, out-of-range numbers, and a sample of
 * hostile strings chosen by what the field holds (an address, a digest, a
 * coin type, a time, free text). Every tool also gets an unknown argument and
 * a misspelt one. The tool passes when every call:
 *
 * - finishes within 60s and leaves the server answering `tools/list`;
 * - fails, when it fails, with `isError` and one readable line: no stack
 *   trace, no HTML, no GraphQL dump;
 * - never answers a malformed input as if it were valid. An input that is
 *   well formed but names nothing (an unused address) may get an empty answer.
 *
 * A few semantic cases the generator cannot derive follow at the end.
 *
 *   npm run build && node scripts/probe/adversarial.mjs
 *
 * VERBOSE=1 prints every case, not just failures.
 */
import { startServer, gql, checker, short as clip, SUI } from "./lib/mcp-client.mjs";

/** A snippet on one line. */
const short = (v) => clip(v).replace(/\s+/g, " ");

const NEMO = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
const CETUS = "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06";
const NEMO_TX = "19Zkat1xArMTMvPCB4e4QtM5HstpYiKvgPjbvkLUAw9";
const NEMO_PKG = "0x2b71664477755b90f9fb71c9c944d5d0d3832fec969260e3f18efc7d855f57c4";
const FRAMEWORK = `0x${"0".repeat(63)}2`;
const CLOCK = `0x${"0".repeat(63)}6`;
const SYSTEM_STATE = `0x${"0".repeat(63)}5`;
/** Cetus USDC/SUI pool; the type is checked against the chain before use. */
const CETUS_POOL = "0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105";
const PLAIN_WALLET = "0xafe2fafac0b048c9c70a61cc1798400a85173df96b30118c40af6f3382b5a777";
/** Well formed, never used: `c0ffee` repeated. */
const UNUSED = `0x${"c0ffee".repeat(10)}0bad`;
const NO_SUCH_NAME = "no-such-name-adversarial-7f3a.sui";
const CALL_LIMIT_MS = 60_000;
const SIZE_LIMIT = 100_000;
const VERBOSE = !!process.env.VERBOSE;

/** Base58 of 32 bytes: a digest that is well formed and names no transaction. */
function base58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
const UNUSED_DIGEST = base58(new Uint8Array(32).fill(0xab));

// ---- independent reads: the fixtures the baselines need ---------------------

const chain = await gql(
  `query($pool:SuiAddress!,$d:String!){
    transaction(digest:$d){ transactionBcs }
    epoch { validatorSet { activeValidators(first:1){ nodes { contents { json } } } } }
    object(address:$pool){ asMoveObject { contents { type { repr } } } }
  }`,
  { pool: CETUS_POOL, d: NEMO_TX },
);
const TX_BCS = chain.transaction.transactionBcs;
const VALIDATOR = chain.epoch.validatorSet.activeValidators.nodes[0].contents.json.metadata.sui_address;
if (!/::pool::Pool</.test(chain.object?.asMoveObject?.contents?.type?.repr ?? "")) {
  throw new Error(`${CETUS_POOL} is no longer a pool; pick another for get_pool_stats`);
}

/**
 * A valid call per tool, kept cheap. A generated case changes one field of
 * it, so the answer is about that field and nothing else.
 */
const BASE = {
  get_chain_info: {},
  get_checkpoint: {},
  get_object: { object_id: CLOCK },
  list_owned_objects: { owner: NEMO, limit: 1 },
  list_dynamic_fields: { parent_id: SYSTEM_STATE, limit: 1 },
  get_balance: { owner: NEMO },
  get_coin_info: { coin_type: SUI },
  get_transaction: { digest: NEMO_TX },
  get_transactions: { digests: [NEMO_TX] },
  query_transactions: { sender: NEMO, limit: 1 },
  query_events: { sender: NEMO, limit: 1 },
  get_package: { package_id: NEMO_PKG },
  get_move_function: { package_id: FRAMEWORK, module_name: "coin", function_name: "value" },
  simulate_transaction: { transaction_bcs: TX_BCS },
  decompile_module: { package_id: NEMO_PKG },
  disassemble_module: { package_id: NEMO_PKG },
  analyze_package: { package_id: NEMO_PKG },
  resolve_name: { address: NEMO },
  get_wallet_overview: { address: NEMO, include_prices: false },
  get_token_prices: { coin_types: [SUI] },
  get_defi_positions: { address: NEMO },
  list_nfts: { address: NEMO, limit: 1 },
  list_nft_collections: { address: NEMO },
  build_transfer: { sender: NEMO, recipient: CETUS, amount: "1" },
  build_staking: { action: "stake", sender: NEMO, validator_address: VALIDATOR, amount_mist: "1000000000" },
  get_validators: { limit: 1 },
  get_staking_summary: { address: NEMO },
  get_transaction_history: { address: NEMO, limit: 1 },
  watch_addresses: { action: "list" },
  poll_watch: {},
  get_nft_sales: { hours: 1, max_pages: 1 },
  search_token: { query: "SUI" },
  check_activity: { address: NEMO, limit: 1 },
  get_top_holders: { type: SUI, limit: 1, max_scan: 100 },
  decode_ptb: { transaction_bcs: TX_BCS },
  trace_funds: { digest: NEMO_TX, direction: "forward", hops: 1 },
  trace_flow_graph: { digest: NEMO_TX, max_depth: 1, max_nodes: 5 },
  find_flow_path: { from: NEMO, to: CETUS, max_hops: 1, max_nodes: 5 },
  get_pool_stats: { pool_id: CETUS_POOL },
  find_pools: { token_a: "SUI", token_b: "USDC" },
  deepbook_orderbook: { pool_name: "SUI_USDC", depth: 1 },
  deepbook_trades: { pool_name: "SUI_USDC", limit: 1 },
  compare_oracle_price: { pool_name: "SUI_USDC", limit: 2 },
  aggregate_events: { sender: NEMO, max_events: 50 },
  sample_control_addresses: { module: NEMO_PKG, size: 1, max_events: 50 },
  resolve_protocol_packages: { package_id: NEMO_PKG, max_versions: 1 },
  resolve_bridge_transfer: { digest: NEMO_TX },
  save_finding: { case_name: "adversarial-probe", title: "probe finding" },
  list_findings: {},
  export_case: { case_name: "adversarial-probe" },
  delete_finding: { finding_id: 999999 },
  get_package_dependency_graph: { package_id: NEMO_PKG, depth: 1 },
  identify_address: { address: NEMO },
  analyze_token: { query: "SUI", include_holders: false },
  mvr_resolve: { names: ["@suins/core"] },
  mvr_reverse_resolve: { package_ids: [FRAMEWORK] },
  mvr_get_package_info: { name: "@suins/core" },
  mvr_search: { search: "suins", limit: 1 },
  mvr_resolve_struct: { types: ["@suins/core::suins::SuiNS"] },
  manage_labels: { action: "lookup", address: NEMO },
  diff_package_upgrade: { package: NEMO_PKG, max_sample_lines: 10 },
  get_address_fanout: { address: NEMO, max_transactions: 50 },
  find_funding_sources: { addresses: [NEMO], max_hops: 1 },
  find_funding_source: { address: NEMO, max_hops: 1 },
  build_timeline: { addresses: [NEMO], limit: 1, per_address: 1 },
  trace_object_history: { object_id: CLOCK, limit: 1 },
  get_upgrade_history: { package: NEMO_PKG },
  build_wallet_edges: { addresses: [NEMO], expand: false, query_budget: 10 },
  analyze_multisig: { address: NEMO, max_transactions: 1 },
  find_shared_multisig: { addresses: [NEMO, CETUS] },
  check_coin_restrictions: { coin_type: SUI, max_addresses: 1 },
  classify_deposit_address: { address: NEMO, max_transactions: 5 },
  screen_address: { address: NEMO, hops: 1, max_transactions: 10, max_expand: 1 },
  analyze_attack_tx: { digest: NEMO_TX },
  summarize_incident_losses: { digests: [NEMO_TX], max_transactions: 1 },
  summarize_address_flows: { address: NEMO, max_transactions: 50, top: 1 },
  enable_tools: { profile: "all" },
};

/**
 * Fields that stand in for one another: setting one drops the others from the
 * baseline, so a case tests the field it names rather than a conflict.
 */
const ALTERNATIVES = {
  get_checkpoint: [["sequence_number", "digest", "timestamp"]],
  list_owned_objects: [["owner", "address"]],
  get_balance: [["owner", "address"], ["at", "at_checkpoint"]],
  query_transactions: [["affected_address", "affected_object", "function"]],
  resolve_name: [["name", "address"]],
  check_activity: [["address", "object_id"]],
  get_top_holders: [["type", "collection_name"]],
  trace_flow_graph: [["digest", "address"]],
  sample_control_addresses: [["module", "event_type"]],
  resolve_protocol_packages: [["protocol", "package_id"]],
  summarize_incident_losses: [["digests", "sender"]],
  enable_tools: [["profile", "profiles"]],
};

/** Tools whose schema marks nothing required but which need one of these. */
const NEEDS_ONE_OF = {
  list_owned_objects: ["owner", "address"],
  get_balance: ["owner", "address"],
  resolve_name: ["name", "address"],
  check_activity: ["address", "object_id"],
  get_top_holders: ["type", "collection_name"],
  trace_flow_graph: ["digest", "address"],
  sample_control_addresses: ["module", "event_type"],
  resolve_protocol_packages: ["protocol", "package_id"],
  summarize_incident_losses: ["digests", "sender"],
  check_coin_restrictions: ["coin_type", "address"],
  enable_tools: ["profile", "profiles"],
};

/** Pairs a tool documents as "give this or that, not both". */
const CONFLICTS = {
  get_balance: { at: "2025-09-07T16:00:00Z", at_checkpoint: 190000000 },
  query_transactions: { affected_address: NEMO, affected_object: CLOCK },
  check_activity: { address: NEMO, object_id: CLOCK },
  get_top_holders: { type: SUI, collection_name: "gawblenz" },
  trace_flow_graph: { digest: NEMO_TX, address: NEMO },
};

// ---- what a field holds ------------------------------------------------------

/** Field name → kind. `tool.field` wins over `field`. */
const KIND = {
  owner: "address", address: "address", sender: "address", recipient: "address", affected_address: "address",
  validator_address: "address", attacker: "address", addresses: "address", exclude: "address",
  "find_flow_path.from": "address", "find_flow_path.to": "address",
  "screen_address.address": "address", "manage_labels.address": "address",
  object_id: "object", parent_id: "object", affected_object: "object", staked_sui_id: "object", pool_id: "object",
  balance_manager_id: "object",
  package_id: "package", package: "package", package_ids: "package",
  digest: "digest", digests: "digest",
  coin_type: "coin_type", coin_types: "coin_type", "get_top_holders.type": "coin_type",
  timestamp: "time", at: "time", since_timestamp: "time", from: "time", to: "time", window_start: "time",
  window_end: "time", since: "time", as_of: "time", start: "time", end: "time", price_at: "time",
  after_checkpoint: "time", before_checkpoint: "time",
  epoch: "uint", sequence_number: "uint", version: "uint", since_version: "uint", amount: "uint", amount_mist: "uint",
  min_amount: "uint",
  transaction_bcs: "bcs",
  cursor: "cursor",
  "mvr_get_package_info.name": "mvr", names: "mvr", types: "mvr",
  "resolve_name.name": "suins",
};
const kindOf = (tool, field) => KIND[`${tool}.${field}`] ?? KIND[field] ?? "text";

/** Integer-valued fields the schema types as `number`. */
const INT_NAMES = /^(limit|top|size|depth|hops|max_.*|per_address|.*_budget|since_checkpoint|seed|finding_id)$/;

const LONG = "a".repeat(10_000);
const INJECTION = '" } query { __schema { types { name } } } #';
const CONTROL = "a\u0000b\u001b[31mc\r\nd";
const UNICODE = "Ωmega 🚀 名前 \u202e";

/**
 * Hostile strings per kind. `expect`: `reject` must be an error; `either`
 * may be a clean error or a clean answer; `lenient` must not be refused as
 * malformed (a documented normalisation). `net` marks a value that passes
 * the schema and reaches the chain: those are sampled, not all sent.
 */
function hostile(kind, base) {
  const addr = typeof base === "string" && /^0x[0-9a-f]{64}$/.test(base) ? base : NEMO;
  const shapeless = [
    { label: "bare 0x", value: "0x", expect: "reject" },
    { label: "65 hex digits", value: `0x${"a".repeat(65)}`, expect: "reject" },
    { label: "non-hex", value: "0xZZ12", expect: "reject" },
    { label: "10k chars", value: `0x${LONG}`, expect: "reject" },
    { label: "unicode", value: "0x12é4", expect: "reject" },
    { label: "control chars", value: "0x12\u0000ab", expect: "reject" },
    { label: "GraphQL injection", value: `0x1${INJECTION}`, expect: "reject" },
    { label: "not an address", value: "not-an-address", expect: "reject" },
  ];
  switch (kind) {
    case "address":
      return [
        ...shapeless,
        { label: "upper case", value: addr.toUpperCase().replace("0X", "0x"), expect: "lenient", net: true },
        { label: "no 0x", value: addr.slice(2), expect: "lenient", net: true },
        { label: "unregistered SuiNS", value: NO_SUCH_NAME, expect: "reject", net: true },
        { label: "unused address", value: UNUSED, expect: "either", net: true },
      ];
    case "object":
      return [
        ...shapeless,
        { label: "upper case", value: addr.toUpperCase().replace("0X", "0x"), expect: "lenient", net: true },
        { label: "package for object", value: FRAMEWORK, expect: "either", net: true },
        { label: "unused id", value: UNUSED, expect: "either", net: true },
      ];
    case "package":
      return [
        ...shapeless,
        { label: "upper case", value: addr.toUpperCase().replace("0X", "0x"), expect: "lenient", net: true },
        { label: "object for package", value: CLOCK, expect: "reject", net: true },
        { label: "wallet for package", value: NEMO, expect: "reject", net: true },
        { label: "unused id", value: UNUSED, expect: "reject", net: true },
      ];
    case "digest":
      return [
        { label: "not Base58", value: "notadigest0OIl", expect: "reject", net: true },
        { label: "44 ones", value: "1".repeat(44), expect: "reject", net: true },
        { label: "hex address as digest", value: FRAMEWORK, expect: "reject", net: true },
        { label: "10k chars", value: LONG, expect: "reject", net: true },
        { label: "GraphQL injection", value: INJECTION, expect: "reject", net: true },
        { label: "control chars", value: CONTROL, expect: "reject", net: true },
        { label: "unused digest", value: UNUSED_DIGEST, expect: "reject", net: true },
      ];
    case "coin_type":
      return [
        { label: "four segments", value: "0x2::a::b::c", expect: "reject", net: true },
        { label: "non-hex package", value: "0xZZ::a::A", expect: "reject", net: true },
        { label: "two segments", value: "0x2::sui", expect: "reject", net: true },
        { label: "GraphQL injection", value: `0x2::sui::SUI${INJECTION}`, expect: "reject", net: true },
        { label: "10k chars", value: `0x2::sui::${LONG}`, expect: "reject", net: true },
        { label: "control chars", value: "0x2::sui::SU\u0000I", expect: "reject", net: true },
        { label: "unknown coin", value: "0x2::nope::NOPE", expect: "either", net: true },
      ];
    case "time":
      return [
        { label: "month 13", value: "2025-13-45T99:00:00Z", expect: "reject", net: true },
        { label: "a word", value: "yesterday", expect: "reject", net: true },
        { label: "negative", value: "-5", expect: "reject", net: true },
        { label: "GraphQL injection", value: INJECTION, expect: "reject", net: true },
        { label: "10k chars", value: LONG, expect: "reject", net: true },
      ];
    case "uint":
      return [
        { label: "a word", value: "abc", expect: "reject", net: true },
        { label: "negative", value: "-1", expect: "reject", net: true },
        { label: "fraction", value: "1.5", expect: "reject", net: true },
        { label: "past u64", value: "18446744073709551616", expect: "reject", net: true },
        { label: "GraphQL injection", value: INJECTION, expect: "reject", net: true },
      ];
    case "bcs":
      return [
        { label: "not base64", value: "not base64!!", expect: "reject", net: true },
        { label: "base64 junk", value: "AAAA", expect: "reject", net: true },
        { label: "10k chars", value: "A".repeat(10_000), expect: "reject", net: true },
        { label: "GraphQL injection", value: INJECTION, expect: "reject", net: true },
      ];
    case "mvr":
      return [
        { label: "not a name", value: "not an mvr name", expect: "reject", net: true },
        { label: "GraphQL injection", value: `@a/b${INJECTION}`, expect: "reject", net: true },
        { label: "10k chars", value: `@a/${LONG}`, expect: "reject", net: true },
        { label: "unregistered name", value: "@nope-adversarial/none", expect: "either", net: true },
      ];
    case "suins":
      return [
        { label: "not a name", value: "bad name!!", expect: "reject", net: true },
        { label: "GraphQL injection", value: INJECTION, expect: "reject", net: true },
        { label: "unregistered name", value: NO_SUCH_NAME, expect: "either", net: true },
      ];
    case "cursor":
      return [
        { label: "junk cursor", value: "zzz", expect: "either", net: true },
        { label: "GraphQL injection", value: INJECTION, expect: "either", net: true },
      ];
    default:
      return [
        { label: "10k chars", value: LONG, expect: "either", net: true },
        { label: "unicode", value: UNICODE, expect: "either", net: true },
        { label: "control chars", value: CONTROL, expect: "either", net: true },
        { label: "GraphQL injection", value: INJECTION, expect: "either", net: true },
      ];
  }
}

// ---- case generation ---------------------------------------------------------

const typesOf = (p) => {
  if (p.anyOf) return new Set(p.anyOf.flatMap((a) => (a.type ? [a.type].flat() : a.anyOf ? ["string"] : [])));
  if (p.$ref) return new Set(["string", "array"]);
  return new Set([p.type].flat().filter(Boolean));
};

/** Round-robin over each kind's network cases, so the whole set is covered across tools. */
const rotation = new Map();
function sample(kind, list, n) {
  if (list.length <= n) return list;
  const start = rotation.get(kind) ?? 0;
  rotation.set(kind, start + n);
  return Array.from({ length: n }, (_, i) => list[(start + i) % list.length]);
}

/** Network cases per field: the rest of each kind's set is covered on other tools. */
const NET_PER_FIELD = 2;

function generate(tool) {
  const name = tool.name;
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const base = BASE[name];
  const groups = ALTERNATIVES[name] ?? [];
  const cases = [];
  const withField = (field, value, keepAlternatives = false) => {
    const args = { ...base };
    if (!keepAlternatives) for (const g of groups) if (g.includes(field)) for (const other of g) delete args[other];
    args[field] = value;
    return args;
  };
  const without = (field) => {
    const args = { ...base };
    delete args[field];
    return args;
  };
  const add = (field, label, args, expect, extra = {}) => cases.push({ field, label, args, expect, ...extra });

  let lenientNumberDone = false;
  let optionalNullDone = false;
  let bareStringDone = false;

  for (const [field, p] of Object.entries(props)) {
    if (field === "network") continue;
    const types = typesOf(p);
    const isReq = required.has(field);
    const kind = kindOf(name, field);
    const isArray = types.has("array") && !types.has("string");
    const isNumber = (types.has("number") || types.has("integer")) && !types.has("string");
    const isEnum = Array.isArray(p.enum);
    const isBool = types.has("boolean");
    const current = base[field];

    if (isReq) add(field, "missing", without(field), "reject");
    if (isReq) add(field, "null", withField(field, null), "reject");
    else if (!optionalNullDone && !isArray && !(field in base) && !(NEEDS_ONE_OF[name] ?? []).includes(field)) {
      optionalNullDone = true;
      add(field, "null (means unset)", withField(field, null, true), "lenient");
    }

    // Wrong JSON types.
    if (isArray) {
      add(field, "object for array", withField(field, { a: 1 }), "reject");
      add(field, "number for array", withField(field, 12345), "reject");
    } else {
      if (!types.has("array")) add(field, "array for scalar", withField(field, [current ?? "x"]), "reject");
      add(field, "object for scalar", withField(field, {}), "reject");
      if (isNumber) add(field, "word for number", withField(field, "abc"), "reject");
      else if (isBool) add(field, "word for boolean", withField(field, "yes"), "reject");
      else if (kind === "uint") add(field, "number for text", withField(field, 12345), "lenient", { net: true });
      else if (!types.has("number")) add(field, "number for string", withField(field, 12345), "reject");
    }

    // Empty and blank.
    const blankExpect = isReq || isNumber || isEnum || isBool || isArray || !["text", "cursor"].includes(kind)
      ? "reject" : "either";
    add(field, "empty string", withField(field, ""), blankExpect, { net: blankExpect === "either" });
    add(field, "whitespace", withField(field, " \t "), blankExpect, { net: blankExpect === "either" });

    if (isBool) add(field, "number for boolean", withField(field, 1), "reject");
    if (isEnum) {
      add(field, "unknown enum value", withField(field, "bogus"), "reject");
      add(field, "enum in upper case", withField(field, String(p.enum[0]).toUpperCase()), "reject");
    }

    // Numbers: range and shape.
    if (isNumber || (types.has("number") && types.has("string"))) {
      const isInt = types.has("integer") || INT_NAMES.test(field);
      const min = p.minimum ?? (p.exclusiveMinimum !== undefined ? p.exclusiveMinimum : undefined);
      if (field !== "seed") add(field, "negative", withField(field, -1), "reject");
      if (min === 1 || p.exclusiveMinimum === 0) add(field, "zero under a minimum", withField(field, 0), "reject");
      if (p.maximum !== undefined) add(field, "over the maximum", withField(field, p.maximum + 1), "reject");
      add(field, "NaN as text", withField(field, "NaN"), "reject");
      add(field, "Infinity as text", withField(field, "Infinity"), "reject");
      add(field, "1e309", withField(field, "1e309"), "reject");
      if (isInt) add(field, "fraction for integer", withField(field, 2.5), "reject");
      if (isNumber && !lenientNumberDone) {
        lenientNumberDone = true;
        const v = current ?? (p.minimum ?? 1);
        add(field, "number as text", withField(field, String(v)), "lenient", { net: true });
      }
    }

    // Arrays: size limits, item types, and a bare string for a list.
    if (isArray) {
      const itemKind = kind;
      if ((p.minItems ?? 0) >= 1) add(field, "empty list", withField(field, []), "reject");
      if (p.maxItems !== undefined && p.maxItems <= 100) {
        const item = Array.isArray(current) && current.length ? current[0] : "x";
        add(field, "over maxItems", withField(field, Array.from({ length: p.maxItems + 1 }, () => item)), "reject");
      }
      add(field, "number in the list", withField(field, [12345]), "reject");
      if (["address", "object", "package"].includes(itemKind)) {
        add(field, "non-hex item", withField(field, ["0xZZ12"]), "reject");
        add(field, "10k-char item", withField(field, [`0x${LONG}`]), "reject");
      } else {
        for (const h of sample(`list:${itemKind}`, hostile(itemKind, undefined).filter((h) => h.net), 1)) {
          add(field, `item: ${h.label}`, withField(field, [h.value]), h.expect, { net: true });
        }
      }
      if (isReq && !bareStringDone && (p.minItems ?? 0) <= 1 && Array.isArray(current) && current.length) {
        bareStringDone = true;
        add(field, "bare string for list", withField(field, current[0]), "lenient", { net: true });
      }
      continue;
    }

    // Hostile strings for string fields.
    if (types.has("string") && !isEnum) {
      const set = hostile(kind, current);
      for (const h of set.filter((h) => !h.net)) add(field, h.label, withField(field, h.value), h.expect);
      for (const h of sample(`${kind}`, set.filter((h) => h.net), NET_PER_FIELD)) {
        add(field, h.label, withField(field, h.value), h.expect, { net: true });
      }
    }
  }

  // Arguments the tool does not have.
  const fields = Object.keys(props);
  add("(extra)", "unknown argument", { ...base, bogus_argument: 1 }, "reject", { names: fields });
  const target = fields.find((f) => f !== "network" && f.includes("_")) ?? fields.find((f) => f !== "network");
  if (target) {
    const typo = [target.split("_")[0], `${target}s`, target.replace(/_/g, "")].find((t) => !fields.includes(t));
    const args = { ...base };
    const value = args[target] ?? hostileDefault(props[target]);
    delete args[target];
    args[typo] = value;
    add("(extra)", `misspelt ${target} as ${typo}`, args, "reject", { names: [target] });
  }
  if (NEEDS_ONE_OF[name]) add("(none)", "no arguments", {}, "reject");
  if (CONFLICTS[name]) add("(conflict)", Object.keys(CONFLICTS[name]).join(" + "), { ...base, ...CONFLICTS[name] }, "reject", { net: true });
  add("network", "unknown network", { ...base, network: "mainnet2" }, "reject");
  return cases;
}

function hostileDefault(p) {
  const types = typesOf(p ?? {});
  if (types.has("array")) return ["x"];
  if (types.has("number") || types.has("integer")) return 1;
  if (types.has("boolean")) return true;
  return "x";
}

// ---- judging -----------------------------------------------------------------

/** The error text of a failed call, from `{"error": ...}` or plain text. */
function errorText(result) {
  const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error === "string") return parsed.error;
  } catch {
    // plain text
  }
  return text;
}

/** Why an error message is not one readable line, or null when it is. */
function badMessage(msg) {
  if (!msg.trim()) return "empty message";
  if (/\n/.test(msg)) return "spans several lines";
  if (/\bat .+\.(m?js|ts):\d+|node:internal|^\s*at /m.test(msg)) return "stack trace";
  if (/<\/?(html|body|head|!doctype|div|pre)\b/i.test(msg)) return "HTML";
  if (/"response":|"errors":\s*\[|"locations":|query\s*\(\$|\{\s*"query"/.test(msg)) return "GraphQL dump";
  if (msg.length > 700) return `${msg.length} chars`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(msg)) return "raw control characters";
  return null;
}

/** Did the tool refuse this as a malformed argument (rather than fail on the chain)? */
const refusedAsMalformed = (msg) =>
  /Invalid arguments|Not a Sui address|Expected (a )?number|Unknown argument|Required|Invalid enum|must be|not a valid|invalid/i.test(msg);

function judge(c, msg, meta) {
  if (msg.timedOut) return `no answer in ${CALL_LIMIT_MS / 1000}s`;
  if (msg.ms > CALL_LIMIT_MS) return `took ${(msg.ms / 1000).toFixed(1)}s`;
  if (msg.error) return `JSON-RPC error instead of isError: ${short(msg.error.message)}`;
  const result = msg.result ?? {};
  const size = (result.content ?? []).reduce((n, i) => n + (i.text?.length ?? 0), 0);
  const limit = meta?.["anthropic/maxResultSizeChars"] ?? SIZE_LIMIT;
  if (size > limit) return `${size} chars returned`;
  if (result.isError) {
    const text = errorText(result);
    const why = badMessage(text);
    if (why) return `error message: ${why}: ${short(text)}`;
    if (c.expect === "lenient" && refusedAsMalformed(text)) return `refused a documented form: ${short(text)}`;
    if (c.names && !c.names.some((n) => text.includes(n))) return `error does not name the right argument: ${short(text)}`;
    return null;
  }
  if (c.expect === "reject") return `answered as if valid: ${short((result.content ?? [])[0]?.text ?? "")}`;
  return null;
}

// ---- run ---------------------------------------------------------------------

let server = await startServer({ name: "adversarial" });
const { ck, finish } = checker();
const listed = (await server.rpc("tools/list", {})).result.tools;
const t0 = Date.now();
const table = [];

async function alive() {
  const r = await server.rpc("tools/list", {}, 15_000);
  return Array.isArray(r.result?.tools);
}

try {
  ck(`tools/list names every tool with a baseline (${listed.length})`, listed.every((t) => BASE[t.name]),
    listed.filter((t) => !BASE[t.name]).map((t) => t.name).join(", "));

  for (const tool of listed) {
    if (!BASE[tool.name]) continue;
    const cases = generate(tool);
    const started = Date.now();
    const failures = [];
    let slowest = 0;
    for (const c of cases) {
      const msg = await server.callRaw(tool.name, c.args, CALL_LIMIT_MS + 5_000);
      slowest = Math.max(slowest, msg.ms ?? 0);
      const why = judge(c, msg, tool._meta);
      const line = `${c.field}: ${c.label} [${c.expect}] ${((msg.ms ?? 0) / 1000).toFixed(1)}s`;
      if (why) failures.push(`${line}  ${why}`);
      else if (VERBOSE) {
        const r = msg.result ?? {};
        console.log(`     ok  ${line}  ${r.isError ? "error" : "answer"}: ${short((r.content ?? [])[0]?.text ?? "")}`);
      }
      if (msg.timedOut && !(await alive())) {
        failures.push(`${line}  server stopped answering; restarted`);
        server.stop();
        server = await startServer({ name: "adversarial" });
      }
    }
    if (!(await alive())) {
      failures.push("server stopped answering tools/list after this tool; restarted");
      server.stop();
      server = await startServer({ name: "adversarial" });
    }
    const secs = (Date.now() - started) / 1000;
    console.log(`\n${tool.name}  ${cases.length} cases, ${secs.toFixed(1)}s, slowest ${(slowest / 1000).toFixed(1)}s`);
    for (const f of failures) ck(`${tool.name} ${f}`, false);
    if (!failures.length) console.log("   ok  every case");
    table.push({ tool: tool.name, cases: cases.length, failed: failures.length, secs });
  }

  // ---- semantic cases the schema cannot produce ------------------------------
  console.log("\nsemantic cases");
  const multisig = async (label, address) => {
    const r = await server.call("analyze_multisig", { address });
    ck(`analyze_multisig refuses ${label}`, !!r._isError, short(r.error ?? r._text ?? r));
  };
  await multisig("a plain wallet", PLAIN_WALLET);
  await multisig("a package", FRAMEWORK);
  await multisig("an unused address", UNUSED);

  const five = Array.from({ length: 5 }, (_, i) => `0x${String(i + 1).repeat(64)}`);
  const shared = await server.call("find_shared_multisig", { addresses: five });
  ck("find_shared_multisig refuses five unusable addresses", !!shared._isError, short(shared.error ?? shared));

  const impostor = await server.call("analyze_token", {
    query: "0x006e09c3c3ebb8c4670e0320da7efe926d35347608f964b4625dd47bae40a664::usdc::USDC",
    include_holders: false,
  });
  ck("an impostor USDC is not verified", impostor.verified === false, `verified=${impostor.verified}`);
  const ambiguous = await server.call("analyze_token", { query: "USDC", include_holders: false });
  ck("the symbol USDC returns candidates", ambiguous.status === "ambiguous_symbol", `status=${ambiguous.status}`);
  const real = await server.call("analyze_token", { query: "SUI", include_holders: false });
  ck("SUI resolves as verified", real.verified === true, `verified_by=${real.verified_by}`);
  const junk = await server.call("analyze_token", { query: "zzzznotacoinzzz", include_holders: false });
  ck("a junk symbol is an error", !!junk._isError, short(junk.error ?? junk));

  const restrict = await server.call("check_coin_restrictions", { coin_type: "0x2::a::b::c" });
  ck("check_coin_restrictions refuses a four-part type", !!restrict._isError, short(restrict.error ?? restrict));
  const idHuge = await server.call("identify_address", { address: `0x${"f".repeat(200)}` });
  ck("identify_address refuses 200 hex digits", !!idHuge._isError, short(idHuge.error ?? idHuge));
  const id63 = await server.call("identify_address", { address: `0x${"1".repeat(63)}` });
  ck("identify_address pads 63 hex digits", !id63._isError && id63.address === `0x0${"1".repeat(63)}`, short(id63.address ?? id63.error));

  const refuses = async (label, tool, args) => {
    const r = await server.call(tool, args);
    ck(`${tool} refuses ${label}`, !!r._isError, short(r.error ?? r._text ?? r));
  };
  await refuses("the framework package as a pool", "get_pool_stats", { pool_id: FRAMEWORK });
  await refuses("the Clock as a pool", "get_pool_stats", { pool_id: CLOCK });
  await refuses("a protocol hint the chain contradicts", "get_pool_stats", { pool_id: CETUS_POOL, protocol: "turbos" });
  await refuses("a value_field no event carries", "aggregate_events", { sender: NEMO, max_events: 50, value_field: "no_such_field" });
  await refuses("bytes left over after a transaction", "decode_ptb", { transaction_bcs: "A".repeat(10_000) });
  await refuses("a list of malformed digests", "get_transactions", { digests: ["notadigest0OIl", "1".repeat(44)] });
  await refuses("a wallet as a package lineage", "resolve_protocol_packages", { package_id: NEMO });

  const nfts = await server.call("list_nfts", { address: NEMO, limit: 1 });
  ck("list_nfts returns no more than limit: 1", nfts.nfts?.length === 1, `${nfts.nfts?.length} NFTs`);

  ck("server still lists every tool at the end", await alive());
} finally {
  server.stop();
}

console.log(`\n${"tool".padEnd(32)} ${"cases".padStart(5)} ${"failed".padStart(6)} ${"secs".padStart(6)}  result`);
for (const r of table) {
  console.log(`${r.tool.padEnd(32)} ${String(r.cases).padStart(5)} ${String(r.failed).padStart(6)} ${r.secs.toFixed(1).padStart(6)}  ${r.failed ? "FAIL" : "pass"}`);
}
const total = table.reduce((n, r) => n + r.cases, 0);
console.log(`${table.length} tools, ${total} cases, ${table.filter((r) => !r.failed).length} passed, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
finish();
