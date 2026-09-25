import { gqlQuery } from "../clients/graphql.js";
import { getCachedFanout, saveFanout } from "./store.js";
import { currentSuiAccount } from "./chain-id.js";

/**
 * How many distinct addresses an address transacts with, in both directions.
 *
 * This is the control that stops shared-ancestry from reading as collusion.
 * Tracing several wallets back to a common funder looks damning until you
 * measure the funder: ~29,000 distinct recipients is an exchange hot wallet and
 * the convergence carries no information, while ~2,400 is small enough that
 * co-funding is worth a control test. Without the number, every shared ancestor
 * looks like a smoking gun and the analyst has to talk themselves down by hand.
 *
 * Deliberately a *sample*, not a census. Counting an exchange's true fan-out
 * would mean paginating tens of thousands of transactions; the question here is
 * only ever "is this big or small", and a bounded scan answers it. Results say
 * how far they looked so a lower bound is never mistaken for a total.
 *
 * The sample is the MOST RECENT transactions, walking backwards. Sui's GraphQL
 * `first` returns oldest-first, so a forward scan of a long-lived address
 * measures what it was doing years ago.
 */

// affectedAddress rather than sentAddress: an exchange's cold wallet receives
// from thousands and sends to almost nobody, so an outbound-only scan reads it
// as a narrow personal wallet. Measuring both directions is what distinguishes
// "quiet address" from "quiet side of a busy address".
// `last` + `before`, walking BACKWARDS from the most recent transaction.
//
// `first` returns the OLDEST transactions, so a forward scan of a 2023-era
// address describes its genesis rather than what it does now — an exchange that
// only became one recently would read as narrow, and every busy address would
// be sampled entirely from its first week. The question is always "what is this
// address doing", present tense.
const COUNTERPARTY_QUERY = `query ($addr: SuiAddress!, $last: Int!, $before: String) {
  transactions(filter: { affectedAddress: $addr }, last: $last, before: $before) {
    nodes {
      # Sponsorship rides along on the scan this query already does. A relayer
      # pays gas for strangers and may move no value at all, so it is invisible
      # in balance changes — the signal that would otherwise be missed entirely.
      sender { address }
      gasInput { gasSponsor { address } }
      effects {
        balanceChanges { nodes { amount owner { address } coinType { repr } } }
      }
    }
    pageInfo { hasPreviousPage startCursor }
  }
}`;

interface CounterpartyPage {
  transactions: {
    nodes: Array<{
      sender?: { address?: string } | null;
      gasInput?: { gasSponsor?: { address?: string } | null } | null;
      effects: {
        balanceChanges: {
          nodes: Array<{
            amount?: string;
            owner?: { address: string };
            coinType?: { repr: string };
          }>;
        };
      } | null;
    }>;
    pageInfo: { hasPreviousPage: boolean; startCursor?: string };
  };
}

export interface FanoutResult {
  address: string;
  /** Distinct recipients seen in the sample. A lower bound when `truncated`. */
  recipient_count: number;
  /** Distinct addresses that sent value TO this one. */
  sender_count: number;
  /** Distinct counterparties in either direction. */
  counterparty_count: number;
  /** Distinct coin types moved. Exchanges handle many; a personal wallet few. */
  coin_type_count: number;
  /**
   * Outbound counterparties divided by inbound, over the sample.
   *
   * Shape, not size — and it separates cases raw counts cannot. A measured
   * exchange runs near 1 (deposits in, withdrawals out) while a distribution
   * wallet runs high (it pays many and is paid by few). Two addresses with
   * ~750 counterparties each came out at 0.9 and 9.2.
   */
  out_in_ratio: number | null;
  /** Plain-language reading of that ratio. */
  flow_shape: "disperser" | "collector" | "balanced" | "unknown";
  /** Transactions actually scanned. */
  scanned_transactions: number;
  /** True when the scan hit its budget before running out of transactions. */
  truncated: boolean;
  /**
   * Coarse reading of the count, so callers don't have to invent thresholds.
   * `hub` means the address distributes so widely that co-funding is
   * meaningless — treat shared ancestry through it as noise.
   */
  classification: "hub" | "distributor" | "narrow";
  interpretation: string;
  /**
   * The classification rests on a scan that hit its budget, so the count is
   * a lower bound. Never set for `hub`, which is proven by what was seen. See
   * {@link reportedClassification}.
   */
  classification_provisional?: boolean;
  /**
   * Distinct addresses this one paid gas FOR, over the sample.
   *
   * A separate question from value fan-out, and not answerable from it: a
   * relayer sponsors strangers while moving no value of its own, so it looks
   * narrow by balance changes and is anything but.
   *
   * The distinction that matters for clustering is breadth, not volume.
   * Measured on mainnet: one sponsor paid gas in 278 of 400 sampled
   * transactions but for only 7 distinct addresses — a private payer for a
   * small set, where shared sponsorship is a real link. A public relayer pays
   * for strangers and shared sponsorship through it means nothing.
   */
  sponsored_address_count: number;
  /** Transactions in the sample where this address paid someone else's gas. */
  sponsored_transaction_count: number;
  /** Coarse reading of sponsorship breadth. `relayer` means treat it as noise. */
  sponsor_shape: "relayer" | "private_sponsor" | "not_a_sponsor";
  /** What that shape licenses. Absent when there is nothing worth saying. */
  sponsor_interpretation?: string;
  /**
   * The shape rests on a scan that hit its budget, so "narrow" may only mean
   * "not far enough". Never set for `relayer`, which is proven by what was
   * seen. See {@link sponsorIsProvisional}.
   */
  sponsor_shape_provisional?: boolean;
  /** True when served from the optional local store rather than re-measured. */
  cached?: boolean;
  measured_ago_ms?: number;
}

