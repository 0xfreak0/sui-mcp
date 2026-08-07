import { gqlQuery } from "../clients/graphql.js";

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
 */

const OUTBOUND_QUERY = `query ($addr: SuiAddress!, $first: Int!, $after: String) {
  transactions(filter: { sentAddress: $addr }, first: $first, after: $after) {
    nodes {
      effects {
        balanceChanges { nodes { amount owner { address } } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

interface OutboundPage {
  transactions: {
    nodes: Array<{
      effects: {
        balanceChanges: {
          nodes: Array<{ amount?: string; owner?: { address: string } }>;
        };
      } | null;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
}

export interface FanoutResult {
  address: string;
  /** Distinct recipients seen in the sample. A lower bound when `truncated`. */
  recipient_count: number;
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
}

/** Above this, shared funding through the address carries no signal. */
const HUB_THRESHOLD = 10_000;
/** Above this it still distributes widely, but co-funding may mean something. */
const DISTRIBUTOR_THRESHOLD = 500;

export function classifyFanout(recipients: number): {
  classification: FanoutResult["classification"];
  interpretation: string;
} {
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
): Promise<FanoutResult> {
  const recipients = new Set<string>();
  let scanned = 0;
  let cursor: string | undefined;
  let hasNext = true;

  while (hasNext && scanned < maxTransactions) {
    const page: OutboundPage = await gqlQuery(OUTBOUND_QUERY, {
      addr: address,
      first: Math.min(50, maxTransactions - scanned),
      after: cursor,
    });

    for (const node of page.transactions.nodes) {
      scanned++;
      for (const bc of node.effects?.balanceChanges.nodes ?? []) {
        const owner = bc.owner?.address;
        if (!owner || owner === address) continue;
        if (BigInt(bc.amount ?? "0") > 0n) recipients.add(owner);
      }
    }

    hasNext = page.transactions.pageInfo.hasNextPage;
    cursor = page.transactions.pageInfo.endCursor;
    if (!cursor) break;
  }

  const { classification, interpretation } = classifyFanout(recipients.size);
  return {
    address,
    recipient_count: recipients.size,
    scanned_transactions: scanned,
    truncated: hasNext,
    classification,
    interpretation,
  };
}
