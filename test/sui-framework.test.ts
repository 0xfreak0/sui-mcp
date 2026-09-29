/**
 * Every Sui framework claim the rules make, checked against the framework's
 * own Move source pinned under `test/fixtures/sui-framework`
 * (`npm run sync:framework`). The expected values come from that source, not
 * from our reading of it.
 *
 * `SUI_FRAMEWORK_SOURCES=<dir>` points the test at another copy of the
 * `sources/` tree, to try a framework version before vendoring it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isCallable, parseMoveModule, type MoveFunction, type MoveModule, type MoveStruct } from "./helpers/move-source.js";
import { CAPABILITY_STRUCTS } from "../scripts/lib/sui-framework-files.mjs";
import type { FrameworkClaim, FunctionClaim, StructClaim, TakenBy } from "../src/utils/framework-claims.js";
import {
  CAPABILITY_USES,
  HIGH_CONSEQUENCE_TYPES,
  OBJECT_FLOW_CLAIMS,
  readObjectMovements,
  type GqlObjectChange,
} from "../src/utils/object-flow.js";
import {
  MINT_DISCOVERY_CLAIMS,
  SUPPLY_CLAIMS,
  UPGRADE_POLICY_CLAIMS,
  classifyCapType,
  classifyCapabilityRisk,
} from "../src/utils/capabilities.js";
import { REGISTRY_LAYOUT_CLAIMS } from "../src/utils/onchain-coin-registry.js";
import { DENY_LIST_LAYOUT_CLAIMS } from "../src/utils/deny-list.js";
import { ADDRESS_BALANCE_CLAIMS } from "../src/utils/address-balance.js";
import { ALIAS_CLAIMS } from "../src/utils/identity.js";
import { DENY_LIST_ID_CLAIMS } from "../src/utils/deny-list-probe.js";
import { FRAMEWORK_TRANSFER_RECIPIENT_ARG } from "../src/utils/ptb-anomalies.js";

const SOURCES =
  process.env.SUI_FRAMEWORK_SOURCES ?? join(dirname(fileURLToPath(import.meta.url)), "fixtures/sui-framework/sources");

function moveFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return moveFiles(p);
    return f.endsWith(".move") ? [p] : [];
  });
}

const modules: MoveModule[] = moveFiles(SOURCES).map((f) => parseMoveModule(readFileSync(f, "utf8")));
const functions = new Map<string, MoveFunction>();
const structs = new Map<string, MoveStruct>();
const constants = new Map<string, string>();
for (const m of modules) {
  for (const f of m.functions) if (!f.testOnly) functions.set(`${m.name}::${f.name}`, f);
  for (const s of m.structs) if (!s.testOnly) structs.set(`${m.name}::${s.name}`, s);
  for (const c of m.constants) constants.set(`${m.name}::${c.name}`, c.value);
}

/** `module::Name` of a full `0x…::module::Name` type. */
const short = (type: string) => type.split("::").slice(1).join("::");
const sorted = (xs: string[]) => [...xs].sort();
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** What is wrong with a claim against the source; empty when it holds. */
function problems(claim: FrameworkClaim): string[] {
  if ("constant" in claim) {
    const value = constants.get(claim.constant);
    if (value === undefined) return ["no such constant"];
    if (claim.address && !(/^@0x[0-9a-f]+$/i.test(value) && BigInt(value.slice(1)) === BigInt(claim.address))) {
      return [`holds ${value}, claimed @${claim.address}`];
    }
    if (claim.value !== undefined && value !== claim.value) return [`holds ${value}, claimed ${claim.value}`];
    return [];
  }
  if ("struct" in claim) return structProblems(claim);
  return functionProblems(claim);
}

function structProblems(claim: StructClaim): string[] {
  const s = structs.get(claim.struct);
  if (!s) return ["no such struct or enum"];
  const out: string[] = [];
  if (claim.abilities && sorted(s.abilities).join() !== sorted(claim.abilities).join()) {
    out.push(`has abilities {${s.abilities.join(", ")}}, claimed {${claim.abilities.join(", ")}}`);
  }
  if (claim.fields && s.fields.join() !== claim.fields.join()) {
    out.push(`has fields [${s.fields.join(", ")}], claimed [${claim.fields.join(", ")}]`);
  }
  return out;
}

