/**
 * Heuristic anomaly triage for a decoded PTB. Given the *formatted* commands
 * from decode_ptb, flag patterns worth a second look during incident triage.
 * Pure (no chain access), so it's unit-testable and cheap. `sender` and
 * `blocklistedPackages` are looked up by the caller (identity resolution and
 * the shipped scam list both need context this module does not have) and
 * passed in as plain values.
 *
 * This is a triage signal, NOT a verdict: flagged patterns (flash loans, calls
 * into unknown packages) are common in legitimate DeFi too.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";

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
  objects?: unknown[]; // TransferObjects
  address?: { address?: string } & Record<string, unknown>; // TransferObjects, resolved recipient when known
  arguments?: Array<{ address?: string } & Record<string, unknown>>; // MoveCall, each resolved the same way when Pure 32-byte
  [k: string]: unknown;
}

/**
 * Framework functions that pay out exactly like TransferObjects does (an
 * owned object, a coin or a balance reaching an address), mapped to the index
 * of their `address`-typed recipient argument, from 0x2's public functions on
 * mainnet:
 *
 * - `transfer::public_transfer<T>(obj, recipient)`
 * - `pay::split_and_transfer<T>(coin, amount, recipient, ctx)`
 * - `pay::join_vec_and_transfer<T>(vector<Coin<T>>, recipient)`
 * - `sui::transfer(coin, recipient)`
 * - `coin::send_funds<T>(coin, recipient)` and
 *   `balance::send_funds<T>(balance, recipient)`, which credit the
 *   recipient's address balance
 * - `coin::mint_and_transfer<T>(treasury_cap, amount, recipient, ctx)`, which
 *   spends the signer's mint authority on someone else
 * - `token::transfer<T>(token, recipient, ctx)`
 * - `party::single_owner(recipient)`, whose `Party` reaches
 *   `transfer::public_party_transfer` as a Result, so the recipient is only
 *   visible where the party is built
 *
 * All of them target a system package, so a drainer routing its payout
 * through one of these instead of TransferObjects is not caught by
 * `unverified-package-call` either.
 */
const FRAMEWORK_TRANSFER_RECIPIENT_ARG: Record<string, number> = {
  "transfer::public_transfer": 1,
  "pay::split_and_transfer": 2,
  "pay::join_vec_and_transfer": 1,
  "sui::transfer": 1,
  "coin::send_funds": 1,
  "coin::mint_and_transfer": 2,
  "balance::send_funds": 1,
  "token::transfer": 1,
  "party::single_owner": 0,
};

export interface FlagPtbAnomaliesOptions {
  /** The transaction's sender, to tell a payment to someone else from a payment to self. */
  sender?: string;
  /** MoveCall packages found on the shipped Sui wallet blocklist. */
  blocklistedPackages?: Set<string>;
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

/** `module::function` of a MoveCall target, the key `FRAMEWORK_TRANSFER_RECIPIENT_ARG` is looked up by. */
function moduleFnOf(target: string | undefined): string {
  const parts = (target ?? "").split("::");
  return parts.length >= 3 ? `${parts[1]}::${parts[2]}` : "";
}

export function flagPtbAnomalies(commands: FormattedCommand[], opts: FlagPtbAnomaliesOptions = {}): PtbAnomaly[] {
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

  // --- Calls a package on the shipped Sui wallet blocklist -------------------
  if (opts.blocklistedPackages?.size) {
    const hits = moveCalls.filter((c) => opts.blocklistedPackages!.has(normalizeSuiAddress(packageOf(c.target))));
    if (hits.length > 0) {
      const pkgs = [...new Set(hits.map((c) => packageOf(c.target)))];
      anomalies.push({
        severity: "high",
        code: "blocklisted-package-call",
        title: `Calls ${pkgs.length} package(s) on the Sui wallet scam blocklist`,
        detail:
          "MystenLabs/wallet_blocklist — the list Sui wallets use to hide scam packages, coins and NFTs — lists a package this PTB calls. Third-party and community-maintained: strong pre-sign evidence, not proof by itself.",
        evidence: hits.map((c) => c.target ?? "").filter(Boolean).slice(0, 10),
      });
    }
  }

  // --- Transfers what the signer owns to someone else ------------------------
  // TransferObjects is how both an owned object and a SplitCoins result reach
  // an address, and a framework call (FRAMEWORK_TRANSFER_RECIPIENT_ARG) can
  // pay out the same way without ever being a TransferObjects command. Its
  // recipient is declared `address`, so a resolved Pure argument reads
  // exactly like a TransferObjects recipient. One check covers a drainer
  // PTB's whole payout leg either way: assets handed to a stranger, whether
  // transferred outright or routed through one of these functions.
  if (opts.sender) {
    const senderNorm = normalizeSuiAddress(opts.sender);
    const transfers = commands.filter((c) => c.type === "TransferObjects" && c.address?.address);
    const divertedTransfers = transfers.filter((c) => normalizeSuiAddress(c.address!.address!) !== senderNorm);

    const frameworkPayouts = moveCalls.filter((c) => {
      if (!isSystemPackage(packageOf(c.target))) return false;
      const argIdx = FRAMEWORK_TRANSFER_RECIPIENT_ARG[moduleFnOf(c.target)];
      if (argIdx === undefined) return false;
      const recipient = c.arguments?.[argIdx]?.address;
      return !!recipient && normalizeSuiAddress(recipient) !== senderNorm;
    });

    if (divertedTransfers.length > 0 || frameworkPayouts.length > 0) {
      const recipients = new Set<string>();
      const evidence: string[] = [];
      for (const c of divertedTransfers) {
        recipients.add(normalizeSuiAddress(c.address!.address!));
        evidence.push(`${(c.objects as unknown[] | undefined)?.length ?? 0} object(s) -> ${c.address!.address}`);
      }
      for (const c of frameworkPayouts) {
        const recipient = c.arguments![FRAMEWORK_TRANSFER_RECIPIENT_ARG[moduleFnOf(c.target)]].address!;
        recipients.add(normalizeSuiAddress(recipient));
        evidence.push(`${c.target} -> ${recipient}`);
      }
      anomalies.push({
        severity: "high",
        code: "transfers-to-non-sender",
        title: `Sends ${divertedTransfers.length + frameworkPayouts.length} object(s)/coin(s) to ${recipients.size} address(es) other than the sender`,
        detail:
          "TransferObjects, or a framework payout call (0x2 transfer::public_transfer, pay::split_and_transfer, pay::join_vec_and_transfer, sui::transfer, coin::send_funds, balance::send_funds, coin::mint_and_transfer, token::transfer, or a party::single_owner party for transfer::public_party_transfer), hands what this transaction controls — owned objects or coins just split off — to an address that is not the signer. Legitimate for payments and gifts, but it is exactly the shape of a drainer PTB: everything the signer holds, moved to a stranger in one transaction.",
        evidence: evidence.slice(0, 10),
      });
    }
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
