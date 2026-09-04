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

/** Sponsors that paid this address's gas, and who it shared transactions with. */
interface SeedProfile {
  sponsors: Map<string, string>;
  coParties: Array<{ digest: string; parties: string[] }>;
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
  return { sponsors, coParties };
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

  // A seed that first-funded another seed. No base rate to argue with: the
  // money that made one subject exist came straight from another subject.
  for (const [seed, funder] of firstFunders) {
    if (uniqueSeeds.includes(funder)) {
      edges.add(
        "funding_edge",
        funder,
        seed,
        `${funder.slice(0, 10)}… sent the first funding that made ${seed.slice(0, 10)}… exist`,
        [funderDigest.get(seed)!],
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
  for (const [funder, members] of bySharedFunder) {
    if (members.length < 2) continue;
    edges.addGroup(
      "cofunded",
      funder,
      members,
      `First funded by the same address (${funder.slice(0, 10)}…), which pays few enough addresses that the coincidence is meaningful`,
      (m) => (funderDigest.get(m) ? [funderDigest.get(m)!] : []),
    );
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
      const seedsHere = uniqueSeeds.filter((s) => firstFunders.get(s) === funder);
      if (found.length + seedsHere.length < 2 || seedsHere.length === 0) continue;
      edges.addStar(
        "cofunded",
        funder,
        seedsHere,
        found,
        `First funded by the same address (${funder.slice(0, 10)}…), which pays few enough addresses that the coincidence is meaningful`,
        (m) => (funderDigest.get(m) ? [funderDigest.get(m)!] : []),
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
