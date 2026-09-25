/**
 * Upgrade governance over a package's whole lineage: who published each
 * version, under which signing scheme, and who held the `UpgradeCap` at every
 * point in time. Pure; `src/tools/upgrade-history.ts` does the reads.
 *
 * The cap's own version history is the spine. Every upgrade transaction takes
 * the cap by mutable reference, so each upgrade is also a cap version, and
 * every transfer of the cap is one too. Interleaving the two by checkpoint
 * answers "who held upgrade authority when this version shipped" without a
 * hand join.
 *
 * Three rules a change here must keep:
 *
 * - **The holder at an upgrade is the cap's INPUT owner.** The upgrade
 *   transaction is itself a cap version, so its owner is the state after the
 *   upgrade. A cap handed back inside the upgrading transaction would
 *   otherwise be credited to whoever received it.
 * - **"Usual holder" is measured in time, not in versions.** A cap borrowed
 *   for eleven minutes to push one upgrade can account for as many versions as
 *   a multisig that held it for months. Counting versions would make the
 *   borrower the norm.
 * - **An excursion is only a departure from the usual holder.** The deployer
 *   holding the cap before handing it to a multisig is how most caps start,
 *   and flagging it would fire on nearly every governed package.
 */

import { ownerKey, type OwnerDesc } from "./object-history.js";
import { isUnspendableAddress } from "./upgrade-cap.js";
import type { Authentication, AuthScheme } from "./multisig.js";

/** Where on the chain something happened. */
export interface ChainPoint {
  tx: string | null;
  /** ISO 8601. */
  timestamp: string | null;
  checkpoint: number | null;
}

/** One version of a package, from the transaction that created it. */
export interface PublishedVersion extends ChainPoint {
  package_id: string;
  version: number;
  sender: string | null;
}

/** One version of the UpgradeCap object. */
export interface CapVersion extends ChainPoint {
  object_version: number;
  /** Sender of the transaction that wrote this version. */
  sender: string | null;
  owner: OwnerDesc;
  /** `UpgradeCap.version`: the lineage version the next upgrade builds on. */
  package_version: number | null;
  /** `UpgradeCap.policy`: 0 compatible, 128 additive, 192 dependency-only. */
  policy: number | null;
}

/** The cap stopped existing as an object: destroyed, or wrapped into another. */
export interface CapEnd extends ChainPoint {
  kind: "deleted" | "wrapped";
  sender: string | null;
}

export interface CustodyPeriod {
  holder: OwnerDesc;
  /** The transaction that put the cap with this holder. */
  from: ChainPoint & { sender: string | null };
  /** The transaction that took it away; null while it is still there. */
  until: (ChainPoint & { sender: string | null }) | null;
}

/** Single-key schemes: one key, one signature, no committee. */
const SINGLE_KEY: Partial<Record<AuthScheme, true>> = {
  ed25519: true,
  secp256k1: true,
  secp256r1: true,
  zklogin: true,
  passkey: true,
};

/** `UpgradeCap.policy` (u8) as a word. The framework only lets it rise. */
export function upgradePolicyName(policy: number | null | undefined): string {
  switch (policy) {
    case 0:
      return "compatible";
    case 128:
      return "additive";
    case 192:
      return "dep_only";
    case null:
    case undefined:
      return "unknown";
    default:
      return `unknown (${policy})`;
  }
}

/** A short scheme label: `multisig 3-of-4`, `ed25519`, `unknown`. */
export function schemeLabel(auth: Authentication | null | undefined): string {
  if (!auth) return "unknown";
  if (auth.scheme === "multisig" && auth.multisig) {
    const c = auth.multisig;
    return c.members.every((m) => m.weight === 1)
      ? `multisig ${c.threshold}-of-${c.members.length}`
      : `multisig threshold ${c.threshold} of ${c.total_weight} weight`;
  }
  return auth.scheme;
}

const short = (a: string): string => `${a.slice(0, 10)}…`;

