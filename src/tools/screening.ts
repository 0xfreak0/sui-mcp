/**
 * Screening tools: exchange deposit-address detection and exposure screening.
 *
 * Both lean on the disclosed label set (src/data/disclosed-labels.json), and
 * both report the provenance of every label they use, so a reader can tell a
 * proof-of-reserves listing from a post-mortem from an investigator's own tag.
 */

import { z } from "zod";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { numArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import { classifyDepositAddress } from "../utils/deposit.js";
import { getLabel, labelProvenance } from "../utils/labels.js";
import { hitsFor, screenAddress, screeningCoverage, type Direction } from "../utils/screening.js";
import { namespaceOf, parseAccountId, currentSuiChain } from "../utils/chain-id.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const SCREEN_CAVEATS = [
  "Labels cover only first-party disclosures (see coverage.labels): four exchanges' proof-of-reserves lists, four bridges' deployment docs, and attackers named in two victim post-mortems. An address with no exposure here may still be exposed to anything those lists do not name.",
  "Each address is read over a window of its most recent transactions (see windows); older activity is not screened when a window is truncated.",
  "Indirect hops expand only the highest-value counterparties of each hop (max_expand); unexpanded_counterparties says how many were not followed.",
  "Paths respect time order: an outgoing hop must happen after the previous one, an incoming hop before it. Leg amounts are what each leg moved, not the share of the subject's funds that reached the end of the path.",
  "Bridge exits are detected from curated Move-call and event markers. Destinations are read from the exit's own events (chain-derived) for every bridge that writes one on Sui, up to 10 exit transactions, and screened. A Wormhole message whose payload this server cannot attribute, a non-OFT LayerZero message and a Meson swap are reported without a destination; run resolve_bridge_transfer on them.",
  "Exposure is not a risk verdict. An exchange or bridge counterparty is ordinary; an exploiter or sanctioned counterparty is a lead to examine, with the path and digests to do it.",
];

export function registerScreeningTools(server: McpServer) {
  server.tool(
    "classify_deposit_address",
    "(Incident investigation) Decide whether an address is an exchange DEPOSIT address, the per-customer address an exchange sweeps into its hot wallet and the identifier a subpoena names. Verdict likely|no|unknown, tier heuristic, from three checks: every outflow is a full-balance sweep to one destination; the sweeps' gas is paid by a relayer-shaped sponsor; the destination is a labelled exchange wallet (with its source_url) or hub-shaped. Returns the hot wallet, exchange label and provenance, sweep sponsor, sweep digests and a deposits sample. About 1 request plus up to ~12 to measure the sponsor and an unlabelled destination.",
    {
      address: z.string().describe("Candidate deposit address (0x...)."),
      max_transactions: numArg()
        .int()
        .min(5)
        .max(50)
        .optional()
        .describe("Most recent transactions to read (default 50)."),
    },
    async ({ address, max_transactions }) => {
      if (!isValidSuiAddress(normalizeSuiAddress(address))) return errorResult(`Not a Sui address: ${address}`);
      try {
        const result = await classifyDepositAddress(address, { last: max_transactions ?? 50 });
        return json({
          ...result,
          interpretation:
            result.verdict === "likely"
              ? `This behaves like a customer deposit address${result.exchange?.entity ? ` at ${result.exchange.entity}` : ""}: incoming funds are swept whole into ${result.hot_wallet}. The exchange can name the account holder for this address.`
              : result.verdict === "no"
                ? "This address does not behave like an exchange deposit address; see reasons."
                : "Not enough evidence either way; see reasons for which check is open.",
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    "screen_address",
    "(Incident investigation) Screen an address for direct and indirect exposure (default 2 hops, both directions) to labelled malicious, sanctioned, exchange, bridge and mixer accounts. Every exposure carries the path, per-leg digests and amounts, and the label's entity, evidence kind and source_url. Bridge exits are screened too: the beneficiaries resolve_bridge_transfer reads from chain data (CCTP, Sui Bridge, Wormhole, Mayan, LayerZero OFT, Axelar, Allbridge, Celer) are matched against the labels and OFAC's SDN digital currency list. States its coverage: which label sources exist, that OFAC lists no Sui addresses, and how much of each address's history was read. About 10-40 requests. A CAIP-10 account on another chain gets a direct label and sanctions lookup only.",
    {
      address: z.string().describe("Sui address (0x...) or CAIP-10 account (e.g. 'eip155:1:0x...')."),
      hops: numArg().int().min(1).max(3).optional().describe("How far to follow counterparties (default 2)."),
      direction: z
        .enum(["both", "in", "out"])
        .optional()
        .describe("'out' = where this address's funds went, 'in' = where they came from (default both)."),
      max_transactions: numArg()
        .int()
        .min(10)
        .max(300)
        .optional()
        .describe("Most recent transactions read for the subject (default 100). Expanded counterparties get 50."),
      max_expand: numArg()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Counterparties expanded per hop, highest value first (default 8)."),
    },
    async ({ address, hops, direction, max_transactions, max_expand }) => {
      let account;
      try {
        account = parseAccountId(address, currentSuiChain());
      } catch (err) {
        return errorResult((err as Error).message);
      }
      const accountId = `${account.chain}:${account.address}`;
      const subjectLabel = getLabel(accountId);
      const subject = {
        account: accountId,
        ...(subjectLabel
          ? { label: { label: subjectLabel.label, category: subjectLabel.category, source: subjectLabel.source, ...labelProvenance(subjectLabel) } }
          : {}),
        direct_hits: hitsFor(accountId),
      };
      const coverage = screeningCoverage();

      if (namespaceOf(account.chain) !== "sui") {
        return json({
          subject,
          exposures: [],
          coverage,
          note: "Not a Sui account, so only the label and sanctions lookups ran. This server cannot read transactions on that chain.",
        });
      }

      try {
        const directions: Direction[] = direction === "in" ? ["in"] : direction === "out" ? ["out"] : ["out", "in"];
        const result = await screenAddress(account.address, {
          hops: hops ?? 2,
          directions,
          subjectTransactions: max_transactions ?? 100,
          hopTransactions: 50,
          maxExpand: max_expand ?? 8,
          maxBridgeLookups: 10,
        });
        const byCategory: Record<string, number> = {};
        for (const e of result.exposures) byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
        const summary = [
          subjectLabel ? `The address itself is labelled ${subjectLabel.label} [${subjectLabel.category}]${subjectLabel.evidence ? ` (${subjectLabel.evidence})` : ""}.` : "",
          result.exposures.length === 0
            ? "No exposure to a labelled or sanctioned account within the screened window."
            : `${result.exposures.length} exposure(s): ${Object.entries(byCategory).map(([c, n]) => `${n} ${c}`).join(", ")}.`,
        ].filter(Boolean).join(" ");
        return json({
          subject,
          summary,
          exposures_by_category: byCategory,
          exposures: result.exposures,
          windows: result.windows,
          unexpanded_counterparties: result.unexpanded_counterparties,
          bridge_exits_seen: result.bridge_exits_seen,
          bridge_exits_with_destination_read: result.bridge_exits_with_destination_read,
          tier: "Paths and bridge destinations are chain-derived; each label's evidence field says what it rests on.",
          coverage,
          caveats: SCREEN_CAVEATS,
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
