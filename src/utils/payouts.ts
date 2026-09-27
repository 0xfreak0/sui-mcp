/**
 * Payouts read from a transaction's effects rather than its commands: coins
 * the sender lost that another address gained, and objects the sender held
 * that another address now holds.
 *
 * The command check in ptb-anomalies.ts sees a payout only where the PTB
 * itself names the recipient: a TransferObjects command or one of the
 * framework payout calls. A function in any other package can transfer what
 * it was handed to an address the PTB never mentions. The effects record
 * where everything ended up, so this reads the payout whichever function made
 * it.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { custodyChanges, createdFor, type ObjectMovement } from "./object-flow.js";

export interface EffectsPayout {
  to: string;
  /** Coin type, for a coin payout. */
  coin_type?: string;
  /** Raw units of `coin_type` the recipient gained, up to what the sender lost. */
  amount?: string;
  /** Object id and type, for an object that left the sender. */
  object_id?: string;
  object_type?: string | null;
}

export interface EffectsPayouts {
  payouts: EffectsPayout[];
  /** Every address other than the sender that gained a coin or received an object. */
  gainers: Set<string>;
  /** Net of the gas it paid, the sender ended with less of some coin, or an object it held went to another owner. */
  sender_lost: boolean;
  /** Net of the gas it paid, the sender gained a coin or received an object. */
  sender_received: boolean;
}

/** What the gas payer paid: computation plus storage, less the storage rebate (negative when the rebate is larger). */
export interface GasPaid {
  payer: string | null;
  net: bigint;
}

/** The gas an executed transaction's payer paid, from its effects' cost summary; null when the effects carry none. */
export function gasPaidOf(
  summary: { computationCost?: bigint; storageCost?: bigint; storageRebate?: bigint } | undefined,
  payer: string | null | undefined,
): GasPaid | null {
  if (summary?.computationCost === undefined || summary.storageCost === undefined || summary.storageRebate === undefined) return null;
  return { payer: payer ?? null, net: summary.computationCost + summary.storageCost - summary.storageRebate };
}

const SUI_COIN = `${normalizeSuiAddress("0x2")}::sui::SUI`;

const isAddressOwner = (kind: string | undefined) => kind === "address" || kind === "consensus";

/**
 * Payouts from the sender to other addresses, by effects. `balanceChanges`
 * are the transaction's per-address coin changes; `movements` its object
 * movements (`readGrpcObjectChanges`), which leave coins to the balance
 * changes. `gas` is taken out of its payer's SUI change, so a sender that
 * only paid gas lost nothing and paid nobody; without it the sender's SUI
 * change still includes gas.
 */
export function effectsPayouts(
  sender: string | null,
  balanceChanges: Array<{ address: string; coinType: string; amount: string }>,
  movements: ObjectMovement[],
  gas: GasPaid | null = null,
): EffectsPayouts {
  const from = sender ? normalizeSuiAddress(sender) : null;
  const net = new Map<string, Map<string, bigint>>();
  const add = (who: string, coinType: string, amount: bigint) => {
    const coins = net.get(who) ?? new Map<string, bigint>();
    coins.set(coinType, (coins.get(coinType) ?? 0n) + amount);
    net.set(who, coins);
  };
  for (const b of balanceChanges) {
    if (b.address) add(normalizeSuiAddress(b.address), b.coinType, BigInt(b.amount));
  }
  if (gas?.payer) add(normalizeSuiAddress(gas.payer), SUI_COIN, gas.net);
  const gainers = new Set<string>();
  const payouts: EffectsPayout[] = [];
  const lost = (from && net.get(from)) || new Map<string, bigint>();
  let senderLost = [...lost.values()].some((v) => v < 0n);
  let senderReceived = [...lost.values()].some((v) => v > 0n);
  for (const [who, coins] of net) {
    if (who === from) continue;
    for (const [coin_type, amount] of coins) {
      if (amount <= 0n) continue;
      gainers.add(who);
      const senderLoss = -(lost.get(coin_type) ?? 0n);
      if (senderLoss > 0n) payouts.push({ to: who, coin_type, amount: (amount < senderLoss ? amount : senderLoss).toString() });
    }
  }
  const heldBy = (ref: ObjectMovement["from"], who: string | null) =>
    !!who && isAddressOwner(ref?.kind) && !!ref?.address && normalizeSuiAddress(ref.address) === who;
  for (const m of movements) {
    const fromSender = heldBy(m.from, from);
    const toSender = heldBy(m.to, from);
    if (fromSender && !toSender) senderLost = true;
    if (toSender && !fromSender) senderReceived = true;
  }
  for (const m of [...custodyChanges(movements), ...createdFor(movements, from)]) {
    if (!isAddressOwner(m.to?.kind) || !m.to?.address) continue;
    const to = normalizeSuiAddress(m.to.address);
    if (to === from) continue;
    gainers.add(to);
    if (from && isAddressOwner(m.from?.kind) && m.from?.address && normalizeSuiAddress(m.from.address) === from) {
      payouts.push({ to, object_id: m.object_id, object_type: m.type });
    }
  }
  return { payouts, gainers, sender_lost: senderLost, sender_received: senderReceived };
}