function functionProblems(claim: FunctionClaim): string[] {
  const f = functions.get(claim.fn);
  if (!f) return ["no such function"];
  const out: string[] = [];
  if (claim.visibility && f.visibility !== claim.visibility) out.push(`is ${f.visibility}, claimed ${claim.visibility}`);
  if (claim.entry !== undefined && f.entry !== claim.entry) out.push(f.entry ? "is entry" : "is not entry");
  for (const [type, mode] of Object.entries(claim.takes ?? {})) {
    const ps = f.params.filter((p) => p.base === type);
    if (!ps.length) out.push(`has no ${type} parameter`);
    for (const p of ps) if (p.takes !== mode) out.push(`takes ${type} ${modeText(p.takes)}, claimed ${modeText(mode)}`);
  }
  for (const [i, type] of Object.entries(claim.paramAt ?? {})) {
    const p = f.params[Number(i)];
    if (p?.base !== type) out.push(`parameter ${i} is ${p ? p.base : "absent"}, claimed ${type}`);
  }
  for (const [name, constraints] of Object.entries(claim.typeParams ?? {})) {
    const tp = f.typeParams.find((t) => t.name === name);
    if (!tp) out.push(`has no type parameter ${name}`);
    else if (sorted(tp.constraints).join() !== sorted(constraints).join()) {
      out.push(`constrains ${name} by {${tp.constraints.join(" + ")}}, claimed {${constraints.join(" + ")}}`);
    }
  }
  for (const name of claim.calls ?? []) {
    if (!f.body || !new RegExp(`\\b${name}\\s*(?:<[^()]*>)?\\s*\\(`).test(f.body)) out.push(`does not call ${name}`);
  }
  if (claim.doc && !squash(f.doc).includes(squash(claim.doc))) out.push(`doc does not say "${claim.doc}"`);
  return out;
}

function modeText(mode: TakenBy): string {
  return mode === "value" ? "by value" : `by ${mode}`;
}

/** Callable functions taking `type` (`module::Name`) by reference, with how. */
function referenceUses(type: string): Map<string, TakenBy> {
  const out = new Map<string, TakenBy>();
  for (const [name, f] of functions) {
    if (!isCallable(f)) continue;
    const p = f.params.find((q) => q.base === type && q.takes !== "value");
    if (p) out.set(name, p.takes);
  }
  return out;
}

const capabilityClaims: FrameworkClaim[] = Object.entries(CAPABILITY_USES).flatMap(([type, uses]) =>
  uses.grants.flatMap((g) =>
    g.fns.map((fn) => ({ fn, takes: { [short(type)]: g.takes }, why: `CAPABILITY_USES: ${g.opens}` })),
  ),
);
const payoutClaims: FunctionClaim[] = Object.entries(FRAMEWORK_TRANSFER_RECIPIENT_ARG).map(([fn, i]) => ({
  fn,
  paramAt: { [i]: "address" },
  why: "ptb-anomalies reads the payout recipient at this argument",
}));

const CLAIM_SETS: Record<string, FrameworkClaim[]> = {
  "object-flow CAPABILITY_USES": capabilityClaims,
  "object-flow OBJECT_FLOW_CLAIMS": OBJECT_FLOW_CLAIMS,
  "capabilities SUPPLY_CLAIMS": SUPPLY_CLAIMS,
  "capabilities MINT_DISCOVERY_CLAIMS": MINT_DISCOVERY_CLAIMS,
  "capabilities UPGRADE_POLICY_CLAIMS": UPGRADE_POLICY_CLAIMS,
  "onchain-coin-registry REGISTRY_LAYOUT_CLAIMS": REGISTRY_LAYOUT_CLAIMS,
  "deny-list DENY_LIST_LAYOUT_CLAIMS": DENY_LIST_LAYOUT_CLAIMS,
  "deny-list-probe DENY_LIST_ID_CLAIMS": DENY_LIST_ID_CLAIMS,
  "address-balance ADDRESS_BALANCE_CLAIMS": ADDRESS_BALANCE_CLAIMS,
  "identity ALIAS_CLAIMS": ALIAS_CLAIMS,
  "ptb-anomalies FRAMEWORK_TRANSFER_RECIPIENT_ARG": payoutClaims,
};

/** Every high-consequence type with its CAPABILITY_USES entry, an empty one when it has none. */
const highConsequenceUses = Object.keys(HIGH_CONSEQUENCE_TYPES).map(
  (type) => [type, CAPABILITY_USES[type] ?? { grants: [], covered: {}, inert: {} }] as const,
);

const label = (c: FrameworkClaim) => ("constant" in c ? c.constant : "struct" in c ? c.struct : c.fn);

describe("framework claims hold in the pinned source", () => {
  for (const [set, claims] of Object.entries(CLAIM_SETS)) {
    it.each(claims.map((c) => [label(c), c] as const))(`${set}: %s`, (name, claim) => {
      const wrong = problems(claim);
      expect(wrong, `${name}: ${wrong.join("; ")} (rule: ${claim.why})`).toEqual([]);
    });
  }

  it.each(payoutClaims.map((c) => c.fn))("ptb-anomalies FRAMEWORK_TRANSFER_RECIPIENT_ARG: %s is callable from a transaction", (fn) => {
    const f = functions.get(fn);
    expect(f && isCallable(f), `${fn} is not public or entry`).toBe(true);
  });
});

