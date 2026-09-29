import { normalizeSuiAddress } from "@mysten/sui/utils";
import { guardiansFlagsForPackage } from "../utils/guardians.js";
import { z } from "zod";
import { resolvePublisher } from "../utils/publisher.js";
import { boolArg } from "./args.js";
import { sui } from "../clients/grpc.js";
import { GrpcTypes } from "@mysten/sui/grpc";
import { errorResult, describeError } from "../utils/errors.js";
import { suivisionPackageUrl, getNetwork } from "../config.js";
import {
  formatVisibility,
  formatSignature,
  abilityName,
  formatDatatypeFields,
} from "./packages.js";
import {
  resolvePackageId,
  fetchAllModuleDisassembly,
  fetchPackageLatestVersion,
  fetchPackageLinkage,
} from "../utils/move-package.js";
import { annotateDisassembly } from "../utils/disassembly.js";
import { analyzeCodeGuards, type CodeLead, type LeadGrade, type UngatedVersionLead } from "../utils/code-guards.js";
import { scanVersionGates, type VersionGateScan } from "../utils/version-gates.js";
import { auditPackageCapabilities } from "../utils/capabilities.js";
import { computeOwnerChanges } from "../utils/object-history.js";
import { fetchCapHistory } from "./upgrade-history.js";
import { groupCapabilities, selectModules, summarizeModule } from "../utils/package-summary.js";
import { capPayload, type ListCap } from "../utils/output-cap.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Normalized shapes — the heuristics operate purely on these (no gRPC types),
// so they're trivially unit-testable and decoupled from the transport layer.
// ---------------------------------------------------------------------------

export interface AnalyzedFunction {
  name: string;
  visibility: string; // "public" | "private" | "public(friend)" | "unknown"
  isEntry: boolean;
  params: string[]; // formatted, fully-qualified type strings
  returns: string[];
}

export interface AnalyzedStruct {
  name: string;
  abilities: string[]; // "key" | "store" | "copy" | "drop"
  fields: { name: string; type: string }[];
}

export interface AnalyzedModule {
  name: string;
  functions: AnalyzedFunction[];
  structs: AnalyzedStruct[];
}

export interface Finding {
  severity: "high" | "medium" | "info";
  code: string;
  title: string;
  detail: string;
  evidence: string[];
  /** Bytecode leads: the function, a grade and the instructions behind it. */
  leads?: CodeLead[];
  /** Leads across the lineage's versions: older versions and the functions in them. */
  version_leads?: VersionLeadView[];
  /** Leads found before the list was cut to its cap. */
  lead_count?: number;
}

/** An {@link UngatedVersionLead} as listed: its functions cut to the first few unless `full`, and counted. */
export type VersionLeadView = UngatedVersionLead & {
  function_count: number;
  /** The analysed version is one of `versions`. */
  this_version?: true;
};

const isPublic = (f: AnalyzedFunction) =>
  f.isEntry || f.visibility === "public" || f.visibility === "public(friend)";

/**
 * Heuristic surface scan over a package's normalized modules.
 *
 * This is deliberately a fast "what does this do / what should I look at"
 * pass, NOT a security audit. It flags patterns that are cheaply and reliably
 * identifiable from structure alone (capabilities, freeze/mint authority, fund
 * handling), and says nothing about whether their *use* is safe.
 */
