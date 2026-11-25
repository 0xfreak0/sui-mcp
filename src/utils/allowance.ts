/**
 * Native allowances (`0x2::allowance`): a funder authorizes a spender to
 * withdraw from the funder's address balance, within limits, without the
 * funder signing each spend.
 *
 * - `new<T>` is `entry`, so only the funder's own transaction creates one.
 *   It shares an `Allowance<Balance<C>>` holding the settings and sends an
 *   `AllowanceCap<T>` to the funder. The cap has `key` and no `store`, so it
 *   cannot leave the funder, and `revoke` deletes both. The funder's caps are
 *   therefore the complete set of that funder's live allowances.
 * - A spend is a PTB whose `FundsWithdrawal` input draws from the funder's
 *   balance (`withdrawFrom: SenderAllowance { funder, allowance }`) and whose
 *   `balance_spend` or `app_balance_spend` call checks it against the shared
 *   allowance. The spender signs and pays gas; the funder does not sign.
 *   Balance changes then show the funder losing coins in a transaction it
 *   never signed, which reads as theft unless the allowance is reported.
 * - Nothing indexes allowances by spender, so the spender side is a scan of
 *   every `Allowance` object, bounded and cached like the alias scan.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork, type SuiNetwork } from "../config.js";
import type { FrameworkClaim } from "./framework-claims.js";

const ADDR2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
export const ALLOWANCE_TYPE = `${ADDR2}::allowance::Allowance`;
export const ALLOWANCE_CAP_TYPE = `${ADDR2}::allowance::AllowanceCap`;
const BALANCE_PREFIX = `${ADDR2}::balance::Balance<`;

/** The framework facts this module reads by. */
export const ALLOWANCE_CLAIMS: FrameworkClaim[] = [
  { struct: "allowance::Allowance", abilities: ["key"], fields: ["id", "settings", "current_spend"], why: "an allowance's limits and spend are read by field name" },
  {
    struct: "allowance::Settings",
    fields: ["funder", "spender", "app", "lifetime_cap", "start_timestamp_ms", "expiration_timestamp_ms", "rate_limit", "name"],
    why: "an allowance's settings are read by field name",
  },
  { struct: "allowance::AllowanceCap", abilities: ["key"], fields: ["id", "allowance"], why: "a cap cannot leave its funder, so the funder's caps are every live allowance it funds" },
  { struct: "allowance::RateLimit", fields: ["Windowed"], why: "a rate limit is read by variant name" },
  { struct: "allowance::Window", fields: ["PeriodicMs", "CalendarMonths"], why: "a rate-limit window is read by variant name" },
  { fn: "allowance::new", entry: true, calls: ["share_new"], why: "only the funder's own transaction creates a signer-path allowance" },
  { fn: "allowance::share_new", visibility: "private", calls: ["transfer::transfer", "transfer::share_object"], why: "an allowance is shared and its cap goes to the funder" },
  { fn: "allowance::balance_spend", visibility: "public", takes: { "allowance::Allowance": "&mut" }, why: "a signer-path spend draws on the allowance" },
  { fn: "allowance::app_balance_spend", visibility: "public", takes: { "allowance::Allowance": "&mut" }, why: "an app-bound spend draws on the allowance" },
  { fn: "allowance::revoke", visibility: "public", takes: { "allowance::AllowanceCap": "value", "allowance::Allowance": "value" }, why: "revoking deletes the allowance and its cap" },
  { fn: "allowance::rotate_spender", visibility: "public", takes: { "allowance::Allowance": "&mut" }, why: "an app-bound allowance's spender can change, so the spender is true only as of the read" },
];

/** Move calls that spend against an allowance. */
export const ALLOWANCE_SPEND_FUNCTIONS = new Set(["balance_spend", "app_balance_spend"]);

/** Whether a Move call target is one of the framework's allowance functions. */
export function isAllowanceCall(pkg: string | undefined, module: string | undefined): boolean {
  return !!pkg && module === "allowance" && normalizeSuiAddress(pkg) === ADDR2;
}

export type AllowanceStatus = "active" | "not_started" | "expired" | "exhausted";

export interface AllowanceRateLimit {
  window: { kind: "periodic"; period_ms: string } | { kind: "calendar_months"; months: number } | { kind: "unknown" };
  limit: string;
  /** Spent in the window the allowance last charged in, as stored. */
  recorded_spent: string;
  /** Start of the first window, set by the first spend; null until then. */
  anchor_ms: string | null;
  /** Spent in the window that holds `evaluated_at`: zero once the stored window has rolled over. */
  spent_in_current_window: string | null;
  remaining_in_current_window: string | null;
  /** When the current window ends, in UTC; null before the first spend or for an unknown window. */
  current_window_ends: string | null;
}

