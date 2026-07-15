import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { GrpcTypes } from "@mysten/sui/grpc";
import { errorResult } from "../utils/errors.js";
import { suivisionPackageUrl } from "../config.js";
import {
  formatVisibility,
  formatSignature,
  abilityName,
  formatDatatypeFields,
} from "./packages.js";
import {
  resolvePackageId,
  fetchModuleDisassembly,
} from "../utils/move-package.js";
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
}

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
    findings.push({
      severity: "info",
      code: "no-public-api",
      title: "No public entry points",
      detail:
        "No public or entry functions — this reads as a library/internal package that other packages call, not one users transact with directly.",
      evidence: [],
    });
  }

  return findings;
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
    "(Developer) Analyze a Sui Move package: summarize what it does (modules, public/entry API, key struct shapes) and run a fast heuristic scan for quickly-identifiable risks (freeze/denylist authority, mint authority, admin capabilities, fund handling, randomness, hot-potato types). Accepts a 0x package ID or an MVR name (@org/app). Set include_disassembly=true to also return per-module bytecode assembly for deeper reading. NOTE: this is a surface scan to guide review, NOT a security audit.",
    {
      package_id: z
        .string()
        .describe("Package ID (0x...) or MVR name (@org/app)"),
      include_disassembly: z
        .boolean()
        .optional()
        .describe("Include GraphQL disassembly for each module (default: false)"),
    },
    async ({ package_id, include_disassembly }) => {
      try {
        const packageId = await resolvePackageId(package_id);
        const { response: res } = await sui.movePackageService.getPackage({
          packageId,
        });
        const pkg = res.package;
        if (!pkg) return errorResult(`Package not found: ${packageId}`);

        const modules = pkg.modules.map(normalizeModule);
        const findings = analyzePackageModules(modules);

        const overview = {
          package_id: pkg.storageId ?? packageId,
          module_count: modules.length,
          modules: modules.map((m) => ({
            name: m.name,
            public_api: publicApi(m),
            struct_count: m.structs.length,
            structs: m.structs.map((s) => ({
              name: s.name,
              abilities: s.abilities,
              fields: s.fields,
            })),
          })),
        };

        let disassembly: { module: string; disassembly: string }[] | undefined;
        if (include_disassembly) {
          disassembly = await Promise.all(
            modules.map(async (m) => {
              try {
                return { module: m.name, disassembly: await fetchModuleDisassembly(packageId, m.name) };
              } catch (err) {
                return {
                  module: m.name,
                  disassembly: `// Error: ${err instanceof Error ? err.message : String(err)}`,
                };
              }
            }),
          );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  disclaimer:
                    "Heuristic surface scan to guide review — NOT a security audit. Absence of findings does not imply safety.",
                  suivision_url: suivisionPackageUrl(packageId),
                  finding_count: findings.length,
                  findings,
                  overview,
                  ...(disassembly ? { disassembly } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
