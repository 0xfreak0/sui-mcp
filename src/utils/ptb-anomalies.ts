/**
 * Heuristic anomaly triage for a decoded PTB. Given the *formatted* commands
 * from decode_ptb, flag patterns worth a second look during incident triage.
 * Pure (no chain access), so it's unit-testable and cheap. The sender, the
 * blocklist, each called package's trust basis and, for an executed
 * transaction, its effects are looked up by the caller (identity resolution,
 * the shipped scam list and the lineage reads all need context this module
 * does not have) and passed in as plain values.
 *
 * This is a triage signal, NOT a verdict: flagged patterns (flash loans, calls
 * into unknown packages) are common in legitimate DeFi too, and a pass that
 * flags nothing clears nothing.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { PackageTrust } from "../protocols/registry.js";
import type { EffectsPayouts } from "./payouts.js";
import { SYSTEM_PACKAGE } from "./system-packages.js";
import { callValues, type CallValue, type FormattedInput } from "./ptb-value-flow.js";

export interface PtbAnomaly {
  severity: "high" | "medium" | "info";
  code: string;
  title: string;
  detail: string;
  evidence: string[];
  /** PTB command indices the flag is about, when it is about commands: a decode's first page lists them first. */
  commands?: number[];
}

/** A check an anomaly pass ran, named in its output so an empty result says what it did not find. */
export interface CheckRun {
  code: string;
  rule: string;
}

/** Sort key for listing anomalies most-severe first. */
export const SEVERITY_RANK: Record<PtbAnomaly["severity"], number> = { high: 0, medium: 1, info: 2 };