/**
 * Thresholds on distinct counterparties within the sampled window.
 *
 * Calibrated against a deliberately small set: seven known exchange wallets
 * landed at 205–439 counterparties per 600 recent transactions, while ordinary
 * wallets landed at 6–12. The 20x gap is what makes a coarse cut defensible on
 * so few points — not the precision of the numbers themselves. Treat these as
 * "obviously busy / obviously not" rather than a calibrated classifier.
 */
const HUB_THRESHOLD = 1_000;

/**
 * Addresses one sponsor may pay for before shared sponsorship stops meaning
 * anything.
 *
 * Same logic as the funder popularity filter and the same reason: a link
 * through an intermediary is only worth something if the intermediary is
 * narrow. Measured on mainnet, a real private sponsor paid gas in 278 of 400
 * sampled transactions for just 7 distinct addresses — heavy use, tiny
 * audience. A public relayer is the opposite shape, and shared sponsorship
 * through one says nothing about whether two wallets are related.
 *
 * Deliberately below the funder limit of 50: sponsoring is an operational
 * relationship, so paying for dozens of strangers already reads as a service.
 */
const SPONSOR_BREADTH_LIMIT = 20;

function classifySponsor(count: number): FanoutResult["sponsor_shape"] {
  if (count === 0) return "not_a_sponsor";
  return count > SPONSOR_BREADTH_LIMIT ? "relayer" : "private_sponsor";
}

/**
 * Narrow and popular are not symmetric, and sponsorship is the sharpest case.
 *
 * `relayer` is proven by what was seen: 21 distinct payees is 21 distinct
 * payees however much history remains. `private_sponsor` is only ever "not
 * many so far", and the scan reads the most recent window.
 *
 * Measured on one mainnet sponsor, the count moves 1 -> 1 -> 12 -> 86 as the
 * window goes 100 -> 200 -> 400 -> 800, crossing the threshold. Reporting
 * "narrow, worth following" off a truncated scan asserts the opposite of what
 * a deeper look shows.
 *
 * Same rule `used_intermediaries.scan_complete` applies to funders.
 */
function sponsorIsProvisional(
  shape: FanoutResult["sponsor_shape"],
  truncated: boolean,
): boolean {
  return truncated && shape !== "relayer";
}

/**
 * What the sponsorship shape licenses, or undefined when it says nothing.
 *
 * Stated separately from `interpretation` because the two can disagree and the
 * disagreement is the point: an address can be narrow by value and a relayer by
 * gas. Reading only the value classification would call it a meaningful shared
 * ancestor when sponsorship through it is noise.
 */
function interpretSponsor(
  shape: FanoutResult["sponsor_shape"],
  count: number,
  truncated: boolean,
): string | undefined {
  if (shape === "not_a_sponsor") {
    // Absence off a truncated scan is not absence. Said only when it could be
    // mistaken for a finding — a complete scan seeing no sponsorship needs no
    // gloss.
    return truncated
      ? "No sponsorship seen in the window scanned, which reached its budget before the end of this address's history. That is not evidence it has never paid anyone's gas."
      : undefined;
  }
  if (shape === "relayer") {
    return `Pays gas for ${count}+ distinct addresses, which is a relayer or paymaster. Two wallets sharing it as a sponsor is NOT evidence they are related — treat shared sponsorship through this address as noise, the same as a shared exchange.`;
  }
  const base = `Pays gas for ${count} distinct address(es) in the window scanned. A narrow sponsor is an operational relationship worth following: whoever funds the gas usually runs the wallets. This can be true even when value fan-out looks unremarkable, since sponsoring moves no value of its own.`;
  return truncated
    ? `${base} PROVISIONAL: the scan hit its budget before the end of this address's history, and breadth only grows with the window — measured on one mainnet sponsor the count went 1 to 86 between a 100- and an 800-transaction scan, crossing from narrow to relayer. Raise max_transactions before relying on "narrow".`
    : base;
}
const DISTRIBUTOR_THRESHOLD = 100;

