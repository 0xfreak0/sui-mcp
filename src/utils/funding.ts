/**
 * Pure selection logic for funding-source attribution: given an address's
 * earliest transactions (oldest first), find the first one that actually funded
 * it (net positive inflow) and who the funder was. Kept pure so it's testable
 * without the chain.
 */

export interface FundingChange {
  address: string;
  amount: string; // signed raw
  coinType: string;
}

export interface FundingTx {
  digest: string;
  sender: string | null;
  timestamp: string | null;
  checkpoint: string | null;
  changes: FundingChange[];
}

export interface FundingResult {
  digest: string;
  funder: string;
  timestamp: string | null;
  checkpoint: string | null;
  /** Net amount the target received, raw. */
  amount: string;
  coinType: string;
}

/**
 * From a list of the address's earliest transactions (ascending), pick the
 * first one where the address received net-positive funds, and identify the
 * funder: the counterparty that lost the most value, else the tx sender.
 */
export function pickFundingTx(txs: FundingTx[], address: string): FundingResult | null {
  for (const tx of txs) {
    // Net inflow to the target, per coin.
    const inflow = new Map<string, bigint>();
    for (const c of tx.changes) {
      if (c.address !== address) continue;
      inflow.set(c.coinType, (inflow.get(c.coinType) ?? 0n) + BigInt(c.amount));
    }
    // Largest positive coin inflow.
    let bestCoin: string | null = null;
    let bestAmt = 0n;
    for (const [coin, amt] of inflow) {
      if (amt > bestAmt) {
        bestAmt = amt;
        bestCoin = coin;
      }
    }
    if (!bestCoin || bestAmt <= 0n) continue; // this tx didn't fund the address

    // Funder = counterparty with the most-negative change (they sent it), else sender.
    let funder: string | null = null;
    let mostNegative = 0n;
    for (const c of tx.changes) {
      if (c.address === address) continue;
      const amt = BigInt(c.amount);
      if (amt < mostNegative) {
        mostNegative = amt;
        funder = c.address;
      }
    }
    funder = funder ?? (tx.sender && tx.sender !== address ? tx.sender : tx.sender);

    return {
      digest: tx.digest,
      funder: funder ?? "unknown",
      timestamp: tx.timestamp,
      checkpoint: tx.checkpoint,
      amount: bestAmt.toString(),
      coinType: bestCoin,
    };
  }
  return null;
}
