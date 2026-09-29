import type { GrpcTypes } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { formatCoinAmount } from "../utils/coin-amount.js";
import { coinScale, displayCoin, type CoinScale } from "../utils/valuation.js";
import { lookupProtocolDisplay, lookupOperation } from "./registry.js";
import { isVerifiedCoin } from "../utils/coin-registry.js";

export interface DecodedTransaction {
  protocols: string[];
  actions: string[];
  /**
   * The SENDER's balance changes, one per coin. On a row listed for some other
   * address, this is what the sender paid or received, not that address.
   */
  token_flow: {
    coin: string;
    amount: string;
    formatted: string | null;
    raw_type: string;
  }[];
}

/** One address's net change in one coin, signed: negative means it paid. */
export interface AddressFlow {
  coin: string;
  /** Raw base units, signed. */
  amount: string;
  /** Human units with the symbol, e.g. `"39.44771725 SUI"`. */
  formatted: string | null;
  raw_type: string;
  coin_verified: boolean | null;
  /** How the amount was scaled, present when no curated list vouches for the coin. */
  coin_scale?: Exclude<CoinScale["source"], "curated">;
}

/**
 * `address`'s own net balance change per coin in one transaction.
 *
 * `token_flow` is the sender's, so on a row in some other address's history an
 * inflow reads as the sender's outflow. This is the flow a history or timeline
 * row is actually about. Addresses are compared in canonical form, so a short
 * or unpadded address still matches the chain's padded one.
 */
export function addressFlow(
  balanceChanges: GrpcTypes.BalanceChange[],
  address: string,
): AddressFlow[] {
  const want = normalizeSuiAddress(address);
  const net = new Map<string, bigint>();
  for (const bc of balanceChanges) {
    if (!bc.address || !bc.coinType || normalizeSuiAddress(bc.address) !== want) continue;
    let value: bigint;
    try {
      value = BigInt(bc.amount ?? "0");
    } catch {
      continue;
    }
    net.set(bc.coinType, (net.get(bc.coinType) ?? 0n) + value);
  }
  const out: AddressFlow[] = [];
  for (const [coinType, value] of net) {
    if (value === 0n) continue;
    const coin = displayCoin(coinType);
    out.push({
      coin: shortCoinType(coinType),
      amount: value.toString(),
      formatted: formatCoinAmount(value, coinType),
      raw_type: coinType,
      // Structural, as in trace_funds: a report must see that the asset is
      // unidentified without parsing the formatted string.
      coin_verified: coin.verified,
      ...(coin.verified ? {} : { coin_scale: coinScale(coinType).source }),
    });
  }
  return out;
}

/**
 * The name a reader sees for a coin: the curated symbol when the list vouches
 * for this exact type, otherwise the struct name with its type arguments.
 * Wormhole's wrapped assets are all `<package>::coin::COIN`, so the struct
 * name alone named ten different assets `COIN`.
 */
function shortCoinType(coinType: string): string {
  return displayCoin(coinType).symbol;
}

const ACTION_LABELS: Record<string, string> = {
  swap: "Swap",
  add_liquidity: "Add liquidity",
  remove_liquidity: "Remove liquidity",
  open_position: "Open position",
  close_position: "Close position",
  deposit: "Deposit",
  withdraw: "Withdraw",
  borrow: "Borrow",
  repay: "Repay",
  flash_swap: "Flash swap",
  flash_loan: "Flash loan",
  flash_repay: "Repay flash loan",
  stake: "Stake",
  unstake: "Unstake",
  transfer: "Transfer",
  claim_rewards: "Claim rewards",
  liquidate: "Liquidate",
  create_obligation: "Create obligation",
  register: "Register",
  renew: "Renew",
  register_blob: "Register blob",
  certify_blob: "Certify blob",
  place_order: "Place order",
  cancel_order: "Cancel order",
};