function ownerText(o: OwnerDesc, auth?: Map<string, Authentication>): string {
  if (o.kind !== "address" && o.kind !== "consensus") return o.kind;
  const scheme = auth?.get(o.address);
  return scheme ? `${short(o.address)} (${schemeLabel(scheme)})` : short(o.address);
}

function ms(p: { timestamp: string | null }): number | null {
  if (!p.timestamp) return null;
  const t = Date.parse(p.timestamp);
  return Number.isNaN(t) ? null : t;
}

/**
 * Order two chain points. Checkpoint first, timestamp when a checkpoint is
 * missing. Null when neither side can be ordered.
 */
export function comparePoints(a: ChainPoint, b: ChainPoint): number | null {
  if (a.checkpoint !== null && b.checkpoint !== null) return a.checkpoint - b.checkpoint;
  const ta = ms(a);
  const tb = ms(b);
  if (ta !== null && tb !== null) return ta - tb;
  return null;
}

/** Collapse the cap's version history into one period per consecutive holder. */
export function custodyPeriods(caps: CapVersion[], end: CapEnd | null = null): CustodyPeriod[] {
  const out: CustodyPeriod[] = [];
  for (const c of caps) {
    const last = out[out.length - 1];
    if (last && ownerKey(last.holder) === ownerKey(c.owner)) continue;
    const at = { tx: c.tx, timestamp: c.timestamp, checkpoint: c.checkpoint, sender: c.sender };
    if (last) last.until = at;
    out.push({ holder: c.owner, from: at, until: null });
  }
  const last = out[out.length - 1];
  if (last && end) last.until = { tx: end.tx, timestamp: end.timestamp, checkpoint: end.checkpoint, sender: end.sender };
  return out;
}

function periodMs(p: CustodyPeriod, nowMs: number): number {
  const start = ms(p.from);
  const stop = p.until ? ms(p.until) : nowMs;
  return start === null || stop === null ? 0 : Math.max(0, stop - start);
}

export interface UsualHolder {
  holder: OwnerDesc;
  /** Fraction of the cap's observed lifetime spent with this holder. */
  share_of_time: number;
}

/**
 * The holder the cap spent the most time with. Held owners only: a cap that
 * went shared or was burned has no holder to return to.
 */
export function usualHolder(periods: CustodyPeriod[], nowMs: number): UsualHolder | null {
  const byKey = new Map<string, { holder: OwnerDesc; ms: number }>();
  let total = 0;
  for (const p of periods) {
    const d = periodMs(p, nowMs);
    total += d;
    if (p.holder.kind !== "address" && p.holder.kind !== "consensus") continue;
    if (isUnspendableAddress(p.holder.address)) continue;
    const k = ownerKey(p.holder);
    const e = byKey.get(k) ?? { holder: p.holder, ms: 0 };
    e.ms += d;
    byKey.set(k, e);
  }
  let best: { holder: OwnerDesc; ms: number } | null = null;
  for (const e of byKey.values()) if (!best || e.ms > best.ms) best = e;
  if (!best || total === 0) return null;
  return { holder: best.holder, share_of_time: Math.round((best.ms / total) * 1000) / 1000 };
}

/** Versions whose publish lies within `[from, until]`; `until` null means open-ended. */
function versionsBetween(versions: PublishedVersion[], from: ChainPoint, until: ChainPoint | null): number[] {
  return versions
    .filter((v) => {
      const afterStart = comparePoints(v, from);
      if (afterStart === null || afterStart < 0) return false;
      if (!until) return true;
      const beforeEnd = comparePoints(v, until);
      return beforeEnd !== null && beforeEnd <= 0;
    })
    .map((v) => v.version);
}

