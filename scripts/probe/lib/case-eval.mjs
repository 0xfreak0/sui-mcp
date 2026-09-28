/**
 * The pure half of the case runner: validating a case file against the
 * contract in cases/README.md, substituting subjects into templates,
 * resolving result paths and evaluating `expect` entries. No I/O, so the
 * unit tests in test/case-eval.test.ts cover all of it.
 */

export const CASE_KINDS = [
  "protocol-exploit",
  "address-poisoning",
  "wallet-drainer",
  "token-rug",
  "sybil-farm",
  "key-compromise",
  "nft-theft",
  "laundering",
  "other",
];
export const SOURCE_KINDS = ["victim-postmortem", "security-firm", "official", "exchange", "news"];
/** The evidence tiers the server itself reports. */
export const TIERS = ["chain-derived", "code-derived", "indexer-attested", "price-provider", "heuristic"];
export const NETWORKS = ["mainnet", "testnet", "devnet"];
export const OPS = [
  "equals",
  "iequals",
  "includes",
  "excludes",
  "contains",
  "matches",
  "gte",
  "lte",
  "approx",
  "exists",
  "absent",
  "count_gte",
  "count_lte",
];
export const DEFAULT_TIMEOUT_S = 120;

const CASE_KEYS = ["slug", "kind", "title", "network", "summary", "sources", "subjects", "checks"];
const SOURCE_KEYS = ["url", "publisher", "kind"];
const CHECK_KEYS = ["id", "question", "tool", "args", "expect", "tier", "basis", "known_defect", "timeout_s", "max_chars", "critical"];
const EXPECT_KEYS = ["path", "op", "value", "tolerance"];
const NO_VALUE_OPS = new Set(["exists", "absent"]);
const STRING_OPS = new Set(["iequals", "contains", "matches"]);
const NUMERIC_OPS = new Set(["gte", "lte", "approx"]);
const COUNT_OPS = new Set(["count_gte", "count_lte"]);
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SUBJECT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TEMPLATE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// ---- paths -------------------------------------------------------------------

/**
 * Parse `a.b[0].c`, `a[*].b` or `""` into steps: `{ key }`, `{ index }` or
 * `{ all: true }`. Throws on anything else.
 */
export function parsePath(path) {
  if (typeof path !== "string") throw new Error("path must be a string");
  if (path === "") return [];
  const steps = [];
  path.split(".").forEach((segment, i) => {
    const m = /^([^.[\]]*)((?:\[(?:\d+|\*)\])*)$/.exec(segment);
    if (!m) throw new Error(`bad path segment "${segment}" in "${path}"`);
    const [, key, brackets] = m;
    if (key === "" && (i > 0 || brackets === "")) throw new Error(`empty path segment in "${path}"`);
    if (key !== "") steps.push({ key });
    for (const [, inner] of brackets.matchAll(/\[(\d+|\*)\]/g)) {
      steps.push(inner === "*" ? { all: true } : { index: Number(inner) });
    }
  });
  return steps;
}

/**
 * Resolve a path against a value. A path without `[*]` gives
 * `{ found, value }`. A path with `[*]` gives `{ found, value: [...], collected: true }`:
 * `found` says the first array existed, and elements that lack the rest of
 * the path contribute nothing.
 */
export function resolvePath(root, path) {
  let current = [root];
  let collected = false;
  for (const step of parsePath(path)) {
    const next = [];
    for (const v of current) {
      if (step.key !== undefined) {
        if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v, step.key)) next.push(v[step.key]);
      } else if (step.index !== undefined) {
        if (Array.isArray(v) && step.index < v.length) next.push(v[step.index]);
      } else if (Array.isArray(v)) {
        next.push(...v);
      } else if (!collected) {
        return { found: false };
      }
    }
    if (step.all) collected = true;
    if (!collected && next.length === 0) return { found: false };
    current = next;
  }
  return collected ? { found: true, value: current, collected: true } : { found: true, value: current[0] };
}

/**
 * A tool call's answer in the shape paths address: the first JSON text block,
 * all text joined, and whether the call failed. A JSON-RPC error (unknown
 * tool, timeout) counts as a failed call whose text is the error message.
 */
