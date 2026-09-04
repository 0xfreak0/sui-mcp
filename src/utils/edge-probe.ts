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
import { pickFundingTx, type FundingTx } from "./funding.js";
import { getCachedFirstFunder, saveFirstFunder } from "./store.js";
import { currentSuiAccount, parseAccountId, currentSuiChain } from "./chain-id.js";
import { EdgeSet, type WalletEdge } from "./wallet-edges.js";
import { assessCoFunding } from "./co-funding.js";

/**
 * Distinct counterparties past which an intermediary is a service, not a person.
 *
 * Mirrors the value a batch pipeline settled on for the same job. Wallet
 * aggregators and sponsored-transaction relayers sponsor thousands; "I pay gas
 * for my own alts" stays far below. The exact cut matters less than that it
 * exists — the gap between the two populations is orders of magnitude, and a
 * mainnet sample bears that out: in one 60-checkpoint window the single service
 * sponsor sat at 22 distinct senders while every other sponsor sat at 1 or 2.
 */
const DEFAULT_POPULARITY_LIMIT = 50;

/**
 * Distinct parties in one transaction past which co-appearance means nothing.
 *
 * An airdrop or mass claim puts hundreds of unrelated addresses in one
 * transaction. Measured on mainnet, ordinary traffic is nowhere near this:
 * the 99th percentile of distinct balance-change parties is 1.
 */
const MASS_ACTION_LIMIT = 20;

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
  reason: string;
}