export interface AllowanceInfo {
  allowance_id: string;
  /** The coin `C` of `Allowance<Balance<C>>`; null for any other `T`. */
  coin_type: string | null;
  object_type: string | null;
  funder: string | null;
  spender: string | null;
  /** The app type an app-bound allowance requires (`app_balance_spend`); null for the signer path. */
  app: string | null;
  name: string | null;
  lifetime_cap: string | null;
  current_spend: string | null;
  remaining_lifetime: string | null;
  start_ms: string | null;
  expiration_ms: string | null;
  rate_limit: AllowanceRateLimit | null;
  status: AllowanceStatus;
  /**
   * The most the spender could take now under the allowance's limits; null
   * when a limit could not be read. The funder's balance bounds it as well.
   */
  spendable_now: string | null;
  evaluated_at: string;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

/** An `Option<T>` as GraphQL renders it: the value, null, or a one-element `vec`. */
function opt(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !Array.isArray(v) && "vec" in (v as Json)) {
    const vec = (v as Json).vec;
    return Array.isArray(vec) && vec.length > 0 ? vec[0] : null;
  }
  return v;
}

function intString(v: unknown): string | null {
  const x = opt(v);
  if (typeof x === "number" && Number.isSafeInteger(x) && x >= 0) return String(x);
  if (typeof x === "string" && /^\d+$/.test(x)) return BigInt(x).toString();
  return null;
}

function addr(v: unknown): string | null {
  const x = opt(v);
  return typeof x === "string" && /^(0x)?[0-9a-fA-F]{1,64}$/.test(x) ? normalizeSuiAddress(x) : null;
}

function str(v: unknown): string | null {
  const x = opt(v);
  return typeof x === "string" ? x : null;
}

/** A `TypeName` as a string, written with a `0x` address. */
function typeName(v: unknown): string | null {
  const x = opt(v);
  const raw = typeof x === "string" ? x : x && typeof x === "object" ? str((x as Json).name) : null;
  if (!raw) return null;
  return /^[0-9a-fA-F]{64}::/.test(raw) ? `0x${raw}` : raw;
}

/** The single positional field of an enum variant, however it is keyed. */
function positional(v: Json): unknown {
  for (const k of ["pos0", "0", "_0", "field0"]) if (k in v) return v[k];
  const rest = Object.keys(v).filter((k) => k !== "@variant");
  return rest.length === 1 ? v[rest[0]!] : undefined;
}

/** `T` in `outer<T>`, or null. */
function typeArgument(type: string | null | undefined, outer: string): string | null {
  if (!type) return null;
  const t = type.replace(/^0x0*2::/, `${ADDR2}::`);
  if (!t.startsWith(`${outer}<`) || !t.endsWith(">")) return null;
  return t.slice(outer.length + 1, -1);
}

/** The coin `C` of an `Allowance<Balance<C>>` or `AllowanceCap<Balance<C>>` type. */
export function allowanceCoinType(objectType: string | null | undefined): string | null {
  const inner = typeArgument(objectType, ALLOWANCE_TYPE) ?? typeArgument(objectType, ALLOWANCE_CAP_TYPE);
  if (!inner) return null;
  const t = inner.replace(/^0x0*2::balance::/, `${ADDR2}::balance::`);
  return t.startsWith(BALANCE_PREFIX) && t.endsWith(">") ? t.slice(BALANCE_PREFIX.length, -1) : null;
}

/* Civil-date arithmetic, as `allowance::civil_from_ms` and `elapsed_windows`. */

const MS_PER_DAY = 86_400_000;

