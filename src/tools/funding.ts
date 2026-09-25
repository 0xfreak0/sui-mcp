import { z } from "zod";
import { boolArg, numArg, addressArg, addressListArg } from "./args.js";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { batchResolveNames } from "../utils/names.js";
import { classifyHeldNames, describeAddresses, identityNote } from "../utils/identity.js";
import { describeLabel, getLabel } from "../utils/labels.js";
import { classifyDepositAddress } from "../utils/deposit.js";
import {
  coinScale,
  decimalsForCoinType,
  displayCoin,
  toHumanAmount,
  usdValue,
} from "../utils/valuation.js";
import { pickFundingTx, type FundingAssessment, type FundingTx, type GasSponsor } from "../utils/funding.js";
import { pricesForRanking } from "../utils/price-providers.js";
import { measureFanout, type FanoutResult } from "../utils/fanout.js";
import { assessCoFunding, detectCoFunding } from "../utils/co-funding.js";
import { detectFundingBursts, detectSubjectLinks } from "../utils/funding-signals.js";
import { Budget, DEFAULT_POPULARITY_LIMIT, probeRecipients } from "../utils/edge-probe.js";
import {
  BALANCE_CHANGES_SELECTION,
  completeTxConnections,
  readAllBalanceChanges,
  type GqlConnection,
} from "../utils/tx-connections.js";
import type { GqlBalanceChangeNode } from "../utils/gql-adapters.js";
import { findSubjectPayments, MAX_PAIRWISE_SUBJECTS, paymentInTx, type SubjectPayment } from "../utils/subject-payments.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * How many distinct addresses a transaction paid.
 *
 * The denominator for co-funding: two subjects sharing a two-recipient payout
 * is near-decisive, sharing a nineteen-recipient one is a batch distribution.
 * Without this the two are indistinguishable in the output.
 */
const TX_RECIPIENTS_QUERY = `query ($digest: String!) {
  transactionEffects(digest: $digest) {
    ${BALANCE_CHANGES_SELECTION}
  }
}`;

interface TxRecipientsResult {
  transactionEffects: { balanceChanges: GqlConnection<GqlBalanceChangeNode> | null } | null;
}

/** Null when the transaction could not be read — never a default that reads as measured. */
async function countTxRecipients(digest: string): Promise<number | null> {
  try {
    const r = await gqlQuery<TxRecipientsResult>(TX_RECIPIENTS_QUERY, { digest });
    if (!r.transactionEffects?.balanceChanges) return null;
    const { nodes, truncated } = await readAllBalanceChanges(digest, r.transactionEffects.balanceChanges);
    // A partial list gives a lower bound, and a lower bound on the payout size
    // makes a batch read as bespoke. Unmeasured is the honest answer.
    if (truncated) return null;
    const recipients = new Set<string>();
    for (const n of nodes) {
      // Positive only: the payer's own negative change is not a recipient.
      if (n.owner?.address && n.amount && BigInt(n.amount) > 0n) recipients.add(n.owner.address);
    }
    return recipients.size;
  } catch {
    return null;
  }
}

/** Transactions read per address when looking for its first funding. */
const EARLIEST_TXS = 12;

const FUNDING_QUERY = `query ($addr: SuiAddress!, $first: Int!) {
  transactions(filter: { affectedAddress: $addr }, first: $first) {
    nodes {
      digest
      sender { address }
      gasInput { gasSponsor { address } }
      effects {
        timestamp
        checkpoint { sequenceNumber }
        ${BALANCE_CHANGES_SELECTION}
      }
    }
  }
}`;

interface FundingQueryResult {
  transactions: {
    nodes: Array<{
      digest: string;
      sender: { address: string } | null;
      gasInput?: { gasSponsor?: { address: string } | null } | null;
      effects: {
        timestamp: string | null;
        checkpoint: { sequenceNumber: number } | null;
        balanceChanges: GqlConnection<GqlBalanceChangeNode> | null;
      } | null;
    }>;
  };
}

/**
 * An address's earliest transactions (oldest first) as FundingTx records,
 * with the digests whose balance changes could not all be read.
 */
async function fetchEarliestTxs(address: string): Promise<{ txs: FundingTx[]; incomplete: string[] }> {
  const data = await gqlQuery<FundingQueryResult>(FUNDING_QUERY, { addr: address, first: EARLIEST_TXS });
  const nodes = data.transactions.nodes;
  const completed = await completeTxConnections(
    nodes.map((n) => ({ digest: n.digest, balanceChanges: n.effects?.balanceChanges })),
  );
  const txs = nodes.map((n, i) => ({
    digest: n.digest,
    sender: n.sender?.address ?? null,
    gasSponsor: n.gasInput?.gasSponsor?.address ?? null,
    timestamp: n.effects?.timestamp ?? null,
    checkpoint: n.effects?.checkpoint?.sequenceNumber?.toString() ?? null,
    changes: completed[i].balanceChanges
      .filter((c) => c.owner?.address && c.amount && c.coinType?.repr)
      .map((c) => ({ address: c.owner!.address, amount: c.amount!, coinType: c.coinType!.repr })),
  }));
  return { txs, incomplete: nodes.filter((_, i) => completed[i].balanceChangesTruncated).map((n) => n.digest) };
}

