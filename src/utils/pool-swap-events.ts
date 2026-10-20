/**
 * The pool swaps a transaction's own events state, attributed to the PTB
 * command that ran each one. A pool's swap event names the pool and which
 * way the swap went, so the coins in and out are read from it rather than
 * guessed from a call's type-argument order or the sender's net change.
 */
import { GrpcTypes } from "@mysten/sui/grpc";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { poolOfEvent, readSwap, typeArgsOf, type EventTargets } from "./attack-analysis.js";
import { eventCommands } from "./command-attribution.js";

/** One event as the decoder takes it: the emitting call's package and module, the type, and the decoded fields. */
export interface SwapEventInput {
  packageId?: string | null;
  module?: string | null;
  type: string;
  json: unknown;
}

/** What the transaction itself says about the objects its events name. */
export interface SwapEvidence {
  events: SwapEventInput[];
  /** Object id of each PTB input, null for a pure input. */
  inputObjectIds: (string | null)[];
  /** Changed objects other than coins and dynamic fields, id to type. */
  objectTypes: ReadonlyMap<string, string | null>;
}

/**
 * A coin type, canonical, or null for anything that is not one: a key that
 * does not start with a hex address (Nemo's `PT<…>` position unit, which
 * `readSwap` names as a swap's side) labels no swap.
 */
function canonicalType(t: string | null | undefined): string | null {
  if (!t || !/^(0x)?[0-9a-fA-F]+::/.test(t)) return null;
  try {
    return normalizeStructTag(t.startsWith("0x") ? t : `0x${t}`);
  } catch {
    return null;
  }
}

/**
 * The coins one event says a pool took in and paid out, and the pool, or
 * null. Coins come from fields that name them (Aftermath's `types_in` and
 * `types_out`, one each; a router's `from` and `target`; the coin-named
 * shapes `readSwap` reads), otherwise
 * from the direction flag (`atob`, `a2b`, `a_to_b`, `x_for_y`, or which side
 * an amount went in on) against the pool object's first two type arguments.
 * A flash swap's event counts: the pool swapped in the stated direction,
 * and the PTB's repay paid the input coin.
 */
export function readPoolSwap(event: SwapEventInput, index: number, targets: EventTargets): { pool: string; coinIn: string; coinOut: string } | null {
  const pool = poolOfEvent(event.json, targets);
  if (!pool) return null;
  const j = event.json as Record<string, unknown> | null;
  const typesIn = Array.isArray(j?.types_in) ? j.types_in : null;
  const typesOut = Array.isArray(j?.types_out) ? j.types_out : null;
  if (typesIn && typesOut) {
    const coinIn = typesIn.length === 1 ? canonicalType(String(typesIn[0])) : null;
    const coinOut = typesOut.length === 1 ? canonicalType(String(typesOut[0])) : null;
    return coinIn && coinOut && coinIn !== coinOut ? { pool, coinIn, coinOut } : null;
  }
  const typeName = (v: unknown) => canonicalType(typeof v === "string" ? v : ((v as { name?: unknown } | null)?.name as string | undefined));
  if (j && "from" in j && "target" in j) {
    const coinIn = typeName(j.from);
    const coinOut = typeName(j.target);
    return coinIn && coinOut && coinIn !== coinOut ? { pool, coinIn, coinOut } : null;
  }
  const swap = readSwap({ index, type: event.type, json: event.json }, targets, { flash: true });
  if (!swap) return null;
  if (swap.coin_in && swap.coin_out) {
    const coinIn = canonicalType(swap.coin_in);
    const coinOut = canonicalType(swap.coin_out);
    return coinIn && coinOut && coinIn !== coinOut ? { pool, coinIn, coinOut } : null;
  }
  if (swap.a_to_b === null) return null;
  const [a, b] = typeArgsOf(targets.shared.get(pool) ?? targets.others.get(pool) ?? "").map(canonicalType);
  if (!a || !b || a === b) return null;
  return swap.a_to_b ? { pool, coinIn: a, coinOut: b } : { pool, coinIn: b, coinOut: a };
}