export function analyzePackageModules(modules: AnalyzedModule[]): Finding[] {
  const findings: Finding[] = [];

  const allFns = modules.flatMap((m) =>
    m.functions.map((f) => ({ ...f, qualified: `${m.name}::${f.name}` })),
  );
  const allStructs = modules.flatMap((m) =>
    m.structs.map((s) => ({ ...s, qualified: `${m.name}::${s.name}` })),
  );

  const paramTypesOf = (f: AnalyzedFunction) => f.params.join(" ");
  const anyParamMatches = (needle: RegExp) =>
    allFns.filter((f) => needle.test(paramTypesOf(f)));

  // --- Freeze / denylist authority (regulated coin) --------------------------
  const denyStructs = allStructs.filter((s) => /DenyCap/i.test(s.name));
  const denyFns = allFns.filter(
    (f) => /deny/i.test(f.name) || /deny_list::DenyList|coin::DenyCap/.test(paramTypesOf(f)),
  );
  if (denyStructs.length > 0 || denyFns.length > 0) {
    findings.push({
      severity: "high",
      code: "freeze-authority",
      title: "Freeze / denylist authority present",
      detail:
        "The package exposes a coin denylist / DenyCap surface. A privileged holder can block specific addresses from transacting the asset (regulated-coin pattern).",
      evidence: [
        ...denyStructs.map((s) => `struct ${s.qualified}`),
        ...denyFns.map((f) => `fn ${f.qualified}`),
      ].slice(0, 12),
    });
  }

  // --- Mint authority --------------------------------------------------------
  const treasuryFns = anyParamMatches(/coin::TreasuryCap/);
  const mintFns = allFns.filter((f) => isPublic(f) && /(^|_)mint($|_)/i.test(f.name));
  if (treasuryFns.length > 0 || mintFns.length > 0) {
    findings.push({
      severity: "medium",
      code: "mint-authority",
      title: "Mint authority — supply can be increased",
      detail:
        "A privileged holder (TreasuryCap or a public mint entry) can increase supply. Confirm the cap's custody and whether minting is capped.",
      evidence: [
        ...mintFns.map((f) => `fn ${f.qualified}`),
        ...treasuryFns.map((f) => `fn ${f.qualified} (takes TreasuryCap)`),
      ].slice(0, 12),
    });
  }

  // --- Privileged capability types (centralized control) ---------------------
  const stdCaps = /^(TreasuryCap|DenyCap|DenyCapV2|UpgradeCap|CoinMetadata)$/;
  const capStructs = allStructs.filter(
    (s) => !stdCaps.test(s.name) && (/Cap$/.test(s.name) || /(Admin|Owner)/i.test(s.name)),
  );
  if (capStructs.length > 0) {
    findings.push({
      severity: "medium",
      code: "privileged-capability",
      title: "Privileged capability types — centralized control",
      detail:
        "The package defines admin/owner capability objects. Holders can invoke gated functions. Who holds them determines how centralized the package is.",
      evidence: capStructs.map((s) => `struct ${s.qualified}`).slice(0, 12),
    });
  }

  // --- Fund handling in the public API --------------------------------------
  const fundFns = allFns.filter(
    (f) => isPublic(f) && /coin::Coin|balance::Balance|::sui::SUI\b/.test(paramTypesOf(f)),
  );
  if (fundFns.length > 0) {
    findings.push({
      severity: "info",
      code: "handles-funds",
      title: "Public API moves coins / balances",
      detail:
        "Public or entry functions accept Coin/Balance/SUI. This is normal for DeFi/marketplace code, but is where fund-safety review should focus.",
      evidence: fundFns.map((f) => `fn ${f.qualified}`).slice(0, 12),
    });
  }

  // --- On-chain randomness ---------------------------------------------------
  const randomFns = anyParamMatches(/random::Random/);
  if (randomFns.length > 0) {
    findings.push({
      severity: "info",
      code: "uses-randomness",
      title: "Uses on-chain randomness",
      detail:
        "Functions consume 0x2::random::Random. Check for test-and-abort patterns that could let callers retry unfavorable outcomes.",
      evidence: randomFns.map((f) => `fn ${f.qualified}`).slice(0, 12),
    });
  }

  // --- Hot-potato types ------------------------------------------------------
  const hotPotatoes = allStructs.filter((s) => s.abilities.length === 0);
  if (hotPotatoes.length > 0) {
    findings.push({
      severity: "info",
      code: "hot-potato",
      title: "Hot-potato types (no abilities)",
      detail:
        "Structs with no abilities must be consumed in the same transaction — a must-use enforcement pattern (e.g. flash loans, receipts).",
      evidence: hotPotatoes.map((s) => `struct ${s.qualified}`).slice(0, 12),
    });
  }

  // --- No public entry surface ----------------------------------------------
  if (allFns.length > 0 && !allFns.some(isPublic)) {
    // A one-time-witness struct is exactly the upper-cased module name with
    // only the `drop` ability, which is what `init` consumes to create a
    // currency. A package with one of these and no public functions is the
    // ordinary shape of a bare coin template: mint/transfer happen through
    // the TreasuryCap the capability audit already reports rather than
    // through a public API, so "library other packages call" names the wrong
    // reason for the absence.
    const witnessStructs = modules.flatMap((m) =>
      m.structs
        .filter((s) => s.name === m.name.toUpperCase() && s.abilities.length === 1 && s.abilities[0] === "drop")
        .map((s) => `struct ${m.name}::${s.name}`),
    );
    const isCoinTemplate = witnessStructs.length > 0;
    findings.push({
      severity: "info",
      code: "no-public-api",
      title: isCoinTemplate ? "No public entry points (bare coin-currency template)" : "No public entry points",
      detail: isCoinTemplate
        ? "No public or entry functions, and the package defines a one-time-witness struct matching its module name — the ordinary shape of a bare coin-currency package, where init mints the TreasuryCap/CoinMetadata and nothing else. This is normal for a token launch, not evidence the package is a library; see the capability audit for who actually holds the TreasuryCap."
        : "No public or entry functions — this reads as a library/internal package that other packages call, not one users transact with directly.",
      evidence: witnessStructs,
    });
  }

  return findings;
}

