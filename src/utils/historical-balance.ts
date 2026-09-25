/**
 * A balance at a past checkpoint.
 *
 * GraphQL reads `address(atCheckpoint:).balance` only inside its consistent
 * range, about the most recent hour of checkpoints. Outside it the balance is
 * reconstructed:
 *
 *   balance at C = balance at A − Σ the owner's changes in that coin, over
 *                  every transaction in checkpoints (C, A]
 *
 * A balance change nets the owner's `Coin<T>` objects and its address balance,
 * so address-balance deposits and withdrawals are in the sum and the result is
 * exact, provided every transaction in (C, A] was read. `affectedAddress`
 * includes every owner of a balance change, an object id holding an address
 * balance among them.
 *
 * Both reads are pinned to one anchor checkpoint A: the current balance is
 * read with `atCheckpoint: A`, and the scan's filter stops at
 * `beforeCheckpoint: A + 1`. Reading "now" twice would let a transaction that
 * lands between the two reads count on one side and not the other.
 *
 * A scan the budget stops, or a transaction whose balance changes could not
 * all be read, gives no number. A partial sum is a wrong balance that looks
 * like a right one.
 */

import { normalizeStructTag } from "@mysten/sui/utils";
import { gqlQuery } from "../clients/graphql.js";
import { checkpointBracket, type CheckpointPoint } from "./checkpoint-time.js";
import { formatCoinAmount } from "./coin-amount.js";
import type { GqlBalanceChangeNode } from "./gql-adapters.js";
import { BOTH_WAYS_PAGE_INFO, orderedPage, orderedPageArgs, type BothWaysPageInfo } from "./pagination.js";
import { BALANCE_CHANGES_SELECTION, completeTxConnections, type GqlConnection } from "./tx-connections.js";

export const DEFAULT_MAX_TRANSACTIONS = 1_000;
export const MAX_MAX_TRANSACTIONS = 10_000;

/**
 * How far below the newest checkpoint the anchor sits. The range and the
 * anchored read are separate requests, and a replica a few checkpoints behind
 * the one that reported the range would refuse the newest checkpoint.
 */
const ANCHOR_MARGIN = 10;

export interface RangeEnd {
  sequenceNumber: number;
  timestamp: string | null;
}

export interface BalanceRange {
  first: RangeEnd;
  last: RangeEnd;
}

/** The checkpoints GraphQL answers `address(atCheckpoint:).balance` for, or null when unreadable. */
export async function readBalanceRange(): Promise<BalanceRange | null> {
  const data = await gqlQuery<{
    serviceConfig: { availableRange: { first: RangeEnd | null; last: RangeEnd | null } | null } | null;
  }>(`query {
    serviceConfig {
      availableRange(type: "Address", field: "balance") {
        first { sequenceNumber timestamp }
        last { sequenceNumber timestamp }
      }
    }
  }`).catch(() => null);
  const range = data?.serviceConfig?.availableRange;
  if (!range?.first || !range.last) return null;
  return { first: range.first, last: range.last };
}

export interface BalanceSplit {
  coin_type: string;
  balance: string;
  coin_balance: string;
  address_balance: string;
  /** The timestamp of the checkpoint read at. */
  timestamp: string | null;
}

/** A balance read at one checkpoint inside the consistent range. */
export async function readBalanceAt(owner: string, coinType: string, checkpoint: number): Promise<BalanceSplit> {
  const data = await gqlQuery<{
    checkpoint: { timestamp: string | null } | null;
    address: {
      balance: { coinType: { repr: string }; totalBalance: string; coinBalance: string | null; addressBalance: string | null } | null;
    } | null;
  }>(
    `query($owner: SuiAddress!, $coinType: String!, $checkpoint: UInt53!) {
      checkpoint(sequenceNumber: $checkpoint) { timestamp }
      address(address: $owner, atCheckpoint: $checkpoint) {
        balance(coinType: $coinType) { coinType { repr } totalBalance coinBalance addressBalance }
      }
    }`,
    { owner, coinType, checkpoint },
  );
  const bal = data.address?.balance;
  return {
    coin_type: bal?.coinType.repr ?? coinType,
    balance: bal?.totalBalance ?? "0",
    coin_balance: bal?.coinBalance ?? "0",
    address_balance: bal?.addressBalance ?? "0",
    timestamp: data.checkpoint?.timestamp ?? null,
  };
}

/** The canonical spelling a balance change reports, or null for something that is not a type. */
export function canonicalCoinType(coinType: string): string | null {
  try {
    return normalizeStructTag(coinType.trim());
  } catch {
    return null;
  }
}

/**
 * The net change to `owner`'s balance of `coinType` in one transaction's
 * balance changes. `coinType` must already be canonical; each change's type is
 * canonicalised before comparing, so a short `0x2::sui::SUI` still matches.
 */