// The issuer's redemption event states both sides of an LST → SUI swap.
// A generic name or framework stake event alone cannot identify the LST:
// this event's defining type and its embedded coin type must both match.
const LST_REDEEM_EVENT = /^0xc35ee7fee75782806890cf8ed8536b52b4ba0ace0fb46b944f1155cc5945baa3::events::Event<0xc35ee7fee75782806890cf8ed8536b52b4ba0ace0fb46b944f1155cc5945baa3::liquid_staking::RedeemEvent>$/;
const SUI_TYPE = normalizeStructTag("0x2::sui::SUI");

function issuerRedeem(event: SwapEventInput): [string, string] | null {
  if (!LST_REDEEM_EVENT.test(event.type)) return null;
  const wrapper = event.json;
  if (!wrapper || typeof wrapper !== "object" || !("event" in wrapper) ||
      !wrapper.event || typeof wrapper.event !== "object") return null;
  const fields = wrapper.event;
  if (!("lst_amount_in" in fields) || typeof fields.lst_amount_in !== "string" || !/^[1-9]\d*$/.test(fields.lst_amount_in) ||
      !("sui_amount_out" in fields) || typeof fields.sui_amount_out !== "string" || !/^[1-9]\d*$/.test(fields.sui_amount_out)) return null;
  const coin = canonicalType("typename" in fields && typeof fields.typename === "string" ? fields.typename : null);
  return coin && coin !== SUI_TYPE ? [coin, SUI_TYPE] : null;
}

/**
 * For each Move call, the pool swaps it ran, in emission order. A pool's
 * own event and a router's event of another type repeating the same pool
 * and direction after it, with no other swap-named event between them (a
 * pool's `Pay`, fee or flash-repay event may sit between), are one swap. A
 * swap goes to the call
 * that takes its pool as an argument and whose package and module could have
 * emitted it, never to a call that repays (a flash swap's repay takes the
 * same pool); when no call that could have emitted it takes the pool, to the
 * one call that could have emitted it. Swaps of one pool that each fit
 * several calls pair with those calls in order when there are as many calls
 * as swaps. A swap that cannot be placed on one call this way labels nothing,
 * and neither does any swap of a call that may have run it, or may have run a
 * swap-named event about a changed object that does not read as a swap: such
 * a call keeps the decoder's fallback reading rather than a label listing
 * some of its swaps.
 */