function formatAction(action: string, protocol: string | null, typeArgs: string[]): string {
  const label = ACTION_LABELS[action] ?? action;

  if (action === "swap" && typeArgs.length >= 2) {
    const coinA = shortCoinType(typeArgs[0]);
    const coinB = shortCoinType(typeArgs[1]);
    const suffix = protocol ? ` on ${protocol}` : "";
    return `${label} ${coinA} → ${coinB}${suffix}`;
  }

  if ((action === "flash_loan" || action === "flash_repay") && typeArgs.length >= 1) {
    const coin = shortCoinType(typeArgs[0]);
    const via = protocol ? ` via ${protocol}` : "";
    return `${label} ${coin}${via}`;
  }

  if ((action === "deposit" || action === "withdraw" || action === "borrow" || action === "repay") && typeArgs.length >= 1) {
    const coin = shortCoinType(typeArgs[0]);
    const on = protocol ? ` on ${protocol}` : "";
    return `${label} ${coin}${on}`;
  }

  if (protocol) {
    return `${label} on ${protocol}`;
  }
  return label;
}

/**
 * Every package a set of commands calls into.
 *
 * Pair with `prefetchProtocolNames` before decoding a batch so unknown packages
 * get their Move Registry names in one bulk request instead of rendering as raw
 * addresses. Decoding without prefetching is still correct, just less readable.
 */
export function collectPackageIds(commands: GrpcTypes.Command[]): string[] {
  const ids = new Set<string>();
  for (const cmd of commands) {
    const c = cmd.command;
    if (c.oneofKind === "moveCall" && c.moveCall.package) ids.add(c.moveCall.package);
  }
  return [...ids];
}
/**
 * Net signed change per coin type, for the sender only. A pool's generic type
 * order is fixed when the pool is created and does not follow which way a
 * swap ran. Cetus's aggregator wrapper and the underlying pool call carry the
 * same two coins in opposite `typeArguments` order for one swap, so that
 * order alone cannot tell a reader which coin went in. The sender's own
 * balance changes can: whichever coin it paid is negative, whichever it
 * received is positive.
 */
function senderNetByCoin(
  balanceChanges: GrpcTypes.BalanceChange[] | undefined,
  sender: string | undefined,
): Map<string, bigint> {
  const net = new Map<string, bigint>();
  if (!balanceChanges || !sender) return net;
  for (const bc of balanceChanges) {
    if (bc.address !== sender || !bc.coinType) continue;
    net.set(bc.coinType, (net.get(bc.coinType) ?? 0n) + BigInt(bc.amount ?? "0"));
  }
  return net;
}

/** Action kinds whose own balance changes can overlap a swap's coins, so a whole-PTB net can no longer be trusted to isolate one swap's flow. */
const NET_POLLUTING_ACTIONS = new Set(["deposit", "withdraw", "borrow", "repay", "add_liquidity", "remove_liquidity"]);

/**
 * The direction a swap function name states outright, when it does:
 * `swap_a2b`/`swapAtoB`/`swap_a_to_b`, Turbos `swap_a_b` and DeepBook
 * `swap_exact_base_for_quote` swap the first type argument in, the second out
 * (the given order already matches); `swap_b2a`/`swapBtoA`/`swap_b_to_a`, Turbos
 * `swap_b_a` and DeepBook `swap_exact_quote_for_base` swap the second in, the
 * first out (the given order is reversed). Turbos's multi-hop
 * `swap_b_a_b_c`-style functions are left out: their first type argument is
 * already the input coin and the second a fee type. Checked before the
 * balance-net heuristic below, since a direction the call names outright is
 * certain.
 */
function directionFromFunctionName(fn: string): "a2b" | "b2a" | null {
  const lower = fn.toLowerCase();
  if (/a2b|atob|a_to_b|^swap_a_b(?:_with_|$)|base_for_quote/.test(lower)) return "a2b";
  if (/b2a|btoa|b_to_a|^swap_b_a(?:_with_|$)|quote_for_base/.test(lower)) return "b2a";
  return null;
}

/**
 * Which way a swap's two coins actually moved for the sender.
 *
 * The sender's whole-PTB net is trusted first, when `netTrusted`: it comes
 * from the actual balance changes, while a function name or typeArguments
 * order may not encode the direction at all (an a2b flag passed as a runtime
 * argument, one function called with its type arguments in either order).
 * Another leg that moves one of the swap's coins nets against the swap's own
 * flow, so `netTrusted` is false for a swap when a
 * deposit/withdraw/borrow/repay/liquidity leg in the same PTB names either
 * of its coins, or names no coin at all. Falls back to the function name's
 * own a2b/b2a direction, when it has one, whenever the net is not trusted,
 * or is trusted but inconclusive (an intermediate leg of a multi-hop route
 * can net to zero or be absent from the sender's own changes). The given
 * order (the call's own typeArguments) stands when neither says anything,
 * and whenever the call carries fewer than two type arguments, since there
 * is no pair to order.
 */
