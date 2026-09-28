import { describe, it, expect } from "vitest";
import {
  compareNumeric,
  evaluate,
  parsePath,
  resolveCheckPath,
  resolvePath,
  substitute,
  toResponse,
  validateCase,
} from "../scripts/probe/lib/case-eval.mjs";

const result = {
  found: true,
  count: 8,
  big: "18446744073709551616",
  label: "Circle CCTP",
  empty: [],
  nothing: null,
  bridge_exits: {
    by_bridge: [
      { bridge: "Circle CCTP", destinations: [{ address: "0xAbC" }, { address: "0xdef" }] },
      { bridge: "Wormhole", destinations: [{ address: "0x123" }] },
      { bridge: "Meson" },
    ],
  },
  hops: [{ digest: "d1" }, { digest: "d2" }],
};

const at = (path: string) => resolvePath(result, path);
const check = (path: string, op: string, value?: unknown, extra: object = {}) =>
  evaluate({ path, op, ...(value === undefined ? {} : { value }), ...extra }, at(path)).ok;

describe("parsePath", () => {
  it("reads keys, indexes and [*]", () => {
    expect(parsePath("a.b[0].c[*][2]")).toEqual([{ key: "a" }, { key: "b" }, { index: 0 }, { key: "c" }, { all: true }, { index: 2 }]);
  });
  it("reads an empty path as the whole result, and a leading index on a root array", () => {
    expect(parsePath("")).toEqual([]);
    expect(parsePath("[*].a")).toEqual([{ all: true }, { key: "a" }]);
  });
  it.each(["a..b", "a.", "a[x]", "a[-1]", "a[0", ".a", "a.[0]"])("rejects %s", (p) => {
    expect(() => parsePath(p)).toThrow();
  });
});

describe("resolvePath", () => {
  it("follows keys and indexes", () => {
    expect(at("hops[1].digest")).toEqual({ found: true, value: "d2" });
    expect(at("bridge_exits.by_bridge[0].bridge")).toEqual({ found: true, value: "Circle CCTP" });
  });
  it("reports a missing key or an out-of-range index as not found", () => {
    expect(at("hops[2].digest").found).toBe(false);
    expect(at("nope").found).toBe(false);
    expect(at("label.more").found).toBe(false);
  });
  it("flattens nested [*] and skips elements without the rest of the path", () => {
    expect(at("bridge_exits.by_bridge[*].destinations[*].address")).toEqual({
      found: true,
      collected: true,
      value: ["0xAbC", "0xdef", "0x123"],
    });
  });
  it("finds an empty array under [*] but not a missing one", () => {
    expect(at("empty[*].x")).toEqual({ found: true, collected: true, value: [] });
    expect(at("missing[*].x").found).toBe(false);
    expect(at("label[*]").found).toBe(false);
  });
  it("returns the whole value for an empty path and keeps null as found", () => {
    expect(at("").value).toBe(result);
    expect(at("nothing")).toEqual({ found: true, value: null });
  });
});

describe("responses", () => {
  const ok = { result: { content: [{ type: "text", text: "note" }, { type: "text", text: '{"a":1}' }] } };
  it("takes the first JSON block and keeps every text for _text", () => {
    const r = toResponse(ok);
    expect(r.json).toEqual({ a: 1 });
    expect(resolveCheckPath(r, "_text").value).toBe('note\n{"a":1}');
    expect(resolveCheckPath(r, "_isError").value).toBe(false);
    expect(resolveCheckPath(r, "a").value).toBe(1);
  });
  it("gives the text as the whole result when nothing is JSON", () => {
    const r = toResponse({ result: { isError: true, content: [{ type: "text", text: "Invalid address" }] } });
    expect(resolveCheckPath(r, "").value).toBe("Invalid address");
    expect(resolveCheckPath(r, "_isError").value).toBe(true);
    expect(resolveCheckPath(r, "a").found).toBe(false);
  });
  it("treats a JSON-RPC error or a timeout as a failed call", () => {
    const r = toResponse({ error: { message: "timed out after 1s" }, timedOut: true });
    expect(r).toEqual({ json: null, text: "timed out after 1s", isError: true, timedOut: true });
  });
});

describe("substitute", () => {
  const subjects = { attacker: "0xa1", dest: "0x13" };
  it("replaces whole and embedded templates, deeply", () => {
    expect(substitute({ address: "{attacker}", to: ["eip155:1:{dest}"], n: 3 }, subjects)).toEqual({
      address: "0xa1",
      to: ["eip155:1:0x13"],
      n: 3,
    });
  });
  it("leaves regex quantifiers alone", () => {
    expect(substitute("^0x[0-9a-f]{64}$", subjects)).toBe("^0x[0-9a-f]{64}$");
  });
  it("throws on a subject that is not defined", () => {
    expect(() => substitute("{victim}", subjects)).toThrow("{victim} is not in subjects");
  });
});