/**
 * Leads a bytecode finding lists by default, strongest first; `lead_count`
 * counts them all and `detail: 'full'` lists them all. A finding is raised
 * only by a strong or medium lead, and weak leads fill the list after them.
 */
const MAX_LEADS = 8;

/** Characters the default response gives to weak leads no finding lists. */
const WEAK_LEADS_BUDGET = 3_000;

const BYTECODE_RULES = [
  {
    key: "discarded_checks",
    code: "discarded-check",
    title: "Check result reaches no use",
    detail:
      "A comparison, or the bool of a call that only reads and cannot abort in this package (whatever its name), reaches no branch, abort, return, store or argument that is used, so the code after it runs whatever it says. Strong when the check read the sender or an object parameter; medium when it read only value parameters.",
  },
  {
    key: "sibling_guard_gaps",
    code: "sibling-guard-gap",
    title: "Public function skips a check its siblings make",
    detail:
      "Most public functions of the module that mutate objects of one package type make a check (a call that only reads, returns nothing and can abort, here or in the package's own callees); the listed function mutates the same type and never makes it. Functions that write a field the check reads, that lack an object a relating check reads, or that make another check over most of the same fields are left out. Strong when the check relates that object to another parameter (an ID or ownership binding) and at least three quarters of the siblings make it, medium when two thirds do. A skipped check of one object's own state (a version or pause check) is often deliberate and stays weak, as does a bare majority or a function that takes an owned object of the package that may gate it.",
  },
  {
    key: "unchecked_state_writes",
    code: "unchecked-state-write",
    title: "Caller value written to a shared object unchecked",
    detail:
      "A public function writes a value computed from a plain-value or copyable parameter into a field of an object the package shares, here or in the package functions it calls, and no comparison on the path links that value to stored state (directly, or through another value it was compared with), branches on the sender, or takes an owned object or witness of the package. A figure computed from the value and stored state together and compared with a constant bounds neither. Strong when no branch reads the value; medium when branches compare it only with constants or other arguments; weak when the function takes a non-copyable struct from another package, or returns one the caller must hand on, either of which may gate it.",
  },
] as const;

/** A weak lead listed apart from the findings, with the check that made it. */
export type WeakLead = CodeLead & { check: string };