/**
 * Human amount with its symbol, marked when nothing vouches for the coin.
 *
 * The `(unverified)` is not decoration. The symbol is whatever the minter
 * chose — 585 mainnet coins end `::SUI` — and the scale used to render the
 * number is a guess for any coin the registry does not know. An amount that
 * might be 10^9 out must not read the same as one that cannot be.
 */
function formatAmount(rawAmount: string, coinType: string): string {
  const scale = coinScale(coinType);
  const { symbol, verified } = displayCoin(coinType);
  const human = toHumanAmount(rawAmount, scale.decimals);
  // `verified === null` means no curated list covers this network, which is
  // neither a claim nor a denial — so it gets no mark at all.
  return `${human} ${symbol}${verified === false ? " (unverified)" : ""}`;
}

/**
 * How widely a funder pays out, by the same probe and the same limit
 * `build_wallet_edges` uses to discard an intermediary, so the two tools
 * cannot disagree about whether an address is a service.
 */
interface FunderPopularity {
  /** Paid more than `limit` distinct addresses in the outgoing transactions scanned. */
  popular: boolean;
  /** Distinct recipients seen before the scan stopped. A lower bound. */
  observed_recipients: number;
  limit: number;
  /** The scan reached the end of the address's outgoing transactions. */
  scan_complete: boolean;
  /** Narrow off an incomplete scan: not measured far enough to rule out a service. */
  provisional?: true;
  /** The per-call query budget ran out before this funder was probed. */
  unmeasured?: true;
}

interface ChainStep {
  hop: number;
  address: string;
  funded_by: string;
  funding_tx: string;
  timestamp: string | null;
  amount: string;
  funder_popularity?: FunderPopularity;
}

/** One address's earliest transactions and what they say about its funding. */
interface FundingStep {
  assessment: FundingAssessment;
  txs: FundingTx[];
  /** Digests whose balance changes could not all be read. */
  incomplete: string[];
}

/**
 * Per-call state shared by every walk in one tool call.
 *
 * Funding chains converge hard — in a ten-wallet sample, eight reached the same
 * three ancestors — so without a shared cache a batch re-derives the same tail
 * once per input address. The cache is per-call rather than process-wide: chain
 * state is cheap to rebuild and a long-lived cache would go stale against a
 * chain that keeps moving. Popularity is cached the same way: a funder shared
 * by forty subjects is probed once.
 */
interface WalkContext {
  steps: Map<string, Promise<FundingStep>>;
  popularity: Map<string, Promise<FunderPopularity>>;
  /** Ceiling on popularity-probe requests for the whole call. */
  budget: Budget;
}

/**
 * Popularity-probe requests per call. A probe costs one to six requests and
 * stops as soon as the limit is exceeded, so a hub is usually one.
 */
const SINGLE_POPULARITY_BUDGET = 60;
const BATCH_POPULARITY_BUDGET = 400;

async function loadFundingStep(address: string): Promise<FundingStep> {
  const { txs, incomplete } = await fetchEarliestTxs(address);
  // Price the coins these candidate inflows are denominated in, so dust and
  // unpriced scam tokens can be told from real funding. Best-effort: with no
  // prices the SUI floor still applies and non-SUI inflows are accepted
  // rather than discarded on a missing dependency.
  const coinTypes = [...new Set(txs.flatMap((t) => t.changes.map((c) => c.coinType)))];
  const prices = await pricesForRanking(coinTypes).catch(
    () => new Map<string, { price: number }>(),
  );
  const valueUsd = (coinType: string, raw: bigint) => {
    const price = prices.get(coinType)?.price;
    if (price == null) return null;
    return usdValue(raw, decimalsForCoinType(coinType), price);
  };
  return { assessment: pickFundingTx(txs, address, { valueUsd }), txs, incomplete };
}

function fundingStep(address: string, ctx: WalkContext): Promise<FundingStep> {
  let step = ctx.steps.get(address);
  if (!step) {
    step = loadFundingStep(address);
    ctx.steps.set(address, step);
  }
  return step;
}

async function probePopularity(address: string, budget: Budget): Promise<FunderPopularity> {
  const before = budget.used;
  const p = await probeRecipients(address, DEFAULT_POPULARITY_LIMIT, budget);
  const base = { observed_recipients: p.observed, limit: DEFAULT_POPULARITY_LIMIT };
  if (budget.used === before) return { popular: false, ...base, scan_complete: false, unmeasured: true };
  if (p.popular) return { popular: true, ...base, scan_complete: true };
  return { popular: false, ...base, scan_complete: p.complete, ...(p.complete ? {} : { provisional: true as const }) };
}

function funderPopularity(address: string, ctx: WalkContext): Promise<FunderPopularity> {
  let p = ctx.popularity.get(address);
  if (!p) {
    p = probePopularity(address, ctx.budget);
    ctx.popularity.set(address, p);
  }
  return p;
}