function swapDirection(typeArgs: string[], net: Map<string, bigint>, fn: string, netTrusted: boolean): string[] {
  if (typeArgs.length < 2) return typeArgs;
  const [a, b, ...rest] = typeArgs;
  if (netTrusted) {
    const na = net.get(a);
    const nb = net.get(b);
    if (na != null && nb != null && na > 0n && nb < 0n) return [b, a, ...rest];
  }
  if (directionFromFunctionName(fn) === "b2a") return [b, a, ...rest];
  return typeArgs;
}

const FRAMEWORK = normalizeSuiAddress("0x2");
/** Framework modules whose calls move a coin of the type they are given. */
const FRAMEWORK_COIN_MODULES = new Set(["coin", "balance", "pay"]);

/**
 * The bookkeeping types a router passes first in each call of a route, such
 * as Aftermath's `RouterDataV1`. A type is one when a call with no known
 * operation passes it with exactly one other type (the call that starts a
 * path, naming the path's coin), a swap call with four or more type
 * arguments passes it first, no call passes it in any other position, and
 * nothing in the transaction shows it to be a coin.
 */
function routeMarkers(commands: GrpcTypes.Command[], hasCoinEvidence: (t: string) => boolean): Set<string> {
  const startsPath = new Set<string>();
  const leadsHop = new Set<string>();
  const elsewhere = new Set<string>();
  for (const cmd of commands) {
    const c = cmd.command;
    if (c.oneofKind !== "moveCall") continue;
    const tas = c.moveCall.typeArguments ?? [];
    if (tas.length === 0) continue;
    const op = lookupOperation(c.moveCall.module ?? "", c.moveCall.function ?? "");
    if (tas.length === 2 && !op) startsPath.add(tas[0]);
    if (op?.action === "swap" && tas.length >= 4) leadsHop.add(tas[0]);
    for (const t of tas.slice(1)) for (const tok of t.split(/[<>,\s]+/)) if (tok) elsewhere.add(tok);
    for (const tok of tas[0].split(/[<>,\s]+/).slice(1)) if (tok) elsewhere.add(tok);
  }
  return new Set([...startsPath].filter((t) => leadsHop.has(t) && !elsewhere.has(t) && !hasCoinEvidence(t)));
}

/**
 * One hop of a route: `[marker, path start coin, ...the hop's own types]`, the
 * hop's own types in each integration's order, so position says nothing about
 * direction. The hop takes in the coin the path holds (the previous hop's
 * output, or the start coin) and gives out another of its own types: the last
 * one the transaction shows to be a coin, else the last one.
 */
function routeHop(typeArgs: string[], pathCoin: string | null, hasCoinEvidence: (t: string) => boolean): [string, string] | null {
  const own = typeArgs.slice(2);
  const input = pathCoin !== null && own.includes(pathCoin) ? pathCoin : typeArgs[1];
  const rest = own.filter((t) => t !== input).reverse();
  const output = rest.find(hasCoinEvidence) ?? rest[0];
  return output ? [input, output] : null;
}

/**
 * `custodyFor` holds the normalized IDs of packages whose publisher this call
 * read (`prefetchProtocolCustody`). Only those may be named through the
 * publisher tier, so a package this call did not read is never named from a
 * cache another tool filled.
 */