export function ownerCoinDelta(changes: GqlBalanceChangeNode[], owner: string, coinType: string): bigint {
  let sum = 0n;
  for (const c of changes) {
    if (c.owner?.address !== owner || !c.coinType?.repr || c.amount == null) continue;
    if (canonicalCoinType(c.coinType.repr) !== coinType) continue;
    sum += BigInt(c.amount);
  }
  return sum;
}

interface ScanNode {
  digest: string;
  effects?: {
    timestamp?: string | null;
    checkpoint?: { sequenceNumber: number } | null;
    balanceChanges?: GqlConnection<GqlBalanceChangeNode> | null;
  } | null;
}

const SCAN_QUERY = `query($owner: SuiAddress!, $afterCp: UInt53!, $beforeCp: UInt53!, $last: Int, $before: String) {
  transactions(filter: { affectedAddress: $owner, afterCheckpoint: $afterCp, beforeCheckpoint: $beforeCp }, last: $last, before: $before) {
    nodes { digest effects { timestamp checkpoint { sequenceNumber } ${BALANCE_CHANGES_SELECTION} } }
    ${BOTH_WAYS_PAGE_INFO}
  }
}`;

export interface DeltaScan {
  /** Σ of the owner's changes in the coin over the transactions read. */
  delta: bigint;
  transactions_scanned: number;
  /** Every transaction in the interval was read, each with all its balance changes. */
  complete: boolean;
  /** The oldest checkpoint read. Null when nothing was read. */
  reached_checkpoint: number | null;
  reached_timestamp: string | null;
  /** The budget ended the scan with transactions still unread. */
  budget_exhausted: boolean;
  /** Transactions whose balance changes could not all be read. */
  incomplete_transactions: string[];
}

/**
 * Sum the owner's changes in `coinType` over every transaction in checkpoints
 * (afterCheckpoint, throughCheckpoint], newest first, reading at most
 * `maxTransactions`.
 */
export async function scanBalanceDeltas(opts: {
  owner: string;
  coinType: string;
  afterCheckpoint: number;
  throughCheckpoint: number;
  maxTransactions: number;
}): Promise<DeltaScan> {
  const scan: DeltaScan = {
    delta: 0n,
    transactions_scanned: 0,
    complete: false,
    reached_checkpoint: null,
    reached_timestamp: null,
    budget_exhausted: false,
    incomplete_transactions: [],
  };
  let cursor: string | undefined;
  while (true) {
    const remaining = opts.maxTransactions - scan.transactions_scanned;
    if (remaining <= 0) {
      scan.budget_exhausted = true;
      return scan;
    }
    const data = await gqlQuery<{ transactions: { nodes: ScanNode[]; pageInfo: BothWaysPageInfo } }>(SCAN_QUERY, {
      owner: opts.owner,
      afterCp: opts.afterCheckpoint,
      beforeCp: opts.throughCheckpoint + 1,
      ...orderedPageArgs("newest", Math.min(50, remaining), cursor),
    });
    const page = orderedPage(data.transactions.nodes, data.transactions.pageInfo, "newest");
    const completed = await completeTxConnections(
      page.nodes.map((n) => ({ digest: n.digest, balanceChanges: n.effects?.balanceChanges })),
    );
    for (const [i, node] of page.nodes.entries()) {
      scan.transactions_scanned++;
      if (completed[i].balanceChangesTruncated) scan.incomplete_transactions.push(node.digest);
      scan.delta += ownerCoinDelta(completed[i].balanceChanges, opts.owner, opts.coinType);
      const cp = node.effects?.checkpoint?.sequenceNumber;
      if (cp != null && (scan.reached_checkpoint == null || cp <= scan.reached_checkpoint)) {
        scan.reached_checkpoint = cp;
        scan.reached_timestamp = node.effects?.timestamp ?? null;
      }
    }
    // A transaction read with part of its balance changes makes every sum
    // after it wrong; reading further only spends requests.
    if (scan.incomplete_transactions.length) return scan;
    if (!page.has_next_page) {
      scan.complete = true;
      return scan;
    }
    // Another page claimed with no cursor would restart at the newest page and
    // count it twice.
    if (!page.next_cursor) return scan;
    cursor = page.next_cursor;
  }
}

export interface ResolvedPoint {
  checkpoint: number;
  /** The checkpoint's own timestamp, when known. */
  timestamp: string | null;
}

/**
 * The last checkpoint stamped at or before `ms`: the one a balance "at" that
 * time reflects. Null when the time precedes genesis. `latest`, when known,
 * is the top of the search, so a time past it resolves to it.
 */
export async function checkpointAtOrBefore(ms: number, latest?: CheckpointPoint): Promise<ResolvedPoint | null> {
  const { before } = await checkpointBracket(ms + 1, latest);
  if (!before) return null;
  return { checkpoint: before.seq, timestamp: new Date(before.ms).toISOString() };
}

