/**
 * What a round trip inside a router path cost, read from the pools' own swap
 * events. Pure: `get_transaction` passes the transaction it already read.
 *
 * The sender's balance changes net the whole PTB, and the coin a loop starts
 * from is the coin the route spends or earns elsewhere, so they never isolate
 * a loop. Only pool events carry the amount one hop took in and paid out.
 */
import type { GrpcTypes } from "@mysten/sui/grpc";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import type { RouteHop, RouteLoop } from "../protocols/decoder.js";
import { canonicalId, readSwap, typeArgsOf } from "./attack-analysis.js";
import { eventCommands } from "./command-attribution.js";
import { formatCoinAmount } from "./coin-amount.js";
import { displayCoin } from "./valuation.js";

/**
 * Swap events whose pool id, direction and amounts `readSwap` reads, checked
 * on router transactions whose consecutive hops carry one event's
 * `amount_out` into the next one's `amount_in`: Cetus and Full Sail
 * `pool::SwapEvent` (`atob`, `amount_in`, `amount_out`), Bluefin
 * `events::AssetSwap` (`a2b`, `amount_in`, `amount_out`), Momentum
 * `trade::SwapEvent` and FlowX CLMM `pool::Swap` (`x_for_y`, `amount_x`,
 * `amount_y`). Any other event shape leaves a hop unmatched.
 */
const VERIFIED_SWAP_EVENTS: Record<string, true> = {
  "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent": true,
  "0xe74104c66dd9f16b3096db2cc00300e556aa92edc871be4bc052b5dfb80db239::pool::SwapEvent": true,
  "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::events::AssetSwap": true,
  "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::SwapEvent": true,
  "0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d::pool::Swap": true,
};

/** An event as the transaction carries it; `json` is undefined when its fields were not read. */
export interface LoopEvent {
  type: string;
  package_id?: string | null;
  module?: string | null;
  json: unknown;
}

export interface RouteLoopReport {
  /** First and last index in `actions` of the loop's hops. */
  hops: [number, number];
  coins: string;
  /** What the loop's first hop took in and its last hop gave back, formatted; null when unmatched. */
  sent: string | null;
  returned: string | null;
  /** Sent minus returned, formatted; negative when more came back. Null when unknown. */
  cost: string | null;
  cost_method: "pool_events" | "unknown";
  /**
   * Why the cost is unknown, present only then: the transaction emitted no
   * events, their fields were not read, a hop matched no verified pool swap
   * event, or the matched amounts do not carry from hop to hop.
   */
  cost_unknown?: "no_events" | "fields_unread" | "unmatched" | "amounts_do_not_chain";
  /** Present when the loop is its path's whole share of a route that starts and ends in the loop's coin. */
  whole_trade?: true;
  note: string;
}

interface Swap {
  index: number;
  commands: number[];
  coin_in: string;
  coin_out: string;
  amount_in: bigint;
  amount_out: bigint;
}

function typeKey(t: string): string {
  try {
    return normalizeStructTag(t);
  } catch {
    return t;
  }
}

/** Verified pool swaps with their coins from the pool's type, and the commands each can have come from. */
function poolSwaps(commands: GrpcTypes.Command[], events: LoopEvent[], objects: Array<{ objectId?: string; objectType?: string | null }>): Swap[] {
  const calls = commands.map((cmd) => {
    const c = cmd.command;
    return c.oneofKind === "moveCall" ? { type: "MoveCall", target: `${normalizeSuiAddress(c.moveCall.package ?? "0x0")}::${c.moveCall.module ?? ""}::${c.moveCall.function ?? ""}` } : { type: c.oneofKind ?? "" };
  });
  const byCommand = eventCommands(events, calls);
  if (!byCommand) return [];
  const typeById = new Map<string, string | null>();
  for (const o of objects) {
    const id = canonicalId(o.objectId);
    if (id && o.objectType && !/^0x0*2::(coin::Coin|dynamic_field::Field)</.test(o.objectType)) typeById.set(id, o.objectType);
  }
  const out: Swap[] = [];
  events.forEach((e, index) => {
    if (!VERIFIED_SWAP_EVENTS[typeKey(e.type.split("<")[0])]) return;
    const s = readSwap({ index, type: e.type, json: e.json }, typeById);
    if (!s || s.a_to_b === null || s.amount_in === null || s.amount_out === null || !s.pool) return;
    const args = typeArgsOf(typeById.get(s.pool) ?? "");
    if (args.length < 2) return;
    const [a, b] = [typeKey(args[0]), typeKey(args[1])];
    out.push({
      index,
      commands: byCommand[index],
      coin_in: s.a_to_b ? a : b,
      coin_out: s.a_to_b ? b : a,
      amount_in: BigInt(s.amount_in),
      amount_out: BigInt(s.amount_out),
    });
  });
  return out;
}

/**
 * Each hop's pool swap: the next verified swap event, in emission order, that
 * the hop's command can have emitted and that moved the hop's coin in and its
 * coin out. A hop none fits stays unmatched and moves no later hop's floor.
 */
