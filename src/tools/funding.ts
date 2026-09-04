import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { batchResolveNames } from "../utils/names.js";
import { getLabel } from "../utils/labels.js";
import { decimalsForCoinType, symbolOf, toHumanAmount, usdValue } from "../utils/valuation.js";
import { pickFundingTx, type FundingTx } from "../utils/funding.js";
import { pricesForRanking } from "../utils/price-providers.js";
import { measureFanout } from "../utils/fanout.js";
import { assessCoFunding, detectCoFunding } from "../utils/co-funding.js";
import { detectFundingBursts, detectSubjectLinks } from "../utils/funding-signals.js";
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
    balanceChanges { nodes { amount owner { address } } }
  }
}`;

interface TxRecipientsResult {
  transactionEffects: {
    balanceChanges: { nodes: Array<{ amount?: string; owner?: { address: string } }> };
  } | null;
}

/** Null when the transaction could not be read — never a default that reads as measured. */
async function countTxRecipients(digest: string): Promise<number | null> {
  try {
    const r = await gqlQuery<TxRecipientsResult>(TX_RECIPIENTS_QUERY, { digest });
    const nodes = r.transactionEffects?.balanceChanges?.nodes;
    if (!nodes) return null;
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

const FUNDING_QUERY = `query ($addr: SuiAddress!, $first: Int!) {
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

interface FundingQueryResult {
  transactions: {
    nodes: Array<{
      digest: string;
      sender: { address: string } | null;
      effects: {
        timestamp: string | null;
        checkpoint: { sequenceNumber: number } | null;
        balanceChanges: { nodes: Array<{ coinType?: { repr: string }; amount?: string; owner?: { address: string } }> };
      } | null;
    }>;
  };
}

/** Fetch an address's earliest transactions (oldest first) as FundingTx records. */
async function fetchEarliestTxs(address: string, first = 12): Promise<FundingTx[]> {
  const data = await gqlQuery<FundingQueryResult>(FUNDING_QUERY, { addr: address, first });
  return data.transactions.nodes.map((n) => ({
    digest: n.digest,
    sender: n.sender?.address ?? null,
    timestamp: n.effects?.timestamp ?? null,
    checkpoint: n.effects?.checkpoint?.sequenceNumber?.toString() ?? null,
    changes: (n.effects?.balanceChanges.nodes ?? [])
      .filter((c) => c.owner?.address && c.amount && c.coinType?.repr)
      .map((c) => ({ address: c.owner!.address, amount: c.amount!, coinType: c.coinType!.repr })),
  }));
}

function formatAmount(rawAmount: string, coinType: string): string {
  const sym = symbolOf(coinType);
  const human = toHumanAmount(rawAmount, decimalsForCoinType(coinType));
  return `${human} ${sym}`;
}

interface ChainStep {
  hop: number;
  address: string;
  funded_by: string;
  funding_tx: string;
  timestamp: string | null;
  amount: string;
}

/**
 * One hop of the walk, memoized.
 *
 * Funding chains converge hard — in a ten-wallet sample, eight reached the same
 * three ancestors — so without a shared cache a batch re-derives the same tail
 * once per input address. The cache is per-call rather than process-wide: chain
 * state is cheap to rebuild and a long-lived cache would go stale against a
 * chain that keeps moving.
 */
type FundingMemo = Map<string, ReturnType<typeof pickFundingTx>>;

async function fundingStep(address: string, memo: FundingMemo) {
  if (!memo.has(address)) {
    const txs = await fetchEarliestTxs(address);
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
    memo.set(address, pickFundingTx(txs, address, { valueUsd }));
  }
  return memo.get(address)!;
}

/** Walk one address back through funding hops. Shared by both funding tools. */
async function walkFunding(address: string, maxHops: number, memo: FundingMemo) {
  const chain: ChainStep[] = [];
  // Inflows rejected as dust along the way. Reported rather than dropped: an
  // investigator needs to see that a 1-MIST send was skipped, both to trust
  // the answer and to lower the floor deliberately if the case calls for it.
  const dustSkipped: Array<Record<string, unknown>> = [];
  const visited = new Set<string>([address]);
  let current = address;
  let origin = address;
  let stopReason = "reached a dead end (no earlier funding found)";

  for (let i = 0; i < maxHops; i++) {
    const funding = await fundingStep(current, memo);
    if (!funding) break;
    for (const d of funding.dustSkipped ?? []) {
      dustSkipped.push({ address: current, ...d, amount: formatAmount(d.amount, d.coinType) });
    }

    chain.push({
      hop: i + 1,
      address: current,
      funded_by: funding.funder,
      funding_tx: funding.digest,
      timestamp: funding.timestamp,
      amount: formatAmount(funding.amount, funding.coinType),
    });

    const funder = funding.funder;
    origin = funder;

    if (funder === "unknown") { stopReason = "funder could not be determined"; break; }
    if (getLabel(funder)) { stopReason = `reached a labeled entity (${getLabel(funder)!.label})`; break; }
    if (visited.has(funder)) { stopReason = "reached an already-seen wallet (cycle)"; break; }
    visited.add(funder);
    current = funder;

    if (i === maxHops - 1) stopReason = `hit max_hops (${maxHops})`;
  }

  return { chain, origin, stopReason, dustSkipped };
}

export function registerFundingTools(server: McpServer) {
  server.tool(
    "get_address_fanout",
    "(Incident investigation) Measure how many distinct addresses an address transacts with, in BOTH directions, over its most recent activity. Use this before concluding anything from shared funding: several wallets tracing back to one funder is only meaningful if that funder is narrow. An exchange hot wallet pays tens of thousands of addresses, so common ancestry through it means nothing. Returns recipient_count, sender_count and counterparty_count, plus out_in_ratio and flow_shape — shape separates cases size cannot, since a custodial exchange and a sybil funder can have near-identical counterparty counts while one runs balanced and the other pays many and is paid by few.",
    {
      address: z.string().describe("Address to measure (0x...)"),
      max_transactions: z
        .number()
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

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...result,
                  ...(existing ? { existing_label: existing } : {}),
                  ...(suggestion ?? {}),
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
    "(Incident investigation) Trace many addresses back to their funding sources in one call, sharing work between them. Funding chains converge, so this is much cheaper than calling find_funding_source per address. Reports shared funders with each one's fan-out and flow shape, so a real common origin is distinguishable from an exchange everyone withdrew from; addresses paid by a single transaction, weighed against how many that transaction paid in total (two of two is bespoke, two of twenty is a batch an unrelated address can land in); any subject that funded another subject directly; and clusters of fundings that landed within a minute of each other, which is what separates scripted setup from coincidence. Draw a control with sample_control_addresses and run this over it before treating any rate as meaningful.",
    {
      addresses: z
        .array(z.string())
        .min(1)
        .max(100)
        .describe("Addresses to attribute (1-100)."),
      max_hops: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max hops per address (default 3, max 12)."),
      depth: z
        .enum(["first_hop", "full"])
        .optional()
        .describe(
          "'first_hop' walks one hop per address — usually the informative one, since deep chains dead-end in early distribution wallets. 'full' walks to max_hops (default).",
        ),
      measure_fanout: z
        .boolean()
        .optional()
        .describe("Measure fan-out for funders shared by 2+ addresses (default true)."),
    },
    async ({ addresses, max_hops, depth, measure_fanout }) => {
      try {
        const maxHops = depth === "first_hop" ? 1 : Math.min(max_hops ?? 3, 12);
        const memo: FundingMemo = new Map();
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
          const { chain, origin, stopReason, dustSkipped } = await walkFunding(addr, maxHops, memo);
          results.push({
            address: addr,
            origin,
            hops: chain.length,
            stop_reason: stopReason,
            first_funder: chain[0]?.funded_by ?? null,
            ...(dustSkipped.length ? { dust_skipped: dustSkipped } : {}),
            chain,
          });
        }

        // Shared funders are the whole point of batching: they're what a
        // per-address call can't see.
        const byFunder = new Map<string, string[]>();
        for (const r of results) {
          for (const step of r.chain) {
            if (step.funded_by === "unknown") continue;
            const list = byFunder.get(step.funded_by) ?? [];
            if (!list.includes(r.address)) list.push(r.address);
            byFunder.set(step.funded_by, list);
          }
        }
        const shared = [...byFunder.entries()]
          .filter(([, addrs]) => addrs.length > 1)
          .sort((a, b) => b[1].length - a[1].length);

        // Fan-out only for shared funders, and with a smaller budget than the
        // standalone tool: this runs once per shared funder inside a batch that
        // may already have made a hundred queries.
        const fanouts: Record<string, Awaited<ReturnType<typeof measureFanout>>> = {};
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
        const subjectSet = new Set(addresses);
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

        // Timing survives where co-funding does not. A wide payout says little,
        // but addresses funded seconds apart did not get there independently —
        // people do not coordinate to the second, scripts do.
        const bursts = detectFundingBursts(allSteps);

        const addrSet = new Set<string>();
        for (const r of results) for (const s of r.chain) { addrSet.add(s.address); addrSet.add(s.funded_by); }
        const nameMap = await batchResolveNames([...addrSet]);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  address_count: addresses.length,
                  depth: depth ?? "full",
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
                    ...(fanouts[funder]
                      ? {
                          // Shape, not just size. This is the tool that decides
                          // whether shared funding means anything, and count
                          // alone cannot: a custodial exchange and a sybil
                          // funder can have near-identical counterparty counts
                          // while one runs balanced and the other pays many and
                          // is paid by few. Surfacing only the count here left
                          // the caller to guess exactly where it matters most.
                          fanout: {
                            recipient_count: fanouts[funder].recipient_count,
                            sender_count: fanouts[funder].sender_count,
                            counterparty_count: fanouts[funder].counterparty_count,
                            coin_type_count: fanouts[funder].coin_type_count,
                            out_in_ratio: fanouts[funder].out_in_ratio,
                            flow_shape: fanouts[funder].flow_shape,
                            scanned_transactions: fanouts[funder].scanned_transactions,
                            truncated: fanouts[funder].truncated,
                            classification: fanouts[funder].classification,
                            interpretation: fanouts[funder].interpretation,
                          },
                        }
                      : {}),
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
    "(Incident investigation) Trace an address back to its funding source — the first transaction that funded the wallet and who sent it — then walk that funder's funding, and so on. Stops when it reaches a labeled entity (exchange/bridge/known wallet — see manage_labels), a wallet it has already seen, or a dead end. Great for attribution: e.g. 'this attacker wallet was first funded by a Binance withdrawal'.",
    {
      address: z.string().describe("Address to attribute (0x...)"),
      max_hops: z.number().int().positive().optional().describe("Max funding hops to walk back (default 5, max 12)"),
      measure_fanout: z
        .boolean()
        .optional()
        .describe(
          "Measure the origin's fan-out so a hub can be told from a real link (default true).",
        ),
    },
    async ({ address, max_hops, measure_fanout }) => {
      try {
        const maxHops = Math.min(max_hops ?? 5, 12);
        const { chain, origin, stopReason, dustSkipped } = await walkFunding(address, maxHops, new Map());

        // Fan-out on the origin, because the origin is what gets over-read.
        // A chain ending at an address with 29,000 recipients has not found a
        // link; it has found an exchange.
        let originFanout: Awaited<ReturnType<typeof measureFanout>> | null = null;
        if (measure_fanout !== false && origin !== address) {
          try {
            originFanout = await measureFanout(origin, 300);
          } catch {
            // Context, not the answer — never fail the trace over it.
          }
        }

        // Resolve names + labels for everything in the chain.
        const addrs = new Set<string>();
        for (const s of chain) { addrs.add(s.address); addrs.add(s.funded_by); }
        const nameMap = await batchResolveNames([...addrs]);
        const labelFor = (a: string) => {
          const label = getLabel(a);
          const name = nameMap.get(a);
          return { address: a, ...(name ? { name } : {}), ...(label ? { label: label.label, category: label.category } : {}) };
        };

        const originLabel = getLabel(origin);
        const originName = nameMap.get(origin);
        const summaryParts = [
          `${address}${nameMap.get(address) ? ` (${nameMap.get(address)})` : ""}`,
          `funded through ${chain.length} hop(s) back to`,
          `${origin}${originName ? ` (${originName})` : ""}${originLabel ? ` — ${originLabel.label} [${originLabel.category}]` : ""}.`,
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
                  ...(originFanout
                    ? {
                        origin_fanout: {
                          recipient_count: originFanout.recipient_count,
                          truncated: originFanout.truncated,
                          classification: originFanout.classification,
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
