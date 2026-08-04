/**
 * Heuristic anomaly triage for a decoded PTB. Given the *formatted* commands
 * from decode_ptb, flag patterns worth a second look during incident triage.
 * Pure — no chain access — so it's unit-testable and cheap.
 *
 * This is a triage signal, NOT a verdict: flagged patterns (flash loans, calls
 * into unknown packages) are common in legitimate DeFi too.
 */

export interface PtbAnomaly {
  severity: "high" | "medium" | "info";
  code: string;
  title: string;
  detail: string;
  evidence: string[];
}

/** A formatted command as emitted by decode_ptb's formatCommand. */
export interface FormattedCommand {
  type: string;
  target?: string; // pkg::module::function (MoveCall)
  protocol?: string; // set when the package is in the protocol registry
  package?: string; // Upgrade
  [k: string]: unknown;
}

function packageOf(target: string | undefined): string {
  return (target ?? "").split("::")[0];
}

function isSystemPackage(pkg: string): boolean {
  const short = pkg.replace(/^0x0+/, "0x");
  return short === "0x1" || short === "0x2" || short === "0x3";
}

function fnName(target: string | undefined): string {
  const parts = (target ?? "").split("::");
  return parts.length >= 3 ? parts[2] : "";
}

export function flagPtbAnomalies(commands: FormattedCommand[]): PtbAnomaly[] {
  const anomalies: PtbAnomaly[] = [];
  const moveCalls = commands.filter((c) => c.type === "MoveCall");

  // --- Publishes / upgrades a package inside the PTB -------------------------
  const pubUp = commands.filter((c) => c.type === "Publish" || c.type === "Upgrade");
  if (pubUp.length > 0) {
    anomalies.push({
      severity: "high",
      code: "publishes-or-upgrades",
      title: "PTB publishes or upgrades a package",
      detail:
        "This transaction publishes new code or upgrades an existing package. Outside of deployments this is unusual and worth scrutiny — an upgrade can change on-chain behavior.",
      evidence: pubUp.map((c) => (c.type === "Upgrade" ? `Upgrade ${c.package ?? ""}` : "Publish")).slice(0, 8),
    });
  }

  // --- Calls into unrecognized (non-system, unlabeled) packages -------------
  const unverified = moveCalls.filter((c) => !c.protocol && !isSystemPackage(packageOf(c.target)));
  const unverifiedPkgs = [...new Set(unverified.map((c) => packageOf(c.target)))];
  if (unverifiedPkgs.length > 0) {
    anomalies.push({
      severity: "medium",
      code: "unverified-package-call",
      title: `Calls into ${unverifiedPkgs.length} unrecognized package(s)`,
      detail:
        "MoveCalls target packages that aren't system packages and aren't in the known-protocol registry. Legitimate for niche/new protocols, but this is where a malicious package would be invoked — verify what these do.",
      evidence: unverified.map((c) => c.target ?? "").filter(Boolean).slice(0, 10),
    });
  }

  // --- Flash-loan wrap ------------------------------------------------------
  const flashFns = moveCalls.filter((c) => /flash/i.test(fnName(c.target)));
  const hasBorrow = moveCalls.some((c) => /(^|_)borrow($|_)/i.test(fnName(c.target)));
  const hasRepay = moveCalls.some((c) => /(^|_)repay($|_)/i.test(fnName(c.target)));
  if (flashFns.length > 0 || (hasBorrow && hasRepay)) {
    anomalies.push({
      severity: "info",
      code: "flashloan-pattern",
      title: "Flash-loan pattern (borrow + repay in one PTB)",
      detail:
        "The transaction borrows and repays within a single PTB — the flash-loan shape. Common in arbitrage/liquidations, but also the backbone of many economic exploits.",
      evidence: (flashFns.length ? flashFns : moveCalls).map((c) => c.target ?? "").filter(Boolean).slice(0, 8),
    });
  }

  // --- Multi-package composition --------------------------------------------
  const distinctPkgs = new Set(moveCalls.map((c) => packageOf(c.target)).filter(Boolean));
  if (distinctPkgs.size >= 4) {
    anomalies.push({
      severity: "info",
      code: "multi-package-composition",
      title: `Composes ${distinctPkgs.size} distinct packages`,
      detail:
        "The PTB chains calls across many packages. Normal for aggregators/routers, but complex compositions are worth mapping when investigating.",
      evidence: [...distinctPkgs].slice(0, 12),
    });
  }

  // Most-severe first.
  const order = { high: 0, medium: 1, info: 2 } as const;
  anomalies.sort((a, b) => order[a.severity] - order[b.severity]);
  return anomalies;
}
