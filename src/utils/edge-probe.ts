/**
 * Building wallet edges on demand, without an analytics warehouse.
 *
 * A batch pipeline answers "is this funder an exchange?" from a precomputed
 * breadth table. On demand there is no such table, and enumerating an exchange
 * hot wallet's 29,000 recipients to find out is exactly the query storm that
 * makes people say clustering can't be done live.
 *
 * The way out is that **the count is never needed — only the bound.** Whether a
 * funder has 51 recipients or 51,000, the verdict is the same: too popular for
 * shared ancestry through it to mean anything. So the probe fetches up to
 * `popularityLimit + 1` distinct counterparties and stops.
 *
 * That single decision also solves candidate generation, because the probe that
 * answers "is F popular?" returns *who F paid* as a side effect:
 *
 *   - popular  -> discard F and every edge through it. No candidates, and the
 *                 scan stopped early, so it was cheap.
 *   - narrow   -> at most `popularityLimit` members, every one of them a
 *                 corroboration-eligible candidate.
 *
 * One bounded query, both answers. Everything else here is budget accounting.
 *
 * ## What this does not see
 *
 * Every observation comes from a capped scan of public transaction data. Two
 * wallets funded out-of-band, sponsored by nobody and never co-appearing in a
 * transaction produce no edge no matter who controls them. Callers must surface
 * that: `truncated` and `excluded_intermediaries` exist so the absence of an
 * edge is never read as evidence of separate control.
 */

import { gqlQuery } from "../clients/graphql.js";
import { BALANCE_CHANGES_SELECTION, completeTxConnections, readAllBalanceChanges, type GqlConnection } from "./tx-connections.js";
import type { GqlBalanceChangeNode } from "./gql-adapters.js";
import { isSponsorGasChange, isSuiCoinType } from "./sponsor-gas.js";
import {
  clearsDustFloor,
  GRANT_MAX_RECIPIENTS,
  pickFundingTx,
  SEND_BURST_CHECKPOINTS,
  UNPRICED_PUBLISHER_SHARE,
  UNPRICED_SUPPLY_SHARE,
  UNPRICED_TARGETED_SHARE,
  type SendShape,
  type CoinOrigin,
  type FundingAssessment,
  type FundingTx,
} from "./funding.js";
import { coinPublisher, coinTotalSupply } from "./coin-origin.js";
import { getCachedFirstFunder, saveFirstFunder } from "./store.js";
import { currentSuiAccount, parseAccountId, currentSuiChain } from "./chain-id.js";
import { EdgeSet, type WalletEdge } from "./wallet-edges.js";
import { assessCoFunding } from "./co-funding.js";
import { pricesForRanking } from "./price-providers.js";
import { prefetchCoinScale, pricingScale, usdValue } from "./valuation.js";
import { counterpartySides } from "./fanout.js";
import { getLabel } from "./labels.js";

/**
 * Distinct counterparties past which an intermediary is a service, not a person.
 *
 * Mirrors the value a batch pipeline settled on for the same job. Wallet
 * aggregators and sponsored-transaction relayers sponsor thousands; "I pay gas
 * for my own alts" stays far below. The exact cut matters less than that it
 * exists: the gap between the two populations is orders of magnitude.
 */
export const DEFAULT_POPULARITY_LIMIT = 50;

/**
 * Distinct parties in one transaction past which co-appearance means nothing.
 *
 * An airdrop or mass claim puts hundreds of unrelated addresses in one
 * transaction. Ordinary traffic is nowhere near this: almost every
 * transaction has one or two distinct balance-change parties.
 */
const MASS_ACTION_LIMIT = 20;

/**
 * Other wallets a sponsor pays gas for whose first funders are read, to test
 * whether the sponsor and the seeds' funder are one operator in two roles.
 *
 * An operator can fund its wallets from one address and pay their gas from
 * another. The sponsor then pays none of the wallets it sponsors, and past
 * the popularity limit it reads as a relayer. Breadth cannot separate the
 * two; who funded the wallets it serves can. A public relayer's users are
 * first funded by whoever onboarded each of them, while a split operator's
 * wallets share its funder.
 */
const ROLE_SPLIT_SAMPLE = 6;
/** Sampled wallets the seeds' funder must have first funded, at least. */
const ROLE_SPLIT_MIN_MATCHES = 3;
/** And at least this share of those whose first funder was read. */
const ROLE_SPLIT_SHARE = 0.5;

/** Transactions read per page. GraphQL caps this at 50. */
const PAGE = 50;

export interface EdgeBuildOptions {
  /** Recent transactions scanned per seed for sponsor / co-appearance signals. */
  maxSeedScan?: number;
  /** Distinct counterparties past which an intermediary is discarded. */
  popularityLimit?: number;
  /** Look for unknown siblings, not just links among the seeds. */
  expand?: boolean;
  /** Candidate first-funder verifications to spend while expanding. */
  expandBudget?: number;
  /** Hard ceiling on GraphQL requests for the whole build. */
  queryBudget?: number;
  /** Reciprocal counterparties to measure for popularity (default 15). */
  reciprocalBudget?: number;
}

/** An intermediary that was measured and thrown away, with the reason. */
export interface ExcludedIntermediary {
  address: string;
  role: "funder" | "sponsor";
  /** Distinct counterparties seen before the scan stopped. A lower bound. */
  observed_counterparties: number;
  /** A funder's recipients paid only below the dust floors, not counted in `observed_counterparties`. */
  below_floor_recipients?: number;
  /** A sponsor checked for a funder in another address; see {@link RoleSplit}. */
  role_split?: RoleSplit;
  reason: string;
}

/**
 * Whether a sponsor and the seeds' first funder serve the same wallets: the
 * first funders of a sample of the other wallets the sponsor pays gas for.
 */
export interface RoleSplit {
  /** The first funder of the seeds this sponsor paid gas for. */
  funder: string;
  /** Other wallets the sponsor pays gas for whose first funder was read. */
  wallets_checked: number;
  /** Of those, how many `funder` first funded. */
  first_funded_by_funder: number;
  /** The share cleared {@link ROLE_SPLIT_SHARE} and {@link ROLE_SPLIT_MIN_MATCHES}. */
  linked: boolean;
  /**
   * Why no wallet was checked: the seeds' funder is a service by the
   * popularity filter or a label, or was never measured. Wallets a service
   * funded share it by being its customers, so the overlap would say nothing.
   */
  not_checked?: string;
}

/** An intermediary that survived the filter, and how well it was measured. */
export interface UsedIntermediary {
  address: string;
  role: "funder" | "sponsor";
  observed_counterparties: number;
  /** A funder's recipients paid only below the dust floors, not counted in `observed_counterparties`. */
  below_floor_recipients?: number;
  /** A sponsor checked for a funder in another address; see {@link RoleSplit}. */
  role_split?: RoleSplit;
  /**
   * False when the scan stopped at its page cap or the query budget before
   * reaching the end of history.
   * The `narrow` verdict is then provisional, not measured.
   */
  scan_complete: boolean;
}

export interface EdgeBuildResult {
  edges: WalletEdge[];
  /** Addresses actually examined, seeds plus anything expansion pulled in. */
  examined: string[];
  excluded_intermediaries: ExcludedIntermediary[];
  /** Intermediaries the edges actually rest on, with how completely each was measured. */
  used_intermediaries: UsedIntermediary[];
  /** First funder per examined address, where one was determined. */
  first_funders: Record<string, string>;
  queries_used: number;
  /**
   * True when a budget stopped the build before it ran out of work, or a
   * funding, seed-profile or intermediary read left evidence unread.
   */
  truncated: boolean;
  notes: string[];
}