export interface BytecodeScan {
  checks: string[];
  /** Leads per check and grade. A check with only weak leads raises no finding. */
  leads: Record<string, Record<LeadGrade, number>>;
  /** Every weak lead no finding lists, strongest check first. */
  weak_leads?: WeakLead[];
  functions_analyzed: number;
  /** Functions whose stack could not be fully modelled, so their leads may be missing: a count and the first names. */
  functions_partial?: { count: number; names: string[] };
  /** How to read a lead, and a weak one in particular. */
  read: string;
  note: string;
}

/**
 * Findings that need the bytecode rather than the signatures: the guard
 * data flow of {@link analyzeCodeGuards} over every module's disassembly.
 * Each finding lists leads, strongest first, and says how many there were;
 * `full` lists every lead. A weak lead no finding lists goes to
 * `weak_leads`, so every lead counted in `leads` is listed somewhere.
 */
export function bytecodeFindings(
  disassembly: Map<string, string>,
  options: { full?: boolean } = {},
): { findings: Finding[]; scan: BytecodeScan } {
  const report = analyzeCodeGuards(disassembly);
  const findings: Finding[] = [];
  const counts: Record<string, Record<LeadGrade, number>> = {};
  const weak: WeakLead[] = [];
  for (const rule of BYTECODE_RULES) {
    const leads = report[rule.key];
    counts[rule.code] = { strong: 0, medium: 0, weak: 0 };
    for (const l of leads) counts[rule.code][l.grade]++;
    const raised = leads.some((l) => l.grade !== "weak");
    const listed = raised ? (options.full ? leads : leads.slice(0, MAX_LEADS)) : [];
    for (const l of leads.slice(listed.length)) if (l.grade === "weak") weak.push({ check: rule.code, ...l });
    if (!raised) continue;
    findings.push({
      severity: leads.some((l) => l.grade === "strong") ? "medium" : "info",
      code: rule.code,
      title: rule.title,
      detail: `${rule.detail} Each lead is code to read with disassemble_module function_name, not a finding on its own.`,
      evidence: listed.slice(0, MAX_LEADS).map((l) => `fn ${l.function} (${l.grade})`),
      leads: listed,
      lead_count: leads.length,
    });
  }
  const partial = report.functions_partial;
  return {
    findings,
    scan: {
      checks: BYTECODE_RULES.map((r) => r.code),
      leads: counts,
      ...(weak.length ? { weak_leads: weak } : {}),
      functions_analyzed: report.functions_analyzed,
      ...(partial.length ? { functions_partial: { count: partial.length, names: partial.slice(0, MAX_LEADS) } } : {}),
      read: "Each lead names a function and the instructions behind it, `module::function: offset: instruction`; read them with disassemble_module function_name. A weak lead is a shape that is often deliberate: a skipped check of one object's own state (a version or pause check), a check only a bare majority of the siblings make, or a function that takes an owned object of the package or a non-copyable struct of another package, either of which may gate it. Weak leads raise no finding; confirm what gates the call before reading one as a flaw. A skipped version check matters when an older version of the package, which stays callable, still mutates the same shared objects.",
      note: "These checks follow data flow for three shapes only. A function with no lead has not been cleared: arithmetic, pricing, ordering and logic errors, and checks made in other packages, are outside them.",
    },
  };
}

/** Functions a version lead lists by default; `function_count` counts them all. */
const MAX_VERSION_LEAD_FUNCTIONS = 6;

/**
 * Older versions that still mutate the lineage's shared objects without a
 * check the newest version makes: a finding when a lead is strong or
 * medium, and weak leads as rows for `bytecode_scan.weak_leads`.
 * `versionId` marks the leads that cover the analysed version; `full` lists
 * every function of each lead.
 */
