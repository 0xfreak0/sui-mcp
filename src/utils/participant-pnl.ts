/**
 * Who made or lost what across a set of transactions: each transaction's
 * sender's own balance changes, summed per coin and per sender. Pure; the
 * `group_pnl` option of `aggregate_events` reads the transactions and prices
 * the result.
 *
 * A sender's P&L here is everything its balance did in those transactions,
 * gas included when it paid its own. A PTB that calls the filtered protocol
 * and others moves value through all of them, so its P&L cannot be pinned on
 * the filtered call; those transactions are counted as `multiLeg` and the
 * other packages named.
 */

import { normalizeSuiAddress } from "@mysten/sui/utils";
import { coinKey } from "./trace-hop.js";

export interface PnlTx {
  digest: string;
  sender: string | null;
  balanceChanges: Array<{ address: string; coinType: string; amount: string }>;
  calls: Array<{ package: string }>;
}

export interface SenderPnl {
  sender: string;
  digests: string[];
  net: Map<string, bigint>;
  /** Transactions that also called a package outside the filtered lineage. */
  multiLeg: string[];
  otherPackages: Set<string>;
}

/** Move stdlib, the Sui framework and the system package: plumbing in every PTB, never a protocol leg. */
const FRAMEWORK = new Set(["0x1", "0x2", "0x3"].map((p) => normalizeSuiAddress(p)));

export function participantPnl(txs: PnlTx[], lineage: ReadonlySet<string> | null): SenderPnl[] {
  const bySender = new Map<string, SenderPnl>();
  const inLineage = lineage ? new Set([...lineage].map((p) => normalizeSuiAddress(p))) : null;
  for (const tx of txs) {
    if (!tx.sender) continue;
    const sender = normalizeSuiAddress(tx.sender);
    const row: SenderPnl = bySender.get(sender) ?? { sender, digests: [], net: new Map(), multiLeg: [], otherPackages: new Set() };
    bySender.set(sender, row);
    row.digests.push(tx.digest);
    for (const b of tx.balanceChanges) {
      if (normalizeSuiAddress(b.address) !== sender) continue;
      const coin = coinKey(b.coinType);
      row.net.set(coin, (row.net.get(coin) ?? 0n) + BigInt(b.amount));
    }
    if (!inLineage) continue;
    const others = new Set(
      tx.calls
        .map((c) => normalizeSuiAddress(c.package))
        .filter((p) => !FRAMEWORK.has(p) && !inLineage.has(p)),
    );
    if (others.size > 0) {
      row.multiLeg.push(tx.digest);
      for (const p of others) row.otherPackages.add(p);
    }
  }
  for (const row of bySender.values()) {
    for (const [coin, v] of row.net) if (v === 0n) row.net.delete(coin);
  }
  return [...bySender.values()];
}