/** An intermediary that survived the filter, and how well it was measured. */
export interface UsedIntermediary {
  address: string;
  role: "funder" | "sponsor";
  observed_counterparties: number;
  /**
   * False when the scan hit its page cap before reaching the end of history.
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
  /** True when a budget stopped the build before it ran out of work. */
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
        balanceChanges { nodes { coinType { repr } amount owner { address } } }
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
      effects { balanceChanges { nodes { amount owner { address } } } }
    }
    pageInfo { hasPreviousPage startCursor }
  }
}`;

/** Outbound only — who did this address pay? */
const SENT_QUERY = `query ($addr: SuiAddress!, $last: Int!, $before: String) {
  transactions(filter: { sentAddress: $addr }, last: $last, before: $before) {
    nodes {
      digest
      effects { balanceChanges { nodes { amount owner { address } } } }
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
      effects?: { balanceChanges: { nodes: Array<{ amount?: string; owner?: { address: string } }> } } | null;
    }>;
    pageInfo: { hasPreviousPage: boolean; startCursor?: string };
  };
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/**
 * The first inflow that made `address` exist, or null.
 *
 * Cached in the optional local store, and the reason it is safe to cache is the
 * same one that makes the transaction cache safe: a wallet's *first* funding is
 * fixed the moment it happens. No later activity can change which inflow came
 * first, so there is no TTL and no invalidation path to get wrong. The
 * asymmetry is that a *negative* would go stale — an address with no qualifying
 * funding today can be funded tomorrow — so only positives are written.
 *
 * This is the expensive half of expansion: verifying sibling candidates is one
 * lookup each, and investigations revisit the same neighbourhood repeatedly.
 */
export async function firstFunderOf(
  address: string,
  budget: Budget,
): Promise<{ funder: string; digest: string } | null> {
  const account = currentSuiAccount(address);
  const cached = getCachedFirstFunder(account);
  if (cached) {
    return {
      funder: parseAccountId(cached.funder_account, currentSuiChain()).address,
      digest: cached.digest,
    };
  }
  if (!budget.take()) return null;
  try {
    const data = await gqlQuery<{ transactions: { nodes: RawEarliest[] } }>(EARLIEST_QUERY, {
      addr: address,
      first: 12,
    });
    const txs: FundingTx[] = data.transactions.nodes.map(toFundingTx);
    // Reuses the dust and gas-sponsor rules rather than re-deriving them: a
    // 1-MIST spam send must not become a cluster edge either.
    const picked = pickFundingTx(txs, address);
    if (!picked || picked.funder === "unknown") return null;
    saveFirstFunder(account, currentSuiAccount(picked.funder), picked.digest);
    return { funder: picked.funder, digest: picked.digest };
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
    balanceChanges: { nodes: Array<{ coinType?: { repr: string }; amount?: string; owner?: { address: string } }> };
  } | null;
}

function toFundingTx(n: RawEarliest): FundingTx {
  return {
    digest: n.digest,
    sender: n.sender?.address ?? null,
    timestamp: n.effects?.timestamp ?? null,
    checkpoint: n.effects?.checkpoint?.sequenceNumber?.toString() ?? null,
    changes: (n.effects?.balanceChanges.nodes ?? [])
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
}

/**
 * Who did `address` pay, up to `limit + 1` distinct recipients?
 *
 * Stops the moment the limit is exceeded — the verdict is settled at that point
 * and every further page is spent proving something already known. When the
 * scan finishes under the limit, `members` is the candidate sibling set.
 */
export async function probeRecipients(
  address: string,
  limit: number,
  budget: Budget,
): Promise<Popularity> {
  const members = new Map<string, string>();
  let cursor: string | undefined;
  let pages = 0;
  let reachedEnd = false;
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
      break;
    }
    pages++;
    for (const n of page.transactions.nodes) {
      for (const bc of n.effects?.balanceChanges.nodes ?? []) {
        const owner = bc.owner?.address;
        if (!owner || owner === address) continue;
        if (BigInt(bc.amount ?? "0") <= 0n) continue;
        if (!members.has(owner)) members.set(owner, n.digest);
      }
    }
    if (members.size > limit) {
      // Proven by what was seen; further pages cannot change the verdict.
      return { members: new Map(), popular: true, observed: members.size, complete: true };
    }
    if (!page.transactions.pageInfo.hasPreviousPage) {
      reachedEnd = true;
      break;
    }
    cursor = page.transactions.pageInfo.startCursor;
    if (!cursor) break;
  }
  return { members, popular: false, observed: members.size, complete: reachedEnd };
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
  const maxPages = Math.ceil((limit + 1) / PAGE) + 4;

  while (pages < maxPages) {
    if (!budget.take()) break;
    let page: RecentPage;
    try {
      page = await gqlQuery<RecentPage>(RECENT_QUERY, { addr: address, last: PAGE, before: cursor });
    } catch {
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
      return { members: new Map(), popular: true, observed: members.size, complete: true };
    }
    if (!page.transactions.pageInfo.hasPreviousPage) {
      reachedEnd = true;
      break;
    }
    cursor = page.transactions.pageInfo.startCursor;
    if (!cursor) break;
  }
  return { members, popular: false, observed: members.size, complete: reachedEnd };
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
    balanceChanges { nodes { amount owner { address } } }
  }
}`;

/** Null when the transaction could not be read — never a default that reads as measured. */
async function countTxRecipients(digest: string, budget: Budget): Promise<number | null> {
  if (!budget.take()) return null;
  try {
    const r = await gqlQuery<{
      transactionEffects: { balanceChanges: { nodes: Array<{ amount?: string; owner?: { address: string } }> } } | null;
    }>(TX_RECIPIENTS_QUERY, { digest });
    const nodes = r.transactionEffects?.balanceChanges?.nodes;
    if (!nodes) return null;
    const recipients = new Set<string>();
    for (const n of nodes) {
      if (n.owner?.address && n.amount && BigInt(n.amount) > 0n) recipients.add(n.owner.address);
    }
    return recipients.size;
  } catch {
    return null;
  }
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
      break;
    }
    for (const n of page.transactions.nodes) {
      scanned++;
      const sender = n.sender?.address;
      const sponsor = n.gasInput?.gasSponsor?.address;
      // Only a sponsor who is somebody else. A self-paid transaction reports
      // the sender as its own gas sponsor, which would otherwise make every
      // address its own sponsor and link it to nobody usefully.
      if (sponsor && sender && sponsor !== sender) sponsors.set(sponsor, n.digest);

      // The SENDER is excluded, and that exclusion is what makes this a signal
      // rather than a restatement of transfer volume. If A pays B, both appear
      // in the balance changes, so counting them would make "A sent to B" an
      // edge — the single most common relationship on chain, and the one this
      // module explicitly refuses to cluster on. What remains is the real
      // signal: a THIRD party moved both balances in one transaction, which is
      // somebody paying two wallets at once.
      // Direction is read from the subject's own net change, the same way
      // measureFanout separates recipients from senders.
      const changes = n.effects?.balanceChanges.nodes ?? [];
      const own = changes.find((c) => c.owner?.address === address);
      const ownDelta = BigInt(own?.amount ?? "0");
      for (const bc of changes) {
        const other = bc.owner?.address;
        if (!other || other === address) continue;
        const amt = BigInt(bc.amount ?? "0");
        if (ownDelta < 0n && amt > 0n && !paidTo.has(other)) paidTo.set(other, n.digest);
        if (ownDelta > 0n && amt < 0n && !paidBy.has(other)) paidBy.set(other, n.digest);
      }

      const parties = [
        ...new Set(
          (n.effects?.balanceChanges.nodes ?? [])
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
  return { sponsors, coParties, paidTo, paidBy };
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

  // --- phase 1: profile every seed -------------------------------------
  const profiles = new Map<string, SeedProfile>();
  const funderDigest = new Map<string, string>();
  for (const seed of uniqueSeeds) {
    const funding = await firstFunderOf(seed, budget);
    if (funding) {
      firstFunders.set(seed, funding.funder);
      funderDigest.set(seed, funding.digest);
    }
    profiles.set(seed, await profileSeed(seed, maxSeedScan, budget));
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

  const distinctFunders = [...new Set(firstFunders.values())].filter((f) => !uniqueSeeds.includes(f));
  for (const funder of distinctFunders) {
    const p = await probeRecipients(funder, popularityLimit, budget);
    if (p.popular) {
      excluded.push({
        address: funder,
        role: "funder",
        observed_counterparties: p.observed,
        reason: `Paid more than ${popularityLimit} distinct addresses — exchange, bridge or faucet-scale distributor. Shared ancestry through it carries no information.`,
      });
      continue;
    }
    funderMembers.set(funder, p.members);
    used.push({
      address: funder,
      role: "funder",
      observed_counterparties: p.observed,
      scan_complete: p.complete,
    });
  }

  const distinctSponsors = new Set<string>();
  for (const prof of profiles.values()) for (const s of prof.sponsors.keys()) distinctSponsors.add(s);
  for (const sponsor of distinctSponsors) {
    if (uniqueSeeds.includes(sponsor)) continue;
    const p = await probeSponsored(sponsor, popularityLimit, budget);
    if (p.popular) {
      excluded.push({
        address: sponsor,
        role: "sponsor",
        observed_counterparties: p.observed,
        reason: `Sponsored gas for more than ${popularityLimit} distinct senders — a relayer or wallet-aggregator service, not a person paying for their own wallets.`,
      });
      continue;
    }
    sponsorMembers.set(sponsor, p.members);
    used.push({
      address: sponsor,
      role: "sponsor",
      observed_counterparties: p.observed,
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
      if (!f || f.funder !== c.funder) continue;
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
  // Value that came BACK.
  //
  // One-directional transfer volume is excluded everywhere else here, and
  // rightly: everyone pays an exchange. Reciprocal flow is a different claim.
  // Measured on mainnet, 1 of 47 counterparty relationships of ordinary active
  // wallets was reciprocal — a 2.1% base rate — while 4 of 6 pairs among four
  // addresses known to share an owner were. Roughly a 32x enrichment.
  //
  // The seed's own scan usually sees only ONE direction, because it reads a
  // bounded window of recent history and the return leg can sit outside it: a
  // wallet that paid another 400 transactions ago shows the outbound half and
  // nothing else. So the missing direction is not scanned for — it is asked of
  // the counterparty, and `probeRecipients` already returns exactly that while
  // measuring whether the counterparty is a service. One probe answers both.
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
  for (const c of reciprocalCandidates) {
    // A seed is under investigation and needs no popularity check; a
    // counterparty is not, and a deposit to an exchange followed by a
    // withdrawal from it is reciprocal while meaning nothing.
    if (uniqueSeeds.includes(c.other)) {
      if (c.alreadyBoth) edges.add("reciprocal", c.seed, c.other, RECIPROCAL_DETAIL, c.digests);
      continue;
    }
    const p = await probeRecipients(c.other, popularityLimit, budget);
    if (p.popular) {
      excluded.push({
        address: c.other,
        role: "funder",
        observed_counterparties: p.observed,
        reason: `Value moved to this address, but it pays more than ${popularityLimit} distinct addresses — an exchange or service, where a deposit followed by a withdrawal is reciprocal and means nothing.`,
      });
      continue;
    }
    // The probe answers the direction the seed's own window could not see.
    const paidSeedBack = p.members.has(c.seed);
    if (!c.alreadyBoth && !paidSeedBack) continue;
    if (paidSeedBack && !c.alreadyBoth) c.digests.push(p.members.get(c.seed)!);
    used.push({
      address: c.other,
      role: "funder",
      observed_counterparties: p.observed,
      scan_complete: p.complete,
    });
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
  // Two cases, and only the second is new. A seed funding another seed needs no
  // base rate to argue with: the money that made one subject exist came
  // straight from another. A funder discovered on the walk needs the popularity
  // filter first, but once it clears — 10 lifetime counterparties, say — it is
  // the strongest single thing in the result, and it used to be discarded.
  //
  // It was only ever used as the `via` label on the `cofunded` edges between
  // the addresses it funded, so the hub of a cluster was excluded from it. That
  // made the answer depend on what the caller already knew: pass both addresses
  // as seeds and the edge appeared, pass one and it did not, on identical chain
  // data. Backwards for a tool whose job is finding the addresses you did not
  // name.
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

  if (budget.truncated) {
    notes.push(
      "The query budget ran out before every lead was followed. Edges found are still valid; " +
        "edges NOT found may simply not have been looked for.",
    );
  }

  return {
    edges: edges.edges(),
    examined: [...examined].sort(),
    excluded_intermediaries: excluded,
    used_intermediaries: used,
    first_funders: Object.fromEntries(firstFunders),
    queries_used: budget.used,
    truncated: budget.truncated,
    notes,
  };
}
