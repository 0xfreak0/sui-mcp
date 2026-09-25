import type { GrpcTypes } from "@mysten/sui/grpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { formatCoinAmount } from "../utils/coin-amount.js";
import { coinScale, displayCoin, type CoinScale } from "../utils/valuation.js";
import { lookupProtocolDisplay, lookupOperation } from "./registry.js";

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

export function decodeTransaction(
  commands: GrpcTypes.Command[],
  balanceChanges: GrpcTypes.BalanceChange[] | undefined,
  sender: string | undefined
): DecodedTransaction {
  const protocols = new Set<string>();
  const actions: string[] = [];

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
        const proto = lookupProtocolDisplay(pkg);
        const op = lookupOperation(mod, fn);

        if (proto) {
          protocols.add(proto.name);
        }

        if (op?.skip) {
          break;
        }

        if (op) {
          actions.push(formatAction(op.action, proto?.name ?? null, typeArgs));
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