export function versionGateFinding(scan: VersionGateScan, versionId: string, full: boolean): { finding: Finding | null; weak: WeakLead[] } {
  const span = (vs: number[]) => (vs.length > 1 ? `versions ${vs[0]} to ${vs[vs.length - 1]}` : `version ${vs[0]}`);
  const raised = scan.leads.filter((l) => l.grade !== "weak");
  const weak: WeakLead[] = scan.leads
    .filter((l) => l.grade === "weak")
    .map((l) => ({
      check: "ungated-older-version",
      function: l.functions[0].function,
      grade: "weak",
      note: `In ${span(l.versions)} (${l.package_ids.join(", ")}), ${l.functions.map((f) => f.function).join(", ")} mutate${l.functions.length === 1 ? "s" : ""} the shared ${l.type} without ${l.gate}, which ${l.newest.gated} of the ${l.newest.mutators} public functions that mutate a ${l.type} make in version ${l.newest.version}. Each returns a request the caller must hand on, whose consumer may authorise the change.`,
      instructions: l.instructions,
    }));
  if (!raised.length) return { finding: null, weak };
  const views: VersionLeadView[] = raised.map((l) => ({
    ...l,
    functions: full ? l.functions : l.functions.slice(0, MAX_VERSION_LEAD_FUNCTIONS),
    function_count: l.functions.length,
    ...(l.package_ids.includes(versionId) ? { this_version: true as const } : {}),
  }));
  return {
    finding: {
      severity: raised.some((l) => l.grade === "strong") ? "medium" : "info",
      code: "ungated-older-version",
      title: "Older version mutates shared objects without a check the newest version makes",
      detail:
        "Every version of a package stays callable, and its types are the lineage's types, so an older version's public functions run against the same shared objects the newest version manages. In the newest version, most public functions that mutate a shared type make one check that reads a shared object (a version or pause check, a binding); each lead is a run of older versions whose public functions mutate that type without the check and without reading any stored field it reads, so a version bump or flag newer code sets cannot stop them. Functions that compare the sender with something or take an owned object of the package are left out, as are functions whose namesake in the newest version skips the check too. Strong when the newest version's function of the same name makes the check; medium when the newest version dropped that function; weak, and listed in bytecode_scan.weak_leads, when every such function returns a request the caller must hand on. Each lead lists its first six functions by default and counts them in function_count; detail: 'full' lists every one. Read the older function with disassemble_module (its package id is in package_ids, same order as versions) and function_name; the lead says the path exists, not that it breaks an invariant.",
      evidence: raised.map((l) => `${span(l.versions)}: ${l.functions.length} public function(s) mutate ${l.type} without ${l.gate} (${l.grade})`),
      version_leads: views,
      lead_count: raised.length,
    },
    weak,
  };
}

// ---------------------------------------------------------------------------
// gRPC → normalized adapter
// ---------------------------------------------------------------------------

function normalizeModule(m: GrpcTypes.Module): AnalyzedModule {
  const functions: AnalyzedFunction[] = m.functions.map((f) => ({
    name: f.name ?? "",
    visibility: formatVisibility(f.visibility),
    isEntry: !!f.isEntry,
    params: f.parameters.map(formatSignature),
    returns: f.returns.map(formatSignature),
  }));
  const structs: AnalyzedStruct[] = m.datatypes.map((dt) => ({
    name: dt.name ?? "",
    abilities: dt.abilities.map(abilityName),
    fields: formatDatatypeFields(dt),
  }));
  return { name: m.name ?? "", functions, structs };
}

function publicApi(mod: AnalyzedModule): string[] {
  return mod.functions
    .filter(isPublic)
    .map((f) => {
      const ret = f.returns.length ? ` -> ${f.returns.join(", ")}` : "";
      const kind = f.isEntry ? "entry " : "";
      return `${kind}${f.name}(${f.params.join(", ")})${ret}`;
    });
}

