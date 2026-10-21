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

const MEMEZ_EVENT = "0x779829966a2e8642c310bed79e6ba603e5acd3c31b25d7d4511e2c9303d6e3ef";

/** A memez Pump/Dump event wraps its pool, coin types and amounts in pos0. */
function memezSwap(event: SwapEventInput, targets: EventTargets): { pool: string; coinIn: string; coinOut: string } | null {
  const type = canonicalType(event.type);
  const pump = type === `${MEMEZ_EVENT}::memez_events_wrapper::Event<${MEMEZ_EVENT}::memez_events::Pump>`;
  const dump = type === `${MEMEZ_EVENT}::memez_events_wrapper::Event<${MEMEZ_EVENT}::memez_events::Dump>`;
  if (!pump && !dump) return null;
  const fields = (event.json as { pos0?: Record<string, unknown> } | null)?.pos0;
  const pool = typeof fields?.memez_fun === "string" ? normalizeSuiAddress(fields.memez_fun) : null;
  if (!pool || (!targets.shared.has(pool) && !targets.others.has(pool))) return null;
  const token = canonicalType(typeof fields?.meme === "string" ? fields.meme : null);
  const quote = canonicalType(typeof fields?.quote === "string" ? fields.quote : null);
  const amountIn = fields?.[pump ? "quote_amount_in" : "meme_amount_in"];
  const amountOut = fields?.[pump ? "meme_amount_out" : "quote_amount_out"];
  if (!token || !quote || token === quote ||
    typeof amountIn !== "string" || !/^[1-9]\d*$/.test(amountIn) ||
    typeof amountOut !== "string" || !/^[1-9]\d*$/.test(amountOut)) return null;
  return { pool, coinIn: pump ? quote : token, coinOut: pump ? token : quote };
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
  const memez = memezSwap(event, targets);
  if (memez) return memez;
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

// Liquid-staking issuers' own mint and redeem events state both sides of a
// SUI <-> LST swap. Each key is the event's defining type, which an upgrade
// does not change. The SpringSui framework and the stSUI fork of it name the
// LST in `typename`; Haedal and Volo issue one LST each, so the event type
// names it. Volo's older `native_pool` event beside `stake_pool`'s states the
// same unstake again, so only `stake_pool`'s is read.
interface IssuerEvent {
  coin: string | null;
  suiField: string;
  lstField: string;
  mint: boolean;
}
const SUI_TYPE = normalizeStructTag("0x2::sui::SUI");
const SPRINGSUI = "0xb0575765166030556a6eafd3b1b970eba8183ff748860680245b9edd41c716e7";
const STSUI_FORK = "0xc35ee7fee75782806890cf8ed8536b52b4ba0ace0fb46b944f1155cc5945baa3";
const HAEDAL = "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d";
const HASUI = normalizeStructTag(`${HAEDAL}::hasui::HASUI`);
const VOLO = "0x68d22cf8bdbcd11ecba1e094922873e4080d4d11133e2443fddda0bfd11dae20";
const VSUI = normalizeStructTag("0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT");
const LST_MINT = { coin: null, suiField: "sui_amount_in", lstField: "lst_amount_out", mint: true };
const LST_REDEEM = { coin: null, suiField: "sui_amount_out", lstField: "lst_amount_in", mint: false };
const ISSUER_EVENTS: Record<string, IssuerEvent> = {
  [`${SPRINGSUI}::events::Event<${SPRINGSUI}::liquid_staking::MintEvent>`]: LST_MINT,
  [`${SPRINGSUI}::events::Event<${SPRINGSUI}::liquid_staking::RedeemEvent>`]: LST_REDEEM,
  [`${STSUI_FORK}::events::Event<${STSUI_FORK}::liquid_staking::MintEvent>`]: LST_MINT,
  [`${STSUI_FORK}::events::Event<${STSUI_FORK}::liquid_staking::RedeemEvent>`]: LST_REDEEM,
  [`${HAEDAL}::staking::UserStaked`]: { coin: HASUI, suiField: "sui_amount", lstField: "st_amount", mint: true },
  [`${HAEDAL}::staking::UserInstantUnstaked`]: { coin: HASUI, suiField: "sui_amount", lstField: "st_amount", mint: false },
  [`${VOLO}::stake_pool::StakeEventExt`]: { coin: VSUI, suiField: "sui_amount_in", lstField: "lst_amount_out", mint: true },
  [`${VOLO}::stake_pool::UnstakeEventExt`]: { coin: VSUI, suiField: "sui_amount_out", lstField: "lst_amount_in", mint: false },
};

/** The coins an issuer's mint or redeem event says went in and out, when it states both amounts. */
function issuerSwap(event: SwapEventInput): [string, string] | null {
  const type = canonicalType(event.type);
  const spec = type ? ISSUER_EVENTS[type] : undefined;
  if (!spec) return null;
  const j = event.json as Record<string, unknown> | null;
  const fields = (spec.coin ? j : j?.event) as Record<string, unknown> | null | undefined;
  if (!fields || typeof fields !== "object") return null;
  const sui = fields[spec.suiField];
  const lst = fields[spec.lstField];
  if (typeof sui !== "string" || typeof lst !== "string" || !/^[1-9]\d*$/.test(sui) || !/^[1-9]\d*$/.test(lst)) return null;
  const coin = spec.coin ?? canonicalType(typeof fields.typename === "string" ? fields.typename : null);
  if (!coin || coin === SUI_TYPE) return null;
  return spec.mint ? [SUI_TYPE, coin] : [coin, SUI_TYPE];
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
  // An issuer's mint or redeem event is a swap of the call that emitted it
  // when the emitter and the event's order leave one call, named `swap…`,
  // whose type argument, if it has one, is the LST. Several calls that could
  // have emitted it keep the fallback reading, as an unplaced pool swap does.
  // Each call's legs, pool swaps and issuer swaps, are listed in event order.
  // A router event beside an issuer event of its call, stating the same coins
  // with no other leg of the call between them, echoes that swap (Cetus
  // aggregator's `router::SwapEvent`): the two are one leg.
  const legs: { index: number; command: number; pair: [string, string]; issuer: boolean }[] = [];
  swaps.forEach((s, k) => {
    const command = placed[k];
    if (command !== null) legs.push({ index: s.index, command, pair: [s.coinIn, s.coinOut], issuer: false });
  });
  evidence.events.forEach((event, index) => {
    const pair = issuerSwap(event);
    const possible = emitters?.[index];
    if (!pair || !possible) return;
    const lst = pair[0] === SUI_TYPE ? pair[1] : pair[0];
    const fits = possible.filter((i) => {
      const c = commands[i].command;
      if (c.oneofKind !== "moveCall" || !c.moveCall.function?.startsWith("swap")) return false;
      const types = c.moveCall.typeArguments ?? [];
      return types.length === 0 || (types.length === 1 && canonicalType(types[0]) === lst);
    });
    if (possible.length === 1 && fits.length === 1) legs.push({ index, command: fits[0], pair, issuer: true });
    else for (const i of fits) incomplete.add(i);
  });
  legs.sort((a, b) => a.index - b.index);
  const byCommand = new Map<number, typeof legs>();
  for (const leg of legs) if (!incomplete.has(leg.command)) byCommand.set(leg.command, [...(byCommand.get(leg.command) ?? []), leg]);
  for (const [command, list] of byCommand) {
    const kept = list.filter((leg, n) => !leg.issuer || ![list[n - 1], list[n + 1]].some((o) => o && !o.issuer && o.pair[0] === leg.pair[0] && o.pair[1] === leg.pair[1]));
    out.set(command, kept.map((leg) => leg.pair));
  }
  return out;
}