/** The anchor for a reconstruction: a checkpoint inside the range, just below its newest end. */
export function anchorCheckpoint(range: BalanceRange): number {
  return Math.max(range.first.sequenceNumber, range.last.sequenceNumber - ANCHOR_MARGIN);
}

/**
 * The balance at `at`, reconstructed from `anchor`. Null when the scan did not
 * read every transaction or the arithmetic gives a negative balance, which a
 * complete scan cannot produce.
 */
export function balanceAt(anchorBalance: string, scan: DeltaScan): bigint | null {
  if (!scan.complete || scan.incomplete_transactions.length) return null;
  const value = BigInt(anchorBalance) - scan.delta;
  return value < 0n ? null : value;
}

export interface ReconstructedBalance {
  complete: boolean;
  balance: string | null;
  balance_formatted: string | null;
  /** Coin objects and address balance are netted together in a balance change, so the split is unknown. */
  coin_balance: null;
  address_balance: null;
  transactions_scanned: number;
  /** Σ of the owner's changes in the coin after `at_checkpoint`, through the anchor. */
  change_since: string | null;
  change_since_formatted: string | null;
  anchor: BalanceSplit & { checkpoint: number; balance_formatted: string | null };
  reached_checkpoint?: number | null;
  reached_timestamp?: string | null;
  incomplete_transactions?: string[];
  note: string;
}

/**
 * Reconstruct `owner`'s balance of `coinType` (canonical) at checkpoint `at`,
 * which lies before the consistent range.
 */
export async function reconstructBalance(opts: {
  owner: string;
  coinType: string;
  at: number;
  range: BalanceRange;
  maxTransactions: number;
}): Promise<ReconstructedBalance> {
  const anchorCp = anchorCheckpoint(opts.range);
  const current = await readBalanceAt(opts.owner, opts.coinType, anchorCp);
  const scan = await scanBalanceDeltas({
    owner: opts.owner,
    coinType: opts.coinType,
    afterCheckpoint: opts.at,
    throughCheckpoint: anchorCp,
    maxTransactions: opts.maxTransactions,
  });
  const value = balanceAt(current.balance, scan);
  const coinType = opts.coinType;
  const anchor = {
    checkpoint: anchorCp,
    ...current,
    balance_formatted: formatCoinAmount(current.balance, coinType),
  };
  // A sum is only meaningful when every transaction was read in full.
  const summed = scan.complete && !scan.incomplete_transactions.length;
  const change = {
    change_since: summed ? scan.delta.toString() : null,
    change_since_formatted: summed ? formatCoinAmount(scan.delta, coinType) : null,
  };
  if (value !== null) {
    return {
      complete: true,
      balance: value.toString(),
      balance_formatted: formatCoinAmount(value, coinType),
      coin_balance: null,
      address_balance: null,
      transactions_scanned: scan.transactions_scanned,
      ...change,
      anchor,
      note:
        `Reconstructed: the balance at checkpoint ${anchorCp} minus the owner's balance changes in this coin over ` +
        `the ${scan.transactions_scanned} transaction(s) after checkpoint ${opts.at}, all of which were read. ` +
        `A balance change nets coin objects and the address balance, so coin_balance and address_balance at ` +
        `this checkpoint are unknown; the anchor carries the split at checkpoint ${anchorCp}.`,
    };
  }
  let note: string;
  if (scan.incomplete_transactions.length) {
    note =
      `No balance: the balance changes of ${scan.incomplete_transactions.length} transaction(s) could not all be read, ` +
      `so any sum would be wrong. Retry; the scan reached checkpoint ${scan.reached_checkpoint}.`;
  } else if (scan.budget_exhausted) {
    note =
      `No balance: max_transactions (${opts.maxTransactions}) ran out with transactions still unread. The scan ` +
      `read every transaction after checkpoint ${scan.reached_checkpoint} (${scan.reached_timestamp ?? "time unknown"}) ` +
      `through ${anchorCp}; those between checkpoint ${opts.at} and ${scan.reached_checkpoint} were not read. ` +
      `Raise max_transactions (at most ${MAX_MAX_TRANSACTIONS}), or ask for a checkpoint at or after ${scan.reached_checkpoint}.`;
  } else if (summed) {
    note =
      `No balance: the anchor balance minus change_since is negative, so a transaction that changed this ` +
      `balance was not returned by the transaction filter.`;
  } else {
    note =
      `No balance: the transaction list claimed another page without a cursor to reach it, so the scan stopped ` +
      `at checkpoint ${scan.reached_checkpoint}.`;
  }
  return {
    complete: false,
    balance: null,
    balance_formatted: null,
    coin_balance: null,
    address_balance: null,
    transactions_scanned: scan.transactions_scanned,
    ...change,
    reached_checkpoint: scan.reached_checkpoint,
    reached_timestamp: scan.reached_timestamp,
    ...(scan.incomplete_transactions.length ? { incomplete_transactions: scan.incomplete_transactions } : {}),
    anchor,
    note,
  };
}
