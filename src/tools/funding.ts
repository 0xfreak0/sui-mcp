import { z } from "zod";
import { gqlQuery } from "../clients/graphql.js";
import { errorResult } from "../utils/errors.js";
import { batchResolveNames } from "../utils/names.js";
import { getLabel } from "../utils/labels.js";
import { decimalsForCoinType, symbolOf, toHumanAmount } from "../utils/valuation.js";
import { pickFundingTx, type FundingTx } from "../utils/funding.js";
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

export function registerFundingTools(server: McpServer) {
  server.tool(
    "find_funding_source",
    "(Incident investigation) Trace an address back to its funding source — the first transaction that funded the wallet and who sent it — then walk that funder's funding, and so on. Stops when it reaches a labeled entity (exchange/bridge/known wallet — see manage_labels), a wallet it has already seen, or a dead end. Great for attribution: e.g. 'this attacker wallet was first funded by a Binance withdrawal'.",
    {
      address: z.string().describe("Address to attribute (0x...)"),
      max_hops: z.number().int().positive().optional().describe("Max funding hops to walk back (default 5, max 12)"),
    },
    async ({ address, max_hops }) => {
      try {
        const maxHops = Math.min(max_hops ?? 5, 12);
        const chain: ChainStep[] = [];
        const visited = new Set<string>([address]);
        let current = address;
        let origin = address;
        let stopReason = "reached a dead end (no earlier funding found)";

        for (let i = 0; i < maxHops; i++) {
          const txs = await fetchEarliestTxs(current);
          const funding = pickFundingTx(txs, current);
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
