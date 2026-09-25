/**
 * Address balances: funds an address holds without any `Coin<T>` object.
 *
 * An address balance is credited with `0x2::balance::send_funds` and spent
 * through a `FundsWithdrawal` transaction input redeemed by
 * `0x2::coin::redeem_funds` or `0x2::balance::redeem_funds`. The owner can be
 * a wallet or an object id. Three consequences shape this module:
 *
 * - A wallet can hold a large balance and own no coin objects, so
 *   `list_owned_objects` shows nothing while `get_balance` shows the funds.
 * - An object can hold funds in its own address balance. They are not among
 *   its fields, so reading the object does not show them, and only code with
 *   `&mut UID` (its defining module) can take them out via
 *   `0x2::balance::withdraw_funds_from_object`.
 * - Transaction effects record every address-balance write as a
 *   `ChangedObject` with `outputState: ACCUMULATOR_WRITE`. Those entries are
 *   accounting, not objects, and a coin can be deleted and merged into its
 *   owner's address balance with no value leaving the owner.
 */

import { fromBase58 } from "@mysten/sui/utils";
import { sui } from "../clients/grpc.js";
import { normalizeCoinType } from "./coin-registry.js";
import { baseType, type GrpcChangedObject } from "./object-flow.js";
import { formatCoinAmount } from "./coin-amount.js";

const ADDR2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
const BALANCE_TYPE = `${ADDR2}::balance::Balance`;
const COIN_TYPE = `${ADDR2}::coin::Coin`;

/** `sui.rpc.v2.AccumulatorWrite.AccumulatorOperation` */
const OP_MERGE = 1;
const OP_SPLIT = 2;
/** `sui.rpc.v2.ChangedObject.IdOperation.DELETED` */
const ID_DELETED = 3;
/** `sui.rpc.v2.Owner.OwnerKind.ADDRESS` */
const OWNER_ADDRESS = 1;
/** `sui.rpc.v2.FundsWithdrawal.Source` */
const WITHDRAW_SOURCE: Record<number, "sender" | "sponsor"> = { 1: "sender", 2: "sponsor" };

/**
 * `T` of `framework<T>`, or null when `type` is anything else. The framework
 * type is matched in full, never by suffix: a package can name its own module
 * `coin` and its struct `Coin`.
 */
function frameworkTypeArgument(type: string | null | undefined, framework: string): string | null {
  if (!type || baseType(type) !== framework) return null;
  const open = type.indexOf("<");
  if (open < 0 || !type.endsWith(">")) return null;
  return type.slice(open + 1, -1);
}

/* ------------------------------------------------------------------ */
/* Funds held by an object                                             */
/* ------------------------------------------------------------------ */

export interface HeldAddressBalance {
  coin_type: string;
  balance: string;
  formatted: string | null;
}

/** Pages of `listBalances` read for one object. An object holding more than
 *  this many coin types is reported as truncated rather than silently cut. */
const OBJECT_BALANCE_PAGES = 4;

/**
 * The funds an object id holds in its own address balance, as output fields
 * for `identify_address` and `get_object`. One gRPC call for almost every
 * object.
 *
 * Empty when the object holds nothing. A failed lookup is said, never
 * returned as empty: an absent `address_balances` reads as "holds nothing".
 */
export async function objectAddressBalanceFields(objectId: string): Promise<Record<string, unknown>> {
  const balances: HeldAddressBalance[] = [];
  let cursor: string | null = null;
  let truncated = false;
  try {
    for (let page = 0; page < OBJECT_BALANCE_PAGES; page++) {
      const res = await sui.listBalances({ owner: objectId, limit: 50, cursor });
      for (const b of res.balances) {
        if (BigInt(b.addressBalance || "0") <= 0n) continue;
        balances.push({
          coin_type: b.coinType,
          balance: b.addressBalance,
          formatted: formatCoinAmount(b.addressBalance, b.coinType),
        });
      }
      if (!res.hasNextPage) break;
      cursor = res.cursor;
      // A page that claims more and gives no cursor, or the last page read,
      // leaves coin types unread.
      if (!cursor || page === OBJECT_BALANCE_PAGES - 1) {
        truncated = true;
        break;
      }
    }
  } catch (err) {
    return {
      address_balances_error: `Could not read this object's address balances (${err instanceof Error ? err.message : String(err)}). get_balance with owner set to this object id reads them one coin type at a time.`,
    };
  }
  if (balances.length === 0 && !truncated) return {};
  return {
    address_balances: balances,
    ...(truncated ? { address_balances_truncated: true } : {}),
    address_balances_note:
      "These funds sit in this object's own address balance. They are not among its fields, so the object's content does not show them. Only code holding the object's &mut UID, normally its defining module, can withdraw them (0x2::balance::withdraw_funds_from_object).",
  };
}

/* ------------------------------------------------------------------ */
/* What a transaction did to address balances                          */
/* ------------------------------------------------------------------ */