/** A command as `resolvePtb` (ptb-resolve.ts) formats it for decode_ptb and get_transaction. */
export interface FormattedCommand {
  type: string;
  target?: string; // pkg::module::function (MoveCall)
  protocol?: string; // display name only; never decides trust
  package?: string; // Upgrade
  returns?: string[]; // MoveCall, declared return types when the signature was read
  objects?: unknown[]; // TransferObjects
  address?: { address?: string } & Record<string, unknown>; // TransferObjects, resolved recipient when known
  arguments?: Array<{ address?: string } & Record<string, unknown>>; // MoveCall; `address` set on an address-typed Pure, or any 32-byte Pure when the signature is unread
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

/** Every check {@link flagPtbAnomalies} runs, with the rule it applies. */
export const PTB_CHECKS: readonly CheckRun[] = [
  { code: "publishes-or-upgrades", rule: "a Publish or Upgrade command (high)" },
  {
    code: "unverified-package-call",
    rule: "a call into a package that neither the curated registry nor a curated protocol's publishing key vouches for; medium when a call into it takes or hands out value and, for an executed transaction, that value went one way (another address gained what the sender lost, or the sender lost value net of gas and received nothing), or when another medium or high lead fires; info otherwise",
  },
  {
    code: "unregistered-package-lineage",
    rule: "a call into a package lineage the registry does not list, published by a key that signed a curated protocol's lineage (info)",
  },
  {
    code: "stale-package-version",
    rule: "a call into a version older than its lineage's newest at the time; medium when the call writes a shared object whose type that lineage defines and the newest version changed or removed the function it ran, info otherwise",
  },
  { code: "blocklisted-package-call", rule: "a call into a package on the Sui wallet scam blocklist (high)" },
  {
    code: "transfers-to-non-sender",
    rule: "TransferObjects or a framework payout call to an address other than the sender (high); for an executed transaction, also coins the sender lost that another address gained and objects the sender held that another address now holds (info, medium beside another lead)",
  },
  { code: "flashloan-pattern", rule: "a function named flash, or a borrow and a repay, in one PTB (info)" },
  { code: "multi-package-composition", rule: "calls into four or more packages (info)" },
];

/** What a pass that flagged nothing, or only some things, has not ruled out. */
export const NO_MATCH_NOTE =
  "These are the checks that ran. A check that did not match clears nothing: an exploit can use a shape no check reads, and an empty list is not evidence the transaction is safe.";

export interface FlagPtbAnomaliesOptions {
  /** The transaction's sender, to tell a payment to someone else from a payment to self. */
  sender?: string;
  /** MoveCall packages found on the shipped Sui wallet blocklist. */
  blocklistedPackages?: Set<string>;
  /** The PTB's resolved inputs, to tell the signer's own objects from shared state. */
  inputs?: FormattedInput[];
  /** Trust basis and version state of a called package. Without it, every non-system package is unrecognized. */
  trust?: (pkg: string) => PackageTrust;
  /** For an executed transaction: payouts read from its effects, the addresses other than the sender that gained, and whether the sender lost or received value net of gas. */
  effects?: Pick<EffectsPayouts, "payouts" | "sender_lost" | "sender_received"> & { gainers: ReadonlySet<string> };
  /**
   * For each call {@link supersededWrites} returned, keyed by
   * {@link targetKey}: whether the newest version changed or removed the
   * function it ran (`superseded-diff.ts`). A call not in the map was not
   * compared.
   */
  supersededChanges?: ReadonlyMap<string, FunctionChangeSince>;
  /** Anomalies found outside this pass (analyze_attack_tx's trade checks); a medium or high one counts as another lead. */
  leads?: PtbAnomaly[];
}

function packageOf(target: string | undefined): string {
  return (target ?? "").split("::")[0];
}

/**
 * A system package: the Move stdlib 0x1, the Sui framework 0x2, Sui system
 * 0x3, the Sui Bridge 0xb or DeepBook v1 0xdee9, the reserved addresses
 * `SYSTEM_PACKAGE` matches (see ./system-packages.ts). Only the protocol can
 * publish there, so a call into one is never a call into an unrecognized
 * package.
 */
export function isSystemPackage(pkg: string): boolean {
  return /^(0x)?[0-9a-fA-F]{1,64}$/.test(pkg) && SYSTEM_PACKAGE.test(normalizeSuiAddress(pkg));
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

/** How the newest version of a lineage treats a function a superseded version ran. */
export type FunctionChangeSince = "changed" | "removed" | "same" | "unread";

const BYPASSED: Record<FunctionChangeSince, boolean> = { changed: true, removed: true, same: false, unread: false };

const CHANGE_NOTE: Record<FunctionChangeSince, string> = {
  changed: "the newest version changed this function",
  removed: "the newest version removed this function",
  same: "this function is unchanged in the newest version",
  unread: "not compared with the newest version",
};

/** `package::module::function` with the package address normalized, the key `supersededChanges` is read by. */
export function targetKey(target: string): string {
  const [pkg, ...rest] = target.split("::");
  return /^(0x)?[0-9a-fA-F]{1,64}$/.test(pkg) ? [normalizeSuiAddress(pkg), ...rest].join("::") : target;
}

/** Does this Move call take a mutable shared object whose type the called package's own lineage defines? */
function writesOwnLineage(command: FormattedCommand, inputs: FormattedInput[], trust: PackageTrust): boolean {
  const lineage = new Set(trust.lineage);
  const args = (command.arguments ?? []) as Array<{ type?: string; index?: number }>;
  return args.some((a) => {
    const input = a.type === "Input" ? inputs[a.index ?? -1] : undefined;
    const typePkg = input?.type === "SharedObject" && input.mutable ? input.object_type?.split("::")[0] : undefined;
    return !!typePkg && /^0x[0-9a-fA-F]{1,64}$/.test(typePkg) && lineage.has(normalizeSuiAddress(typePkg));
  });
}

/**
 * Calls into a superseded package version that write a shared object their
 * own lineage defines, with the newest version to compare each function
 * against. The caller reads that comparison (`superseded-diff.ts`) and passes
 * it back as `supersededChanges`.
 */
export function supersededWrites(
  commands: FormattedCommand[],
  inputs: FormattedInput[],
  trust: (pkg: string) => PackageTrust,
): Array<{ target: string; newest: string }> {
  const out = new Map<string, { target: string; newest: string }>();
  for (const c of commands) {
    if (c.type !== "MoveCall" || !c.target) continue;
    const pkg = packageOf(c.target);
    if (!/^(0x)?[0-9a-fA-F]{1,64}$/.test(pkg) || isSystemPackage(pkg)) continue;
    const t = trust(normalizeSuiAddress(pkg));
    if (t.superseded && writesOwnLineage(c, inputs, t)) out.set(targetKey(c.target), { target: targetKey(c.target), newest: t.superseded.newest });
  }
  return [...out.values()];
}

const UNRECOGNISED: PackageTrust = { basis: null, protocols: [], superseded: null, lineage: [] };

/** One called non-system package: its trust, and every call into it with the value that moved. */
interface CalledPackage {
  pkg: string;
  trust: PackageTrust;
  calls: CallValue[];
}

/** `target (takes a coin; returns a coin or balance)`, one line per distinct call. */
function callEvidence(calls: CallValue[], note?: (c: CallValue) => string | null): string[] {
  const seen = new Map<string, string>();
  for (const c of calls) {
    const why = [...c.takes.map((t) => `takes ${t}`), ...c.gives, ...(note ? [note(c)].filter((n): n is string => !!n) : [])];
    const line = why.length ? `${c.target} (${why.join("; ")})` : c.target;
    if (!seen.has(c.target) || why.length) seen.set(c.target, line);
  }
  return [...seen.values()];
}

export function flagPtbAnomalies(commands: FormattedCommand[], opts: FlagPtbAnomaliesOptions = {}): PtbAnomaly[] {
  const anomalies: PtbAnomaly[] = [];
  const moveCalls = commands.filter((c) => c.type === "MoveCall");
  const inputs = opts.inputs ?? [];
  const position = new Map(commands.map((c, i) => [c, i]));
  const indicesOf = (list: FormattedCommand[]) => [...new Set(list.map((c) => position.get(c)!))].sort((a, b) => a - b);

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
      commands: indicesOf(pubUp),
    });
  }

  // --- Calls a package on the shipped Sui wallet blocklist -------------------
  const blocklisted = opts.blocklistedPackages?.size
    ? moveCalls.filter((c) => opts.blocklistedPackages!.has(normalizeSuiAddress(packageOf(c.target))))
    : [];
  if (blocklisted.length > 0) {
    const pkgs = [...new Set(blocklisted.map((c) => packageOf(c.target)))];
    anomalies.push({
      severity: "high",
      code: "blocklisted-package-call",
      title: `Calls ${pkgs.length} package(s) on the Sui wallet scam blocklist`,
      detail:
        "MystenLabs/wallet_blocklist — the list Sui wallets use to hide scam packages, coins and NFTs — lists a package this PTB calls. Third-party and community-maintained: strong pre-sign evidence, not proof by itself.",
      evidence: blocklisted.map((c) => c.target ?? "").filter(Boolean).slice(0, 10),
      commands: indicesOf(blocklisted),
    });
  }

  // --- Transfers what the signer owns to someone else ------------------------
  // TransferObjects is how both an owned object and a SplitCoins result reach
  // an address, and a framework call (FRAMEWORK_TRANSFER_RECIPIENT_ARG) can
  // pay out the same way without ever being a TransferObjects command. Its
  // recipient is declared `address`, so a resolved Pure argument reads
  // exactly like a TransferObjects recipient. One check covers a drainer
  // PTB's whole payout leg either way: assets handed to a stranger, whether
  // transferred outright or routed through one of these functions.
  const senderNorm = opts.sender ? normalizeSuiAddress(opts.sender) : null;
  const divertedTransfers = senderNorm
    ? commands.filter((c) => c.type === "TransferObjects" && c.address?.address && normalizeSuiAddress(c.address.address) !== senderNorm)
    : [];
  const frameworkPayouts = senderNorm
    ? moveCalls.filter((c) => {
        if (!isSystemPackage(packageOf(c.target))) return false;
        const argIdx = FRAMEWORK_TRANSFER_RECIPIENT_ARG[moduleFnOf(c.target)];
        if (argIdx === undefined) return false;
        const recipient = c.arguments?.[argIdx]?.address;
        return !!recipient && normalizeSuiAddress(recipient) !== senderNorm;
      })
    : [];
  const commandPayouts = divertedTransfers.length + frameworkPayouts.length;

  // A lead that does not depend on the grading below: those decide whether
  // an otherwise info-grade trust flag or effects payout reads medium.
  const otherLead =
    pubUp.length > 0 || blocklisted.length > 0 || commandPayouts > 0 || (opts.leads ?? []).some((a) => a.severity !== "info");

  const effectsPayouts = senderNorm ? (opts.effects?.payouts ?? []) : [];
  if (commandPayouts > 0 || effectsPayouts.length > 0) {
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
    for (const p of effectsPayouts) {
      recipients.add(p.to);
      evidence.push(
        p.coin_type ? `by effects: ${p.amount} ${p.coin_type} the sender lost -> ${p.to}` : `by effects: object ${p.object_id} (${p.object_type ?? "unknown type"}) the sender held -> ${p.to}`,
      );
    }
    // A TransferObjects command can hand over several objects; each counts.
    const itemsSent =
      divertedTransfers.reduce((n, c) => n + Math.max(1, (c.objects as unknown[] | undefined)?.length ?? 0), 0) + frameworkPayouts.length;
    anomalies.push({
      severity: commandPayouts > 0 ? "high" : otherLead ? "medium" : "info",
      code: "transfers-to-non-sender",
      title:
        commandPayouts > 0
          ? `Sends ${itemsSent} object(s)/coin(s) to ${recipients.size} address(es) other than the sender`
          : `Effects show value the sender held reaching ${recipients.size} other address(es)`,
      detail:
        "TransferObjects, or a framework payout call (0x2 transfer::public_transfer, pay::split_and_transfer, pay::join_vec_and_transfer, sui::transfer, coin::send_funds, balance::send_funds, coin::mint_and_transfer, token::transfer, or a party::single_owner party for transfer::public_party_transfer), hands what this transaction controls — owned objects or coins just split off — to an address that is not the signer. Legitimate for payments and gifts, but it is exactly the shape of a drainer PTB: everything the signer holds, moved to a stranger in one transaction. " +
        "Lines marked `by effects` come from the executed transaction instead: a coin the sender lost that another address gained, or an object the sender held that another address now holds, whichever function moved it. On their own they read info, since fees and payments look the same; beside another medium or high lead they read medium.",
      evidence: evidence.slice(0, 10),
      ...(commandPayouts > 0 ? { commands: indicesOf([...divertedTransfers, ...frameworkPayouts]) } : {}),
    });
  }

  // --- Who vouches for each called package ---------------------------------
  // A curated registry entry, or a version whose own publisher signed a
  // curated lineage. A display name (Move Registry, custody) never counts.
  const values = new Map(callValues(commands, inputs, { sender: opts.sender, gainers: opts.effects?.gainers }).map((v) => [v.index, v]));
  const called = new Map<string, CalledPackage>();
  commands.forEach((c, index) => {
    if (c.type !== "MoveCall" || !c.target) return;
    const raw = packageOf(c.target);
    if (!/^(0x)?[0-9a-fA-F]{1,64}$/.test(raw) || isSystemPackage(raw)) return;
    const pkg = normalizeSuiAddress(raw);
    const entry = called.get(pkg) ?? { pkg, trust: opts.trust?.(pkg) ?? UNRECOGNISED, calls: [] };
    const value = values.get(index);
    if (value) entry.calls.push(value);
    called.set(pkg, entry);
  });

  const unrecognised = [...called.values()].filter((p) => p.trust.basis === null);
  if (unrecognised.length > 0) {
    const withValue = unrecognised.filter((p) => p.calls.some((c) => c.takes.length > 0 || c.gives.length > 0));
    const calls = [...withValue, ...unrecognised.filter((p) => !withValue.includes(p))].flatMap((p) => p.calls);
    // With effects, value through an unrecognized package is a lead only when
    // it went one way: another address gained what the sender lost, or the
    // sender lost value and got nothing back. A swap, deposit or redeem that
    // returns value to the sender is a round trip.
    const fx = opts.effects;
    const oneWay = fx ? fx.payouts.length > 0 || (fx.sender_lost && !fx.sender_received) : true;
    const roundTrip = withValue.length > 0 && !oneWay;
    anomalies.push({
      severity: (withValue.length > 0 && oneWay) || otherLead ? "medium" : "info",
      code: "unverified-package-call",
      title:
        `Calls into ${unrecognised.length} unrecognized package(s)` +
        (withValue.length ? `, ${withValue.length} of them taking or handing out value` : ", none taking or handing out value") +
        (roundTrip ? "; by effects no value left the sender one way" : ""),
      detail:
        "Neither the curated registry nor a curated protocol's publishing key vouches for these packages; a Move Registry name is shown for display and does not count. Legitimate for niche or new protocols, but this is where a malicious package would be invoked. Medium when a call into one takes a coin, balance or owned object, returns a coin or balance, or names another address that gained, and, for an executed transaction, the value went one way: another address gained what the sender lost, or the sender lost value (net of gas) and received nothing. Also medium when another medium or high lead fires. Info otherwise, which includes a swap, deposit or redeem that returned value to the sender.",
      evidence: callEvidence(calls).slice(0, 10),
      commands: [...new Set(calls.map((c) => c.index))].sort((a, b) => a - b),
    });
  }

  const unregistered = [...called.values()].filter((p) => p.trust.basis === "publisher");
  if (unregistered.length > 0) {
    anomalies.push({
      severity: "info",
      code: "unregistered-package-lineage",
      title: `Calls ${unregistered.length} package(s) from lineages the registry does not list, published by a curated protocol's key`,
      detail:
        "Each package version was published by a key that also published or upgraded a curated protocol's lineage, so that protocol's deployer shipped this code; the registry itself does not list the lineage. A compromised or careless deployer key ships code the same way, so read what the call does before relying on the name.",
      evidence: unregistered
        .flatMap((p) => callEvidence(p.calls, () => `published by ${p.trust.protocols.join(" or ")}'s key`))
        .slice(0, 10),
      commands: [...new Set(unregistered.flatMap((p) => p.calls.map((c) => c.index)))].sort((a, b) => a - b),
    });
  }

  // --- Superseded versions -------------------------------------------------
  // Old code writing the live state its own lineage defines is how a fixed
  // bug stays exploitable: the fix ships in a new version, and the old one
  // still accepts the same objects. The grade reads the call itself: whether
  // the newest version changed the function it ran.
  const superseded = [...called.values()].filter((p) => p.trust.superseded !== null);
  if (superseded.length > 0) {
    const bypasses = (p: CalledPackage, c: CallValue) =>
      writesOwnLineage(commands[c.index], inputs, p.trust) && BYPASSED[opts.supersededChanges?.get(targetKey(c.target)) ?? "unread"];
    const risky = superseded.filter((p) => p.calls.some((c) => bypasses(p, c)));
    const note = (p: CalledPackage, c: CallValue) => {
      const s = p.trust.superseded!;
      const parts = [`v${s.version}; v${s.newest_version} ${s.newest} was already published`];
      if (writesOwnLineage(commands[c.index], inputs, p.trust)) {
        parts.push(`writes a shared object its lineage defines; ${CHANGE_NOTE[opts.supersededChanges?.get(targetKey(c.target)) ?? "unread"]}`);
      }
      return parts.join("; ");
    };
    anomalies.push({
      severity: risky.length > 0 ? "medium" : "info",
      code: "stale-package-version",
      title:
        `Calls a superseded version of ${superseded.length} package lineage(s)` +
        (risky.length ? `, ${risky.length} of them running a function the newest version changed on their own lineage's shared objects` : ""),
      detail:
        "The called version was older than its lineage's newest version when the transaction ran. A fix ships as a new version while the old one stays callable, so a superseded version that writes the shared objects its own lineage defines can still run the old logic on live state. Medium when such a call runs a function whose body the newest version changed or removed, whatever the registry says: the call bypasses a change the lineage shipped. Info otherwise, since old versions whose functions are unchanged are called routinely.",
      evidence: [...risky, ...superseded.filter((p) => !risky.includes(p))].flatMap((p) => callEvidence(p.calls, (c) => note(p, c))).slice(0, 10),
      // The calls that bypass a change first: a first page lists them first.
      commands: [
        ...new Set([
          ...superseded.flatMap((p) => p.calls.filter((c) => bypasses(p, c)).map((c) => c.index)),
          ...superseded.flatMap((p) => p.calls.map((c) => c.index)),
        ]),
      ],
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
      commands: indicesOf(flashFns.length ? flashFns : moveCalls.filter((c) => /(^|_)(borrow|repay)($|_)/i.test(fnName(c.target)))),
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
  anomalies.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return anomalies;
}
