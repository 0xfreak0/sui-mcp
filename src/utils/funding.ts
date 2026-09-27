/**
 * Pure selection logic for funding-source attribution: given an address's
 * earliest transactions (oldest first), find the first one that actually funded
 * it (net positive inflow) and who the funder was. Kept pure so it's testable
 * without the chain.
 */

import { isSuiCoinType } from "./sponsor-gas.js";

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
  /** Who paid the gas, when the service reports it. Absent when not read. */
  gasSponsor?: string | null;
}

export interface FundingResult {
  digest: string;
  funder: string;
  timestamp: string | null;
  checkpoint: string | null;
  /** Net amount the target received, raw. */
  amount: string;
  coinType: string;
  /** Set when the coin has no price and counted for its share of supply. */
  unpriced?: UnpricedFunding;
}

/** What the chain says about an unpriced coin, for {@link FundingOptions.coinOrigin}. */
export interface CoinOrigin {
  /** Total supply in raw units, or null when the chain does not report it. */
  totalSupply: bigint | null;
  /** The address that published the coin's package, or null when not read. */
  publisher: string | null;
}

/** Why an inflow in a coin nobody prices still counted as funding. */
export interface UnpricedFunding {
  /** The inflow as a share of the coin's current total supply, 0 to 1. */
  share_of_supply: number;
  /** The coin's own publisher sent it. */
  from_publisher: boolean;
  /**
   * `supply_share`: the share alone clears {@link UNPRICED_SUPPLY_SHARE}, or
   * {@link UNPRICED_PUBLISHER_SHARE} from the publisher. `targeted_send`: a
   * smaller share, sent in the shape of a grant (see {@link SendShape}).
   */
  basis: "supply_share" | "targeted_send";
  /** How the funder sent the coin, when it was read. */
  send_shape?: SendShape;
}

/**
 * How a funder sent one unpriced coin around the inflow being judged. A mass
 * send pays many addresses at once, or in a burst, or the same amount each;
 * a grant pays one or a few, in amounts of their own.
 */
export interface SendShape {
  /** Distinct addresses other than the funder the inflow's own transaction paid in the coin. */
  recipients_in_tx: number;
  /**
   * Distinct addresses the funder paid in the coin across the transactions it
   * sent within {@link SEND_BURST_CHECKPOINTS} either side of the inflow, the
   * inflow's own included. A lower bound when `burst_truncated`.
   */
  burst_recipients: number;
  /** The window held more sends, or a send more balance changes, than one read returns. */
  burst_truncated?: true;
  /** At least three of those payments, all of one amount: a list send. */
  even_amounts: boolean;
}

/**
 * The share of an unpriced coin's supply that counts as funding whoever sent
 * it. An airdrop pays thousands of wallets, and at most 100 can each hold 1%
 * of a supply at once, so no mass send reaches this.
 */
export const UNPRICED_SUPPLY_SHARE = 0.01;

/**
 * The same, when the coin's publisher sent it: a deployer's allocation to an
 * insider or a bundled buyer. At most 1,000 wallets can each hold 0.1%, still
 * too few for an airdrop, while a publisher's spam send of 0.01% apiece to
 * 10,000 wallets stays below it.
 */
export const UNPRICED_PUBLISHER_SHARE = 0.001;

/**
 * The share below which an unpriced inflow is spam whatever its shape. Above
 * it and below the two shares above, the send decides: a grant to one or a
 * few insiders counts, a list or burst send does not. A spammer paying
 * 10,000 wallets this much one at a time, slowly enough to pass as a grant,
 * would take months per coin.
 */
export const UNPRICED_TARGETED_SHARE = 0.0001;

/** Most distinct recipients a send may have, in its transaction and its burst, and read as a grant. */
export const GRANT_MAX_RECIPIENTS = 5;

/** Checkpoints either side of an inflow searched for the funder's other sends of the coin: about ten minutes. */
export const SEND_BURST_CHECKPOINTS = 2400;

/** Whether a send reads as a grant to one or a few addresses rather than a mass send. */
export function isTargetedSend(shape: SendShape): boolean {
  return (
    !shape.burst_truncated &&
    shape.recipients_in_tx <= GRANT_MAX_RECIPIENTS &&
    shape.burst_recipients <= GRANT_MAX_RECIPIENTS &&
    !shape.even_amounts
  );
}

/** How a candidate inflow was judged, so a skip is never silent. */
export interface SkippedInflow {
  digest: string;
  amount: string;
  coinType: string;
  /** Who sent it, by the rule the funding pick applies. */
  funder: string;
  reason: "below_sui_floor" | "below_usd_floor" | "unpriced_coin";
}

/** A party that paid gas for transactions the address sent. */
export interface GasSponsor {
  sponsor: string;
  /** Transactions among those scanned whose gas this sponsor paid. */
  transactions: number;
  first_digest: string;
}