export interface CapExcursion {
  /** Every holder the cap passed through while away, in order. */
  holders: OwnerDesc[];
  left: ChainPoint & { sender: string | null };
  /** Null while the cap is still away. */
  returned: (ChainPoint & { sender: string | null }) | null;
  duration_hours: number | null;
  /** Versions published while the cap was away. */
  upgrades_during: number[];
  /** Came back within the window, with at least one upgrade published while away. */
  round_trip: boolean;
}

/**
 * Every stretch the cap spent away from its usual holder after first reaching
 * it. Consecutive non-usual holders form one excursion, so a cap passed from
 * the multisig to A to B and back is one trip, not two.
 */
export function capExcursions(
  periods: CustodyPeriod[],
  versions: PublishedVersion[],
  usual: OwnerDesc | null,
  windowHours: number,
): CapExcursion[] {
  if (!usual) return [];
  const usualKey = ownerKey(usual);
  const first = periods.findIndex((p) => ownerKey(p.holder) === usualKey);
  if (first < 0) return [];
  const out: CapExcursion[] = [];
  let i = first + 1;
  while (i < periods.length) {
    if (ownerKey(periods[i].holder) === usualKey) {
      i++;
      continue;
    }
    const start = i;
    while (i < periods.length && ownerKey(periods[i].holder) !== usualKey) i++;
    const away = periods.slice(start, i);
    const left = away[0].from;
    // The period after the excursion, when there is one, starts with the return.
    const returned = i < periods.length ? periods[i].from : null;
    const startMs = ms(left);
    const endMs = returned ? ms(returned) : null;
    const hours = startMs !== null && endMs !== null ? (endMs - startMs) / 3_600_000 : null;
    const upgrades = versionsBetween(versions, left, returned);
    out.push({
      holders: away.map((p) => p.holder),
      left,
      returned,
      duration_hours: hours === null ? null : Math.round(hours * 1000) / 1000,
      upgrades_during: upgrades,
      round_trip: returned !== null && hours !== null && hours <= windowHours && upgrades.length > 0,
    });
  }
  return out;
}

/**
 * Who held the cap when `v` was published: the owner of the cap's version
 * BEFORE the upgrade transaction, which is the one the sender had to hold.
 * Version 1 creates the cap, so its holder is whoever received it.
 */
export function capHolderAtPublish(v: PublishedVersion, caps: CapVersion[]): OwnerDesc | null {
  const idx = v.tx ? caps.findIndex((c) => c.tx === v.tx) : -1;
  if (idx > 0) return caps[idx - 1].owner;
  if (idx === 0) return caps[0].owner;
  // The upgrade is not among the cap's versions (history truncated, or the cap
  // was reached some other way). Fall back to the last version strictly before.
  let holder: OwnerDesc | null = null;
  for (const c of caps) {
    const d = comparePoints(c, v);
    if (d === null || d >= 0) break;
    holder = c.owner;
  }
  return holder;
}

export type UpgradeFlagKind =
  | "cap_round_trip"
  | "single_key_upgrade"
  | "policy_change"
  | "cap_destroyed"
  | "cap_wrapped"
  | "cap_renounced"
  | "cap_frozen"
  | "cap_shared";

export interface UpgradeFlag {
  kind: UpgradeFlagKind;
  severity: "high" | "medium" | "info";
  summary: string;
  versions?: number[];
  txs: string[];
}

export interface FlagInput {
  versions: PublishedVersion[];
  caps: CapVersion[];
  end: CapEnd | null;
  periods: CustodyPeriod[];
  excursions: CapExcursion[];
  usual: UsualHolder | null;
  /** The authentication each version's sender signed its publish with, by version. */
  signerByVersion: Map<number, Authentication | null>;
  /** How each address authenticates, where known. */
  auth: Map<string, Authentication>;
}