/**
 * @param counterparties distinct addresses in EITHER direction.
 * @param coinTypes distinct coin types moved — exchanges handle many.
 *
 * Bidirectional on purpose. An earlier outbound-only version classified a
 * Binance cold wallet as "narrow" off 5 recipients, because it receives from
 * thousands and sends to almost nobody. Counting only what an address pays out
 * cannot distinguish a quiet wallet from the quiet side of a busy one.
 */
export function classifyFanout(counterparties: number): {
  classification: FanoutResult["classification"];
  interpretation: string;
} {
  if (counterparties >= HUB_THRESHOLD) {
    return {
      classification: "hub",
      interpretation:
        "Exchange hot wallet, bridge or faucet-scale distributor. Two addresses sharing this " +
        "funder tells you nothing — do not read common ancestry through it as a link.",
    };
  }
  if (counterparties >= DISTRIBUTOR_THRESHOLD) {
    return {
      classification: "distributor",
      interpretation:
        "Distributes widely. Co-funding is weak evidence on its own; compare the rate against " +
        "a control group before drawing a conclusion.",
    };
  }
  return {
    classification: "narrow",
    interpretation:
      "Narrow fan-out. Several targets funded from here is meaningful and worth investigating.",
  };
}

/**
 * The classification as it may be reported, given how the scan ended.
 *
 * Same asymmetry as {@link sponsorIsProvisional}. `hub` is proven by the
 * counterparties seen. `narrow` and `distributor` off a truncated scan are
 * lower bounds, because the scan reads the most recent window and a quiet
 * recent window says nothing about what the address did before. Reporting
 * "narrow, worth investigating" off such a scan is the reading that names an
 * exchange's early wallet as a meaningful origin.
 */
export function reportedClassification(
  counterparties: number,
  truncated: boolean,
): Pick<FanoutResult, "classification" | "interpretation" | "classification_provisional"> {
  const { classification, interpretation } = classifyFanout(counterparties);
  if (!truncated || classification === "hub") return { classification, interpretation };
  return {
    classification,
    classification_provisional: true,
    interpretation:
      classification === "narrow"
        ? "Narrow within the window scanned, but the scan reached its budget before the end of this address's history, so the count is a lower bound. Raise max_transactions before reading shared funding through it as meaningful."
        : `${interpretation} The scan reached its budget before the end of this address's history, so the count is a lower bound and the address may be hub-scale.`,
  };
}

/**
 * Count distinct counterparties of `address`, walking backwards from its most
 * recent activity and scanning at most `maxTransactions`.
 *
 * Both directions count. A balance change belonging to someone else is a
 * recipient when the subject's own change is negative and a sender when it is
 * positive. Counting outflows alone cannot see a custodial wallet, which
 * receives from thousands and pays almost nobody, and so read as "narrow".
 */