/**
 * What the earliest transactions say about how an address was funded.
 *
 * `dustSkipped` is kept whether or not a funding was found: a wallet whose
 * every inflow was below the floors is the case where the skipped list is the
 * only evidence there is.
 */
export interface FundingAssessment {
  funding: FundingResult | null;
  dustSkipped: SkippedInflow[];
  /**
   * Parties that paid gas for transactions the address sent, most frequent
   * first. Since gas can be paid from an address balance, a wallet can run
   * with no SUI of its own and no qualifying inflow, and then its operator
   * appears here and nowhere else.
   */
  sponsors: GasSponsor[];
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
   * small payment. The exception is below: `coinOrigin`.
   */
  valueUsd?: (coinType: string, rawAmount: bigint) => number | null;
  /**
   * Supply and publisher of an unpriced coin, when the caller read them.
   *
   * A rug's own token is unpriced once its pool dies, and the deployer's
   * grant of it to an insider is how that insider was set up. An inflow of
   * {@link UNPRICED_SUPPLY_SHARE} of the supply, or
   * {@link UNPRICED_PUBLISHER_SHARE} from the publisher, counts as funding;
   * anything smaller counts only as a grant (`sendShape`), and a coin whose
   * supply is unknown stays spam.
   */
  coinOrigin?: (coinType: string) => CoinOrigin | undefined;
  /**
   * How the funder sent an unpriced coin, when the caller read it, by the
   * inflow's digest and coin. An inflow of at least
   * {@link UNPRICED_TARGETED_SHARE} of the supply counts as funding when the
   * send reads as a grant ({@link isTargetedSend}).
   */
  sendShape?: (digest: string, coinType: string) => SendShape | undefined;
}

export const DEFAULT_MIN_SUI_MIST = 10_000_000n; // 0.01 SUI
export const DEFAULT_MIN_USD = 0.1;


/**
 * From a list of the address's earliest transactions (ascending), pick the
 * first one that actually **funded** it, and identify the funder.
 *
 * Three things this gets right that a naive "first positive inflow" does not.
 *
 * **Dust is not funding.** Airdropped scam NFTs are already invisible here
 * (they move no coin), but coin dust is not: without a floor a 1-MIST spam
 * send would become "first funded by", and `find_funding_source` would then
 * walk the spammer's ancestry as if it were the subject's origin. Candidates
 * below the floors, or denominated in a coin nobody prices, are skipped and
 * reported in `dustSkipped` rather than dropped silently.
 *
 * **The funder must have sent what the target received.** Picking the
 * counterparty with the most-negative change across *all* coins attributes a
 * sponsored transfer to whoever paid the gas: gas is folded into the payer's
 * net SUI rather than itemised, so a sponsor's -0.036 SUI (raw -36000000)
 * outranks a real sender's -11 USDC (raw -11085939) purely because SUI has
 * three more decimals. The funder is sought in the coin that actually
 * arrived.
 *
 * **A gas sponsor is reported whether or not funding was found.** The two
 * are independent facts: a sponsor pays this wallet's gas regardless of who
 * happened to send it a coin. An address-poisoning lookalike's only inflow
 * clearing the funding floor can be its victim's payment, while the address
 * that created and operates it never sends enough to clear a dust floor and
 * shows up only as its gas sponsor. Reporting sponsors only at a dead end
 * would hide that operator whenever any inflow, however unrelated, cleared
 * the floor.
 */
export function pickFundingTx(
  txs: FundingTx[],
  address: string,
  opts: FundingOptions = {},
): FundingAssessment {
  const minSui = opts.minSuiMist ?? DEFAULT_MIN_SUI_MIST;
  const minUsd = opts.minUsd ?? DEFAULT_MIN_USD;
  const valueUsd = opts.valueUsd;
  const dustSkipped: SkippedInflow[] = [];
  const sponsors = gasSponsorsOf(txs, address);

  for (const tx of txs) {
    // Net inflow to the target, per coin.
    const inflow = new Map<string, bigint>();
    for (const c of tx.changes) {
      if (c.address !== address) continue;
      inflow.set(c.coinType, (inflow.get(c.coinType) ?? 0n) + BigInt(c.amount));
    }

    // Positive inflows, most valuable first: by USD where a price exists,
    // else raw.
    //
    // Raw amounts are not comparable across coins: 1 USDC is 1e6 units against
    // SUI's 1e9, so a raw comparison ranks by decimal places and would call a
    // 0.1 SUI inflow "larger" than 1 USDC. A priced candidate always ranks
    // above an unpriced one: an unpriced coin is usually a token nobody
    // trades, which is the spam signature below.
    const ranked = [...inflow]
      .filter(([, amt]) => amt > 0n)
      .map(([coin, amt]) => ({ coin, amt, usd: valueUsd?.(coin, amt) ?? null }))
      .sort((a, b) => {
        if (a.usd !== null && b.usd !== null) return b.usd - a.usd;
        if (a.usd !== null || b.usd !== null) return a.usd !== null ? -1 : 1;
        return a.amt === b.amt ? 0 : a.amt > b.amt ? -1 : 1;
      });

    // Every inflow is judged before the transaction is passed over, so a
    // sub-floor coin in the same transaction cannot hide one that counts.
    for (const { coin, amt } of ranked) {
      const funder = findFunder(tx, address, coin);
      const judged = classifyInflow(tx.digest, coin, amt, funder, minSui, minUsd, opts);
      if ("skip" in judged) {
        dustSkipped.push({ digest: tx.digest, amount: amt.toString(), coinType: coin, funder, reason: judged.skip });
        continue;
      }
      return {
        funding: {
          digest: tx.digest,
          funder,
          timestamp: tx.timestamp,
          checkpoint: tx.checkpoint,
          amount: amt.toString(),
          coinType: coin,
          ...(judged.unpriced ? { unpriced: judged.unpriced } : {}),
        },
        dustSkipped,
        sponsors,
      };
    }
  }
  return { funding: null, dustSkipped, sponsors };
}