export function toResponse(msg) {
  if (msg.error) return { json: null, text: String(msg.error.message ?? msg.error), isError: true, timedOut: Boolean(msg.timedOut) };
  const texts = (msg.result?.content ?? []).map((c) => (typeof c.text === "string" ? c.text : ""));
  let json = null;
  for (const t of texts) {
    const s = t.trim();
    if (!s.startsWith("{") && !s.startsWith("[")) continue;
    try {
      json = JSON.parse(s);
      break;
    } catch {
      // Not JSON after all; the text is still reachable as `_text`.
    }
  }
  return { json, text: texts.join("\n"), isError: Boolean(msg.result?.isError), timedOut: false };
}

/** Resolve a check path against a response: `_text` and `_isError` first, then the JSON. */
export function resolveCheckPath(response, path) {
  if (path === "_text") return { found: true, value: response.text };
  if (path === "_isError") return { found: true, value: response.isError };
  if (path === "") return { found: true, value: response.json ?? response.text };
  if (response.json === null) return { found: false };
  return resolvePath(response.json, path);
}

// ---- templates ---------------------------------------------------------------

/** Every `{name}` referenced in the strings of a value. */
export function templateNames(value) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === "string") for (const [, name] of v.matchAll(TEMPLATE)) out.add(name);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

/** Replace every `{name}` in the strings of a value with `subjects[name]`. Throws on a name not in subjects. */
export function substitute(value, subjects) {
  if (typeof value === "string") {
    return value.replace(TEMPLATE, (_, name) => {
      if (!Object.hasOwn(subjects, name)) throw new Error(`{${name}} is not in subjects`);
      return subjects[name];
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, subjects));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, subjects)]));
  }
  return value;
}

// ---- comparison --------------------------------------------------------------

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** A number or numeric string, or null. Integers come back as BigInt so no precision is lost. */
export function toNumeric(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return Number.isInteger(v) ? BigInt(v) : v;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (INTEGER.test(s)) return BigInt(s);
    if (DECIMAL.test(s)) return Number(s);
  }
  return null;
}

/** -1, 0 or 1; BigInt when both sides are integers, Number otherwise. Null when either is not numeric. */
export function compareNumeric(a, b) {
  const x = toNumeric(a);
  const y = toNumeric(b);
  if (x === null || y === null) return null;
  if (typeof x === "bigint" && typeof y === "bigint") return x < y ? -1 : x > y ? 1 : 0;
  const nx = Number(x);
  const ny = Number(y);
  return nx < ny ? -1 : nx > ny ? 1 : 0;
}

const sameItem = (item, want) =>
  typeof item === "string" && typeof want === "string" ? item.toLowerCase() === want.toLowerCase() : deepEqual(item, want);