export function poolSwapsByCommand(commands: GrpcTypes.Command[], evidence: SwapEvidence): Map<number, [string, string][]> {
  const out = new Map<number, [string, string][]>();
  if (!evidence.events.length) return out;
  const targets: EventTargets = { shared: evidence.objectTypes, others: new Map() };
  const resolved = commands.map((c) =>
    c.command.oneofKind === "moveCall"
      ? { type: "MoveCall", target: `${c.command.moveCall.package}::${c.command.moveCall.module}::${c.command.moveCall.function}` }
      : { type: c.command.oneofKind ?? "" },
  );
  const emitters = eventCommands(
    evidence.events.map((e) => ({ package_id: e.packageId ?? null, module: e.module ?? null })),
    resolved,
  );
  const poolArgs = commands.map((c) => {
    if (c.command.oneofKind !== "moveCall" || (c.command.moveCall.function ?? "").startsWith("repay")) return new Set<string>();
    const ids = (c.command.moveCall.arguments ?? [])
      .filter((a) => a.kind === GrpcTypes.Argument_ArgumentKind.INPUT && a.input !== undefined)
      .map((a) => evidence.inputObjectIds[a.input!])
      .filter((id): id is string => !!id)
      .map((id) => normalizeSuiAddress(id));
    return new Set(ids);
  });

  // Each swap once: an echo of the swap before it is dropped. A
  // swap-named event about a changed object that does not read as a swap is
  // kept apart: the call that ran it has a swap no label could state, unless
  // an event of another type right beside it reads as a swap of the same
  // pool (a router's echo of a pool event this reader cannot read, or the
  // reverse).
  const swaps: { index: number; pool: string; coinIn: string; coinOut: string }[] = [];
  const read = new Map<number, string>();
  let unread: { index: number; pool: string }[] = [];
  evidence.events.forEach((event, index) => {
    const hop = readPoolSwap(event, index, targets);
    if (!hop) {
      const name = event.type.split("<")[0].split("::").pop() ?? "";
      const pool = /swap/i.test(name) && !/repay/i.test(name) ? poolOfEvent(event.json, targets) : null;
      if (pool) unread.push({ index, pool });
      return;
    }
    read.set(index, hop.pool);
    const last = swaps[swaps.length - 1];
    const echo =
      last &&
      last.pool === hop.pool &&
      last.coinIn === hop.coinIn &&
      last.coinOut === hop.coinOut &&
      evidence.events[last.index].type.split("<")[0] !== event.type.split("<")[0] &&
      !evidence.events.slice(last.index + 1, index).some((e) => /swap/i.test(e.type.split("<")[0].split("::").pop() ?? "") && !/repay/i.test(e.type.split("<")[0].split("::").pop() ?? ""));
    if (!echo) swaps.push({ index, ...hop });
  });
  const base = (i: number) => evidence.events[i].type.split("<")[0];
  const pairedWith = (u: { index: number; pool: string }, i: number) => read.get(i) === u.pool && base(i) !== base(u.index);
  unread = unread.filter((u) => !pairedWith(u, u.index - 1) && !pairedWith(u, u.index + 1));

  // The calls each event can have come from: those taking its pool that its
  // package and module could have emitted it from, or, when none of those
  // takes the pool, those that could have emitted it.
  const callable = (i: number) => {
    const c = commands[i].command;
    return c.oneofKind === "moveCall" && !(c.moveCall.function ?? "").startsWith("repay");
  };
  const candidatesOf = (s: { index: number; pool: string }) => {
    const taking = poolArgs.flatMap((ids, i) => (ids.has(s.pool) ? [i] : []));
    const emittedBy = emitters?.[s.index];
    if (!emittedBy) return taking;
    const both = taking.filter((i) => emittedBy.includes(i));
    return both.length ? both : emittedBy.filter(callable);
  };
  const candidates = swaps.map(candidatesOf);
  const placed = candidates.map((c) => (c.length === 1 ? c[0] : null));
  // Several swaps of one pool that each could be several calls: as many
  // calls as swaps between them, in order, each within the swap's own set.
  for (const pool of new Set(swaps.map((s) => s.pool))) {
    const open = swaps.flatMap((s, k) => (s.pool === pool && placed[k] === null && candidates[k].length > 1 ? [k] : []));
    const calls = [...new Set(open.flatMap((k) => candidates[k]))].sort((a, b) => a - b);
    if (open.length > 1 && calls.length === open.length && open.every((k, n) => candidates[k].includes(calls[n])))
      open.forEach((k, n) => (placed[k] = calls[n]));
  }
  // A call that may have run a swap left unread or unplaced would be
  // labelled with only some of its swaps, so it keeps the fallback reading.
  const incomplete = new Set([...unread.flatMap(candidatesOf), ...swaps.flatMap((_, k) => (placed[k] === null ? candidates[k] : []))]);
  swaps.forEach((s, k) => {
    const command = placed[k];
    if (command !== null && !incomplete.has(command)) out.set(command, [...(out.get(command) ?? []), [s.coinIn, s.coinOut]]);
  });
  // An issuer can redeem an LST without a pool swap event. The emitter and
  // the event's order identify its call, and the issuer's own event names
  // the LST and the SUI it paid. Do not infer a leg when several calls could
  // have emitted the event or another pool swap of this call is unread.
  let issuerHops: Map<number, [string, string][]> | null = null;
  for (let i = 0; i < evidence.events.length; i++) {
    const pair = issuerRedeem(evidence.events[i]);
    const possible = emitters?.[i];
    if (!pair || possible?.length !== 1) continue;
    const at = possible[0];
    const call = commands[at].command;
    if (call.oneofKind !== "moveCall" || !call.moveCall.function?.startsWith("swap") ||
        call.moveCall.typeArguments?.length !== 1 || canonicalType(call.moveCall.typeArguments[0]) !== pair[0]) continue;
    issuerHops ??= new Map();
    const pairs = issuerHops.get(at);
    if (pairs) pairs.push(pair);
    else issuerHops.set(at, [pair]);
  }
  if (issuerHops) for (const [at, pairs] of issuerHops) if (!out.has(at) && !incomplete.has(at)) out.set(at, pairs);
  return out;
}