export function upgradeFlags(input: FlagInput): UpgradeFlag[] {
  const { versions, caps, end, periods, excursions, usual, signerByVersion, auth } = input;
  const flags: UpgradeFlag[] = [];
  const byVersion = new Map(versions.map((v) => [v.version, v]));

  for (const x of excursions) {
    if (!x.round_trip || !usual || !x.returned) continue;
    const ups = x.upgrades_during.map((n) => {
      const v = byVersion.get(n);
      return `v${n} published ${v?.timestamp ?? "at an unknown time"}${v?.sender ? ` by ${short(v.sender)}` : ""}`;
    });
    flags.push({
      kind: "cap_round_trip",
      severity: "high",
      summary:
        `The UpgradeCap left ${ownerText(usual.holder, auth)} for ${x.holders.map((h) => ownerText(h, auth)).join(" → ")} ` +
        `at ${x.left.timestamp} and returned at ${x.returned.timestamp} (${(x.duration_hours ?? 0) < 2 ? `${Math.round((x.duration_hours ?? 0) * 60)} minutes` : `${Math.round((x.duration_hours ?? 0) * 10) / 10} hours`}). ` +
        `Published while it was away: ${ups.join("; ")}.`,
      versions: x.upgrades_during,
      txs: [x.left.tx, ...x.upgrades_during.map((n) => byVersion.get(n)?.tx ?? null), x.returned.tx].filter(
        (t): t is string => !!t,
      ),
    });
  }

  const usualAuth =
    usual && (usual.holder.kind === "address" || usual.holder.kind === "consensus")
      ? auth.get(usual.holder.address)
      : undefined;
  if (usualAuth?.scheme === "multisig") {
    for (const v of versions) {
      if (v.version === 1 || !v.sender) continue;
      const signer = signerByVersion.get(v.version) ?? auth.get(v.sender);
      if (!signer || !SINGLE_KEY[signer.scheme]) continue;
      flags.push({
        kind: "single_key_upgrade",
        severity: "high",
        summary: `v${v.version} was published by ${short(v.sender)}, signed with a single ${signer.scheme} key, while the cap is usually held by ${ownerText(usual!.holder, auth)}.`,
        versions: [v.version],
        txs: v.tx ? [v.tx] : [],
      });
    }
  }

  for (let i = 1; i < caps.length; i++) {
    const was = caps[i - 1].policy;
    const now = caps[i].policy;
    if (was === null || now === null || was === now) continue;
    flags.push({
      kind: "policy_change",
      severity: "info",
      summary: `Upgrade policy changed from ${upgradePolicyName(was)} to ${upgradePolicyName(now)} at ${caps[i].timestamp}${caps[i].sender ? ` by ${short(caps[i].sender!)}` : ""}. The framework only lets a policy become more restrictive.`,
      txs: caps[i].tx ? [caps[i].tx!] : [],
    });
  }

  if (end?.kind === "deleted") {
    flags.push({
      kind: "cap_destroyed",
      severity: "info",
      summary: `The UpgradeCap was destroyed at ${end.timestamp}${end.sender ? ` by ${short(end.sender)}` : ""}. Only 0x2::package::make_immutable can destroy one, so the package cannot be upgraded after that.`,
      txs: end.tx ? [end.tx] : [],
    });
  } else if (end?.kind === "wrapped") {
    flags.push({
      kind: "cap_wrapped",
      severity: "medium",
      summary: `The UpgradeCap was wrapped inside another object at ${end.timestamp}${end.sender ? ` by ${short(end.sender)}` : ""}. Upgrade authority now follows whatever rules that object's package enforces; read the wrapping transaction to see which.`,
      txs: end.tx ? [end.tx] : [],
    });
  }

  const current = periods[periods.length - 1];
  if (current && !end) {
    const at = current.from;
    const txs = at.tx ? [at.tx] : [];
    const h = current.holder;
    if ((h.kind === "address" || h.kind === "consensus") && isUnspendableAddress(h.address)) {
      flags.push({
        kind: "cap_renounced",
        severity: "info",
        summary: `The UpgradeCap was sent to ${h.address} at ${at.timestamp}, an address nobody holds a key for. Upgrade rights are renounced.`,
        txs,
      });
    } else if (h.kind === "immutable") {
      flags.push({
        kind: "cap_frozen",
        severity: "info",
        summary: `The UpgradeCap was frozen at ${at.timestamp}. An immutable object cannot be passed by mutable reference, so authorize_upgrade can no longer be called with it.`,
        txs,
      });
    } else if (h.kind === "shared") {
      flags.push({
        kind: "cap_shared",
        severity: "high",
        summary: `The UpgradeCap is a shared object (since ${at.timestamp}). 0x2::package::authorize_upgrade is public and takes the cap by mutable reference, and any transaction can pass a shared object that way, so any sender can upgrade this package.`,
        txs,
      });
    }
  }

  const order = { high: 0, medium: 1, info: 2 } as const;
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}