/** Short rendering of an actual value for a failure line. */
export function show(v, max = 160) {
  const s = v === undefined ? "undefined" : typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Evaluate one expect entry (already substituted) against a resolved path.
 * Returns `{ ok, got }`; `got` describes what was there when it failed.
 */
export function evaluate(expect, resolved) {
  const { op, value } = expect;
  const present = resolved.found && (resolved.collected ? resolved.value.some((v) => v != null) : resolved.value != null);
  if (op === "exists") return { ok: present, got: resolved.found ? show(resolved.value) : "path not found" };
  if (op === "absent") return { ok: !present, got: show(resolved.value) };
  if (!resolved.found) return { ok: false, got: "path not found" };

  const actual = resolved.value;
  const list = resolved.collected ? actual : Array.isArray(actual) ? actual : null;
  const single = () => (resolved.collected ? { ok: false, got: `${op} needs one value; the path collects ${actual.length}` } : null);

  switch (op) {
    case "equals":
      return { ok: deepEqual(actual, value), got: show(actual) };
    case "iequals":
      return single() ?? (typeof actual === "string" ? { ok: actual.toLowerCase() === value.toLowerCase(), got: show(actual) } : { ok: false, got: `not a string: ${show(actual)}` });
    case "includes":
    case "excludes": {
      if (!list) return { ok: false, got: `not an array: ${show(actual)}` };
      const has = list.some((item) => sameItem(item, value));
      return { ok: op === "includes" ? has : !has, got: `${list.length} values: ${show(list)}` };
    }
    case "contains":
      return single() ?? (typeof actual === "string" ? { ok: actual.toLowerCase().includes(value.toLowerCase()), got: show(actual) } : { ok: false, got: `not a string: ${show(actual)}` });
    case "matches":
      return single() ?? (typeof actual === "string" ? { ok: new RegExp(value).test(actual), got: show(actual) } : { ok: false, got: `not a string: ${show(actual)}` });
    case "gte":
    case "lte": {
      const bad = single();
      if (bad) return bad;
      const c = compareNumeric(actual, value);
      if (c === null) return { ok: false, got: `not numeric: ${show(actual)}` };
      return { ok: op === "gte" ? c >= 0 : c <= 0, got: show(actual) };
    }
    case "approx": {
      const bad = single();
      if (bad) return bad;
      const a = toNumeric(actual);
      if (a === null) return { ok: false, got: `not numeric: ${show(actual)}` };
      const want = Number(toNumeric(value));
      return { ok: Math.abs(Number(a) - want) <= expect.tolerance * Math.abs(want), got: show(actual) };
    }
    case "count_gte":
    case "count_lte": {
      if (!list) return { ok: false, got: `not an array: ${show(actual)}` };
      return { ok: op === "count_gte" ? list.length >= value : list.length <= value, got: `${list.length} values` };
    }
    default:
      return { ok: false, got: `unknown op ${op}` };
  }
}

// ---- validation --------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonBlank = (v) => typeof v === "string" && v.trim() !== "";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every way a parsed case file breaks the contract, as readable lines.
 * `tools` maps each registered tool name to its input schema (or null);
 * `file` is the file's base name, which must be `<slug>.json`.
 */
export function validateCase(c, { tools, file } = {}) {
  const errors = [];
  const err = (where, msg) => errors.push(`${where}: ${msg}`);
  const unknownKeys = (obj, allowed, where) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(where || "(top level)", `unknown key "${k}"; allowed: ${allowed.join(", ")}`);
  };
  const oneOf = (v, list, where) => {
    if (!list.includes(v)) err(where, `${show(v)} is not one of ${list.join(", ")}`);
  };

  if (!isObject(c)) return ["(top level): a case file is one JSON object"];
  unknownKeys(c, CASE_KEYS, "");

  if (!nonBlank(c.slug) || !SLUG.test(c.slug)) err("slug", "lower-case letters, digits and dashes");
  else if (file !== undefined && file !== `${c.slug}.json`) err("slug", `file is ${file}; it must be ${c.slug}.json`);
  oneOf(c.kind, CASE_KINDS, "kind");
  if (!nonBlank(c.title)) err("title", "required");
  oneOf(c.network, NETWORKS, "network");
  if (!nonBlank(c.summary)) err("summary", "required");

  const publishers = [];
  if (!Array.isArray(c.sources) || c.sources.length === 0) {
    err("sources", "at least one published source is required");
  } else {
    c.sources.forEach((s, i) => {
      const where = `sources[${i}]`;
      if (!isObject(s)) return err(where, "must be an object");
      unknownKeys(s, SOURCE_KEYS, where);
      if (typeof s.url !== "string" || !/^https?:\/\/\S+$/.test(s.url)) err(`${where}.url`, "an http(s) URL is required");
      if (!nonBlank(s.publisher)) err(`${where}.publisher`, "required");
      else publishers.push(s.publisher);
      oneOf(s.kind, SOURCE_KINDS, `${where}.kind`);
    });
  }

  const subjects = isObject(c.subjects) ? c.subjects : {};
  if (!isObject(c.subjects)) err("subjects", "an object of name to address, digest or CAIP-10 account");
  for (const [name, v] of Object.entries(subjects)) {
    if (!SUBJECT_NAME.test(name)) err(`subjects.${name}`, "names are letters, digits and underscores");
    if (!nonBlank(v)) err(`subjects.${name}`, "must be a non-empty string");
  }
  const missingSubjects = (value, where) => {
    for (const name of templateNames(value)) if (!Object.hasOwn(subjects, name)) err(where, `{${name}} is not in subjects`);
  };

  if (!Array.isArray(c.checks) || c.checks.length === 0) {
    err("checks", "at least one check is required");
    return errors;
  }
  const ids = new Set();
  c.checks.forEach((ck, i) => {
    const where = `checks[${i}]${nonBlank(ck?.id) ? ` (${ck.id})` : ""}`;
    if (!isObject(ck)) return err(where, "must be an object");
    unknownKeys(ck, CHECK_KEYS, where);

    if (!nonBlank(ck.id) || /\s/.test(ck.id)) err(`${where}.id`, "a non-empty id without spaces is required");
    else if (ids.has(ck.id)) err(`${where}.id`, "duplicate id");
    else ids.add(ck.id);
    if (!nonBlank(ck.question)) err(`${where}.question`, "required");

    const schema = tools && nonBlank(ck.tool) ? tools.get(ck.tool) : undefined;
    if (!nonBlank(ck.tool)) err(`${where}.tool`, "required");
    else if (tools && !tools.has(ck.tool)) err(`${where}.tool`, `unknown tool "${ck.tool}"`);

    if (!isObject(ck.args)) {
      err(`${where}.args`, "an object of the tool's arguments is required");
    } else {
      missingSubjects(ck.args, `${where}.args`);
      const props = schema?.properties;
      if (props) {
        for (const k of Object.keys(ck.args)) if (!Object.hasOwn(props, k)) err(`${where}.args`, `${ck.tool} has no argument "${k}"`);
        for (const k of schema.required ?? []) if (!Object.hasOwn(ck.args, k)) err(`${where}.args`, `${ck.tool} requires "${k}"`);
      }
    }

    if (!Array.isArray(ck.expect) || ck.expect.length === 0) {
      err(`${where}.expect`, "at least one expectation is required");
    } else {
      ck.expect.forEach((e, j) => validateExpect(e, `${where}.expect[${j}]`, err, unknownKeys, missingSubjects));
    }

    oneOf(ck.tier, TIERS, `${where}.tier`);
    if (!nonBlank(ck.basis)) {
      err(`${where}.basis`, "say where the pinned value comes from: a source's publisher or the chain");
    } else {
      const named = [...publishers, "chain"].some((p) => new RegExp(`\\b${escapeRe(p)}\\b`, "i").test(ck.basis));
      if (!named) err(`${where}.basis`, `names no source (${publishers.join(", ") || "none listed"}) and not the chain; every pinned fact needs one`);
    }
    if (ck.known_defect !== undefined && !nonBlank(ck.known_defect)) err(`${where}.known_defect`, "one line saying what the tool gets wrong");
    if (ck.timeout_s !== undefined && !(typeof ck.timeout_s === "number" && ck.timeout_s > 0)) err(`${where}.timeout_s`, "a positive number of seconds");
    if (ck.max_chars !== undefined && !(Number.isInteger(ck.max_chars) && ck.max_chars > 0)) err(`${where}.max_chars`, "a positive integer");
    if (ck.critical !== undefined && ck.critical !== true) err(`${where}.critical`, "true, or left out");
    if (ck.critical === true && ck.known_defect !== undefined) err(`${where}.critical`, "a critical check cannot be a known defect");
  });
  return errors;
}

