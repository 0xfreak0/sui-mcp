/**
 * Direct payments between addresses under investigation.
 *
 * A funding walk sees one inflow per address, its first. A later payment from
 * one subject to another is invisible to it, yet it is chain-derived and needs
 * no base rate to interpret: the transaction names both parties. This finds
 * every such payment for a batch of subjects.
 *
 * Each ordered pair is asked directly, with `sentAddress: payer` and
 * `affectedAddress: payee` in one filter, so the answer does not depend on how
 * far back either address's history runs. Pairs are aliased into one document
 * per `PAIRS_PER_REQUEST`, which keeps a batch of three subjects at one request.
 *
 * Nothing here is a clustering signal. `build_wallet_edges` does not weigh a
 * one-way payment, and this does not change that.
 */

import { gqlQuery } from "../clients/graphql.js";
import { normalizeWatchAddress } from "./watch.js";
import { completeTxConnections, NESTED_PAGE_SIZE, type GqlConnection } from "./tx-connections.js";
import type { GqlBalanceChangeNode } from "./gql-adapters.js";
import type { FundingChange } from "./funding.js";

/**
 * Ordered pairs per aliased document.
 *
 * The service rejects a document over 5,000 bytes or 300 nodes. One alias is
 * about 390 bytes and 18 nodes with balance changes selected, so ten stays
 * clear of both.
 */
export const PAIRS_PER_REQUEST = 10;

/** Transactions per pair in the aliased request. Pairs with more are paged alone. */
const FIRST_PAGE = 20;

/** Follow-up pages for one pair, at 50 transactions each. */
const MAX_PAIR_PAGES = 5;

/**
 * Subjects past which the pairwise check is not run. Pairs grow with the
 * square of the batch: 20 subjects are 380 ordered pairs, 38 requests.
 */
export const MAX_PAIRWISE_SUBJECTS = 20;

const PAIR_SELECTION =
  "pageInfo{hasNextPage endCursor} nodes{digest effects{timestamp " +
  `balanceChanges(first:${NESTED_PAGE_SIZE}){pageInfo{hasNextPage endCursor} nodes{amount owner{address} coinType{repr}}}}}`;

const MORE_PAIR_QUERY = `query ($payer: SuiAddress!, $payee: SuiAddress!, $after: String) {
  transactions(filter: { sentAddress: $payer, affectedAddress: $payee }, first: 50, after: $after) { ${PAIR_SELECTION} }
}`;

interface PairNode {
  digest: string;
  effects?: { timestamp?: string | null; balanceChanges?: GqlConnection<GqlBalanceChangeNode> | null } | null;
}

interface PairConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes: PairNode[];
}

export interface SubjectPayment {
  payer: string;
  payee: string;
  digest: string;
  timestamp: string | null;
  /** The payee's net gain in this transaction, per coin, raw. */
  received: Array<{ coinType: string; amount: string }>;
  /** The transaction's balance changes could not all be read. */
  balance_changes_incomplete?: true;
}

export interface SubjectPaymentScan {
  payments: SubjectPayment[];
  pairs_checked: number;
  /** Pairs whose transactions were not all read, so more payments may exist. */
  incomplete_pairs: Array<{ payer: string; payee: string }>;
  /** Inputs left out because they are not valid addresses. */
  invalid: string[];
  requests: number;
}

/**
 * The payee's net positive change per coin, or null when it gained nothing.
 *
 * Net, not the first positive row: a payee that received one coin and spent
 * it in the same transaction was not paid.
 */
export function paymentInTx(
  payer: string,
  payee: string,
  digest: string,
  timestamp: string | null,
  changes: FundingChange[],
): SubjectPayment | null {
  const net = new Map<string, bigint>();
  for (const c of changes) {
    if (c.address !== payee) continue;
    net.set(c.coinType, (net.get(c.coinType) ?? 0n) + BigInt(c.amount));
  }
  const received = [...net]
    .filter(([, amt]) => amt > 0n)
    .map(([coinType, amt]) => ({ coinType, amount: amt.toString() }));
  if (received.length === 0) return null;
  return { payer, payee, digest, timestamp, received };
}

/**
 * Every payment between two of `subjects` that the payer signed.
 *
 * Invalid addresses are left out of the batched documents and reported: one
 * unparseable address makes the service return no data for the whole document.
 */
export async function findSubjectPayments(subjects: string[]): Promise<SubjectPaymentScan> {
  const invalid: string[] = [];
  const valid: string[] = [];
  for (const s of subjects) {
    const n = normalizeWatchAddress(s);
    if (!n) invalid.push(s);
    else if (!valid.includes(n)) valid.push(n);
  }

  const pairs: Array<{ payer: string; payee: string }> = [];
  for (const payer of valid) for (const payee of valid) if (payer !== payee) pairs.push({ payer, payee });

  const found: Array<{ payer: string; payee: string; node: PairNode }> = [];
  const incomplete: Array<{ payer: string; payee: string }> = [];
  let requests = 0;

  for (let i = 0; i < pairs.length; i += PAIRS_PER_REQUEST) {
    const batch = pairs.slice(i, i + PAIRS_PER_REQUEST);
    const query =
      "query{" +
      batch
        .map(
          (p, j) =>
            `p${j}:transactions(filter:{sentAddress:"${p.payer}",affectedAddress:"${p.payee}"},first:${FIRST_PAGE}){${PAIR_SELECTION}}`,
        )
        .join("") +
      "}";
    requests++;
    const data = await gqlQuery<Record<string, PairConnection | null>>(query, {});

    for (const [j, p] of batch.entries()) {
      const conn = data[`p${j}`];
      if (!conn) {
        incomplete.push(p);
        continue;
      }
      for (const node of conn.nodes) found.push({ ...p, node });
      let more = conn.pageInfo?.hasNextPage === true;
      let cursor = conn.pageInfo?.endCursor ?? null;
      let pages = 0;
      while (more && cursor && pages < MAX_PAIR_PAGES) {
        requests++;
        pages++;
        const next = await gqlQuery<{ transactions: PairConnection }>(MORE_PAIR_QUERY, {
          payer: p.payer,
          payee: p.payee,
          after: cursor,
        }).catch(() => null);
        if (!next) break;
        for (const node of next.transactions.nodes) found.push({ ...p, node });
        more = next.transactions.pageInfo?.hasNextPage === true;
        cursor = next.transactions.pageInfo?.endCursor ?? null;
      }
      if (more) incomplete.push(p);
    }
  }

  const completed = await completeTxConnections(
    found.map((f) => ({ digest: f.node.digest, balanceChanges: f.node.effects?.balanceChanges })),
  );

  const payments: SubjectPayment[] = [];
  for (const [k, f] of found.entries()) {
    const payment = paymentInTx(
      f.payer,
      f.payee,
      f.node.digest,
      f.node.effects?.timestamp ?? null,
      completed[k].balanceChanges
        .filter((c) => c.owner?.address && c.amount && c.coinType?.repr)
        .map((c) => ({ address: c.owner!.address, amount: c.amount!, coinType: c.coinType!.repr })),
    );
    if (payment) {
      if (completed[k].balanceChangesTruncated) payment.balance_changes_incomplete = true;
      payments.push(payment);
    } else if (completed[k].balanceChangesTruncated) {
      // The payee's credit may sit in the rows that could not be read.
      incomplete.push({ payer: f.payer, payee: f.payee });
    }
  }
  payments.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));

  return { payments, pairs_checked: pairs.length, incomplete_pairs: incomplete, invalid, requests };
}