export function registerAnalyzePackageTools(server: McpServer) {
  server.tool(
    "analyze_package",
    "(Developer) Analyze a Sui Move package: summarize what it does (modules, public/entry API, key struct shapes) and run a fast heuristic scan for quickly-identifiable risks (freeze/denylist authority, mint authority, admin capabilities, fund handling, randomness, hot-potato types). From the bytecode it traces data flow through each function and the package's own callees, with no name lists, and returns graded leads (function, the instructions behind it, strong/medium/weak): `discarded-check`, a bool from a comparison or a read-only call that reaches no branch, abort, return or store; `sibling-guard-gap`, a public function that mutates an object of a package type without a check most public functions of its module make on that type (an ID binding, a version or pause check); `unchecked-state-write`, a public function that writes a plain-value argument into a shared object's field with no comparison against stored state, sender check or owned-object gate. It also reads every version of the lineage (up to 30: the oldest and the newest) and raises `ungated-older-version` when an older version's public functions mutate a shared type without a check most of the newest version's public functions on that type make (a version check added later): every version stays callable against the same objects, whichever version you pass. Leads point at code to read, not at a flaw; no lead clears the package. A strong or medium lead raises a finding that lists its first leads; weak leads raise none and are listed in `bytecode_scan.weak_leads` (the first few by default, every one with `detail: 'full'`, which also lists every lead of each finding), and `bytecode_scan.read` says how to read them. Also audits capabilities: who currently holds the UpgradeCap / TreasuryCap / deny caps and what that means for upgrade / mint / rug risk, including authority-named structs minted after publish. A struct type held one-per-protocol-user (DeepBook's TradeCap, a KioskOwnerCap) is reported as a count in `user_held_types` rather than one entry per holder; a struct whose instance scan failed outright (timeout, 429), or whose defining package version could not be read, is named in `incomplete_scans` rather than silently reading as having no live instances. For each coin the package defines whose TreasuryCap the publish transaction did not show at top level, the cap is looked up through the on-chain coin registry and then by type (`found_by`); a coin whose cap is still not found is named in `coins_without_located_mint_authority` with what was checked, and who can mint it is unknown. Reports two publishers: `root_publisher` deployed the package lineage and received the UpgradeCap, so the cap's holder is judged against it; `version_publisher` sent the upgrade that created the version you passed, so it is who pushed that code. `upgrade_cap` counts the UpgradeCap's owner changes and names the latest; get_upgrade_history has the per-version join of publishers, signing schemes and cap holders. Accepts a 0x package ID or an MVR name (@org/app). Set include_disassembly=true to also return per-module bytecode assembly. NOTE: this is a surface scan to guide review, NOT a security audit. `overview.modules` is a per-module summary by default: function and struct counts, entry and public function names. Pass `modules: ['pool']` for those modules' struct shapes (full field names and types) and signatures, or `detail: 'full'` for every module; use that rather than hand-writing GraphQL, whose `structs` connection pages at 20 while `fields` is a plain list with no `nodes`, a shape that is easy to get wrong and silently truncating.",
    {
      package_id: z
        .string()
        .describe("Package ID (0x...) or MVR name (@org/app)"),
      include_disassembly: boolArg()
        .optional()
        .describe("Include GraphQL disassembly for each module (default: false)"),
      audit_capabilities: boolArg()
        .optional()
        .describe("Audit who holds the package's UpgradeCap/TreasuryCap/admin caps (default: true)"),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe(
          "'summary' (default): per-module counts and entry/public names, caps of one type folded with every holder listed, and the first leads of each bytecode check. 'full': every module's signatures and struct shapes, every cap separately, and every bytecode lead, weak ones included.",
        ),
      modules: z
        .array(z.string())
        .optional()
        .describe("Module names to return in full (signatures, struct shapes), e.g. ['pool']. Others are left out."),
    },
    async ({ package_id, include_disassembly, audit_capabilities, detail, modules: wantedModules }) => {
      try {
        const packageId = await resolvePackageId(package_id);
        const { response: res } = await sui.movePackageService.getPackage({
          packageId,
        });
        const pkg = res.package;
        if (!pkg) return errorResult(`Package not found: ${packageId}`);

        const modules = pkg.modules.map(normalizeModule);
        const findings = analyzePackageModules(modules);
        const flaggedBy = guardiansFlagsForPackage(pkg.storageId ?? packageId);

        const full = detail === "full";
        const fullModule = (m: AnalyzedModule) => ({
          name: m.name,
          public_api: publicApi(m),
          struct_count: m.structs.length,
          structs: m.structs.map((s) => ({
            name: s.name,
            abilities: s.abilities,
            fields: s.fields,
          })),
        });
        const picked = selectModules(modules, wantedModules);
        const overview = {
          package_id: pkg.storageId ?? packageId,
          module_count: modules.length,
          ...(wantedModules?.length
            ? {
                module_names: modules.map((m) => m.name),
                modules: picked.selected.map(fullModule),
                ...(picked.missing.length ? { modules_not_found: picked.missing } : {}),
              }
            : full
              ? { modules: modules.map(fullModule) }
              : {
                  modules: modules.map(summarizeModule),
                  note: "Per-module summary. Pass modules: [name, …] for those modules' signatures and struct shapes, or detail: 'full' for every module.",
                }),
        };

        // Two publishers, answering different questions. The lineage ROOT's
        // publisher deployed the package and received its UpgradeCap, so the
        // cap's holder is judged against that address. This version's
        // publisher is whoever held the cap when this code was pushed, which
        // is the answer to "who shipped this version". They differ whenever
        // the cap moved between deploy and upgrade.
        const versionId = pkg.storageId ?? packageId;
        const rootId = pkg.originalId ?? versionId;
        const [rootPublisher, versionPublisher, latestVersion, bytecode] = await Promise.all([
          resolvePublisher(rootId),
          rootId === versionId ? null : resolvePublisher(versionId),
          fetchPackageLatestVersion(versionId).catch(() => null),
          fetchAllModuleDisassembly(versionId).then(
            (texts) => ({ texts, unavailable: null }),
            (err: unknown) => ({ texts: null, unavailable: err instanceof Error ? err.message : String(err) }),
          ),
        ]);
        const scan = bytecode.texts ? bytecodeFindings(bytecode.texts, { full }) : null;
        if (scan) findings.push(...scan.findings);

        // Capability audit (default on). Best-effort — never breaks the analysis.
        // `modules` lets it also find authority-named caps minted after
        // publish (an OperatorCap handed out post-deploy is invisible to a
        // publish-transaction scan alone). The lineage's other versions are
        // read alongside it, for checks older versions lack.
        const [capabilities, versionGates] = await Promise.all([
          audit_capabilities === false ? undefined : auditPackageCapabilities(packageId, rootPublisher.publisher, modules),
          scanVersionGates(versionId, bytecode.texts ? { package_id: versionId, disassembly: bytecode.texts } : undefined).then(
            (gates) => ({ gates, unavailable: null }),
            (err: unknown) => ({ gates: null, unavailable: err instanceof Error ? err.message : String(err) }),
          ),
        ]);
        const gate = versionGates.gates ? versionGateFinding(versionGates.gates, normalizeSuiAddress(versionId), full) : null;
        if (gate?.finding) findings.push(gate.finding);
        const weakLeads = [...(scan?.scan.weak_leads ?? []), ...(gate?.weak ?? [])];

        // Current custody says nothing about how the cap got there. Its
        // owner-change count and the latest change are one query; the full
        // per-version join is get_upgrade_history's job.
        const capId = capabilities?.capabilities.find((c) => c.kind === "upgrade")?.object_id;
        let upgradeCap: Record<string, unknown> | null = null;
        let upgradeCapUnavailable: string | undefined;
        if (capId) {
          try {
            const h = await fetchCapHistory(capId);
            const changes = computeOwnerChanges(
              h.versions.map((c) => ({
                version: String(c.object_version),
                tx: c.tx,
                timestamp: c.timestamp,
                checkpoint: c.checkpoint === null ? null : String(c.checkpoint),
                owner: c.owner,
              })),
            );
            const last = changes[changes.length - 1];
            upgradeCap = {
              object_id: capId,
              owner_change_count: changes.length,
              last_owner_change: last ? { from: last.from, to: last.to, tx: last.tx, timestamp: last.timestamp } : null,
              history_complete: h.complete && !!rootPublisher.publish_tx && h.versions[0]?.tx === rootPublisher.publish_tx,
              see: { tool: "get_upgrade_history", args: { package: rootId } },
            };
          } catch (err) {
            upgradeCapUnavailable = `The UpgradeCap's history could not be read (${err instanceof Error ? err.message : String(err)}). Its owner-change count is unknown, not zero.`;
          }
        }

        // The linkage only annotates `use` lines; without it they stay plain.
        const linkage = include_disassembly ? await fetchPackageLinkage(versionId).catch(() => undefined) : undefined;
        const disassembly =
          include_disassembly && bytecode.texts
            ? [...bytecode.texts].map(([module, text]) => ({
                module,
                disassembly: annotateDisassembly(text, { linkage, packageId: versionId }),
              }))
            : undefined;

        const payload = {
          disclaimer:
            "Heuristic surface scan to guide review — NOT a security audit. Absence of findings does not imply safety.",
          suivision_url: suivisionPackageUrl(packageId),
          lineage: {
            root_package_id: rootId,
            version: pkg.version !== undefined ? Number(pkg.version) : null,
            latest_version: latestVersion,
          },
          root_publisher: rootPublisher,
          // Absent a later version, the root's publisher shipped this code.
          version_publisher: versionPublisher ?? rootPublisher,
          finding_count: findings.length,
          findings,
          ...(scan
            ? {
                bytecode_scan: {
                  ...scan.scan,
                  ...(weakLeads.length ? { weak_leads: weakLeads } : {}),
                  version_gates: versionGates.gates
                    ? {
                        version_count: versionGates.gates.version_count,
                        versions_compared: versionGates.gates.versions_compared,
                        ...(versionGates.gates.versions_not_compared ? { versions_not_compared: versionGates.gates.versions_not_compared } : {}),
                        ...(versionGates.gates.unreadable ? { unreadable: versionGates.gates.unreadable } : {}),
                        note: "Each older version was compared with the newest for a check most of the newest version's public functions on a shared type make; `ungated-older-version` lists the versions whose public functions on that type skip it. A check written inline (a comparison and a branch to abort) is not compared.",
                      }
                    : versionGates.unavailable
                      ? { unavailable: `The lineage's versions could not be read (${versionGates.unavailable}), so older versions were not compared.` }
                      : { note: "The lineage has one version, or upgrades in place (a framework package), so no older version's code stays callable to compare." },
                },
              }
            : {}),
          ...(capabilities
            ? {
                capabilities: full
                  ? capabilities
                  : { ...capabilities, capabilities: groupCapabilities(capabilities.capabilities) },
              }
            : {}),
          ...(flaggedBy.length ? { flagged_by: flaggedBy } : {}),
          ...(capId ? { upgrade_cap: upgradeCap } : {}),
          ...(upgradeCapUnavailable ? { upgrade_cap_unavailable: upgradeCapUnavailable } : {}),
          overview,
          ...(disassembly ? { disassembly } : {}),
          ...(bytecode.unavailable
            ? {
                disassembly_unavailable: `The package's bytecode could not be read (${bytecode.unavailable}), so the bytecode findings (discarded-check, sibling-guard-gap, unchecked-state-write) were not checked${include_disassembly ? " and no disassembly is returned" : ""}.`,
              }
            : {}),
        };
        // Weak leads raise no finding: the default lists the first few and
        // `detail: 'full'` lists them all.
        const { payload: out } = capPayload(
          "analyze_package",
          { package_id, include_disassembly, audit_capabilities, modules: wantedModules },
          payload,
          {
            "bytecode_scan.weak_leads": {
              budget: WEAK_LEADS_BUDGET,
              keepOrder: true,
              brief: (l: WeakLead) => ({ check: l.check, function: l.function }),
            } satisfies ListCap<WeakLead>,
          },
          { full, next_call: { tool: "analyze_package", repeat_with: { detail: "full" } } },
        );
        // Compact: indentation adds a quarter to a result that is already
        // the largest this server returns.
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
      } catch (err) {
        return errorResult(describeError(err, getNetwork()));
      }
    },
  );
}