describe("ops", () => {
  it("equals is deep and exact", () => {
    expect(check("hops", "equals", [{ digest: "d1" }, { digest: "d2" }])).toBe(true);
    expect(check("label", "equals", "circle cctp")).toBe(false);
    expect(check("count", "equals", "8")).toBe(false);
    expect(check("hops[*].digest", "equals", ["d1", "d2"])).toBe(true);
  });
  it("iequals ignores case and needs a string", () => {
    expect(check("label", "iequals", "circle cctp")).toBe(true);
    expect(check("count", "iequals", "8")).toBe(false);
  });
  it("includes and excludes compare strings without case", () => {
    expect(check("bridge_exits.by_bridge[*].destinations[*].address", "includes", "0xabc")).toBe(true);
    expect(check("bridge_exits.by_bridge[*].destinations[*].address", "includes", "0x999")).toBe(false);
    expect(check("bridge_exits.by_bridge[*].destinations[*].address", "excludes", "0x999")).toBe(true);
    expect(check("bridge_exits.by_bridge[*].destinations[*].address", "excludes", "0xDEF")).toBe(false);
    expect(check("hops", "includes", { digest: "d2" })).toBe(true);
  });
  it("includes needs an array or a [*] path", () => {
    expect(check("label", "includes", "Circle CCTP")).toBe(false);
  });
  it("contains and matches read one string", () => {
    expect(check("label", "contains", "cctp")).toBe(true);
    expect(check("label", "contains", "wormhole")).toBe(false);
    expect(check("label", "matches", "^Circle")).toBe(true);
    expect(check("label", "matches", "^circle")).toBe(false);
    expect(check("hops[*].digest", "contains", "d1")).toBe(false);
  });
  it("gte and lte compare numbers and numeric strings", () => {
    expect(check("count", "gte", 8)).toBe(true);
    expect(check("count", "gte", "9")).toBe(false);
    expect(check("count", "lte", 8.5)).toBe(true);
    expect(check("label", "gte", 1)).toBe(false);
  });
  it("compares large integers as BigInt", () => {
    // Both round to the same double, so a Number comparison says equal.
    expect(check("big", "gte", "18446744073709551615")).toBe(true);
    expect(check("big", "lte", "18446744073709551615")).toBe(false);
    expect(compareNumeric("18446744073709551617", "18446744073709551616")).toBe(1);
    expect(compareNumeric("1.5", 1)).toBe(1);
    expect(compareNumeric("abc", 1)).toBe(null);
  });
  it("approx uses a relative tolerance", () => {
    expect(check("count", "approx", 8.05, { tolerance: 0.01 })).toBe(true);
    expect(check("count", "approx", 9, { tolerance: 0.01 })).toBe(false);
    expect(check("big", "approx", "1.8446744e19", { tolerance: 0.001 })).toBe(true);
  });
  it("exists and absent treat null and an empty collection as nothing", () => {
    expect(check("label", "exists")).toBe(true);
    expect(check("nothing", "exists")).toBe(false);
    expect(check("nothing", "absent")).toBe(true);
    expect(check("nope", "absent")).toBe(true);
    expect(check("empty[*].x", "exists")).toBe(false);
    expect(check("bridge_exits.by_bridge[*].bridge", "exists")).toBe(true);
  });
  it("count_gte and count_lte count collected values or an array", () => {
    expect(check("bridge_exits.by_bridge[*].destinations[*]", "count_gte", 3)).toBe(true);
    expect(check("bridge_exits.by_bridge[*].destinations[*]", "count_lte", 2)).toBe(false);
    expect(check("hops", "count_lte", 2)).toBe(true);
    expect(check("empty", "count_lte", 0)).toBe(true);
    expect(check("label", "count_gte", 1)).toBe(false);
  });
  it("fails every op but absent on a path that does not resolve", () => {
    for (const [op, value] of [
      ["equals", null],
      ["excludes", "x"],
      ["count_lte", 5],
      ["contains", "x"],
    ] as const) {
      expect(evaluate({ path: "nope", op, value }, at("nope"))).toEqual({ ok: false, got: "path not found" });
    }
  });
  it("refuses a single-value op on a [*] path", () => {
    expect(check("hops[*].digest", "gte", 1)).toBe(false);
  });
});

