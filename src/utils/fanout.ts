import { gqlQuery } from "../clients/graphql.js";
import { getCachedFanout, saveFanout } from "./store.js";

/**
 * How many distinct addresses an address has sent value to.
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
export function classifyFanout(counterparties: number, coinTypes = 0): {
  classification: FanoutResult["classification"];
  interpretation: string;
} {
  const recipients = counterparties;
  if (recipients >= HUB_THRESHOLD) {
    return {
      classification: "hub",
      interpretation:
        "Exchange hot wallet, bridge or faucet-scale distributor. Two addresses sharing this " +
        "funder tells you nothing — do not read common ancestry through it as a link.",
    };
  }
  if (recipients >= DISTRIBUTOR_THRESHOLD) {
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
 * Count distinct recipients of `address`, scanning at most `maxTransactions`.
 *
 * Only outflows count: a balance change is a recipient when it is positive and
 * belongs to someone else. Counting every counterparty would fold in the
 * address's own funders and inflate narrow wallets into apparent distributors.
 */
export async function measureFanout(
  address: string,
  maxTransactions = 1000,
  useCache = true,
): Promise<FanoutResult> {
  // Cheap win when the optional store is on: this is the expensive measurement
  // in the toolkit (up to 20 paginated queries) and its answer is stable.
  // Returns nothing when the store is disabled, which is the default.
  if (useCache) {
    const cached = getCachedFanout(address);
    if (cached) {
      // The store keeps only the counterparty total, so a cached hit cannot
      // restore the in/out split or coin diversity. Reported as unknown rather
      // than zero, which would read as a measured absence.
      const { classification, interpretation } = classifyFanout(cached.recipient_count);
      return {
        address,
        recipient_count: cached.recipient_count,
        sender_count: -1,
        counterparty_count: cached.recipient_count,
        coin_type_count: -1,
        out_in_ratio: null,
        flow_shape: "unknown",
        scanned_transactions: 0,
        truncated: cached.truncated === 1,
        classification,
        interpretation,
        cached: true,
        measured_ago_ms: cached.age_ms,
      };
    }
  }

  const recipients = new Set<string>();
  const senders = new Set<string>();
  const coinTypes = new Set<string>();
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
  const { classification, interpretation } = classifyFanout(counterparties.size, coinTypes.size);
  saveFanout({ address, recipient_count: counterparties.size, truncated: hasNext ? 1 : 0 });

  return {
    address,
    recipient_count: recipients.size,
    sender_count: senders.size,
    counterparty_count: counterparties.size,
    coin_type_count: coinTypes.size,
    out_in_ratio: ratio === null ? null : Number(ratio.toFixed(2)),
    flow_shape: flowShape,
    scanned_transactions: scanned,
    truncated: hasNext,
    classification,
    interpretation,
  };
}