/* ------------------------------------------------------------------ *
 * Point-in-time: who held upgrade authority at T, which version was newest
 * ------------------------------------------------------------------ */

export type AsOfPoint = { checkpoint: number } | { ms: number; iso: string };

/** A decimal string is a checkpoint, `now` is the current time, anything else must parse as a date. */
export function parseAsOf(value: string, nowMs: number = Date.now()): AsOfPoint {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return { checkpoint: Number(trimmed) };
  const t = trimmed.toLowerCase() === "now" ? nowMs : Date.parse(trimmed);
  if (Number.isNaN(t)) {
    throw new Error(
      `Could not parse as_of '${value}'. Use an ISO 8601 timestamp (2025-09-07T16:03:00Z), 'now', or a checkpoint number.`,
    );
  }
  return { ms: t, iso: new Date(t).toISOString() };
}

/** Did `p` happen at or before `at`? Null when `p` lacks the field `at` is measured in. */
export function atOrBefore(p: ChainPoint, at: AsOfPoint): boolean | null {
  if ("checkpoint" in at) return p.checkpoint === null ? null : p.checkpoint <= at.checkpoint;
  const t = ms(p);
  return t === null ? null : t <= at.ms;
}

export interface StateAsOf {
  /** The newest version published at or before the point. */
  latest_version: PublishedVersion | null;
  cap_state: "not_created" | "held" | "deleted" | "wrapped";
  /** The cap's owner at the point; null when it did not exist then. */
  holder: OwnerDesc | null;
  /** The transaction that put the cap with that holder. */
  holder_since: (ChainPoint & { sender: string | null }) | null;
  policy: number | null;
  /** Events whose position could not be compared with the point. */
  unordered: number;
}

export function stateAsOf(
  at: AsOfPoint,
  versions: PublishedVersion[],
  caps: CapVersion[],
  end: CapEnd | null,
): StateAsOf {
  let unordered = 0;
  let latest: PublishedVersion | null = null;
  for (const v of versions) {
    const b = atOrBefore(v, at);
    if (b === null) unordered++;
    else if (b && (!latest || v.version > latest.version)) latest = v;
  }

  if (end && atOrBefore(end, at) === true) {
    return { latest_version: latest, cap_state: end.kind, holder: null, holder_since: null, policy: null, unordered };
  }

  let idx = -1;
  for (let i = 0; i < caps.length; i++) {
    const b = atOrBefore(caps[i], at);
    if (b === null) {
      unordered++;
      continue;
    }
    if (!b) break;
    idx = i;
  }
  if (idx < 0) {
    return { latest_version: latest, cap_state: "not_created", holder: null, holder_since: null, policy: null, unordered };
  }
  // Walk back to where this holder's custody began.
  let start = idx;
  while (start > 0 && ownerKey(caps[start - 1].owner) === ownerKey(caps[idx].owner)) start--;
  const s = caps[start];
  return {
    latest_version: latest,
    cap_state: "held",
    holder: caps[idx].owner,
    holder_since: { tx: s.tx, timestamp: s.timestamp, checkpoint: s.checkpoint, sender: s.sender },
    policy: caps[idx].policy,
    unordered,
  };
}