function matchHops(hops: RouteHop[], swaps: Swap[]): Map<RouteHop, Swap> {
  const matched = new Map<RouteHop, Swap>();
  let floor = -1;
  for (const hop of hops) {
    const cin = typeKey(hop.coin_in);
    const cout = typeKey(hop.coin_out);
    const hit = swaps.find((s) => s.index > floor && s.commands.includes(hop.command) && s.coin_in === cin && s.coin_out === cout);
    if (!hit) continue;
    matched.set(hop, hit);
    floor = hit.index;
  }
  return matched;
}

const LEAD = "A loop is a lead about execution quality and says nothing about intent.";

/**
 * One report per loop of a successful transaction; a failed one swapped
 * nothing, since its effects were reverted. `events` is what the
 * transaction emitted with its fields, or `{ unread }` saying why the fields
 * are missing.
 */
export function describeRouteLoops(
  loops: RouteLoop[],
  allHops: RouteHop[],
  tx: {
    success: boolean;
    commands: GrpcTypes.Command[];
    events: LoopEvent[] | { unread: string };
    objects: Array<{ objectId?: string; objectType?: string | null }>;
  },
): RouteLoopReport[] {
  if (!tx.success || loops.length === 0) return [];
  const events = Array.isArray(tx.events) ? tx.events : [];
  const unread = Array.isArray(tx.events) ? null : tx.events.unread;
  const matched = matchHops(allHops, poolSwaps(tx.commands, events, tx.objects));
  return loops.map(({ hops, whole_trade }) => {
    const first = hops[0];
    const last = hops[hops.length - 1];
    const coin = first.coin_in;
    const symbol = displayCoin(coin).symbol;
    const coins = [coin, ...hops.map((h) => h.coin_out)].map((t) => displayCoin(t).symbol).join(" → ");
    const span = `actions ${first.action} to ${last.action}`;
    const base = { hops: [first.action, last.action] as [number, number], coins, ...(whole_trade ? { whole_trade: true as const } : {}) };

    let unknown: { code: NonNullable<RouteLoopReport["cost_unknown"]>; reason: string } | null = null;
    const missing = hops.filter((h) => !matched.has(h));
    if (unread !== null) unknown = { code: "fields_unread", reason: unread };
    else if (events.length === 0) unknown = { code: "no_events", reason: "the transaction emitted no events" };
    else if (missing.length)
      unknown = {
        code: "unmatched",
        reason: `no pool swap event of a verified shape matched action${missing.length > 1 ? "s" : ""} ${missing.map((h) => h.action).join(", ")} by command, coins and direction`,
      };
    else if (hops.some((h, k) => k > 0 && matched.get(hops[k - 1])!.amount_out !== matched.get(h)!.amount_in))
      unknown = { code: "amounts_do_not_chain", reason: "the matched pool events' amounts do not carry from one hop to the next" };

    const trade = `The route starts and ends in ${symbol}, so the round trip ${coins} (${span}) is its path's whole share of the routed trade`;
    if (unknown) {
      const because = `because ${unknown.reason}, and the sender's balance changes cannot stand in since they net the whole transaction.`;
      return {
        ...base,
        sent: null,
        returned: null,
        cost: null,
        cost_method: "unknown",
        cost_unknown: unknown.code,
        note: whole_trade
          ? `${trade}; its result is unknown ${because}`
          : `The route sent ${symbol} through a loop, ${coins} (${span}), that came back to ${symbol}; what it cost is unknown ${because} ${LEAD}`,
      };
    }
    const inAmount = matched.get(first)!.amount_in;
    const outAmount = matched.get(last)!.amount_out;
    const sent = formatCoinAmount(inAmount, coin);
    const returned = formatCoinAmount(outAmount, coin);
    const cost = formatCoinAmount(inAmount - outAmount, coin);
    const diff = formatCoinAmount(outAmount > inAmount ? outAmount - inAmount : inAmount - outAmount, coin);
    const moved = `${sent} went in and ${returned} came back by the pools' own swap events`;
    if (whole_trade) {
      const result = outAmount > inAmount ? `${diff} more than went in` : outAmount < inAmount ? `${diff} less than went in` : "exactly what went in";
      return {
        ...base,
        sent,
        returned,
        cost,
        cost_method: "pool_events",
        note: `${trade}: ${moved}, ${result}. Gas and any fee the router charged outside the pools are not counted.`,
      };
    }
    const outcome = outAmount < inAmount ? `so the loop cost ${diff}` : outAmount === inAmount ? "so the loop cost nothing" : `so ${diff} more came back than went in`;
    return {
      ...base,
      sent,
      returned,
      cost,
      cost_method: "pool_events",
      note: `The route sent ${sent} through a loop, ${coins} (${span}), that came back to ${symbol}, and ${returned} returned by the pools' own swap events, ${outcome}. ${LEAD}`,
    };
  });
}