interface Walk {
  chain: ChainStep[];
  origin: string;
  stopReason: string;
  dustSkipped: Array<Record<string, unknown>>;
  /** Gas sponsors of the address where the walk found no qualifying funding. */
  sponsoredBy: Array<GasSponsor & { address: string }>;
  /** The walk stopped because the last funder is a service-scale distributor. */
  stoppedAtHub: boolean;
  /** Funding transactions whose balance changes could not all be read. */
  incompleteReads: string[];
}

/** Walk one address back through funding hops. Shared by both funding tools. */
async function walkFunding(address: string, maxHops: number, ctx: WalkContext): Promise<Walk> {
  const chain: ChainStep[] = [];
  // Inflows rejected as dust along the way. Reported rather than dropped: an
  // investigator needs to see that a 1-MIST send was skipped, both to trust
  // the answer and to lower the floor deliberately if the case calls for it.
  const dustSkipped: Array<Record<string, unknown>> = [];
  const sponsoredBy: Walk["sponsoredBy"] = [];
  const incompleteReads: string[] = [];
  const visited = new Set<string>([address]);
  let current = address;
  let origin = address;
  let stopReason = "";
  let stoppedAtHub = false;

  for (let i = 0; i < maxHops; i++) {
    const { assessment, txs, incomplete } = await fundingStep(current, ctx);
    for (const d of assessment.dustSkipped) {
      dustSkipped.push({ address: current, ...d, amount: formatAmount(d.amount, d.coinType) });
    }
    const funding = assessment.funding;
    // Only the transactions up to the pick could have changed it.
    const pickedAt = funding ? txs.findIndex((t) => t.digest === funding.digest) : txs.length - 1;
    incompleteReads.push(...incomplete.filter((d) => txs.findIndex((t) => t.digest === d) <= pickedAt));
    if (!funding) {
      stopReason =
        txs.length < EARLIEST_TXS
          ? "reached a dead end (no qualifying inflow in its whole history)"
          : `reached a dead end (no qualifying inflow in its earliest ${EARLIEST_TXS} transactions)`;
      if (assessment.sponsors.length) {
        sponsoredBy.push(...assessment.sponsors.map((s) => ({ address: current, ...s })));
        stopReason += "; its gas was paid by a sponsor, see sponsored_by";
      }
      break;
    }

    const step: ChainStep = {
      hop: i + 1,
      address: current,
      funded_by: funding.funder,
      funding_tx: funding.digest,
      timestamp: funding.timestamp,
      amount: formatAmount(funding.amount, funding.coinType),
    };
    chain.push(step);

    const funder = funding.funder;
    origin = funder;

    if (funder === "unknown") { stopReason = "funder could not be determined"; break; }
    if (getLabel(funder)) { stopReason = `reached a labeled entity (${describeLabel(getLabel(funder)!)})`; break; }
    if (visited.has(funder)) { stopReason = "reached an already-seen wallet (cycle)"; break; }
    visited.add(funder);

    // Measured before walking further, because a service-scale funder ends
    // attribution: its own first funding says who funded the exchange, not
    // who funded the subject.
    const pop = await funderPopularity(funder, ctx);
    step.funder_popularity = pop;
    if (pop.popular) {
      stopReason =
        `reached a high-fanout distributor (paid more than ${pop.limit} distinct addresses), likely an exchange ` +
        "or service; ancestry beyond it carries no attribution";
      stoppedAtHub = true;
      break;
    }
    current = funder;

    if (i === maxHops - 1) stopReason = `hit max_hops (${maxHops})`;
  }

  return { chain, origin, stopReason, dustSkipped, sponsoredBy, stoppedAtHub, incompleteReads };
}

/**
 * Fan-out as reported beside a shared funder.
 *
 * When the popularity probe found more than `limit` recipients, the
 * bidirectional count over a short window can still classify the address
 * `narrow`, and "narrow, worth investigating" is the reading that makes an
 * exchange look like a common origin. The probe's verdict takes precedence in
 * the interpretation; the measured numbers are kept.
 */
function fanoutView(f: FanoutResult, pop: FunderPopularity | undefined) {
  return {
    recipient_count: f.recipient_count,
    sender_count: f.sender_count,
    counterparty_count: f.counterparty_count,
    coin_type_count: f.coin_type_count,
    out_in_ratio: f.out_in_ratio,
    flow_shape: f.flow_shape,
    scanned_transactions: f.scanned_transactions,
    truncated: f.truncated,
    classification: f.classification,
    ...(f.classification_provisional ? { classification_provisional: true } : {}),
    interpretation: pop?.popular
      ? `Paid more than ${pop.limit} distinct addresses in its recent outgoing transactions, the limit build_wallet_edges ` +
        "uses to discard an intermediary as an exchange or service. Shared funding through it is weak on its own: compare " +
        "the rate against a control group, and read flow_shape, since a disperser paid by few can still be one operator's payout wallet."
      : f.interpretation,
  };
}

