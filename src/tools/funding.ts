import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { batchResolveNames } from "../utils/names.js";
import { getLabel } from "../utils/labels.js";
import { decimalsForCoinType, symbolOf, toHumanAmount } from "../utils/valuation.js";
import { pickFundingTx, type FundingTx } from "../utils/funding.js";
import { measureFanout } from "../utils/fanout.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
    memo.set(address, pickFundingTx(await fetchEarliestTxs(address), address));
  }
  return memo.get(address)!;
}

/** Walk one address back through funding hops. Shared by both funding tools. */
async function walkFunding(address: string, maxHops: number, memo: FundingMemo) {
  const chain: ChainStep[] = [];
  const visited = new Set<string>([address]);
  let current = address;
  let origin = address;
  let stopReason = "reached a dead end (no earlier funding found)";

  for (let i = 0; i < maxHops; i++) {
    const funding = await fundingStep(current, memo);
    if (!funding) break;

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

  return { chain, origin, stopReason };
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
    "(Incident investigation) Trace many addresses back to their funding sources in one call, sharing work between them. Funding chains converge, so this is much cheaper than calling find_funding_source per address. Reports which funders are shared across the batch and measures each shared funder's fan-out, so you can tell a real common origin from an exchange everyone happens to have withdrawn from.",
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
          const { chain, origin, stopReason } = await walkFunding(addr, maxHops, memo);
          results.push({
            address: addr,
            origin,
            hops: chain.length,
            stop_reason: stopReason,
            first_funder: chain[0]?.funded_by ?? null,
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
        const { chain, origin, stopReason } = await walkFunding(address, maxHops, new Map());

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