export async function measureFanout(
  address: string,
  maxTransactions = 1000,
  useCache = true,
): Promise<FanoutResult> {
  // Cheap win when the optional store is on: this is the expensive measurement
  // in the toolkit (up to 20 paginated queries) and its answer is stable.
  // Returns nothing when the store is disabled, which is the default.
  // Chain-qualified so a mainnet and a testnet measurement of the same
  // address string cannot share a cache row — they are different accounts
  // with genuinely different counterparty counts.
  const account = currentSuiAccount(address);

  if (useCache) {
    const cached = getCachedFanout(account);
    // A cached reading is only usable if it is at least as thorough as what is
    // being asked for. find_funding_sources measures shared funders at 300
    // transactions and the cache is keyed on address alone, so without this a
    // shallow reading is served to a later 1500-transaction request — weaker and
    // more truncated than asked for, for a week. An untruncated scan is exempt:
    // it reached the end of the address's history, so more depth finds nothing.
    const deepEnough =
      cached && (cached.truncated === 0 || cached.scanned_transactions >= maxTransactions);
    if (cached && deepEnough) {
      return {
        address,
        recipient_count: cached.recipient_count,
        sender_count: cached.sender_count,
        counterparty_count: cached.counterparty_count,
        coin_type_count: cached.coin_type_count,
        out_in_ratio: cached.out_in_ratio,
        flow_shape: cached.flow_shape as FanoutResult["flow_shape"],
        // Read back rather than recomputed. Defaulting these to 0 on a cache
        // hit would claim "not a sponsor" from data this path never looked at,
        // and a cached answer would silently disagree with a fresh one.
        sponsored_address_count: cached.sponsored_address_count,
        sponsored_transaction_count: cached.sponsored_transaction_count,
        sponsor_shape: cached.sponsor_shape as FanoutResult["sponsor_shape"],
        ...(interpretSponsor(
          cached.sponsor_shape as FanoutResult["sponsor_shape"],
          cached.sponsored_address_count,
          cached.truncated === 1,
        )
          ? {
              sponsor_interpretation: interpretSponsor(
                cached.sponsor_shape as FanoutResult["sponsor_shape"],
                cached.sponsored_address_count,
                cached.truncated === 1,
              ),
            }
          : {}),
        ...(sponsorIsProvisional(
          cached.sponsor_shape as FanoutResult["sponsor_shape"],
          cached.truncated === 1,
        )
          ? { sponsor_shape_provisional: true }
          : {}),
        scanned_transactions: cached.scanned_transactions,
        truncated: cached.truncated === 1,
        ...reportedClassification(cached.counterparty_count, cached.truncated === 1),
        cached: true,
        measured_ago_ms: cached.age_ms,
      };
    }
  }

  const recipients = new Set<string>();
  const senders = new Set<string>();
  const coinTypes = new Set<string>();
  /** Addresses this one paid gas FOR. Never includes self-paid transactions. */
  const sponsored = new Set<string>();
  let sponsoredTxs = 0;
  let scanned = 0;
  let cursor: string | undefined;
  let hasNext = true;

  while (hasNext && scanned < maxTransactions) {
    const page: CounterpartyPage = await gqlQuery(COUNTERPARTY_QUERY, {
      addr: address,
      last: Math.min(50, maxTransactions - scanned),
      before: cursor,
    });

    for (const node of page.transactions.nodes) {
      scanned++;

      // Paying your own gas is not sponsorship, so the sender must differ.
      const sponsor = node.gasInput?.gasSponsor?.address;
      const sender = node.sender?.address;
      if (sponsor === address && sender && sender !== address) {
        sponsored.add(sender);
        sponsoredTxs++;
      }

      const changes = node.effects?.balanceChanges.nodes ?? [];
      // Whether this transaction moved value in or out decides which side each
      // counterparty belongs to, so read the subject's own change first.
      const own = changes.find((c) => c.owner?.address === address);
      const ownDelta = BigInt(own?.amount ?? "0");

      for (const bc of changes) {
        const owner = bc.owner?.address;
        if (!owner) continue;
        if (bc.coinType?.repr) coinTypes.add(bc.coinType.repr);
        if (owner === address) continue;
        // Subject paid out → the counterparty gaining value is a recipient.
        if (ownDelta < 0n && BigInt(bc.amount ?? "0") > 0n) recipients.add(owner);
        // Subject took value in → the counterparty losing value is a sender.
        if (ownDelta > 0n && BigInt(bc.amount ?? "0") < 0n) senders.add(owner);
      }
    }

    hasNext = page.transactions.pageInfo.hasPreviousPage;
    cursor = page.transactions.pageInfo.startCursor;
    if (!cursor) break;
  }

  const counterparties = new Set([...recipients, ...senders]);
  const ratio = senders.size > 0 ? recipients.size / senders.size : null;
  const flowShape: FanoutResult["flow_shape"] =
    ratio === null ? "unknown" : ratio >= 3 ? "disperser" : ratio <= 0.33 ? "collector" : "balanced";
  const sponsorShape = classifySponsor(sponsored.size);
  // Persist every field the measurement produced. Storing only the total used
  // to make a cache hit report -1 for the in/out split and "unknown" for flow
  // shape — and recipient_count was written as the counterparty total, so a
  // cached read disagreed with a fresh one on the same address.
  saveFanout({
    account,
    recipient_count: recipients.size,
    sender_count: senders.size,
    counterparty_count: counterparties.size,
    coin_type_count: coinTypes.size,
    out_in_ratio: ratio,
    flow_shape: flowShape,
    sponsored_address_count: sponsored.size,
    sponsored_transaction_count: sponsoredTxs,
    sponsor_shape: sponsorShape,
    scanned_transactions: scanned,
    truncated: hasNext ? 1 : 0,
  });

  return {
    address,
    recipient_count: recipients.size,
    sender_count: senders.size,
    counterparty_count: counterparties.size,
    coin_type_count: coinTypes.size,
    out_in_ratio: ratio === null ? null : Number(ratio.toFixed(2)),
    flow_shape: flowShape,
    sponsored_address_count: sponsored.size,
    sponsored_transaction_count: sponsoredTxs,
    sponsor_shape: sponsorShape,
    ...(interpretSponsor(sponsorShape, sponsored.size, hasNext)
      ? { sponsor_interpretation: interpretSponsor(sponsorShape, sponsored.size, hasNext) }
      : {}),
    ...(sponsorIsProvisional(sponsorShape, hasNext) ? { sponsor_shape_provisional: true } : {}),
    scanned_transactions: scanned,
    truncated: hasNext,
    ...reportedClassification(counterparties.size, hasNext),
  };
}