export function registerFundingTools(server: McpServer) {
  server.tool(
    "get_address_fanout",
    "(Incident investigation) Measure how many distinct addresses an address transacts with, in BOTH directions, over its most recent activity. Use this before concluding anything from shared funding: several wallets tracing back to one funder is only meaningful if that funder is narrow. An exchange hot wallet pays tens of thousands of addresses, so common ancestry through it means nothing. Returns recipient_count, sender_count and counterparty_count, plus out_in_ratio and flow_shape — shape separates cases size cannot, since a custodial exchange and a sybil funder can have near-identical counterparty counts while one runs balanced and the other pays many and is paid by few.",
    {
      address: addressArg().describe("Address to measure (0x...)"),
      max_transactions: numArg()
        .int()
        .min(50)
        .max(3000)
        .optional()
        .describe(
          "Transactions to scan, walking backwards from the most recent (default 1000). Counts both directions. Higher is slower but tighter; check `truncated` in the response.",
        ),
    },
    async ({ address, max_transactions }) => {
      try {
        const result = await measureFanout(address, max_transactions ?? 1000);
        const existing = getLabel(address);

        // Suggested, never applied. Labels decide where fund traces stop, so
        // an automatic one would let a measurement silently redirect an
        // investigation. The human confirms it with manage_labels.
        const suggestion =
          !existing && result.classification === "hub"
            ? {
                suggested_label: {
                  category: "cex",
                  label: `Unidentified hub (~${result.recipient_count}+ recipients)`,
                  confidence: "low",
                },
                why: "Fan-out at exchange/bridge scale. NOT applied — confirm the identity yourself, then record it with manage_labels action='add'. A wrong sink label silently truncates every future trace through this address.",
              }
            : null;

        // A narrow address that pays one or two destinations is the shape of
        // an exchange deposit address being swept (a sponsor's storage rebate
        // counts as a second recipient in the fan-out). One more request reads
        // the sweeps; the sponsor and destination are not measured here, so
        // only a labelled exchange destination can make it `likely`.
        const deposit =
          !existing && result.classification === "narrow" && result.recipient_count <= 2 && result.sender_count >= 1
            ? await classifyDepositAddress(address, { measureSponsor: false, measureDestination: false }).catch(() => null)
            : null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...result,
                  ...(existing ? { existing_label: existing } : {}),
                  ...(suggestion ?? {}),
                  ...(deposit
                    ? {
                        deposit_address: {
                          verdict: deposit.verdict,
                          tier: deposit.tier,
                          hot_wallet: deposit.hot_wallet,
                          exchange: deposit.exchange,
                          reasons: deposit.reasons,
                          next_step: "classify_deposit_address measures the sweep sponsor and destination and lists sweeps and deposits.",
                        },
                      }
                    : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    "find_funding_sources",
    "(Incident investigation) Trace many addresses back to their funding sources in one call, sharing work between them. Funding chains converge, so this is much cheaper than calling find_funding_source per address. Each walk stops at a funder that paid more than 50 distinct addresses, like find_funding_source, and a chain is counted toward shared funders only up to the first funder that is itself a subject. Reports shared funders with each one's fan-out and flow shape, so a real common origin is distinguishable from an exchange everyone withdrew from; addresses paid by a single transaction, weighed against how many that transaction paid in total (two of two is bespoke, two of twenty is a batch an unrelated address can land in); any subject that funded another subject directly, plus every later payment one subject signed to another (subject_paid_subject, checked pair by pair for up to 20 subjects); and clusters of fundings that landed within a minute of each other, which is what separates scripted setup from coincidence. Draw a control with sample_control_addresses and run this over it before treating any rate as meaningful.",
    {
      addresses: addressListArg()
        .min(1)
        .max(100)
        .describe("Addresses to attribute (1-100)."),
      max_hops: numArg()
        .int()
        .positive()
        .max(12)
        .optional()
        .describe("Max hops per address (default 5, max 12)."),
      depth: z
        .enum(["first_hop", "full"])
        .optional()
        .describe(
          "'first_hop' walks one hop per address — usually the informative one, since deep chains dead-end in early distribution wallets. 'full' walks to max_hops (default).",
        ),
      measure_fanout: boolArg()
        .optional()
        .describe("Measure fan-out for funders shared by 2+ addresses (default true)."),
    },
    async ({ addresses, max_hops, depth, measure_fanout }) => {
      try {
        const maxHops = depth === "first_hop" ? 1 : Math.min(max_hops ?? 5, 12);
        const ctx: WalkContext = {
          steps: new Map(),
          popularity: new Map(),
          budget: new Budget(BATCH_POPULARITY_BUDGET),
        };
        const results: Array<{
          address: string;
          origin: string;
          hops: number;
          stop_reason: string;
          first_funder: string | null;
          chain: ChainStep[];
        }> = [];

        // Sequential on purpose: the memo only pays off if earlier walks have
        // finished populating it before later ones start.
        for (const addr of addresses) {
          const { chain, origin, stopReason, dustSkipped, sponsoredBy, incompleteReads } = await walkFunding(
            addr,
            maxHops,
            ctx,
          );
          results.push({
            address: addr,
            origin,
            hops: chain.length,
            stop_reason: stopReason,
            first_funder: chain[0]?.funded_by ?? null,
            ...(dustSkipped.length ? { dust_skipped: dustSkipped } : {}),
            ...(sponsoredBy.length ? { sponsored_by: sponsoredBy } : {}),
            ...(incompleteReads.length ? { incomplete_balance_changes: incompleteReads } : {}),
            chain,
          });
        }

        // Shared funders are the whole point of batching: they're what a
        // per-address call can't see.
        //
        // A chain is counted only up to the first funder that is itself a
        // subject. Everything past it is that subject's own ancestry, already
        // counted under its own result, and counting it again turns one chain
        // into "shared funding" of two addresses. The link itself is reported
        // in subject_funded_subject. Walks also stop at a service-scale funder,
        // so nothing reached through a hub is counted either.
        const subjectSet = new Set(addresses);
        const byFunder = new Map<string, string[]>();
        for (const r of results) {
          for (const step of r.chain) {
            if (step.funded_by === "unknown") continue;
            const list = byFunder.get(step.funded_by) ?? [];
            if (!list.includes(r.address)) list.push(r.address);
            byFunder.set(step.funded_by, list);
            if (step.funded_by !== r.address && subjectSet.has(step.funded_by)) break;
          }
        }
        const shared = [...byFunder.entries()]
          .filter(([, addrs]) => addrs.length > 1)
          .sort((a, b) => b[1].length - a[1].length);

        // Fan-out only for shared funders, and with a smaller budget than the
        // standalone tool: this runs once per shared funder inside a batch that
        // may already have made a hundred queries.
        const fanouts: Record<string, FanoutResult> = {};
        if (measure_fanout !== false) {
          for (const [funder] of shared.slice(0, 10)) {
            try {
              fanouts[funder] = await measureFanout(funder, 300);
            } catch {
              // Fan-out is context, not the answer — a failure here must not
              // discard a batch of completed traces.
            }
          }
        }
        const popularityOf: Record<string, FunderPopularity> = {};
        for (const [funder] of shared) {
          const p = ctx.popularity.get(funder);
          if (p) popularityOf[funder] = await p;
        }

        // Same funder is weak; same *transaction* is not. One PTB paying
        // several addresses is a single signed action whose author held every
        // recipient in mind at once, so this is reported separately rather than
        // folded into shared_funders — otherwise the weaker claim borrows the
        // stronger one's confidence.
        const allSteps = results.flatMap((r) => r.chain);
        const coFunded = detectCoFunding(allSteps, addresses);

        // Weigh each group against how many addresses its transaction actually
        // paid. The recipient-count lookup is capped, because this runs after a
        // batch that may already have made a hundred queries — but the cap is
        // on the *lookups*, not on what gets reported.
        //
        // Reporting only the first 10 was actively backwards. detectCoFunding
        // sorts widest-payout-first, and a wide payout is the weak signal — a
        // transaction paying nineteen addresses, two of which are yours, is a
        // batch distribution. The decisive case is the narrow one, a payment to
        // exactly the two addresses under investigation, and that sorts last.
        // So the truncation dropped the strongest evidence and kept the
        // weakest, silently.
        const RECIPIENT_LOOKUP_CAP = 10;
        const assessed = [];
        for (const g of coFunded.slice(0, RECIPIENT_LOOKUP_CAP)) {
          const total = await countTxRecipients(g.funding_tx);
          const matched = g.addresses.filter((a) => subjectSet.has(a)).length;
          assessed.push({
            ...g,
            transaction_recipient_count: total,
            ...assessCoFunding(matched, total),
          });
        }

        // Every group is reported. The ones past the lookup cap carry no
        // payout size — that is the measurement we declined to spend a query
        // on — but they are still evidence, and dropping them entirely removed
        // the narrow payouts that matter most.
        const reportedCoFunding = [
          ...assessed,
          ...coFunded.slice(RECIPIENT_LOOKUP_CAP).map((g) => ({
            ...g,
            transaction_recipient_count: null,
            strength: "unmeasured" as const,
            why: "Payout size not measured (per-call lookup cap). Weigh this group yourself: a payment to only the addresses under investigation is close to decisive, a wide batch distribution is not.",
          })),
        ];

        // One subject funding another needs no denominator to interpret: the
        // money went straight from one address under investigation to another,
        // so there is no base rate it could be confused with. Easy to miss by
        // eye, since the funder sits rows away in the input list.
        const subjectLinks = detectSubjectLinks(allSteps, addresses);

        // Every payment between subjects, not only first fundings. A later
        // payment is as chain-derived as a first one, and the walk never sees
        // it: it reads one inflow per address.
        const subjectPayments: SubjectPayment[] = [];
        let paymentScope: Record<string, unknown> | null = null;
        if (addresses.length > 1 && addresses.length <= MAX_PAIRWISE_SUBJECTS) {
          try {
            const scan = await findSubjectPayments(addresses);
            subjectPayments.push(...scan.payments);
            paymentScope = {
              method: "every ordered pair of subjects",
              pairs_checked: scan.pairs_checked,
              ...(scan.incomplete_pairs.length ? { incomplete_pairs: scan.incomplete_pairs } : {}),
              ...(scan.invalid.length ? { invalid_addresses: scan.invalid } : {}),
            };
          } catch (err) {
            // Context beside the walks, not the answer: a failure here must
            // not discard a batch of completed traces, and must not read as
            // "no payments".
            paymentScope = {
              method: "every ordered pair of subjects",
              error: `Not checked: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        } else if (addresses.length > MAX_PAIRWISE_SUBJECTS) {
          for (const payee of addresses) {
            const { txs } = await fundingStep(payee, ctx);
            for (const tx of txs) {
              if (!tx.sender || tx.sender === payee || !subjectSet.has(tx.sender)) continue;
              const payment = paymentInTx(tx.sender, payee, tx.digest, tx.timestamp, tx.changes);
              if (payment) subjectPayments.push(payment);
            }
          }
          paymentScope = {
            method: `each subject's earliest ${EARLIEST_TXS} transactions`,
            note: `More than ${MAX_PAIRWISE_SUBJECTS} subjects, so pairs were not queried one by one and later payments are not covered. Split the batch to check every pair.`,
          };
        }
        const firstFundingKeys = new Set(subjectLinks.map((l) => `${l.funder}>${l.funded}>${l.funding_tx}`));

        // Timing survives where co-funding does not. A wide payout says little,
        // but addresses funded seconds apart did not get there independently —
        // people do not coordinate to the second, scripts do.
        const bursts = detectFundingBursts(allSteps);

        const addrSet = new Set<string>();
        for (const r of results) for (const s of r.chain) { addrSet.add(s.address); addrSet.add(s.funded_by); }
        const batchIds = await describeAddresses([...addrSet], { expandMembers: true });
        const nameMap = new Map(
          [...batchIds].filter(([, v]) => v.name).map(([k, v]) => [k, v.name!]),
        );
        // Origins that are not wallets, called out once for the whole batch —
        // the case a reader is most likely to misread as "this person funded
        // them".
        // Addresses carrying names they no longer resolve to. Surfaced for the
        // whole batch, since a lapsed alias is the attribution most easily lost.
        // A name another address sent and the holder never touched is listed
        // apart: holding a transferable NFT says nothing about who the holder is.
        const formerNames: Array<{
          address: string;
          current_name?: string;
          expired_names: string[];
          expired_names_provenance_unread?: string[];
        }> = [];
        const receivedNames: Array<{
          address: string;
          name: string;
          expired: boolean;
          received_from?: string;
          received_in?: string;
          received_at?: string;
        }> = [];
        for (const v of batchIds.values()) {
          const held = classifyHeldNames(v);
          if (held.expired_own.length || held.expired_unread.length) {
            formerNames.push({
              address: v.address,
              ...(v.name ? { current_name: v.name } : {}),
              expired_names: held.expired_own.map((n) => n.name),
              ...(held.expired_unread.length
                ? { expired_names_provenance_unread: held.expired_unread.map((n) => n.name) }
                : {}),
            });
          }
          for (const n of held.received) {
            receivedNames.push({
              address: v.address,
              name: n.name,
              expired: n.expired,
              ...(n.received_from ? { received_from: n.received_from } : {}),
              ...(n.last_tx ? { received_in: n.last_tx } : {}),
              ...(n.last_tx_at ? { received_at: n.last_tx_at } : {}),
            });
          }
        }
        const nonWalletOrigins = [...batchIds.values()]
          .filter((v) => v.kind !== "wallet")
          .map((v) => ({
            address: v.address,
            kind: v.kind,
            ...(v.protocol ? { protocol: v.protocol } : {}),
            ...(v.object_type ? { object_type: v.object_type } : {}),
          }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  address_count: addresses.length,
                  depth: depth ?? "full",
                  ...(formerNames.length
                    ? {
                        expired_suins_names: formerNames,
                        expired_names_note:
                          "These addresses hold SuiNS registrations that have EXPIRED and that they registered or used themselves: each one's last transaction was sent by the holder. Reverse lookup no longer returns these names, so they will not appear anywhere else, and older records may refer to the address by them. Names under expired_names_provenance_unread had no readable last transaction, so whether the address registered them or was sent them is unknown.",
                      }
                    : {}),
                  ...(receivedNames.length
                    ? {
                        received_suins_names: receivedNames,
                        received_names_note:
                          "These registrations were sent to the address by another address (received_from, in received_in), and the holder has not transacted with them since. Anyone can send a SuiNS name to any address, so a received name is not attribution.",
                      }
                    : {}),
                  ...(nonWalletOrigins.length
                    ? {
                        non_wallet_addresses: nonWalletOrigins,
                        non_wallet_note:
                          "These addresses in the funding chains are packages or objects, not wallets. Value associated with a package is protocol activity, and a shared object may be a pool many parties touch — neither reads as a person who funded someone.",
                      }
                    : {}),
                  max_hops: maxHops,
                  addresses_resolved: results.filter((r) => r.hops > 0).length,
                  ...(coFunded.length
                    ? {
                        co_funding_group_count: coFunded.length,
                        ...(coFunded.length > RECIPIENT_LOOKUP_CAP
                          ? {
                              co_funding_note:
                                `${coFunded.length} co-funding groups were found; the payout size of the first ` +
                                `${RECIPIENT_LOOKUP_CAP} was measured and the rest are reported without it. ` +
                                "Groups are ordered widest-payout-first, so the unmeasured ones are the narrow " +
                                "payouts — the stronger signal, not the weaker.",
                            }
                          : {}),
                        co_funded_in_one_transaction: reportedCoFunding.map((g) => ({
                          ...g,
                          ...(nameMap.get(g.funder) ? { funder_name: nameMap.get(g.funder) } : {}),
                        })),
                        co_funding_note:
                          "These addresses were paid by a single transaction, not merely by the same funder over time. " +
                          "Read `strength` before concluding anything: a transaction paying only these addresses is " +
                          "near-decisive, while one paying twenty of which two are yours is a batch distribution that an " +
                          "unrelated address can land in by chance. `transaction_recipient_count` is the denominator.",
                      }
                    : {}),
                  ...(subjectLinks.length
                    ? {
                        subject_funded_subject: subjectLinks.map((l) => ({
                          ...l,
                          ...(nameMap.get(l.funder) ? { funder_name: nameMap.get(l.funder) } : {}),
                        })),
                        subject_link_note:
                          "One address under investigation funded another directly. Unlike shared ancestry this needs no " +
                          "control to interpret — there is no base rate for money moving straight from one subject to another.",
                      }
                    : {}),
                  ...(paymentScope
                    ? {
                        ...(subjectPayments.length
                          ? {
                              subject_paid_subject: subjectPayments.map((p) => ({
                                payer: p.payer,
                                payee: p.payee,
                                digest: p.digest,
                                timestamp: p.timestamp,
                                received: p.received.map((r) => formatAmount(r.amount, r.coinType)),
                                ...(firstFundingKeys.has(`${p.payer}>${p.payee}>${p.digest}`) ? { first_funding: true } : {}),
                                ...(p.balance_changes_incomplete ? { balance_changes_incomplete: true } : {}),
                              })),
                              subject_payment_note:
                                "Transactions one address under investigation signed that credited another, with the payee's net " +
                                "gain per coin. Every payment is listed, not only first fundings, which carry first_funding. Each " +
                                "digest shows the transfer. A one-way payment carries no clustering weight here or in build_wallet_edges.",
                            }
                          : {}),
                        subject_payment_scope: paymentScope,
                      }
                    : {}),
                  ...(bursts.length
                    ? {
                        funding_bursts: bursts,
                        burst_note:
                          "Addresses funded within " +
                          "60s of each other, tightest first. Timing is the discriminator that survives when co-funding " +
                          "does not: a wide payout proves little, but a set of wallets funded seconds apart did not arrive " +
                          "there independently. Check the span — sub-second spans are scripted, minutes are not conclusive. " +
                          "Ignore any entry with same_transaction true: that burst is a single payment, already reported " +
                          "under co_funded_in_one_transaction, and counting it again would tally one fact as two.",
                      }
                    : {}),
                  shared_funders: shared.map(([funder, addrs]) => ({
                    funder,
                    ...(nameMap.get(funder) ? { name: nameMap.get(funder) } : {}),
                    ...(getLabel(funder) ? { label: getLabel(funder)!.label } : {}),
                    funded_count: addrs.length,
                    funded: addrs,
                    ...(popularityOf[funder] ? { funder_popularity: popularityOf[funder] } : {}),
                    // Shape, not just size. This is the tool that decides
                    // whether shared funding means anything, and count alone
                    // cannot: a custodial exchange and a sybil funder can have
                    // near-identical counterparty counts while one runs
                    // balanced and the other pays many and is paid by few.
                    ...(fanouts[funder] ? { fanout: fanoutView(fanouts[funder], popularityOf[funder]) } : {}),
                  })),
                  results,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    "find_funding_source",
    "(Incident investigation) Trace an address back to its funding source — the first transaction that funded the wallet and who sent it — then walk that funder's funding, and so on. Stops when it reaches a labeled entity (exchange/bridge/known wallet — see manage_labels), a funder that paid more than 50 distinct addresses (an exchange or service, by the same limit build_wallet_edges uses; ancestry beyond it carries no attribution), a wallet it has already seen, or a dead end. Each hop reports the funder's popularity. At a dead end, inflows skipped as dust are listed in dust_skipped, and parties that paid the address's gas are listed in sponsored_by, since a wallet paying gas from an address balance can run with no SUI inflow at all. Great for attribution: e.g. 'this attacker wallet was first funded by a Binance withdrawal'.",
    {
      address: addressArg().describe("Address to attribute (0x...)"),
      max_hops: numArg().int().positive().max(12).optional().describe("Max funding hops to walk back (default 5, max 12)"),
      measure_fanout: boolArg()
        .optional()
        .describe(
          "Measure the origin's fan-out so a hub can be told from a real link (default true).",
        ),
    },
    async ({ address, max_hops, measure_fanout }) => {
      try {
        const maxHops = Math.min(max_hops ?? 5, 12);
        const ctx: WalkContext = {
          steps: new Map(),
          popularity: new Map(),
          budget: new Budget(SINGLE_POPULARITY_BUDGET),
        };
        const { chain, origin, stopReason, dustSkipped, sponsoredBy, stoppedAtHub, incompleteReads } =
          await walkFunding(address, maxHops, ctx);
        const originPopularity = chain.at(-1)?.funder_popularity;

        // Fan-out on the origin, because the origin is what gets over-read.
        // A chain ending at an address with 29,000 recipients has not found a
        // link; it has found an exchange. A walk that stopped at a hub has
        // already measured that, and a bidirectional count over a short window
        // could call the same address narrow.
        let originFanout: FanoutResult | null = null;
        if (measure_fanout !== false && origin !== address && !stoppedAtHub) {
          try {
            originFanout = await measureFanout(origin, 300);
          } catch {
            // Context, not the answer — never fail the trace over it.
          }
        }

        // Resolve names + labels for everything in the chain.
        const addrs = new Set<string>();
        for (const s of chain) { addrs.add(s.address); addrs.add(s.funded_by); }
        // Name, label, and WHAT THE ADDRESS IS, in two batched calls. The kind
        // matters here more than anywhere: "funded by 0xabc" reads as a person,
        // and if 0xabc is a package or a shared object that reading is wrong.
        const identities = await describeAddresses([...addrs], { expandMembers: true });
        const labelFor = (a: string) => {
          const id = identities.get(a);
          const note = id ? identityNote(id) : undefined;
          return {
            address: a,
            ...(id?.name ? { name: id.name } : {}),
            ...(id?.label ? { label: id.label, category: id.label_category } : {}),
            ...(id?.label_provenance ? { label_provenance: id.label_provenance } : {}),
            ...(id && id.kind !== "wallet" ? { kind: id.kind } : {}),
            ...(id?.object_type ? { object_type: id.object_type } : {}),
            ...(id?.protocol ? { protocol: id.protocol } : {}),
            // Every held name, expired included, with its provenance. Reverse
            // lookup drops a name the moment it lapses, which is exactly when
            // an investigation still needs it.
            ...(id?.names_held?.length ? { names_held: id.names_held } : {}),
            ...(note ? { note } : {}),
          };
        };

        const originId = identities.get(origin);
        const subjectId = identities.get(address);
        const originLabel = getLabel(origin);
        const summaryParts = [
          `${address}${subjectId?.name ? ` (${subjectId.name})` : ""}`,
          `funded through ${chain.length} hop(s) back to`,
          `${origin}${originId?.name ? ` (${originId.name})` : ""}${originLabel ? ` — ${originLabel.label} [${originLabel.category}]` : ""}.`,
          // Said in the summary, not only in the chain entry. An origin that is
          // a package or shared object is the case a reader is most likely to
          // misread as "this person funded them".
          originId && originId.kind !== "wallet"
            ? `NOTE: the origin is a ${originId.kind}${originId.protocol ? ` (${originId.protocol})` : ""}, not a wallet.`
            : "",
          stopReason ? `Stopped: ${stopReason}.` : "",
        ];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  address,
                  origin: labelFor(origin),
                  hops: chain.length,
                  stop_reason: stopReason,
                  ...(dustSkipped.length ? { dust_skipped: dustSkipped } : {}),
                  ...(sponsoredBy.length
                    ? {
                        sponsored_by: sponsoredBy,
                        sponsored_by_note:
                          "No inflow qualified as funding, but another party paid gas for transactions this address sent. " +
                          "Gas can be paid from an address balance, so a wallet can operate with no SUI of its own; the " +
                          "sponsor is then the closest thing to a funder the chain records.",
                      }
                    : {}),
                  ...(incompleteReads.length ? { incomplete_balance_changes: incompleteReads } : {}),
                  ...(stoppedAtHub && originPopularity ? { origin_popularity: originPopularity } : {}),
                  ...(originFanout
                    ? {
                        origin_fanout: {
                          recipient_count: originFanout.recipient_count,
                          truncated: originFanout.truncated,
                          classification: originFanout.classification,
                          ...(originFanout.classification_provisional ? { classification_provisional: true } : {}),
                          interpretation: originFanout.interpretation,
                        },
                      }
                    : {}),
                  summary: summaryParts.join(" "),
                  chain: chain.map((s) => ({ ...s, address_label: labelFor(s.address), funder_label: labelFor(s.funded_by) })),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