describe("CAPABILITY_USES accounts for every callable function taking a capability by reference", () => {
  it("covers exactly the high-consequence types, and the sync script vendors every module naming them", () => {
    const uncovered = Object.keys(HIGH_CONSEQUENCE_TYPES).filter((t) => !(t in CAPABILITY_USES)).map(short);
    expect(uncovered, `high-consequence types CAPABILITY_USES does not cover: ${uncovered.join(", ")}`).toEqual([]);
    const extra = Object.keys(CAPABILITY_USES).filter((t) => !(t in HIGH_CONSEQUENCE_TYPES)).map(short);
    expect(extra, `CAPABILITY_USES types that are not high-consequence: ${extra.join(", ")}`).toEqual([]);
    for (const type of Object.keys(CAPABILITY_USES)) expect(CAPABILITY_STRUCTS).toContain(type.split("::").pop());
  });

  for (const [type, uses] of highConsequenceUses) {
    it(short(type), () => {
      const found = referenceUses(short(type));
      const listed = new Set([...uses.grants.flatMap((g) => g.fns), ...Object.keys(uses.covered), ...Object.keys(uses.inert)]);
      const unlisted = [...found].filter(([fn]) => !listed.has(fn)).map(([fn, mode]) => `${fn} (${mode})`);
      expect(unlisted, `callable functions taking ${short(type)} by reference that CAPABILITY_USES neither grants, covers nor marks inert: ${unlisted.join(", ")}`).toEqual([]);
      const stale = [...listed].filter((fn) => !found.has(fn));
      expect(stale, `listed in CAPABILITY_USES for ${short(type)}, but not a callable function taking it by reference: ${stale.join(", ")}`).toEqual([]);
    });
  }
});

describe("the capability rules agree with what the framework lets any transaction do", () => {
  const A = `0xaa${"1".repeat(62)}`;
  const state = (type: string, owner: unknown) => ({ asMoveObject: { contents: { type: { repr: type } } }, owner: owner as never });
  const frozen = (type: string): GqlObjectChange => ({
    address: "0xcap",
    idCreated: false,
    idDeleted: false,
    inputState: state(type, { __typename: "AddressOwner", address: { address: A } }),
    outputState: state(type, { __typename: "Immutable" }),
  });
  // public_share_object only shares an object the transaction created.
  const shared = (type: string): GqlObjectChange => ({ address: "0xcap", idCreated: true, idDeleted: false, outputState: state(type, { __typename: "Shared" }) });

  for (const [type, uses] of highConsequenceUses) {
    const struct = structs.get(short(type));
    const instance = struct?.typeParams.length ? `${type}<0xa::t::T>` : type;
    const found = [...referenceUses(short(type))].filter(([fn]) => !(fn in uses.inert));
    const byRef = found.filter(([, mode]) => mode === "&").map(([fn]) => fn);
    const cited = uses.grants.flatMap((g) => g.fns);

    it(`${short(type)} frozen: renounced only when no function taking it by & grants anything`, () => {
      const m = readObjectMovements([frozen(instance)])[0]!;
      if (byRef.length) {
        expect(m.renounced, `a frozen ${short(type)} still passes by & to ${byRef.join(", ")}`).toBeFalsy();
        expect(m.opened).toBe(true);
      } else {
        expect(m.renounced, `no function takes ${short(type)} by & to any effect, so freezing renounces it`).toBe(true);
      }
      for (const fn of cited) expect(m.note, `the note names ${fn}`).toContain(fn.split("::")[1]);
      const kind = classifyCapType(instance);
      if (kind === "upgrade" || kind === "treasury" || kind === "deny") {
        const r = classifyCapabilityRisk({ kind, type: instance, owner: "immutable" });
        expect(r.risk, `capabilities.ts on a frozen ${short(type)}`).toBe(byRef.length ? "medium" : "info");
        for (const fn of cited) expect(r.note, `the note names ${fn}`).toContain(fn.split("::")[1]);
      }
    });

    it(`${short(type)} shared: opened to everyone`, () => {
      expect(found.length, `no callable function takes ${short(type)} by reference to any effect`).toBeGreaterThan(0);
      const m = readObjectMovements([shared(instance)])[0]!;
      expect(m.renounced, `any transaction can pass a shared ${short(type)} to ${found.map(([fn]) => fn).join(", ")}`).toBeFalsy();
      expect(m.opened).toBe(true);
      for (const fn of cited) expect(m.note, `the note names ${fn}`).toContain(fn.split("::")[1]);
      const kind = classifyCapType(instance);
      if (kind === "upgrade" || kind === "treasury" || kind === "deny") {
        const r = classifyCapabilityRisk({ kind, type: instance, owner: "shared" });
        expect(r.risk, `capabilities.ts on a shared ${short(type)}`).toBe("high");
        for (const fn of cited) expect(r.note, `the note names ${fn}`).toContain(fn.split("::")[1]);
      }
    });
  }
});
