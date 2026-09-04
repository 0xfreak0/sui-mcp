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

/** How a candidate inflow was judged, so a skip is never silent. */
export interface SkippedInflow {
  digest: string;
  amount: string;
  coinType: string;
  reason: "below_sui_floor" | "below_usd_floor" | "unpriced_coin";
}

export interface FundingOptions {
  /**
   * Smallest SUI inflow that counts as funding, in MIST. Default 0.01 SUI.
   *
   * Gas for a simple transfer is on the order of 0.001-0.005 SUI, so a real
   * funder sends enough to cover many transactions. Spam sends sit orders of
   * magnitude below this.
   */
  minSuiMist?: bigint;
  /** Smallest USD value for a priced non-SUI inflow. Default $0.10. */
  minUsd?: number;
  /**
   * USD value of a raw amount, or null when the coin has no price.
   *
   * Injected so this stays pure. An unpriced coin is the load-bearing signal
   * and not a threshold at all: nobody funds a wallet with a token that has no
   * market, so an unknown unpriced coin is a spam signature rather than a
   * small payment.
   */
  valueUsd?: (coinType: string, rawAmount: bigint) => number | null;
}

export const DEFAULT_MIN_SUI_MIST = 10_000_000n; // 0.01 SUI
export const DEFAULT_MIN_USD = 0.1;

const SUI_TYPE_SUFFIX = "::sui::SUI";

/**
 * From a list of the address's earliest transactions (ascending), pick the
 * first one that actually **funded** it, and identify the funder.
 *
 * Two things this gets right that a naive "first positive inflow" does not.
 *
 * **Dust is not funding.** Airdropped scam NFTs are already invisible here —
 * they move no coin — but coin dust is not: a 1-MIST spam send used to become
 * "first funded by", and `find_funding_source` would then walk the spammer's
 * ancestry as if it were the subject's origin. Candidates below the floors, or
 * denominated in a coin nobody prices, are skipped and reported in
 * `dustSkipped` rather than dropped silently.
 *
 * **The funder must have sent what the target received.** Picking the
 * counterparty with the most-negative change across *all* coins attributes a
 * sponsored transfer to whoever paid the gas: gas is folded into the payer's
 * net SUI rather than itemised, so a sponsor's -0.036 SUI (raw -36000000)
 * outranks a real sender's -11 USDC (raw -11085939) purely because SUI has
 * three more decimals. The funder is now sought in the coin that actually
 * arrived.
 */
export function pickFundingTx(
  txs: FundingTx[],
  address: string,
  opts: FundingOptions = {},
): (FundingResult & { dustSkipped: SkippedInflow[] }) | null {
  const minSui = opts.minSuiMist ?? DEFAULT_MIN_SUI_MIST;
  const minUsd = opts.minUsd ?? DEFAULT_MIN_USD;
  const valueUsd = opts.valueUsd;
  const dustSkipped: SkippedInflow[] = [];

  for (const tx of txs) {
    // Net inflow to the target, per coin.
    const inflow = new Map<string, bigint>();
    for (const c of tx.changes) {
      if (c.address !== address) continue;
      inflow.set(c.coinType, (inflow.get(c.coinType) ?? 0n) + BigInt(c.amount));
    }

    // Most valuable positive inflow — by USD where a price exists, else raw.
    //
    // Raw amounts are not comparable across coins: 1 USDC is 1e6 units against
    // SUI's 1e9, so a raw comparison ranks by decimal places and would call a
    // 0.1 SUI inflow "larger" than 1 USDC. Same defect the trace's hop ranking
    // had.
    let bestCoin: string | null = null;
    let bestAmt = 0n;
    let bestRank: number | null = null;
    for (const [coin, amt] of inflow) {
      if (amt <= 0n) continue;
      const usd = valueUsd?.(coin, amt) ?? null;
      if (bestCoin === null) {
        bestCoin = coin;
        bestAmt = amt;
        bestRank = usd;
        continue;
      }
      // A priced candidate always beats an unpriced one: an unpriced coin is
      // usually a token nobody trades, which is the spam signature below.
      const better =
        usd !== null && bestRank !== null
          ? usd > bestRank
          : usd !== null
            ? true
            : bestRank !== null
              ? false
              : amt > bestAmt;
      if (better) {
        bestCoin = coin;
        bestAmt = amt;
        bestRank = usd;
      }
    }
    if (!bestCoin || bestAmt <= 0n) continue; // this tx didn't fund the address

    const skip = classifyInflow(bestCoin, bestAmt, minSui, minUsd, valueUsd);
    if (skip) {
      dustSkipped.push({ digest: tx.digest, amount: bestAmt.toString(), coinType: bestCoin, reason: skip });
      continue;
    }

    return {
      digest: tx.digest,
      funder: findFunder(tx, address, bestCoin),
      timestamp: tx.timestamp,
      checkpoint: tx.checkpoint,
      amount: bestAmt.toString(),
      coinType: bestCoin,
      dustSkipped,
    };
  }
  return null;
}

/** Null when the inflow counts as funding, else why it does not. */
function classifyInflow(
  coinType: string,
  amount: bigint,
  minSui: bigint,
  minUsd: number,
  valueUsd?: (coinType: string, rawAmount: bigint) => number | null,
): SkippedInflow["reason"] | null {
  if (coinType.endsWith(SUI_TYPE_SUFFIX)) {
    return amount < minSui ? "below_sui_floor" : null;
  }
  // Without a price oracle there is nothing to judge a non-SUI coin by, so
  // accept it rather than discard evidence on a missing dependency.
  if (!valueUsd) return null;
  const usd = valueUsd(coinType, amount);
  if (usd === null) return "unpriced_coin";
  return usd < minUsd ? "below_usd_floor" : null;
}

/**
 * Who sent the funds — sought in the coin that actually arrived.
 *
 * Falls back to the overall most-negative counterparty, then to the
 * transaction sender, so an unusual shape still names someone rather than
 * "unknown".
 */
function findFunder(tx: FundingTx, address: string, receivedCoin: string): string {
  let inCoin: string | null = null;
  let inCoinMost = 0n;
  let anyCoin: string | null = null;
  let anyMost = 0n;

  for (const c of tx.changes) {
    if (c.address === address) continue;
    const amt = BigInt(c.amount);
    if (amt >= 0n) continue;
    if (c.coinType === receivedCoin && amt < inCoinMost) {
      inCoinMost = amt;
      inCoin = c.address;
    }
    if (amt < anyMost) {
      anyMost = amt;
      anyCoin = c.address;
    }
  }

  return inCoin ?? anyCoin ?? (tx.sender && tx.sender !== address ? tx.sender : "unknown");
}