export function decodeTransaction(
  commands: GrpcTypes.Command[],
  balanceChanges: GrpcTypes.BalanceChange[] | undefined,
  sender: string | undefined,
  opts: { custodyFor?: ReadonlySet<string> } = {},
): DecodedTransaction {
  const protocols = new Set<string>();
  const actions: string[] = [];
  const net = senderNetByCoin(balanceChanges, sender);

  // The type tokens of every deposit/withdraw/borrow/repay/liquidity leg in
  // the PTB. Such a leg can move the coins a swap does, and then the
  // whole-PTB net no longer isolates that swap's own flow. A leg sharing
  // neither of a swap's coins cannot move them (a USDT withdraw beside a
  // USDC/SUI swap), while a leg with no type arguments may move any coin.
  // Whole type tokens are compared, so a coin nested in a leg's generic
  // (`Pool<USDC>`) still counts.
  const pollutingLegs: Set<string>[] = [];
  for (const cmd of commands) {
    const c = cmd.command;
    if (c.oneofKind !== "moveCall") continue;
    const op = lookupOperation(c.moveCall.module ?? "", c.moveCall.function ?? "");
    if (op && NET_POLLUTING_ACTIONS.has(op.action)) {
      pollutingLegs.push(new Set((c.moveCall.typeArguments ?? []).flatMap((t) => t.split(/[<>,\s]+/).filter(Boolean))));
    }
  }

  // Types the transaction shows to be coins: moved in a balance change or
  // passed to a framework coin call.
  const coinTypes = new Set<string>((balanceChanges ?? []).flatMap((bc) => (bc.coinType ? [bc.coinType] : [])));
  for (const cmd of commands) {
    const c = cmd.command;
    if (c.oneofKind !== "moveCall") continue;
    if (normalizeSuiAddress(c.moveCall.package ?? "0x0") === FRAMEWORK && FRAMEWORK_COIN_MODULES.has(c.moveCall.module ?? "")) {
      for (const t of c.moveCall.typeArguments ?? []) coinTypes.add(t);
    }
  }
  const hasCoinEvidence = (t: string) => coinTypes.has(t) || isVerifiedCoin(t);
  const markers = routeMarkers(commands, hasCoinEvidence);
  // The coin a route's path holds: its start coin, then each hop's output.
  let pathCoin: string | null = null;

  for (const cmd of commands) {
    const c = cmd.command;
    switch (c.oneofKind) {
      case "moveCall": {
        const mc = c.moveCall;
        const pkg = mc.package ?? "";
        const mod = mc.module ?? "";
        const fn = mc.function ?? "";
        const typeArgs = mc.typeArguments ?? [];

        // Display lookup: a Move Registry name is strictly better output than a
        // truncated 0x address, and nothing downstream of the decoder makes a
        // trust decision on it.
        const proto = lookupProtocolDisplay(pkg, { custody: opts.custodyFor?.has(normalizeSuiAddress(pkg)) ?? false });
        const op = lookupOperation(mod, fn);

        if (proto) {
          protocols.add(proto.name);
        }

        if (op?.skip) {
          break;
        }

        const routed = typeArgs.length >= 2 && markers.has(typeArgs[0]);
        if (routed && typeArgs.length === 2 && !op) pathCoin = typeArgs[1];

        if (op) {
          let args = typeArgs;
          if (op.action === "swap" && routed) {
            const hop = routeHop(typeArgs, pathCoin, hasCoinEvidence);
            args = hop ?? typeArgs.slice(1);
            if (hop) pathCoin = hop[1];
          } else if (op.action === "swap") {
            args = swapDirection(
              typeArgs,
              net,
              fn,
              !pollutingLegs.some((coins) => coins.size === 0 || coins.has(typeArgs[0]) || coins.has(typeArgs[1])),
            );
          } else if (routed) {
            args = typeArgs.slice(1);
          }
          actions.push(formatAction(op.action, proto?.name ?? null, args));
        } else if (proto) {
          actions.push(`Call ${mod}::${fn} on ${proto.name}`);
        } else {
          // Unknown package — show abbreviated address
          const shortPkg = pkg.length > 16 ? pkg.slice(0, 10) + "…" + pkg.slice(-4) : pkg;
          actions.push(`Call ${shortPkg}::${mod}::${fn}`);
        }
        break;
      }
      case "transferObjects": {
        actions.push("Transfer to recipient");
        break;
      }
      // splitCoins, mergeCoins, makeMoveVector are infrastructure — skip
      case "publish":
        actions.push("Publish new package");
        break;
      case "upgrade":
        actions.push("Upgrade package");
        break;
      default:
        break;
    }
  }

  // Token flow: the SENDER's balance changes. `addressFlow` gives any other
  // address's view of the same transaction.
  const tokenFlow: DecodedTransaction["token_flow"] = [];
  if (balanceChanges && sender) {
    for (const bc of balanceChanges) {
      if (bc.address === sender) {
        tokenFlow.push({
          coin: shortCoinType(bc.coinType ?? ""),
          amount: bc.amount ?? "0",
          formatted: formatCoinAmount(bc.amount ?? "0", bc.coinType ?? ""),
          raw_type: bc.coinType ?? "",
        });
      }
    }
  }

  return {
    protocols: [...protocols],
    actions,
    token_flow: tokenFlow,
  };
}