describe("validateCase", () => {
  const tools = new Map<string, unknown>([
    ["trace_funds", { properties: { digest: {}, direction: {}, network: {} }, required: ["digest"] }],
    ["get_balance", null],
  ]);
  const good = () => ({
    slug: "demo-2025",
    kind: "laundering",
    title: "Demo",
    network: "mainnet",
    summary: "What happened.",
    sources: [{ url: "https://example.org/report", publisher: "Example Labs", kind: "security-firm" }],
    subjects: { tx: "abc" },
    checks: [
      {
        id: "first",
        question: "Where did it go?",
        tool: "trace_funds",
        args: { digest: "{tx}" },
        expect: [
          { path: "hops[*].digest", op: "includes", value: "{tx}" },
          { path: "usd", op: "approx", value: 10, tolerance: 0.1 },
          { path: "stop_reason", op: "exists" },
        ],
        tier: "chain-derived",
        basis: "Example Labs names the destination.",
      },
    ],
  });
  type Node = Record<string | number, unknown>;
  /** The good case with the value at `path` replaced; `undefined` deletes it. */
  const errorsWith = (path: (string | number)[], value: unknown, file = "demo-2025.json") => {
    const c: Node = good();
    let node = c;
    for (const k of path.slice(0, -1)) node = node[k] as Node;
    const last = path[path.length - 1];
    if (value === undefined) delete node[last];
    else node[last] = value;
    return validateCase(c, { tools, file });
  };

  it("accepts a case that follows the contract", () => {
    expect(validateCase(good(), { tools, file: "demo-2025.json" })).toEqual([]);
  });
  it("names the file after the slug", () => {
    expect(validateCase(good(), { tools, file: "case.json" })).toEqual(["slug: file is case.json; it must be demo-2025.json"]);
  });
  it.each([
    ["unknown tool", ["checks", 0, "tool"], "trace_fund", 'checks[0] (first).tool: unknown tool "trace_fund"'],
    ["unknown op", ["checks", 0, "expect", 0, "op"], "include", "checks[0] (first).expect[0].op: unknown op"],
    ["missing subject in args", ["checks", 0, "args", "digest"], "{exploit}", "checks[0] (first).args: {exploit} is not in subjects"],
    ["missing subject in a value", ["checks", 0, "expect", 0, "value"], "{victim}", "checks[0] (first).expect[0].value: {victim} is not in subjects"],
    ["basis naming no source", ["checks", 0, "basis"], "Seen in a tweet.", "checks[0] (first).basis: names no source"],
    ["no sources", ["sources"], [], "sources: at least one published source is required"],
    ["unknown argument", ["checks", 0, "args", "hops2"], 3, 'checks[0] (first).args: trace_funds has no argument "hops2"'],
    ["missing required argument", ["checks", 0, "args"], {}, 'checks[0] (first).args: trace_funds requires "digest"'],
    ["approx without tolerance", ["checks", 0, "expect", 1, "tolerance"], undefined, "checks[0] (first).expect[1].tolerance: approx needs"],
    ["value on exists", ["checks", 0, "expect", 2, "value"], 1, "checks[0] (first).expect[2].value: exists takes no value"],
    ["bad path", ["checks", 0, "expect", 0, "path"], "hops[*", "checks[0] (first).expect[0].path: bad path segment"],
    ["bad regex", ["checks", 0, "expect", 0], { path: "a", op: "matches", value: "(" }, "checks[0] (first).expect[0].value: bad regex"],
    ["unknown key", ["checks", 0, "notes"], "x", 'checks[0] (first): unknown key "notes"'],
    ["unknown tier", ["checks", 0, "tier"], "post-mortem", 'checks[0] (first).tier: "post-mortem" is not one of'],
    ["unknown kind", ["kind"], "hack", 'kind: "hack" is not one of'],
    ["duplicate id", ["checks", 1], good().checks[0], "checks[1] (first).id: duplicate id"],
    ["blank known_defect", ["checks", 0, "known_defect"], " ", "checks[0] (first).known_defect"],
    ["critical other than true", ["checks", 0, "critical"], "yes", "checks[0] (first).critical"],
    ["critical known defect", ["checks", 0], { ...good().checks[0], critical: true, known_defect: "wrong total" }, "checks[0] (first).critical"],
  ] as const)("reports %s", (_what, path, value, message) => {
    const errors = errorsWith([...path], value);
    expect(errors.some((e) => e.startsWith(message)), errors.join("\n")).toBe(true);
  });
  it("accepts a basis that names the chain", () => {
    expect(errorsWith(["checks", 0, "basis"], "Read on chain.")).toEqual([]);
  });
  it("accepts a critical check", () => {
    expect(errorsWith(["checks", 0, "critical"], true)).toEqual([]);
  });
  it("skips argument checks for a tool without a schema", () => {
    expect(errorsWith(["checks", 0], { ...good().checks[0], tool: "get_balance", args: { anything: 1 } })).toEqual([]);
  });
});