function validateExpect(e, where, err, unknownKeys, missingSubjects) {
  if (!isObject(e)) return err(where, "must be an object");
  unknownKeys(e, EXPECT_KEYS, where);
  if (typeof e.path !== "string") err(`${where}.path`, 'required; "" is the whole result');
  else {
    try {
      parsePath(e.path);
    } catch (x) {
      err(`${where}.path`, x.message);
    }
  }
  if (!OPS.includes(e.op)) return err(`${where}.op`, `unknown op ${show(e.op)}; one of ${OPS.join(", ")}`);
  const has = Object.hasOwn(e, "value");
  if (NO_VALUE_OPS.has(e.op)) {
    if (has) err(`${where}.value`, `${e.op} takes no value`);
  } else if (!has) {
    err(`${where}.value`, `${e.op} needs a value`);
  } else {
    missingSubjects(e.value, `${where}.value`);
    if (STRING_OPS.has(e.op) && typeof e.value !== "string") err(`${where}.value`, `${e.op} compares strings`);
    if (e.op === "matches" && typeof e.value === "string") {
      try {
        new RegExp(e.value);
      } catch (x) {
        err(`${where}.value`, `bad regex: ${x.message}`);
      }
    }
    if (NUMERIC_OPS.has(e.op) && toNumeric(e.value) === null) err(`${where}.value`, `${e.op} needs a number or numeric string`);
    if (COUNT_OPS.has(e.op) && !(Number.isInteger(e.value) && e.value >= 0)) err(`${where}.value`, `${e.op} needs a non-negative integer`);
  }
  if (e.op === "approx") {
    if (!(typeof e.tolerance === "number" && e.tolerance > 0)) err(`${where}.tolerance`, "approx needs a positive relative tolerance, e.g. 0.01");
  } else if (Object.hasOwn(e, "tolerance")) {
    err(`${where}.tolerance`, "only approx takes a tolerance");
  }
}