/** Counts requests so every scan shares one ceiling. Exported for tests. */
export class Budget {
  used = 0;
  truncated = false;
  constructor(private readonly limit: number) {}
  /** False when the caller must stop; also latches `truncated`. */
  take(): boolean {
    if (this.used >= this.limit) {
      this.truncated = true;
      return false;
    }
    this.used++;
    return true;
  }
  /**
   * Record requests already made that could not ask first: the follow-up
   * reads that complete a transaction's balance changes.
   */
  charge(n: number): void {
    this.used += n;
  }
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

/** Oldest-first: the first funding of a wallet is by definition its earliest. */
const EARLIEST_QUERY = `query ($addr: SuiAddress!, $first: Int!) {
  transactions(filter: { affectedAddress: $addr }, first: $first) {
    nodes {
      digest
      sender { address }
      effects {
        timestamp
        checkpoint { sequenceNumber }
        ${BALANCE_CHANGES_SELECTION}
      }
    }
  }
}`;

/**
 * Recent activity, walking backwards.
 *
 * `last`/`before` rather than `first`/`after` for the same reason `measureFanout`
 * does it: a forward scan of a long-lived address describes what it was doing
 * years ago, and sponsorship is a present-tense question.
 */
const RECENT_QUERY = `query ($addr: SuiAddress!, $last: Int!, $before: String) {
  transactions(filter: { affectedAddress: $addr }, last: $last, before: $before) {
    nodes {
      digest
      sender { address }
      gasInput { gasSponsor { address } }
      effects { ${BALANCE_CHANGES_SELECTION} }
    }
    pageInfo { hasPreviousPage startCursor }
  }
}`;

/** Outbound only — who did this address pay? */
const SENT_QUERY = `query ($addr: SuiAddress!, $last: Int!, $before: String) {
  transactions(filter: { sentAddress: $addr }, last: $last, before: $before) {
    nodes {
      digest
      sender { address }
      gasInput { gasSponsor { address } }
      effects { ${BALANCE_CHANGES_SELECTION} }
    }
    pageInfo { hasPreviousPage startCursor }
  }
}`;

interface RecentPage {
  transactions: {
    nodes: Array<{
      digest: string;
      sender?: { address: string } | null;
      gasInput?: { gasSponsor?: { address: string } | null } | null;
      effects?: { balanceChanges: GqlConnection<GqlBalanceChangeNode> } | null;
    }>;
    pageInfo: { hasPreviousPage: boolean; startCursor?: string };
  };
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/** SUI's coin type as GraphQL reports it. Rides in every price request as a canary. */
const SUI_COIN_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

/** How candidate inflows are valued before `pickFundingTx` judges them. */
export interface FundingValuer {
  /** USD value of a raw amount. Absent when the price service answered nothing. */
  valueUsd?: (coinType: string, rawAmount: bigint) => number | null;
  /** A coin other than SUI reached the address while no price could be read. */
  pricesUnavailable: boolean;
}

/**
 * The price rule both funding tools apply, so `build_wallet_edges` and
 * `find_funding_source` cannot name two different first funders from the
 * same chain data. Only coins the address received are priced, since only
 * those are ever valued.
 *
 * `fetchAftermath` answers an outage (non-ok response, timeout, network
 * error) with an empty map, never a throw, and an empty map would make every
 * non-SUI inflow `unpriced_coin`, so a non-SUI inflow that created a wallet
 * would be skipped and a later SUI inflow named its funder. SUI is therefore
 * asked for in every request. When even SUI comes back unpriced the service is
 * down, and `valueUsd` is withheld so `pickFundingTx` applies its documented
 * fallback: the SUI floor still holds and a non-SUI inflow is accepted rather
 * than discarded on a missing dependency. Callers disclose `pricesUnavailable`.
 *
 * Decimals are read from CoinMetadata in the same round trip, before anything
 * is valued. A coin outside the curated registry otherwise falls back to an
 * assumed 9 decimals and the dust floor judges a value off by powers of ten
 * (100 of a 6-decimal coin at $0.05 would read as $0.005). Warming them only
 * for display, after the floors ran, would fix the rendered amount and not
 * the pick.
 */
async function fundingValuer(txs: FundingTx[], address: string): Promise<FundingValuer> {
  const received = new Set<string>();
  for (const t of txs) {
    for (const c of t.changes) if (c.address === address && BigInt(c.amount) > 0n) received.add(c.coinType);
  }
  return floorValuer(received);
}

/**
 * USD values for `coinTypes` under the rule {@link fundingValuer} states: SUI
 * rides in every request as the canary, and when even SUI comes back unpriced
 * the service is down and `valueUsd` is withheld.
 */
async function floorValuer(coinTypes: Iterable<string>): Promise<FundingValuer> {
  const types = [...new Set(coinTypes)];
  const [prices] = await Promise.all([pricesForRanking([...types, SUI_COIN_TYPE]), prefetchCoinScale(types)]);
  if (!prices.has(SUI_COIN_TYPE)) {
    return { pricesUnavailable: types.some((t) => !isSuiCoinType(t)) };
  }
  return {
    pricesUnavailable: false,
    valueUsd: (coinType, raw) => {
      const quote = prices.get(coinType);
      return quote ? usdValue(raw, pricingScale(coinType, quote).decimals, quote.price) : null;
    },
  };
}

/** What `assessFunding` concluded, with what it cost to conclude it. */
export interface FundingJudgement {
  assessment: FundingAssessment;
  /** A coin other than SUI reached the address while no price could be read. */
  pricesUnavailable: boolean;
  /** Requests made to read unpriced coins' supply, publisher and send shape, for a caller's budget. */
  reads: number;
  /**
   * Unpriced coins still skipped before the pick whose supply, publisher or
   * send-shape read failed. Each was judged spam without the read that could
   * have made it funding, so the pick stands only provisionally and callers
   * disclose it.
   */
  originUnread: string[];
}

/** Unpriced inflows whose send shape one judgement reads, at most. */
const MAX_SHAPE_READS = 3;

/**
 * Judge an address's earliest transactions the one way both funding tools do:
 * priced by {@link fundingValuer}, then, for any coin skipped as unpriced,
 * its supply and publisher read and the pick made again with them.
 *
 * The second pass exists because "no market" is also what a rug's own token
 * looks like once its pool dies, and a deployer's grant of it to an insider
 * is how that insider was set up. Only coins actually skipped as
 * unpriced are read: the supply first, and the publisher only when the
 * largest such inflow is big enough to count at all, so `from_publisher` is
 * a read fact wherever it is reported. An inflow whose share could count only
 * as a grant also has its send read ({@link readSendShape}), up to
 * {@link MAX_SHAPE_READS}. When a read fails the coin stays skipped, and if
 * its skip still precedes the final pick it is listed in `originUnread`.
 */
export async function assessFunding(txs: FundingTx[], address: string): Promise<FundingJudgement> {
  const { valueUsd, pricesUnavailable } = await fundingValuer(txs, address);
  const first = pickFundingTx(txs, address, { valueUsd });
  const largest = new Map<string, bigint>();
  for (const s of first.dustSkipped) {
    if (s.reason !== "unpriced_coin") continue;
    const amount = BigInt(s.amount);
    if (amount > (largest.get(s.coinType) ?? 0n)) largest.set(s.coinType, amount);
  }
  if (largest.size === 0) return { assessment: first, pricesUnavailable, reads: 0, originUnread: [] };

  const origins = new Map<string, CoinOrigin>();
  const unread = new Set<string>();
  let reads = 0;
  for (const [coinType, amount] of largest) {
    const supply = await coinTotalSupply(coinType);
    if (supply.fetched) reads++;
    if (supply.failed) unread.add(coinType);
    if (!supply.value) continue;
    // Scaled to the same millionths `pickFundingTx` compares in.
    const share = Number((amount * 1_000_000n) / supply.value) / 1_000_000;
    let publisher: string | null = null;
    if (share >= UNPRICED_TARGETED_SHARE) {
      const read = await coinPublisher(coinType);
      // The package object, then its creating transaction.
      if (read.fetched) reads += 2;
      if (read.failed) unread.add(coinType);
      publisher = read.value;
    }
    origins.set(coinType, { totalSupply: supply.value, publisher });
  }

  // Only an inflow the share alone does not settle, and that clears the grant floor.
  const shapes = new Map<string, SendShape>();
  let shapeReads = 0;
  for (const s of first.dustSkipped) {
    const origin = origins.get(s.coinType);
    if (s.reason !== "unpriced_coin" || !origin?.totalSupply) continue;
    const share = Number((BigInt(s.amount) * 1_000_000n) / origin.totalSupply) / 1_000_000;
    const fromPublisher = origin.publisher !== null && origin.publisher === s.funder;
    if (share < UNPRICED_TARGETED_SHARE || share >= UNPRICED_SUPPLY_SHARE || (fromPublisher && share >= UNPRICED_PUBLISHER_SHARE)) continue;
    const tx = txs.find((t) => t.digest === s.digest);
    if (!tx) continue;
    if (shapeReads >= MAX_SHAPE_READS) {
      unread.add(s.coinType);
      continue;
    }
    shapeReads++;
    const read = await readSendShape(tx, s.funder, s.coinType);
    reads += read.reads;
    if (!read.shape) {
      unread.add(s.coinType);
      continue;
    }
    shapes.set(`${s.digest}|${s.coinType}`, read.shape);
  }

  const assessment =
    origins.size === 0
      ? first
      : pickFundingTx(txs, address, {
          valueUsd,
          coinOrigin: (t) => origins.get(t),
          sendShape: (digest, coinType) => shapes.get(`${digest}|${coinType}`),
        });
  // Only a skip before the final pick could have changed it.
  const originUnread = [...unread].filter((t) =>
    assessment.dustSkipped.some((s) => s.reason === "unpriced_coin" && s.coinType === t),
  );
  return { assessment, pricesUnavailable, reads, originUnread };
}

const SENT_IN_WINDOW_QUERY = `query ($filter: TransactionFilter) {
  transactions(filter: $filter, first: ${PAGE}) {
    pageInfo { hasNextPage }
    nodes { digest effects { ${BALANCE_CHANGES_SELECTION} } }
  }
}`;

/**
 * How `funder` sent `coinType` around `tx`: who the transaction itself paid
 * in the coin, and who the funder paid in it across the transactions it sent
 * within {@link SEND_BURST_CHECKPOINTS} either side. One read. The shape is
 * absent when the read failed or the transaction has no checkpoint; a window
 * or a transaction past one page marks it `burst_truncated`, which never
 * reads as a grant. This is deliberately a bounded heuristic, unlike funding
 * attribution or seed profiling: `isTargetedSend` rejects every truncated
 * shape, so a lower-bound recipient count cannot establish a targeted grant.
 */
async function readSendShape(tx: FundingTx, funder: string, coinType: string): Promise<{ shape?: SendShape; reads: number }> {
  const paid = new Map<string, bigint>();
  const add = (owner: string, amount: bigint) => paid.set(owner, (paid.get(owner) ?? 0n) + amount);
  for (const c of tx.changes) {
    if (c.coinType === coinType && c.address !== funder && BigInt(c.amount) > 0n) add(c.address, BigInt(c.amount));
  }
  const recipientsInTx = paid.size;
  const shapeOf = (truncated: boolean): SendShape => {
    const amounts = [...paid.values()];
    return {
      recipients_in_tx: recipientsInTx,
      burst_recipients: paid.size,
      ...(truncated ? { burst_truncated: true as const } : {}),
      even_amounts: amounts.length >= 3 && amounts.every((a) => a === amounts[0]),
    };
  };
  // A transaction that already paid more than a grant does is a mass send; no read changes that.
  if (recipientsInTx > GRANT_MAX_RECIPIENTS) return { reads: 0, shape: shapeOf(false) };
  if (tx.checkpoint === null || funder === "unknown") return { reads: 0 };
  const cp = Number(tx.checkpoint);
  let truncated: boolean;
  try {
    const page = await gqlQuery<{
      transactions?: {
        pageInfo: { hasNextPage: boolean };
        nodes: Array<{ digest: string; effects?: { balanceChanges: GqlConnection<GqlBalanceChangeNode> } | null }>;
      } | null;
    }>(SENT_IN_WINDOW_QUERY, {
      filter: { sentAddress: funder, afterCheckpoint: Math.max(0, cp - SEND_BURST_CHECKPOINTS - 1), beforeCheckpoint: cp + SEND_BURST_CHECKPOINTS + 1 },
    });
    if (!page?.transactions) return { reads: 1 };
    truncated = page.transactions.pageInfo?.hasNextPage === true;
    for (const n of page.transactions.nodes) {
      if (n.digest === tx.digest) continue;
      const conn = n.effects?.balanceChanges;
      if (conn?.pageInfo?.hasNextPage) truncated = true;
      for (const bc of conn?.nodes ?? []) {
        const owner = bc.owner?.address;
        const amount = BigInt(bc.amount ?? "0");
        if (owner && owner !== funder && bc.coinType?.repr === coinType && amount > 0n) add(owner, amount);
      }
    }
  } catch {
    return { reads: 1 };
  }
  return { reads: 1, shape: shapeOf(truncated) };
}

/** What {@link firstFunderOf} found, and how firmly. */
export interface FirstFunderLookup {
  /** Null, as is `digest`, when no inflow among the earliest transactions qualified. */
  funder: string | null;
  digest: string | null;
  pricesUnavailable: boolean;
  /** See {@link FundingJudgement.originUnread}. */
  originUnread: string[];
}

/**
 * The first inflow that made `address` exist. Null when the lookup could not
 * run (the budget, or a failed read); `funder: null` when it ran and no inflow
 * qualified.
 *
 * Cached in the optional local store, and the reason it is safe to cache is the
 * same one that makes the transaction cache safe: a wallet's *first* funding is
 * fixed the moment it happens. No later activity can change which inflow came
 * first, so there is no TTL and no invalidation path to get wrong. The
 * asymmetry is that a *negative* would go stale (an address with no qualifying
 * funding today can be funded tomorrow), so only positives are written.
 *
 * Which inflow counts as funding is another matter once a coin other than SUI
 * is involved: that is decided by a live price, and a price moves, lapses or
 * fails to load. So a pick is written only when every inflow up to it was
 * SUI, judged by the SUI floor alone. Anything else is recomputed per call.
 *
 * This is the expensive half of expansion: verifying sibling candidates is one
 * lookup each, and investigations revisit the same neighbourhood repeatedly.
 */
export async function firstFunderOf(address: string, budget: Budget): Promise<FirstFunderLookup | null> {
  const account = currentSuiAccount(address);
  const cached = getCachedFirstFunder(account);
  if (cached) {
    return {
      funder: parseAccountId(cached.funder_account, currentSuiChain()).address,
      digest: cached.digest,
      pricesUnavailable: false,
      originUnread: [],
    };
  }
  if (!budget.take()) return null;
  try {
    const data = await gqlQuery<{ transactions: { nodes: RawEarliest[] } }>(EARLIEST_QUERY, {
      addr: address,
      first: 12,
    });
    // The subject's own inflow can sort past the first 50 balance changes of
    // a batch payout; complete the lists before picking the funding.
    const completed = await completeTxConnections(
      data.transactions.nodes.map((n) => ({ digest: n.digest, balanceChanges: n.effects?.balanceChanges })),
    );
    budget.charge(completed.reduce((sum, c) => sum + c.reads, 0));
    // Missing rows can hide an earlier inflow or change the apparent payer.
    // This is an unread lookup, not a negative result or a cacheable pick.
    if (completed.some((c) => c.balanceChangesTruncated)) return null;
    const txs: FundingTx[] = data.transactions.nodes.map((n, i) => toFundingTx(n, completed[i].balanceChanges));
    // Judged the way `find_funding_source` judges the same candidates, so an
    // unpriced or sub-floor transfer cannot pass as funding here while that
    // tool skips it as dust.
    const { assessment, pricesUnavailable, reads, originUnread } = await assessFunding(txs, address);
    budget.charge(reads);
    const picked = assessment.funding;
    if (!picked || picked.funder === "unknown") return { funder: null, digest: null, pricesUnavailable, originUnread };
    const pickedAt = txs.findIndex((t) => t.digest === picked.digest);
    const priceFree = txs
      .slice(0, pickedAt + 1)
      .every((t) => t.changes.every((c) => c.address !== address || BigInt(c.amount) <= 0n || isSuiCoinType(c.coinType)));
    if (priceFree) saveFirstFunder(account, currentSuiAccount(picked.funder), picked.digest);
    return { funder: picked.funder, digest: picked.digest, pricesUnavailable, originUnread };
  } catch {
    return null;
  }
}

interface RawEarliest {
  digest: string;
  sender: { address: string } | null;
  effects: {
    timestamp: string | null;
    checkpoint: { sequenceNumber: number } | null;
    balanceChanges: GqlConnection<GqlBalanceChangeNode>;
  } | null;
}

function toFundingTx(n: RawEarliest, balanceChanges: GqlBalanceChangeNode[]): FundingTx {
  return {
    digest: n.digest,
    sender: n.sender?.address ?? null,
    timestamp: n.effects?.timestamp ?? null,
    checkpoint: n.effects?.checkpoint?.sequenceNumber?.toString() ?? null,
    changes: balanceChanges
      .filter((c) => c.owner?.address && c.amount && c.coinType?.repr)
      .map((c) => ({ address: c.owner!.address, amount: c.amount!, coinType: c.coinType!.repr })),
  };
}

export interface Popularity {
  /** Counterparties found before the scan stopped. Empty when popular. */
  members: Map<string, string>;
  popular: boolean;
  observed: number;
  /**
   * Distinct addresses {@link probeRecipients} saw paid only below the dust
   * floors funding is judged by (0.01 SUI, $0.10 of a priced coin, or a coin
   * no source prices). They are not counted toward the limit: dusting a
   * thousand addresses costs next to nothing, and counting them would let
   * anyone make a funder read as a service and end a walk there.
   */
  belowFloor?: number;
  /**
   * Popular only: the counterparties seen before the scan stopped. A sample
   * for a measurement of who the address served (see {@link ROLE_SPLIT_SAMPLE}),
   * never sibling candidates.
   */
  sample?: Map<string, string>;
  /**
   * True when the scan reached the end of the address's history.
   *
   * A `popular` verdict is proven either way — the limit was exceeded by
   * things actually seen. A `narrow` verdict off an INCOMPLETE scan is not:
   * the scan walks backwards from recent activity, while the fundings being
   * filtered are historical, so an address that airdropped ten thousand
   * wallets years ago and has been quiet since reads as narrow. Callers must
   * surface this rather than presenting a provisional verdict as measured.
   */
  complete: boolean;
  /**
   * Set when this probe cannot be read as a verdict, with why: the shared
   * query budget was spent before its first page (`budget`), or one of its
   * reads failed after retries before the scan settled (`read_failed`: a 429,
   * a 5xx, a timeout, on the first page or a later one, or a transaction's
   * balance-change continuation).
   *
   * Different from `complete: false`: a scan stopped by its page cap or by
   * the budget after its first page still reports a genuine, if
   * provisional, lower bound. A failed read does not: a hub that pays one
   * recipient per transaction shows at most 50 recipients a page and is
   * proven popular only on its second, so a scan that failed there says
   * nothing about whether the address pays few people. `observed` is what
   * was seen before the failure. A caller must never treat an unmeasured
   * intermediary as narrow; report it as unmeasured instead, and say which
   * of the two it was, since only the budget is fixed by raising it.
   */
  unmeasured?: UnmeasuredReason;
}

/** Why a popularity probe gave no verdict. See {@link Popularity.unmeasured}. */
export type UnmeasuredReason = "budget" | "read_failed";

/**
 * Who did `address` pay at least the dust floor, up to `limit + 1` distinct
 * recipients?
 *
 * Stops the moment the limit is exceeded — the verdict is settled at that point
 * and every further page is spent proving something already known. When the
 * scan finishes under the limit, `members` is the candidate sibling set.
 *
 * A payment counts only when it clears the floors `pickFundingTx` applies
 * ({@link clearsDustFloor}); recipients paid only below them are counted
 * apart in `belowFloor`. When no price can be read, a non-SUI payment counts,
 * the same fallback funding applies.
 */
export async function probeRecipients(
  address: string,
  limit: number,
  budget: Budget,
): Promise<Popularity> {
  const members = new Map<string, string>();
  const belowFloor = new Set<string>();
  const valuedTypes = new Set<string>();
  let valuer: FundingValuer | null = null;
  let cursor: string | undefined;
  let pages = 0;
  let reachedEnd = false;
  let readFailed = false;
  // Worst case one new recipient per transaction, so limit+1 recipients need
  // at most that many transactions; the page cap keeps a contract-call-heavy
  // address (many transactions, no recipients) from burning the whole budget.
  const maxPages = Math.ceil((limit + 1) / PAGE) + 4;

  while (pages < maxPages) {
    if (!budget.take()) break;
    let page: RecentPage;
    try {
      page = await gqlQuery<RecentPage>(SENT_QUERY, { addr: address, last: PAGE, before: cursor });
    } catch {
      readFailed = true;
      break;
    }
    pages++;
    const completed = await completeTxConnections(
      page.transactions.nodes.map((n) => ({ digest: n.digest, balanceChanges: n.effects?.balanceChanges })),
    );
    budget.charge(completed.reduce((sum, c) => sum + c.reads, 0));
    // A short recipient list is not a count. The scan goes on, since a
    // popular verdict proven by what was read still stands.
    if (completed.some((c) => c.balanceChangesTruncated)) readFailed = true;
    const payments: Array<{ owner: string; digest: string; coin: string; amount: bigint }> = [];
    for (const [i, n] of page.transactions.nodes.entries()) {
      const sender = n.sender?.address;
      const sponsor = n.gasInput?.gasSponsor?.address;
      for (const bc of completed[i].balanceChanges) {
        const owner = bc.owner?.address;
        if (!owner || owner === address) continue;
        const amount = BigInt(bc.amount ?? "0");
        if (amount <= 0n) continue;
        // The sponsor's storage rebate is not a payment, and a sponsor listed
        // here would become a sibling candidate.
        if (isSponsorGasChange(owner, bc.coinType?.repr, sender, sponsor)) continue;
        payments.push({ owner, digest: n.digest, coin: bc.coinType?.repr ?? "", amount });
      }
    }
    // Priced once per new coin, SUI excluded: its floor needs no price.
    const unvalued = payments.filter((p) => !isSuiCoinType(p.coin) && !valuedTypes.has(p.coin));
    if (unvalued.length > 0) {
      for (const p of unvalued) valuedTypes.add(p.coin);
      valuer = await floorValuer(valuedTypes);
    }
    for (const p of payments) {
      if (clearsDustFloor(p.coin, p.amount, valuer?.valueUsd) === true) {
        if (!members.has(p.owner)) members.set(p.owner, p.digest);
      } else {
        belowFloor.add(p.owner);
      }
    }
    if (members.size > limit) {
      // Proven by what was seen; further pages cannot change the verdict.
      return { members: new Map(), popular: true, observed: members.size, belowFloor: dustOnly(belowFloor, members), complete: true };
    }
    if (!page.transactions.pageInfo.hasPreviousPage) {
      reachedEnd = true;
      break;
    }
    cursor = page.transactions.pageInfo.startCursor;
    if (!cursor) break;
  }
  return {
    members,
    popular: false,
    observed: members.size,
    belowFloor: dustOnly(belowFloor, members),
    complete: reachedEnd,
    ...unmeasured(pages, readFailed),
  };
}

/** `below_floor_recipients` for an intermediary's row, when the probe saw any. */
function belowFloorOf(p: Popularity): { below_floor_recipients?: number } {
  return p.belowFloor ? { below_floor_recipients: p.belowFloor } : {};
}

/** Addresses paid below the floors that no payment above them reached. */
function dustOnly(belowFloor: Set<string>, members: Map<string, string>): number {
  let n = 0;
  for (const a of belowFloor) if (!members.has(a)) n++;
  return n;
}

/**
 * Whose gas did `address` pay, up to `limit + 1` distinct senders?
 *
 * There is no sponsor filter in the GraphQL schema, so this scans transactions
 * affecting the address and keeps the ones where it appears as gas sponsor for
 * somebody else. Noisier per page than {@link probeRecipients}, same bound.
 */
export async function probeSponsored(
  address: string,
  limit: number,
  budget: Budget,
): Promise<Popularity> {
  const members = new Map<string, string>();
  let cursor: string | undefined;
  let pages = 0;
  let reachedEnd = false;
  let readFailed = false;
  const maxPages = Math.ceil((limit + 1) / PAGE) + 4;

  while (pages < maxPages) {
    if (!budget.take()) break;
    let page: RecentPage;
    try {
      page = await gqlQuery<RecentPage>(RECENT_QUERY, { addr: address, last: PAGE, before: cursor });
    } catch {
      readFailed = true;
      break;
    }
    pages++;
    for (const n of page.transactions.nodes) {
      const sender = n.sender?.address;
      const sponsor = n.gasInput?.gasSponsor?.address;
      if (!sender || sponsor !== address || sender === address) continue;
      if (!members.has(sender)) members.set(sender, n.digest);
    }
    if (members.size > limit) {
      // Proven by what was seen; further pages cannot change the verdict.
      return { members: new Map(), sample: members, popular: true, observed: members.size, complete: true };
    }
    if (!page.transactions.pageInfo.hasPreviousPage) {
      reachedEnd = true;
      break;
    }
    cursor = page.transactions.pageInfo.startCursor;
    if (!cursor) break;
  }
  return { members, popular: false, observed: members.size, complete: reachedEnd, ...unmeasured(pages, readFailed) };
}

/**
 * A probe with no popular verdict is unmeasured when any of its reads failed,
 * wherever in the scan, or when the budget stopped it before its first page.
 */
function unmeasured(pages: number, readFailed: boolean): { unmeasured?: UnmeasuredReason } {
  if (readFailed) return { unmeasured: "read_failed" };
  return pages === 0 ? { unmeasured: "budget" } : {};
}

/** The `excluded_intermediaries` reason for an intermediary no probe could measure. */
function unmeasuredExclusion(why: UnmeasuredReason, observed: number): string {
  if (why === "budget") {
    return "Query budget ran out before this could be probed for popularity. It was never measured and is not assumed narrow.";
  }
  const seen = observed > 0 ? ` after ${observed} distinct counterparties were seen` : "";
  return (
    `The popularity read for this address failed${seen} (the query errored after retries), so its popularity is unmeasured ` +
    "and is not assumed narrow. Raising query_budget does not help; rerun the call."
  );
}

/**
 * How many distinct addresses one transaction paid.
 *
 * The denominator that decides what shared funding is worth. Two addresses
 * first funded by the same transaction is near-decisive when that transaction
 * paid two addresses, and close to meaningless when it paid twenty — an
 * unrelated wallet lands in a batch distribution by being on a list, not by
 * sharing an operator. Without this the two are scored identically.
 */
const TX_RECIPIENTS_QUERY = `query ($digest: String!) {
  transactionEffects(digest: $digest) {
    transaction { sender { address } gasInput { gasSponsor { address } } }
    ${BALANCE_CHANGES_SELECTION}
  }
}`;

/** Null when the transaction could not be read — never a default that reads as measured. */
async function countTxRecipients(digest: string, budget: Budget): Promise<number | null> {
  if (!budget.take()) return null;
  try {
    const r = await gqlQuery<{
      transactionEffects: {
        transaction?: TxParties | null;
        balanceChanges: GqlConnection<GqlBalanceChangeNode>;
      } | null;
    }>(TX_RECIPIENTS_QUERY, { digest });
    const first = r.transactionEffects?.balanceChanges;
    if (!first) return null;
    // The denominator is every recipient, not the first page of 50.
    const all = await readAllBalanceChanges(digest, first);
    budget.charge(all.reads);
    // A partial list would understate the batch and overstate the pair's weight.
    if (all.truncated) return null;
    return countPaidAddresses(all.nodes, r.transactionEffects?.transaction);
  } catch {
    return null;
  }
}

/** Sender and gas sponsor of a transaction, as GraphQL selects them. */
export interface TxParties {
  sender?: { address?: string } | null;
  gasInput?: { gasSponsor?: { address?: string } | null } | null;
}

/**
 * Distinct addresses a transaction's balance changes paid: every positive
 * change except the sender's own and a gas-only sponsor's storage rebate.
 */
export function countPaidAddresses(changes: GqlBalanceChangeNode[], parties: TxParties | null | undefined): number {
  const sender = parties?.sender?.address;
  const sponsor = parties?.gasInput?.gasSponsor?.address;
  const recipients = new Set<string>();
  for (const n of changes) {
    const owner = n.owner?.address;
    if (!owner || !n.amount || BigInt(n.amount) <= 0n) continue;
    if (owner === sender || isSponsorGasChange(owner, n.coinType?.repr, sender, sponsor)) continue;
    recipients.add(owner);
  }
  return recipients.size;
}

/**
 * Weight for a `cofunded` pair, given how the two were funded.
 *
 * Reuses {@link assessCoFunding}, the same doctrine `find_funding_sources`
 * applies, so the two tools cannot disagree about what a batch payout is worth.
 *
 * Only pairs funded by the SAME transaction are re-weighted. Two addresses
 * funded by one funder in separate transactions were each funded deliberately,
 * which is the ordinary `cofunded` case and keeps the default weight.
 */
function coFundedWeight(
  sharedDigest: string | null,
  recipientCount: number | null,
): { weight: number; detail: string } | undefined {
  if (!sharedDigest) return undefined;
  const { strength, interpretation } = assessCoFunding(2, recipientCount);
  // Calibrated to what assessCoFunding actually says, which is subtler than
  // "batch = weak". A wide batch is "no stronger than shared funding" — not
  // worthless — and it asks the reader to check whether the cohort clusters
  // within the batch by timing or later behaviour. So it sits just under the
  // 1.0 merge threshold: enough that one corroborating signal carries the pair,
  // not enough to assert a cluster from list membership alone.
  //
  // A failed lookup keeps the default. Declining to spend a query is not
  // evidence about the payout's width.
  const weight =
    strength === "targeted" ? 1.2 : strength === "batch" ? 0.8 : 1.0;
  const size = recipientCount === null ? "an unknown number of" : `${recipientCount}`;
  return {
    weight,
    detail: `Both were first funded by the SAME transaction (${sharedDigest.slice(0, 10)}…), which paid ${size} addresses. ${interpretation}`,
  };
}

const RECIPROCAL_DETAIL =
  "Value moved in BOTH directions between these addresses, and the counterparty is not a service. " +
  "One-directional payment is the commonest relationship on chain and means little; money coming back is not what paying a merchant looks like.";

/** Sponsors that paid this address's gas, and who it shared transactions with. */
interface SeedProfile {
  sponsors: Map<string, string>;
  coParties: Array<{ digest: string; parties: string[] }>;
  /**
   * Counterparties this address PAID, and those that paid it, with a digest.
   *
   * Kept directed on purpose. One direction is ordinary transfer volume and
   * clusters the world together; an address appearing on BOTH sides is the
   * signal, because value coming back is not what a payment looks like.
   */
  paidTo: Map<string, string>;
  paidBy: Map<string, string>;
  /** Transactions whose balance changes could not be completed. */
  unreadTransactions: string[];
  /** A recent-transaction page failed; earlier complete evidence remains usable. */
  readFailed: boolean;
}

/**
 * Distinct parties in one transaction past which co-appearance means nothing.
 *
 * See {@link MASS_ACTION_LIMIT}. Kept separate from the sender-exclusion rule
 * below because they defend against different things: this one against
 * airdrops, that one against ordinary payments.
 */

async function profileSeed(
  address: string,
  maxScan: number,
  budget: Budget,
): Promise<SeedProfile> {
  const sponsors = new Map<string, string>();
  const coParties: Array<{ digest: string; parties: string[] }> = [];
  const paidTo = new Map<string, string>();
  const paidBy = new Map<string, string>();
  const unreadTransactions: string[] = [];
  let readFailed = false;
  let cursor: string | undefined;
  let scanned = 0;

  while (scanned < maxScan) {
    if (!budget.take()) break;
    let page: RecentPage;
    try {
      page = await gqlQuery<RecentPage>(RECENT_QUERY, {
        addr: address,
        last: Math.min(PAGE, maxScan - scanned),
        before: cursor,
      });
    } catch {
      readFailed = true;
      break;
    }
    const completed = await completeTxConnections(
      page.transactions.nodes.map((n) => ({ digest: n.digest, balanceChanges: n.effects?.balanceChanges })),
    );
    budget.charge(completed.reduce((sum, c) => sum + c.reads, 0));
    for (const [i, n] of page.transactions.nodes.entries()) {
      scanned++;
      const sender = n.sender?.address;
      const sponsor = n.gasInput?.gasSponsor?.address;
      // Only a sponsor who is somebody else. A self-paid transaction reports
      // the sender as its own gas sponsor, which would otherwise make every
      // address its own sponsor and link it to nobody usefully.
      if (sponsor && sender && sponsor !== sender) sponsors.set(sponsor, n.digest);
      // Sponsorship is independent of the balance connection. Payment direction
      // and the mass-action bound are not: missing rows can change either.
      if (completed[i].balanceChangesTruncated) {
        unreadTransactions.push(n.digest);
        continue;
      }

      // The sender is excluded, and that exclusion is what makes this a signal
      // rather than a restatement of transfer volume. If A pays B, both appear
      // in the balance changes, so counting them would make "A sent to B" an
      // edge: the single most common relationship on chain, and the one this
      // module explicitly refuses to cluster on. What remains is the real
      // signal: a third party moved both balances in one transaction, which
      // is somebody paying two wallets at once.
      // Direction is read coin by coin from the subject's own net change, the
      // same way measureFanout separates recipients from senders. The gas
      // sponsor's own SUI row is filtered first, as measureFanout does: a
      // sponsor's net SUI change is its computation/storage cost (or a sweep's
      // rebate), never a payment. Left in, it can put the sponsor of a
      // transaction that also credits the seed SUI into `paidBy`, so a public
      // relayer that never sent this seed a coin reads as having funded it
      // and, paired with `sponsors` below (which records every sponsor),
      // becomes an "operator" at the merge-floor weight.
      const changes = completed[i].balanceChanges;
      const sides = counterpartySides(
        changes.filter((bc) => !isSponsorGasChange(bc.owner?.address, bc.coinType?.repr, sender, sponsor)),
        address,
      );
      for (const other of sides.recipients) if (!paidTo.has(other)) paidTo.set(other, n.digest);
      for (const other of sides.senders) if (!paidBy.has(other)) paidBy.set(other, n.digest);

      const parties = [
        ...new Set(
          changes
            .map((bc) => bc.owner?.address)
            .filter((a): a is string => Boolean(a) && a !== sender),
        ),
      ];
      // A mass claim or airdrop puts hundreds of strangers in one transaction.
      if (parties.length >= 2 && parties.length <= MASS_ACTION_LIMIT) {
        coParties.push({ digest: n.digest, parties });
      }
    }
    if (!page.transactions.pageInfo.hasPreviousPage) break;
    cursor = page.transactions.pageInfo.startCursor;
    if (!cursor) break;
  }
  return { sponsors, coParties, paidTo, paidBy, unreadTransactions, readFailed };
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

/**
 * Derive shared-control edges for a set of seed addresses.
 *
 * Two phases, because they answer different questions and cost differently:
 *
 *   1. **Seeds only** — are the addresses I already have related? Every signal
 *      here is exact: first funders are computed per seed, so `cofunded` means
 *      two seeds genuinely share a first funder rather than merely both having
 *      been paid by it at some point.
 *   2. **Expansion** (`expand`) — who else belongs to this set? Narrow
 *      intermediaries hand back their member lists for free, and each candidate
 *      is verified by computing its own first funder before it is admitted as
 *      `cofunded`. Sponsorship needs no such check: the probe observed it
 *      directly.
 */
export async function buildWalletEdges(
  seeds: string[],
  opts: EdgeBuildOptions = {},
): Promise<EdgeBuildResult> {
  const popularityLimit = opts.popularityLimit ?? DEFAULT_POPULARITY_LIMIT;
  const maxSeedScan = opts.maxSeedScan ?? 100;
  const expand = opts.expand !== false;
  const expandBudget = opts.expandBudget ?? 25;
  const budget = new Budget(opts.queryBudget ?? 150);

  const uniqueSeeds = [...new Set(seeds)];
  const reciprocalBudget = opts.reciprocalBudget ?? 15;
  const reciprocalCandidates: Array<{ seed: string; other: string; digests: string[]; alreadyBoth: boolean }> = [];
  let unprobedReciprocal = 0;
  const edges = new EdgeSet();
  const excluded: ExcludedIntermediary[] = [];
  const used: UsedIntermediary[] = [];
  const firstFunders = new Map<string, string>();
  const notes: string[] = [];

  // --- phase 1a: first funders for every seed ---------------------------
  //
  // Split from profiling (1b) below so the single most decisive signal (one
  // seed being the very address that funded another) never depends on how
  // much budget profiling the other seeds happens to cost. Interleaved, a
  // seed processed late could lose its first-funder lookup to budget spent
  // scanning earlier seeds, and which seed goes last is only input order, so
  // the same call could link different pairs of seeds depending on where the
  // shared budget ran out. `firstFunderOf` also reads oldest-first history,
  // which does not shift as the chain grows, unlike the windowed scan
  // `profileSeed` runs; that is another reason to spend budget on it first.
  const funderDigest = new Map<string, string>();
  // First-funder picks made while no coin price could be read. Disclosed,
  // since a non-SUI inflow is then accepted at any value.
  let unpricedLookups = 0;
  // Lookups where an unpriced coin's supply or publisher read failed, so an
  // inflow that may have been a grant was judged spam without it.
  let originUnreadLookups = 0;
  let unreadFundingLookups = 0;
  for (const seed of uniqueSeeds) {
    const funding = await firstFunderOf(seed, budget);
    if (!funding) unreadFundingLookups++;
    if (funding?.pricesUnavailable) unpricedLookups++;
    if (funding?.originUnread.length) originUnreadLookups++;
    if (funding?.funder && funding.digest) {
      firstFunders.set(seed, funding.funder);
      funderDigest.set(seed, funding.digest);
    }
  }

  // --- phase 1b: profile every seed for sponsor / co-appearance signals -
  const profiles = new Map<string, SeedProfile>();
  let unreadSeedScans = 0;
  for (const seed of uniqueSeeds) {
    const profile = await profileSeed(seed, maxSeedScan, budget);
    profiles.set(seed, profile);
    if (profile.readFailed || profile.unreadTransactions.length > 0) unreadSeedScans++;
    if (profile.readFailed) {
      notes.push(`The recent-transaction scan for ${seed} is unread past a failed page. Signals from complete transactions already read are retained.`);
    }
    if (profile.unreadTransactions.length > 0) {
      notes.push(
        `Balance changes remain unread for transaction(s) ${profile.unreadTransactions.join(", ")} while profiling ${seed}. ` +
          "Co-appearance and payment-derived signals from those transactions are withheld; independent gas sponsorship is retained.",
      );
    }
  }

  // Co-appearance, free: derived from pages already fetched for the seeds.
  for (const { coParties } of profiles.values()) {
    for (const { digest, parties } of coParties) {
      for (let i = 0; i < parties.length; i++) {
        for (let j = i + 1; j < parties.length; j++) {
          // Only between addresses under examination. Every swap has a
          // counterparty, and linking seeds to every pool they ever touched is
          // the cluster explosion in miniature.
          if (!uniqueSeeds.includes(parties[i]) || !uniqueSeeds.includes(parties[j])) continue;
          edges.add(
            "co_tx",
            parties[i],
            parties[j],
            "Both had balances changed by one transaction sent by a third party",
            [digest],
          );
        }
      }
    }
  }

  // --- phase 2: measure the intermediaries -----------------------------
  // Each distinct funder and sponsor is probed once. This is where popularity
  // is decided and, for the survivors, where candidates come from.
  const funderMembers = new Map<string, Map<string, string>>();
  const sponsorMembers = new Map<string, Map<string, string>>();

  // An intermediary no probe could measure goes to `excluded`, never to
  // `used_intermediaries` or a member map where it could seed an edge: its
  // `observed` would read as "measured and narrow", and it is neither. A
  // failed read, unlike a spent budget, does not latch `budget.truncated`,
  // so it is counted to mark the build partial all the same.
  let unreadIntermediaries = 0;
  const excludeUnmeasured = (address: string, role: ExcludedIntermediary["role"], why: UnmeasuredReason, observed: number) => {
    if (why === "read_failed") unreadIntermediaries++;
    excluded.push({ address, role, observed_counterparties: observed, reason: unmeasuredExclusion(why, observed) });
  };

  const distinctFunders = [...new Set(firstFunders.values())].filter((f) => !uniqueSeeds.includes(f));
  for (const funder of distinctFunders) {
    const p = await probeRecipients(funder, popularityLimit, budget);
    if (p.unmeasured) {
      excludeUnmeasured(funder, "funder", p.unmeasured, p.observed);
      continue;
    }
    if (p.popular) {
      excluded.push({
        address: funder,
        role: "funder",
        observed_counterparties: p.observed,
        ...belowFloorOf(p),
        reason: `Paid more than ${popularityLimit} distinct addresses at least 0.01 SUI or $0.10 each — exchange, bridge or faucet-scale distributor. Shared ancestry through it carries no information.`,
      });
      continue;
    }
    funderMembers.set(funder, p.members);
    used.push({
      address: funder,
      role: "funder",
      observed_counterparties: p.observed,
      ...belowFloorOf(p),
      scan_complete: p.complete,
    });
  }

  // A sponsor that also sent a seed its very first coin created the wallet it
  // is now paying gas for, which is more than incidental gas payment. That is
  // decisive on its own and does not wait on the popularity probe below: the
  // probe asks whether other senders use this address as a relayer, which can
  // be true of the same address at the same time, since an operator that
  // funds and sponsors its own lookalikes can also sponsor many strangers.
  // Both `paidBy` (any inbound transfer, unfiltered) and `sponsors` come
  // straight out of each seed's own profile, so this needs no probe and covers
  // a sponsor that is itself a seed too, which the loop below skips outright
  // because a seed needs no popularity check to be believed.
  const operators = new Set<string>();
  for (const seed of uniqueSeeds) {
    const prof = profiles.get(seed);
    if (!prof) continue;
    for (const [sponsor, sponsorDigest] of prof.sponsors) {
      const fundDigest = prof.paidBy.get(sponsor);
      if (!fundDigest) continue;
      edges.add(
        "sponsor",
        sponsor,
        seed,
        `${sponsor.slice(0, 10)}… sent this address its first coin AND paid its gas — an operator relationship, not a public relayer's incidental sponsorship`,
        [fundDigest, sponsorDigest],
        undefined,
        // Weighted like `funding_edge` rather than the default 0.7 for a bare
        // shared sponsor: `paidBy` is unfiltered chain fact (it does not stop
        // at the dust floor `firstFunderOf` applies), and paired with
        // sponsorship it is as decisive as a funding edge, because a public
        // relayer sponsors strangers' wallets without also creating them.
        1.0,
      );
      operators.add(sponsor);
    }
  }

  /**
   * Is `sponsor` one operator with the seeds' first funder, working from a
   * second address? Reads the first funders of up to {@link ROLE_SPLIT_SAMPLE}
   * other wallets it pays gas for. Null when no seed it sponsored has a known
   * first funder other than itself, so there is nothing to compare against.
   */
  const checkRoleSplit = async (sponsor: string, p: Popularity): Promise<(RoleSplit & { digests: string[] }) | null> => {
    const seedsHere = uniqueSeeds.filter((s) => profiles.get(s)?.sponsors.has(sponsor));
    const known = [...new Set(seedsHere.map((s) => firstFunders.get(s)).filter((f): f is string => Boolean(f) && f !== sponsor))];
    if (known.length === 0) return null;
    // Only a funder that is a seed, or that passed the popularity filter and
    // carries no label: an exchange's customers share it by being customers.
    const funders = known.filter((f) => uniqueSeeds.includes(f) || (funderMembers.has(f) && !getLabel(f)));
    if (funders.length === 0) {
      const f = known[0];
      const why = getLabel(f)
        ? "it carries a label"
        : excluded.some((e) => e.address === f && e.role === "funder")
          ? "it was excluded as a service or could not be measured"
          : "its popularity was not measured";
      return { funder: f, wallets_checked: 0, first_funded_by_funder: 0, linked: false, not_checked: `The seeds' funder is not narrow: ${why}.`, digests: [] };
    }
    const served = [...(p.popular ? (p.sample ?? new Map()) : p.members)].filter(
      ([a]) => !uniqueSeeds.includes(a) && !funders.includes(a),
    );
    const tally = new Map<string, string[]>();
    let checked = 0;
    for (const [wallet] of served.slice(0, ROLE_SPLIT_SAMPLE)) {
      const f = await firstFunderOf(wallet, budget);
      if (!f) {
        unreadFundingLookups++;
        continue;
      }
      if (f.pricesUnavailable) unpricedLookups++;
      if (f.originUnread.length) originUnreadLookups++;
      checked++;
      if (f.funder && f.digest && funders.includes(f.funder)) tally.set(f.funder, [...(tally.get(f.funder) ?? []), f.digest]);
    }
    const [funder, digests] = [...tally].sort((a, b) => b[1].length - a[1].length)[0] ?? [funders[0], []];
    const matched = digests.length;
    return {
      funder,
      wallets_checked: checked,
      first_funded_by_funder: matched,
      linked: matched >= ROLE_SPLIT_MIN_MATCHES && matched >= checked * ROLE_SPLIT_SHARE,
      digests,
    };
  };
  const splitFunders = new Set<string>();

  const distinctSponsors = new Set<string>();
  for (const prof of profiles.values()) for (const s of prof.sponsors.keys()) distinctSponsors.add(s);
  for (const sponsor of distinctSponsors) {
    // A seed's sponsorship of another seed was handled directly above, exact
    // and unconditional; an operator already proven above needs no further
    // popularity verdict either, since one would only relabel the same
    // address a relayer while an edge for it already stands.
    if (uniqueSeeds.includes(sponsor) || operators.has(sponsor)) continue;
    const p = await probeSponsored(sponsor, popularityLimit, budget);
    if (p.unmeasured) {
      excludeUnmeasured(sponsor, "sponsor", p.unmeasured, p.observed);
      continue;
    }
    const split = await checkRoleSplit(sponsor, p);
    const roleSplit = split
      ? {
          role_split: {
            funder: split.funder,
            wallets_checked: split.wallets_checked,
            first_funded_by_funder: split.first_funded_by_funder,
            linked: split.linked,
            ...(split.not_checked ? { not_checked: split.not_checked } : {}),
          },
        }
      : {};
    if (split?.linked) {
      // Linked at operator weight whatever the sponsor's breadth: the wallets
      // it pays gas for share the seeds' funder, which a relayer's users do not.
      const detail =
        `${sponsor.slice(0, 10)}… pays gas for wallets ${split.funder.slice(0, 10)}… first funded: ` +
        `${split.first_funded_by_funder} of the ${split.wallets_checked} other wallets it sponsors whose first funder was read. ` +
        "One operator funding from one address and paying gas from another shows this shape; so does a wallet provider that onboards and sponsors its own users.";
      edges.add("sponsor", sponsor, split.funder, detail, split.digests, undefined, 1.0);
      for (const seed of uniqueSeeds) {
        const sponsorDigest = profiles.get(seed)?.sponsors.get(sponsor);
        if (!sponsorDigest || firstFunders.get(seed) !== split.funder) continue;
        const fundDigest = funderDigest.get(seed);
        edges.add("sponsor", sponsor, seed, detail, fundDigest ? [sponsorDigest, fundDigest] : [sponsorDigest], undefined, 1.0);
      }
      operators.add(sponsor);
      splitFunders.add(split.funder);
    }
    if (p.popular && !split?.linked) {
      const measured = !split
        ? "No seed it paid gas for has a known first funder, so whether one operator funds these wallets from another address was not checked."
        : split.not_checked
          ? `${split.not_checked} Whether one operator funds these wallets from another address was not checked.`
          : split.wallets_checked === 0
          ? `No first funder of the other wallets it sponsors could be read (the query budget ran out or the reads failed), so whether the seeds' funder ${split.funder.slice(0, 10)}… funds them from another address was not checked.`
          : `${split.first_funded_by_funder} of the ${split.wallets_checked} other wallets it sponsors whose first funder was read were first funded by the seeds' funder ${split.funder.slice(0, 10)}…, below the ${ROLE_SPLIT_MIN_MATCHES} (and half) that would make the two one operator.`;
      excluded.push({
        address: sponsor,
        role: "sponsor",
        observed_counterparties: p.observed,
        ...roleSplit,
        reason: `Sponsored gas for more than ${popularityLimit} distinct senders, so shared sponsorship through it is not used as a link on its own. ${measured}`,
      });
      continue;
    }
    if (!p.popular) sponsorMembers.set(sponsor, p.members);
    used.push({
      address: sponsor,
      role: "sponsor",
      observed_counterparties: p.observed,
      ...roleSplit,
      scan_complete: p.complete,
    });
  }

  // Seeds sharing a narrow first funder. Exact: both sides were computed.
  const bySharedFunder = new Map<string, string[]>();
  for (const [seed, funder] of firstFunders) {
    if (!funderMembers.has(funder)) continue;
    bySharedFunder.set(funder, [...(bySharedFunder.get(funder) ?? []), seed]);
  }
  // Recipient counts for any transaction that first-funded two or more of the
  // addresses under examination. Fetched once, shared by every emission site.
  const txRecipients = new Map<string, number | null>();
  const prefetchRecipients = async (members: string[]) => {
    const byDigest = new Map<string, number>();
    for (const m of members) {
      const d = funderDigest.get(m);
      if (d) byDigest.set(d, (byDigest.get(d) ?? 0) + 1);
    }
    for (const [digest, count] of byDigest) {
      if (count < 2 || txRecipients.has(digest)) continue;
      txRecipients.set(digest, await countTxRecipients(digest, budget));
    }
  };

  /**
   * Emit `cofunded` edges for one funder, weighted by how the pair was funded.
   *
   * A star from the seeds: same components as pairing everyone, far less output.
   */
  const emitCoFunded = async (funder: string, seedsHere: string[], others: string[]) => {
    if (seedsHere.length === 0 || seedsHere.length + others.length < 2) return;
    await prefetchRecipients([...seedsHere, ...others]);
    edges.addStar(
      "cofunded",
      funder,
      seedsHere,
      others,
      `First funded by the same address (${funder.slice(0, 10)}…), which pays few enough addresses that the coincidence is meaningful`,
      (m) => (funderDigest.get(m) ? [funderDigest.get(m)!] : []),
      (a, b) => {
        const da = funderDigest.get(a);
        const db = funderDigest.get(b);
        // Only a SHARED funding transaction is re-weighted. Separate
        // transactions from one funder means each was funded deliberately,
        // which is the ordinary case and keeps the default weight.
        if (!da || !db || da !== db) return undefined;
        return coFundedWeight(da, txRecipients.get(da) ?? null);
      },
    );
  };

  for (const [funder, members] of bySharedFunder) {
    await emitCoFunded(funder, members, []);
  }

  // Seeds sharing a narrow sponsor. Directly observed, no verification needed.
  for (const [sponsor, members] of sponsorMembers) {
    const seedsHere = uniqueSeeds.filter((s) => profiles.get(s)?.sponsors.has(sponsor));
    if (seedsHere.length >= 2) {
      edges.addGroup(
        "sponsor",
        sponsor,
        seedsHere,
        `Gas paid by the same address (${sponsor.slice(0, 10)}…), which sponsors few enough senders to rule out a relayer service`,
        (m) => {
          const d = profiles.get(m)?.sponsors.get(sponsor);
          return d ? [d] : [];
        },
      );
    }
  }

  const examined = new Set(uniqueSeeds);
  for (const o of operators) examined.add(o);
  for (const f of splitFunders) examined.add(f);

  // --- phase 3: expansion ----------------------------------------------
  if (expand) {
    // Anyone else the narrow sponsors paid gas for is admitted directly — the
    // probe watched it happen.
    for (const [sponsor, members] of sponsorMembers) {
      const seedsHere = uniqueSeeds.filter((s) => profiles.get(s)?.sponsors.has(sponsor));
      const group = [...new Set([...members.keys(), ...seedsHere])];
      if (group.length < 2 || seedsHere.length === 0) continue;
      edges.addStar(
        "sponsor",
        sponsor,
        seedsHere,
        [...members.keys()],
        `Gas paid by the same address (${sponsor.slice(0, 10)}…), which sponsors few enough senders to rule out a relayer service`,
        (m) => {
          const d = members.get(m) ?? profiles.get(m)?.sponsors.get(sponsor);
          return d ? [d] : [];
        },
      );
      for (const m of group) examined.add(m);
    }

    // Candidates a narrow funder paid. Being paid is not being funded, so each
    // is verified by computing its own first funder before it joins as
    // `cofunded` — otherwise a one-off payment would read as shared origin.
    const candidates: Array<{ address: string; funder: string }> = [];
    for (const [funder, members] of funderMembers) {
      for (const m of members.keys()) {
        if (uniqueSeeds.includes(m)) continue;
        candidates.push({ address: m, funder });
      }
    }
    let verified = 0;
    const confirmed = new Map<string, string[]>();
    for (const c of candidates) {
      if (verified >= expandBudget || budget.truncated) break;
      verified++;
      const f = await firstFunderOf(c.address, budget);
      if (!f) unreadFundingLookups++;
      if (f?.pricesUnavailable) unpricedLookups++;
      if (f?.originUnread.length) originUnreadLookups++;
      if (!f?.funder || !f.digest || f.funder !== c.funder) continue;
      firstFunders.set(c.address, f.funder);
      funderDigest.set(c.address, f.digest);
      confirmed.set(c.funder, [...(confirmed.get(c.funder) ?? []), c.address]);
      examined.add(c.address);
    }
    if (candidates.length > verified) {
      notes.push(
        `${candidates.length - verified} sibling candidates were left unverified (expansion budget ${expandBudget}). ` +
          "They are neither confirmed nor ruled out — raise expand_budget to check them.",
      );
    }
    for (const [funder, found] of confirmed) {
      await emitCoFunded(
        funder,
        uniqueSeeds.filter((s) => firstFunders.get(s) === funder),
        found,
      );
    }
  }

  const provisional = used.filter((u) => !u.scan_complete);
  if (provisional.length) {
    notes.push(
      `${provisional.length} intermediary scan(s) hit the page cap before reaching the end of that address's history, ` +
        "so their `narrow` verdict is provisional rather than measured. The scan walks backwards from recent activity " +
        "while the fundings it filters are historical, so an address that distributed widely long ago and has been " +
        "quiet since can read as narrow. Check `used_intermediaries`.",
    );
  }
  // Value that came back.
  //
  // One-directional transfer volume is excluded everywhere else here, and
  // rightly: everyone pays an exchange. Reciprocal flow is a different claim:
  // it is rare between unrelated active wallets and common between addresses
  // that share an owner.
  //
  // The seed's own scan usually sees only one direction, because it reads a
  // bounded window of recent history and the return leg can sit outside it: a
  // wallet that paid another 400 transactions ago shows the outbound half and
  // nothing else. So the missing direction is asked of the counterparty, and
  // `probeRecipients` already returns exactly that while measuring whether the
  // counterparty is a service. One probe answers both.
  const reciprocalSeen = new Set<string>();
  for (const [seed, prof] of profiles) {
    for (const [other, outDigest] of prof.paidTo) {
      if (other === seed) continue;
      const pairKey = seed < other ? `${seed}|${other}` : `${other}|${seed}`;
      if (reciprocalSeen.has(pairKey)) continue;
      reciprocalSeen.add(pairKey);
      const digests = [outDigest];
      const back = prof.paidBy.get(other);
      if (back) digests.push(back);
      if (reciprocalCandidates.length < reciprocalBudget) {
        reciprocalCandidates.push({ seed, other, digests, alreadyBoth: Boolean(back) });
      } else {
        unprobedReciprocal++;
      }
    }
  }
  // One probe per counterparty, however many seeds traded with it. A second
  // probe spends budget re-proving the first one's verdict, and one made after
  // the budget ran out would report as unmeasured an address already measured.
  const reciprocalProbes = new Map<string, Popularity>();
  const usedReciprocal = new Set<string>();
  for (const c of reciprocalCandidates) {
    // A seed is under investigation and needs no popularity check; a
    // counterparty is not, and a deposit to an exchange followed by a
    // withdrawal from it is reciprocal while meaning nothing.
    if (uniqueSeeds.includes(c.other)) {
      if (c.alreadyBoth) edges.add("reciprocal", c.seed, c.other, RECIPROCAL_DETAIL, c.digests);
      continue;
    }
    let p = reciprocalProbes.get(c.other);
    const firstVerdict = !p;
    if (!p) {
      p = await probeRecipients(c.other, popularityLimit, budget);
      reciprocalProbes.set(c.other, p);
    }
    if (p.unmeasured) {
      // No verdict. A narrow reading here would let a `reciprocal` edge,
      // which alone meets the merge floor, link every seed that traded with
      // an unread market maker. Funders and sponsors refuse the same way above.
      if (firstVerdict) excludeUnmeasured(c.other, "funder", p.unmeasured, p.observed);
      continue;
    }
    if (p.popular) {
      if (firstVerdict) {
        excluded.push({
          address: c.other,
          role: "funder",
          observed_counterparties: p.observed,
          reason: `Value moved to this address, but it pays more than ${popularityLimit} distinct addresses at least 0.01 SUI or $0.10 each — an exchange or service, where a deposit followed by a withdrawal is reciprocal and means nothing.`,
        });
      }
      continue;
    }
    // The probe answers the direction the seed's own window could not see.
    const paidSeedBack = p.members.has(c.seed);
    if (!c.alreadyBoth && !paidSeedBack) continue;
    if (paidSeedBack && !c.alreadyBoth) c.digests.push(p.members.get(c.seed)!);
    if (!usedReciprocal.has(c.other)) {
      usedReciprocal.add(c.other);
      used.push({
        address: c.other,
        role: "funder",
        observed_counterparties: p.observed,
        scan_complete: p.complete,
      });
    }
    edges.add("reciprocal", c.seed, c.other, RECIPROCAL_DETAIL, c.digests);
    examined.add(c.other);
  }
  if (unprobedReciprocal > 0) {
    notes.push(
      `${unprobedReciprocal} counterparties were not checked for reciprocal flow (budget ${reciprocalBudget}). ` +
        "They are neither confirmed nor ruled out — raise reciprocal_budget to check them.",
    );
  }

  // Who first-funded whom.
  //
  // Two cases. A seed funding another seed needs no base rate to argue with:
  // the money that made one subject exist came straight from another. A
  // funder discovered on the walk needs the popularity filter first, but once
  // it clears (10 lifetime counterparties, say) it is the strongest single
  // thing in the result.
  //
  // The edge is emitted for a narrow funder whether or not it is a seed, so
  // the hub of a cluster appears in it and the answer does not depend on
  // which addresses the caller already named.
  for (const [funded, funder] of firstFunders) {
    const isSeed = uniqueSeeds.includes(funder);
    const isNarrow = funderMembers.has(funder);
    if (!isSeed && !isNarrow) continue;
    const digest = funderDigest.get(funded);
    edges.add(
      "funding_edge",
      funder,
      funded,
      `${funder.slice(0, 10)}… sent the first funding that made ${funded.slice(0, 10)}… exist` +
        (isSeed ? "" : ", and pays few enough addresses that this is not an exchange withdrawal"),
      digest ? [digest] : [],
    );
    examined.add(funder);
  }

  if (unreadFundingLookups > 0) {
    notes.push(
      `${unreadFundingLookups} first-funding lookup(s) remain unread because a read failed, balance changes could not ` +
        "be completed, or the query budget ran out. No first funder was chosen or cached for those lookups; " +
        "missing funding edges are not evidence of separate origins.",
    );
  }
  if (unpricedLookups > 0) {
    notes.push(
      `Coin prices could not be read for ${unpricedLookups} first-funding lookup(s), so a non-SUI inflow there was ` +
        "accepted as funding at any value instead of being checked against the $0.10 dust floor. Those picks were " +
        "not cached; rerun once prices load before relying on a non-SUI first funder.",
    );
  }
  if (originUnreadLookups > 0) {
    notes.push(
      `The supply or publisher of a coin nobody prices could not be read for ${originUnreadLookups} first-funding ` +
        "lookup(s), so an inflow of it was skipped as spam without the check that counts a large share of supply as " +
        "funding. The first funder named there may be a later inflow; rerun before relying on it.",
    );
  }
  if (budget.truncated) {
    notes.push(
      "The query budget ran out before every lead was followed. Edges found are still valid; " +
        "edges NOT found may simply not have been looked for.",
    );
  }
  if (unreadIntermediaries > 0) {
    notes.push(
      `${unreadIntermediaries} intermediary popularity read(s) failed (the query errored after retries, not the budget), ` +
        "so those addresses are excluded unmeasured and any edge through them was not looked for. Edges found are " +
        "still valid. Rerunning may measure them; raising query_budget will not.",
    );
  }

  return {
    edges: edges.edges(),
    examined: [...examined].sort(),
    excluded_intermediaries: excluded,
    used_intermediaries: used,
    first_funders: Object.fromEntries(firstFunders),
    queries_used: budget.used,
    truncated: budget.truncated || unreadFundingLookups > 0 || unreadSeedScans > 0 || unreadIntermediaries > 0 || originUnreadLookups > 0,
    notes,
  };
}
