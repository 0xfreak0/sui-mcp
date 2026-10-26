import { isSponsorGasChange } from "./sponsor-gas.js";
import type { LaunchChange } from "./launch-accounting.js";
import type { LaunchPayment } from "./launch-scoring.js";

export const SUI_LAUNCH_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

export interface PaymentTransaction {
  sender: string | null;
  sponsor: string | null;
  gas: bigint | null;
  changes: LaunchChange[];
}

function balance(tx: PaymentTransaction, owner: string, coin: string): bigint {
  return tx.changes.filter(change => change.address === owner && change.coin_type === coin)
    .reduce((sum, change) => sum + change.amount, 0n);
}

/** A storage rebate paid to a gas-only sponsor is not a top-up. */
export function launchTopup(tx: PaymentTransaction, buyer: string): { source: string; amountMist: bigint } | null {
  if (isSponsorGasChange(buyer, SUI_LAUNCH_TYPE, tx.sender, tx.sponsor)) return null;
  const gained = balance(tx, buyer, SUI_LAUNCH_TYPE);
  if (gained <= 0n || tx.sender === buyer) return null;
  const candidates = tx.changes.filter(change => change.coin_type === SUI_LAUNCH_TYPE && change.address !== buyer
    && change.amount < 0n && !isSponsorGasChange(change.address, change.coin_type, tx.sender, tx.sponsor));
  const source = candidates.map(change => ({
    source: change.address, spent: -change.amount
      - (change.address === (tx.sponsor ?? tx.sender) ? tx.gas ?? change.amount * -1n : 0n)
  }))
    .filter(change => change.spent >= gained).sort((a, b) => a.spent > b.spent ? -1 : a.spent < b.spent ? 1 : 0)[0];
  return source ? { source: source.source, amountMist: gained } : null;
}

/** Credit to a destination is the creator's payment only when its matching debit is established. */
export function creatorPaid(tx: PaymentTransaction, creator: string, destination: string, coin: string): bigint {
  if (tx.sender !== creator || creator === destination || isSponsorGasChange(destination, coin, tx.sender, tx.sponsor)) return 0n;
  const received = balance(tx, destination, coin);
  if (received <= 0n) return 0n;
  const gas = coin === SUI_LAUNCH_TYPE && (tx.sponsor ?? tx.sender) === creator ? tx.gas : 0n;
  if (gas === null) return 0n;
  const spent = -balance(tx, creator, coin) - gas;
  return spent >= received ? received : 0n;
}

/** The event's buyer is a signing key; a session buy can leave its tokens in an object. */
export function buyerReceivedLaunchCoin(tx: PaymentTransaction, buyer: string, coin: string): boolean {
  return balance(tx, buyer, coin) > 0n;
}

/** A shared destination can also be a buyer, read by both creator-payment walks. */
export function uniqueCreatorPayments(groups: readonly (readonly LaunchPayment[])[]): LaunchPayment[] {
  const seen = new Set<string>();
  return groups.flatMap(group => group.filter(payment => {
    const key = JSON.stringify([payment.to, payment.digest, payment.asset]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

export function launchAccountingComplete(historyComplete: boolean, openingComplete: boolean, unreadPoolEvents: number): boolean {
  return historyComplete && openingComplete && unreadPoolEvents === 0;
}

export function launchTotalsPartial(rows: readonly { raw: { unread_pool_events: number } }[]): boolean {
  return rows.some(row => row.raw.unread_pool_events > 0);
}