export interface AddressBalanceOp {
  owner: string | null;
  /** `T` of `Balance<T>`. Absent when the accumulator is not a balance. */
  coin_type?: string;
  /** The raw accumulator type, only when it is not a `Balance<T>`. */
  accumulator_type?: string;
  op: "deposit" | "withdraw" | "unknown";
  amount: string;
  /** Coins of the same owner and type deleted in the same transaction. */
  converted_from_coins?: string[];
  note?: string;
}

/**
 * Deposits to and withdrawals from address balances, one per accumulator
 * write. The amount is the net per owner and coin type for the whole
 * transaction, which is how the effects record it.
 *
 * A coin of type T deleted from owner X in the same transaction as a deposit
 * of T to X is the coin being folded into X's address balance. That deposit
 * carries `converted_from_coins`, because otherwise a large deleted coin and a
 * large deposit read as value arriving from somewhere.
 */
export function readAddressBalanceOps(changes: GrpcChangedObject[]): AddressBalanceOp[] {
  const deletedCoins = changes.flatMap((c) => {
    if (c.idOperation !== ID_DELETED) return [];
    const coinType = frameworkTypeArgument(c.objectType, COIN_TYPE);
    const owner = c.inputOwner?.kind === OWNER_ADDRESS ? c.inputOwner.address : undefined;
    return coinType && owner && c.objectId ? [{ id: c.objectId, coinType, owner }] : [];
  });

  const ops: AddressBalanceOp[] = [];
  for (const c of changes) {
    const w = c.accumulatorWrite;
    if (!w) continue;
    const owner = w.address ?? null;
    const coinType = frameworkTypeArgument(w.accumulatorType, BALANCE_TYPE);
    const op: AddressBalanceOp = {
      owner,
      ...(coinType ? { coin_type: coinType } : { accumulator_type: w.accumulatorType ?? "unknown" }),
      op: w.operation === OP_MERGE ? "deposit" : w.operation === OP_SPLIT ? "withdraw" : "unknown",
      amount: (w.value ?? 0n).toString(),
    };
    if (op.op === "deposit" && coinType && owner) {
      const want = normalizeCoinType(coinType) ?? coinType;
      const swept = deletedCoins.filter(
        (d) => d.owner === owner && (normalizeCoinType(d.coinType) ?? d.coinType) === want,
      );
      if (swept.length > 0) {
        op.converted_from_coins = swept.map((d) => d.id);
        op.note =
          "Coin converted to owner's address balance (no value moved). A coin of this type belonging to the same owner was deleted in this transaction and this deposit went to that owner's own address balance, so it is the owner's funds changing form rather than a payment. balance_changes show what the owner actually gained or lost.";
      }
    }
    ops.push(op);
  }
  return ops;
}

export interface FundsWithdrawalInput {
  /** The most the transaction may withdraw. */
  amount: string;
  coin_type: string | null;
  source: "sender" | "sponsor" | "unknown";
}

/** Shape of a gRPC `Input` carrying a `FundsWithdrawal`. */
export interface GrpcFundsInput {
  fundsWithdrawal?: { amount?: bigint; coinType?: string; source?: number };
}

/** `FundsWithdrawal` inputs: whose address balance the transaction may draw on, and how much. */
export function readFundsWithdrawals(inputs: GrpcFundsInput[]): FundsWithdrawalInput[] {
  return inputs.flatMap((i) => {
    const w = i.fundsWithdrawal;
    if (!w) return [];
    return [
      {
        amount: (w.amount ?? 0n).toString(),
        coin_type: w.coinType ?? null,
        source: WITHDRAW_SOURCE[w.source ?? 0] ?? "unknown",
      },
    ];
  });
}

/* ------------------------------------------------------------------ */
/* Gas                                                                 */
/* ------------------------------------------------------------------ */

/**
 * A gas payment entry that stands for the owner's address balance rather
 * than a coin object. Such a reference names no object: its digest ends in
 * twenty 0xAC bytes, the marker `@mysten/sui`'s JSON-RPC client uses to filter
 * these out of coin listings (`isCoinReservationDigest`). Mainnet transaction
 * 34q8kUTe8Uoe3f6cD5wKmS7ZqgYg3uX8J7nAJEuGeGTF lists one beside a real coin.
 */
function isAddressBalanceGasRef(digest: string | undefined): boolean {
  if (!digest) return false;
  let bytes: Uint8Array;
  try {
    bytes = fromBase58(digest);
  } catch {
    return false;
  }
  if (bytes.length !== 32) return false;
  for (let i = 12; i < 32; i++) if (bytes[i] !== 0xac) return false;
  return true;
}

export type GasSource = "coins" | "address_balance" | "coins_and_address_balance";

/**
 * Where gas came from. An empty payment list means the gas owner's address
 * balance paid; a list may also mix real coins with an address-balance entry.
 */
export function gasSource(payment: ReadonlyArray<{ objectId?: string; digest?: string }>): {
  source: GasSource;
  coins: string[];
} {
  const coins = payment.filter((p) => !isAddressBalanceGasRef(p.digest)).map((p) => p.objectId ?? "");
  const fromBalance = payment.length === 0 || coins.length < payment.length;
  return {
    source: coins.length === 0 ? "address_balance" : fromBalance ? "coins_and_address_balance" : "coins",
    coins,
  };
}