/**
 * Who paid gas for the transactions `address` sent, most frequent first.
 *
 * Paying your own gas is not sponsorship, so a sponsor equal to the address is
 * skipped. A wallet that runs on zero SUI of its own, which gas paid from an
 * address balance allows, has its operator here.
 */
function gasSponsorsOf(txs: FundingTx[], address: string): GasSponsor[] {
  const bySponsor = new Map<string, GasSponsor>();
  for (const tx of txs) {
    if (tx.sender !== address || !tx.gasSponsor || tx.gasSponsor === address) continue;
    const entry = bySponsor.get(tx.gasSponsor);
    if (entry) entry.transactions++;
    else bySponsor.set(tx.gasSponsor, { sponsor: tx.gasSponsor, transactions: 1, first_digest: tx.digest });
  }
  return [...bySponsor.values()].sort((a, b) => b.transactions - a.transactions);
}

/**
 * Whether a payment clears the dust floors funding is judged by: `minSui` for
 * SUI, `minUsd` for a priced coin. Null for a coin no price source quotes,
 * which a floor cannot judge. With no `valueUsd` (no price could be read at
 * all) any non-SUI amount clears, so evidence is not discarded on a missing
 * dependency.
 */
export function clearsDustFloor(
  coinType: string,
  amount: bigint,
  valueUsd?: (coinType: string, rawAmount: bigint) => number | null,
  minSui: bigint = DEFAULT_MIN_SUI_MIST,
  minUsd: number = DEFAULT_MIN_USD,
): boolean | null {
  // The exact type: any package can name a coin `sui::SUI`.
  if (isSuiCoinType(coinType)) return amount >= minSui;
  if (!valueUsd) return true;
  const usd = valueUsd(coinType, amount);
  return usd === null ? null : usd >= minUsd;
}

/** Why the inflow does not count, or, when it counts unpriced, on what grounds. */
function classifyInflow(
  digest: string,
  coinType: string,
  amount: bigint,
  funder: string,
  minSui: bigint,
  minUsd: number,
  opts: FundingOptions,
): { skip: SkippedInflow["reason"] } | { unpriced?: UnpricedFunding } {
  const clears = clearsDustFloor(coinType, amount, opts.valueUsd, minSui, minUsd);
  if (clears === true) return {};
  if (clears === false) return { skip: isSuiCoinType(coinType) ? "below_sui_floor" : "below_usd_floor" };
  // No market. Spam, unless the inflow is a share of the supply that no mass
  // send could give each of its recipients, or a smaller share sent as a
  // grant to one or a few addresses rather than as a list or burst send.
  const origin = opts.coinOrigin?.(coinType);
  if (!origin?.totalSupply || origin.totalSupply <= 0n) return { skip: "unpriced_coin" };
  const share = Number((amount * 1_000_000n) / origin.totalSupply) / 1_000_000;
  const fromPublisher = origin.publisher !== null && origin.publisher === funder;
  const shape = opts.sendShape?.(digest, coinType);
  const shaped = shape ? { send_shape: shape } : {};
  if (share >= UNPRICED_SUPPLY_SHARE || (fromPublisher && share >= UNPRICED_PUBLISHER_SHARE)) {
    return { unpriced: { share_of_supply: share, from_publisher: fromPublisher, basis: "supply_share", ...shaped } };
  }
  if (share >= UNPRICED_TARGETED_SHARE && shape && isTargetedSend(shape)) {
    return { unpriced: { share_of_supply: share, from_publisher: fromPublisher, basis: "targeted_send", send_shape: shape } };
  }
  return { skip: "unpriced_coin" };
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