function civilFromMs(ms: number): { y: number; m: number; d: number } {
  const date = new Date(Math.floor(ms / MS_PER_DAY) * MS_PER_DAY);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function elapsedWindows(anchorMs: number, nowMs: number, months: number): number {
  const a = civilFromMs(anchorMs);
  const n = civilFromMs(nowMs);
  let elapsed = n.y * 12 + n.m - (a.y * 12 + a.m);
  if (elapsed > 0 && n.d < Math.min(a.d, daysInMonth(n.y, n.m))) elapsed -= 1;
  return Math.floor(elapsed / months);
}

/** 00:00 UTC on the anchor's day-of-month, `months` after the anchor's month, clamped to the month's end. */
function calendarBoundary(anchorMs: number, months: number): number {
  const a = civilFromMs(anchorMs);
  const total = a.y * 12 + (a.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return Date.UTC(y, m - 1, Math.min(a.d, daysInMonth(y, m)));
}

function readRateLimit(raw: unknown, nowMs: number): AllowanceRateLimit | null {
  const r = opt(raw);
  if (!r || typeof r !== "object") return null;
  const rl = r as Json;
  const w = rl.window && typeof rl.window === "object" ? (rl.window as Json) : null;
  const variant = w ? str(w["@variant"]) : null;
  let window: AllowanceRateLimit["window"] = { kind: "unknown" };
  if (w && variant === "PeriodicMs") {
    const p = intString(positional(w));
    if (p && p !== "0") window = { kind: "periodic", period_ms: p };
  } else if (w && variant === "CalendarMonths") {
    const m = intString(positional(w));
    if (m && Number(m) > 0) window = { kind: "calendar_months", months: Number(m) };
  }
  const limit = intString(rl.limit);
  const spent = intString(rl.spent);
  const anchor = intString(rl.anchor_ms);
  const index = intString(rl.index);
  if (limit === null || spent === null) return null;

  let spentNow: bigint | null = null;
  let endsMs: number | null = null;
  if (anchor === null) {
    spentNow = 0n; // no spend yet: the first one anchors the windows
  } else if (window.kind !== "unknown" && index !== null) {
    const anchorMs = Number(anchor);
    const current =
      window.kind === "periodic"
        ? Math.floor((nowMs - anchorMs) / Number(window.period_ms))
        : elapsedWindows(anchorMs, nowMs, window.months);
    spentNow = current > Number(index) ? 0n : BigInt(spent);
    endsMs =
      window.kind === "periodic"
        ? anchorMs + (current + 1) * Number(window.period_ms)
        : calendarBoundary(anchorMs, (current + 1) * window.months);
  }
  const remaining = spentNow === null ? null : BigInt(limit) > spentNow ? BigInt(limit) - spentNow : 0n;
  return {
    window,
    limit,
    recorded_spent: spent,
    anchor_ms: anchor,
    spent_in_current_window: spentNow?.toString() ?? null,
    remaining_in_current_window: remaining?.toString() ?? null,
    current_window_ends: endsMs === null || !Number.isFinite(endsMs) ? null : new Date(endsMs).toISOString(),
  };
}

/**
 * An `Allowance` object's contents, with its status and what it still
 * permits at `nowMs`. Pure: every amount is read from the JSON given.
 */
export function parseAllowance(id: string, objectType: string | null, json: unknown, nowMs: number): AllowanceInfo {
  const j = json && typeof json === "object" ? (json as Json) : {};
  const s = j.settings && typeof j.settings === "object" ? (j.settings as Json) : {};
  const lifetimeCap = intString(s.lifetime_cap);
  const currentSpend = intString(j.current_spend);
  const start = intString(s.start_timestamp_ms);
  const expiration = intString(s.expiration_timestamp_ms);
  const rateLimit = readRateLimit(s.rate_limit, nowMs);
  const rateLimitSet = opt(s.rate_limit) !== null;

  const remainingLifetime =
    lifetimeCap !== null && currentSpend !== null
      ? BigInt(lifetimeCap) > BigInt(currentSpend)
        ? (BigInt(lifetimeCap) - BigInt(currentSpend)).toString()
        : "0"
      : null;

  let status: AllowanceStatus = "active";
  if (start !== null && nowMs < Number(start)) status = "not_started";
  else if (expiration !== null && nowMs >= Number(expiration)) status = "expired";
  else if (remainingLifetime === "0") status = "exhausted";

  // The tighter of the two limits. A limit set but unreadable leaves it unknown.
  let spendable: string | null = null;
  if (status !== "active") spendable = "0";
  else {
    const lifetimeOk = lifetimeCap === null || remainingLifetime !== null;
    const rateOk = !rateLimitSet || rateLimit?.remaining_in_current_window != null;
    if (lifetimeOk && rateOk) {
      const bounds = [remainingLifetime, rateLimitSet ? rateLimit!.remaining_in_current_window : null]
        .filter((b): b is string => b !== null)
        .map(BigInt);
      spendable = bounds.length ? bounds.reduce((a, b) => (a < b ? a : b)).toString() : null;
    }
  }

  return {
    allowance_id: normalizeSuiAddress(id),
    coin_type: allowanceCoinType(objectType),
    object_type: objectType,
    funder: addr(s.funder),
    spender: addr(s.spender),
    app: typeName(s.app),
    name: str(s.name),
    lifetime_cap: lifetimeCap,
    current_spend: currentSpend,
    remaining_lifetime: remainingLifetime,
    start_ms: start,
    expiration_ms: expiration,
    rate_limit: rateLimit,
    status,
    spendable_now: spendable,
    evaluated_at: new Date(nowMs).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Keys per multi-get: the service caps a request at 50 keys and 5,000 bytes. */
const MULTI_GET_BATCH = 40;

const MULTI_GET_QUERY = `query ($keys: [ObjectKey!]!) {
  multiGetObjects(keys: $keys) { address asMoveObject { contents { type { repr } json } } }
}`;

interface ObjectNode {
  address?: string;
  asMoveObject?: { contents?: { type?: { repr?: string }; json?: unknown } | null } | null;
}

/**
 * The current state of each allowance id that exists, keyed by normalized id.
 * An id absent from the result has no object now: a revoked allowance is
 * deleted. An object of another type is left out. A failed read throws.
 */
export async function readAllowances(ids: string[], nowMs = Date.now()): Promise<Map<string, AllowanceInfo>> {
  const unique = [...new Set(ids.map((i) => normalizeSuiAddress(i)))];
  const out = new Map<string, AllowanceInfo>();
  for (let i = 0; i < unique.length; i += MULTI_GET_BATCH) {
    const d = await gqlQuery<{ multiGetObjects?: Array<ObjectNode | null> }>(MULTI_GET_QUERY, {
      keys: unique.slice(i, i + MULTI_GET_BATCH).map((address) => ({ address })),
    });
    for (const o of d.multiGetObjects ?? []) {
      const type = o?.asMoveObject?.contents?.type?.repr ?? null;
      if (!o?.address || !isAllowanceType(type)) continue;
      out.set(normalizeSuiAddress(o.address), parseAllowance(o.address, type, o.asMoveObject?.contents?.json, nowMs));
    }
  }
  return out;
}

function isAllowanceType(type: string | null): boolean {
  return !!type && type.replace(/^0x0*2::/, `${ADDR2}::`).startsWith(`${ALLOWANCE_TYPE}<`);
}

/** Cap pages (50 each) read per funder. */
const FUNDER_CAP_PAGES = 10;

const FUNDER_CAPS_QUERY = `query ($a: SuiAddress!, $after: String) {
  address(address: $a) {
    objects(first: 50, after: $after, filter: { type: "0x2::allowance::AllowanceCap" }) {
      pageInfo { hasNextPage endCursor }
      nodes { address contents { type { repr } json } }
    }
  }
}`;

interface FunderCapsResult {
  address: {
    objects: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ address?: string; contents?: { type?: { repr?: string }; json?: { allowance?: unknown } | null } | null }>;
    } | null;
  } | null;
}

export interface FunderAllowances {
  /** Each with the id of the AllowanceCap that revokes it. */
  allowances: Array<AllowanceInfo & { cap_id: string }>;
  /** Caps held whose allowance could not be read as one (absent now, or another type). */
  caps_without_allowance: Array<{ cap_id: string; allowance_id: string | null }>;
  caps_read: number;
  complete: boolean;
}

/**
 * Every allowance `funder` funds, from the `AllowanceCap`s it holds. The cap
 * cannot be transferred, so this is the complete set while `complete` is true.
 */
export async function readFunderAllowances(funder: string, nowMs = Date.now()): Promise<FunderAllowances> {
  const caps: Array<{ cap_id: string; allowance_id: string | null }> = [];
  let after: string | null = null;
  let complete = true;
  for (let page = 0; ; page++) {
    if (page >= FUNDER_CAP_PAGES) {
      complete = false;
      break;
    }
    const r: FunderCapsResult = await gqlQuery<FunderCapsResult>(FUNDER_CAPS_QUERY, { a: funder, after });
    const objects = r.address?.objects;
    for (const n of objects?.nodes ?? []) {
      if (!n.address) continue;
      caps.push({ cap_id: normalizeSuiAddress(n.address), allowance_id: addr(n.contents?.json?.allowance) });
    }
    if (!objects?.pageInfo.hasNextPage) break;
    after = objects.pageInfo.endCursor;
    if (!after) {
      complete = false;
      break;
    }
  }
  const states = await readAllowances(
    caps.flatMap((c) => (c.allowance_id ? [c.allowance_id] : [])),
    nowMs,
  );
  const allowances: FunderAllowances["allowances"] = [];
  const orphans: FunderAllowances["caps_without_allowance"] = [];
  for (const c of caps) {
    const a = c.allowance_id ? states.get(c.allowance_id) : undefined;
    if (a) allowances.push({ ...a, cap_id: c.cap_id });
    else orphans.push(c);
  }
  return { allowances, caps_without_allowance: orphans, caps_read: caps.length, complete };
}

/* Spender side: a bounded, cached scan of every allowance. */

const SCAN_PAGE = 50;
/** Allowances read before a scan stops; the result then says `truncated`. */
const SCAN_CAP = 5000;
const SCAN_TTL_MS = 5 * 60 * 1000;

const SCAN_QUERY = `query ($first: Int!, $after: String) {
  objects(filter: { type: "${ALLOWANCE_TYPE}" }, first: $first, after: $after) {
    nodes { address asMoveObject { contents { type { repr } json } } }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface ScanResult {
  objects: { nodes: ObjectNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

export type AllowanceScanStatus = "complete" | "truncated" | "failed";

interface AllowanceScan {
  /** Spender -> allowance ids naming it. */
  bySpender: Map<string, Array<{ id: string; type: string | null; json: unknown }>>;
  scanned: number;
  status: AllowanceScanStatus;
  readAt: number;
  error?: string;
}

const scanCache = new Map<SuiNetwork, AllowanceScan>();

/** Test-only. */
export function resetAllowanceScanCache(): void {
  scanCache.clear();
}

async function scanAllowances(): Promise<AllowanceScan> {
  const network = getNetwork();
  const cached = scanCache.get(network);
  if (cached && Date.now() - cached.readAt < SCAN_TTL_MS) return cached;
  const readAt = Date.now();
  const bySpender: AllowanceScan["bySpender"] = new Map();
  let after: string | null = null;
  let scanned = 0;
  let status: AllowanceScanStatus = "complete";
  let error: string | undefined;
  try {
    for (;;) {
      const r: ScanResult = await gqlQuery<ScanResult>(SCAN_QUERY, { first: SCAN_PAGE, after });
      for (const n of r.objects.nodes) {
        scanned++;
        const json = n.asMoveObject?.contents?.json;
        const settings = json && typeof json === "object" ? (json as Json).settings : undefined;
        const spender = settings && typeof settings === "object" ? addr((settings as Json).spender) : null;
        if (!n.address || !spender) continue;
        const list = bySpender.get(spender) ?? [];
        list.push({ id: n.address, type: n.asMoveObject?.contents?.type?.repr ?? null, json });
        bySpender.set(spender, list);
      }
      if (!r.objects.pageInfo.hasNextPage) break;
      after = r.objects.pageInfo.endCursor;
      if (!after || scanned >= SCAN_CAP) {
        status = "truncated";
        break;
      }
    }
  } catch (e) {
    status = "failed";
    error = e instanceof Error ? e.message : String(e);
  }
  const scan: AllowanceScan = { bySpender, scanned, status, readAt, ...(error ? { error } : {}) };
  if (status !== "failed") scanCache.set(network, scan);
  return scan;
}

export interface SpenderAllowances {
  allowances: AllowanceInfo[];
  scanned: number;
  status: AllowanceScanStatus;
  /** When the scan read chain state; a cached scan keeps its own time. */
  as_of: string;
  error?: string;
}

/**
 * Every allowance whose spender is `spender`, from a scan of all `Allowance`
 * objects. Reused for five minutes, so a spender rotated or an allowance
 * revoked inside that window is not reflected; `as_of` says when it was read.
 */
export async function readSpenderAllowances(spender: string, nowMs = Date.now()): Promise<SpenderAllowances> {
  const scan = await scanAllowances();
  const hits = scan.bySpender.get(normalizeSuiAddress(spender)) ?? [];
  return {
    allowances: hits.map((h) => parseAllowance(h.id, h.type, h.json, nowMs)),
    scanned: scan.scanned,
    status: scan.status,
    as_of: new Date(scan.readAt).toISOString(),
    ...(scan.error ? { error: scan.error } : {}),
  };
}

/** The sentence beside any answer resting on the spender scan. */
export function spenderScanNote(s: Pick<SpenderAllowances, "status" | "scanned" | "as_of">): string {
  const base = `The spender side comes from a scan of every Allowance object, read at ${s.as_of} and reused for ${SCAN_TTL_MS / 60_000} minutes`;
  if (s.status === "complete") return `${base}; it read all ${s.scanned}.`;
  if (s.status === "truncated") return `${base}; it stopped after ${s.scanned} allowances, so an allowance naming this spender may be among those not read.`;
  return `${base}; the scan failed after ${s.scanned} allowances, so no allowance naming this spender can be ruled out.`;
}
