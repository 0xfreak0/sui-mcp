import type { GrpcTypes } from "@mysten/sui/grpc";
import { lookupProtocol, lookupOperation } from "./registry.js";

export interface DecodedTransaction {
  protocols: string[];
  actions: string[];
  token_flow: {
    coin: string;
    amount: string;
    raw_type: string;
  }[];
}

function shortCoinType(coinType: string): string {
  // "0x000...002::sui::SUI" → "SUI"
  const parts = coinType.split("::");
  return parts.length >= 3 ? parts[parts.length - 1] : coinType;
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

        const proto = lookupProtocol(pkg);
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

  // Token flow: sender's net balance changes
  const tokenFlow: DecodedTransaction["token_flow"] = [];
  if (balanceChanges && sender) {
    for (const bc of balanceChanges) {
      if (bc.address === sender) {
        tokenFlow.push({
          coin: shortCoinType(bc.coinType ?? ""),
          amount: bc.amount ?? "0",
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
