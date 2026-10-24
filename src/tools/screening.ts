/**
 * Screening tools: exchange deposit-address detection and exposure screening.
 *
 * Both lean on the disclosed label set (src/data/disclosed-labels.json), and
 * both report the provenance of every label they use, so a reader can tell a
 * proof-of-reserves listing from a post-mortem from an investigator's own tag.
 */

import { z } from "zod";
import { addressArg, numArg, timePointArg } from "./args.js";
import { errorResult } from "../utils/errors.js";
import { classifyDepositAddress } from "../utils/deposit.js";
import { getLabel, labelProvenance } from "../utils/labels.js";
import { hitsFor, screenAddress, screeningCoverage, type Direction } from "../utils/screening.js";
import { namespaceOf, parseAccountId, currentSuiChain } from "../utils/chain-id.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { capPayload } from "../utils/output-cap.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

const SCREEN_CAVEATS = [
  "Labels cover only first-party disclosures (see coverage.labels): four exchanges' proof-of-reserves lists, four bridges' deployment docs, and attackers named in two victim post-mortems. An address with no exposure here may still be exposed to anything those lists do not name.",
  "Each address is read over a window of its most recent transactions (see windows); older activity is not screened when a window is truncated.",
  "Indirect hops expand only the highest-value counterparties of each hop (max_expand); unexpanded_counterparties says how many were not followed.",
  "Paths respect time order: an outgoing hop must happen after the previous one, an incoming hop before it. Leg amounts are what each leg moved, not the share of the subject's funds that reached the end of the path.",
 "Bridge exits are detected from curated Move-call and event markers, one per transaction under the protocol that carried it. Destinations are read from exit events up to max_bridge_lookups and screened. bridge_destinations_unread names exits not read, with calls for the remaining transactions.",
  "Exposure is not a risk verdict. An exchange or bridge counterparty is ordinary; an exploiter or sanctioned counterparty is a lead to examine, with the path and digests to do it.",
];

export function registerScreeningTools(server: McpServer) {
  server.tool(
    "classify_deposit_address",
    "(Incident investigation) Classify exchange deposit behaviour over a chosen window. The heuristic verdict covers only transactions read; window states bounds, coverage and continuation. Historical sweep balances are reconstructed with a separate budget. No outflows means unknown, not clearance. Session verdicts are shared with identification, flows and label lookup without adding trace sinks.",
    {
      address: addressArg().describe("Candidate deposit address (0x...)."),
      from: timePointArg().optional().describe("Window start: ISO 8601 time (inclusive) or checkpoint (exclusive)."),
      to: timePointArg().optional().describe("Window end: ISO 8601 time (inclusive), 'now', or checkpoint (exclusive)."),
      max_transactions: numArg()
        .int()
        .min(5)
        .max(5000)
        .optional()
        .describe("Newest transactions to read within the window (default 50)."),
   max_balance_transactions: numArg().int().min(50).max(100000).optional()
        .describe("Later transactions to undo for historical sweep balances (default 1000). An incomplete reconstruction withholds that check."),
   max_balance_reads: numArg().int().min(1).max(2000).optional()
    .describe("Historical balance reconstruction pages (default 200, up to 50 transactions each); raise with max_balance_transactions for a busy wallet."),
      detail: z.enum(["summary", "full"]).optional().describe("Summary caps evidence lists with omissions; full returns every scanned sweep, deposit and other outflow."),
    },
  async ({ address, from, to, max_transactions, max_balance_transactions, max_balance_reads, detail }) => {
      try {
        const result = await classifyDepositAddress(address, {
     last: max_transactions ?? 50, from, to, maxBalanceTransactions: max_balance_transactions, maxBalanceReads: max_balance_reads,
        });
        const { payload } = capPayload("classify_deposit_address",
     { address, from, to, max_transactions, max_balance_transactions, max_balance_reads },
          {
          ...result,
          interpretation:
            result.verdict === "likely"
              ? `In the transactions read, this behaves like a customer deposit address${result.exchange?.entity ? ` at ${result.exchange.entity}` : ""}: incoming funds are swept whole into ${result.hot_wallet}. This is a heuristic lead for asking the exchange about the account, not proof of ownership. See window for the period actually read.`
              : result.verdict === "no"
                ? "The outflows in this window do not fit an exchange deposit address; see reasons."
                : "Not enough evidence in the transactions read; see window, reasons and checks_not_run. Older sweeps outside this window may give a different answer.",
          },
          { sweeps: { budget: 12000 }, deposits: { budget: 6000 }, other_outflows: { budget: 4000 } },
          { full: detail === "full", next_call: { tool: "classify_deposit_address", repeat_with: { detail: "full" } } },
        );
        return json(payload);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.tool(
    "screen_address",
    "(Incident investigation) Screen direct and indirect exposure to labelled malicious, sanctioned, exchange, bridge and mixer accounts, by default two hops in both directions. Exposures include paths, per-leg digests and amounts, and label provenance. Screens chain-derived bridge beneficiaries against labels and OFAC's SDN list for CCTP, Sui Bridge, Wormhole, Mayan, LayerZero OFT, Axelar, Allbridge and Celer. Each exit counts once under its carrying protocol, with settlement bridges and other exits listed separately. Coverage names label sources and history read, and notes that OFAC lists no Sui addresses. windows[].incomplete_transactions names unread balances; their paths are withheld and affected bridge sent amounts are null. Reads up to 300 recent subject transactions each way by default, typically costing 15–60 requests. A non-Sui CAIP-10 account receives only direct label and sanctions lookups.",
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
        .describe(
          "Recent subject transactions per direction (default/max 300); expanded counterparties get 50.",
        ),
      max_expand: numArg()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Counterparties expanded per hop, highest value first (default 8)."),
   max_bridge_lookups: numArg()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe("Exit transactions whose on-chain destinations are read (default 10, max 300). Unread exits leave bridge screening incomplete."),
   digest_offset: numArg().int().min(0).optional().describe("First digest shown for each exposure or path leg (five per page); follow digest_listing.next_call."),
    },
  async ({ address, hops, direction, max_transactions, max_expand, max_bridge_lookups, digest_offset }) => {
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
          subjectTransactions: max_transactions ?? 300,
          hopTransactions: 50,
          maxExpand: max_expand ?? 8,
     maxBridgeLookups: max_bridge_lookups ?? 10,
     digestOffset: digest_offset,
        });
        const byCategory: Record<string, number> = {};
        for (const e of result.exposures) byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
        const incomplete = result.windows.some((w) => w.incomplete_transactions.length > 0);
    const bridgeDestinationsIncomplete = result.bridge_exits_with_destination_read < result.bridge_exits_seen;
        const summary = [
          subjectLabel ? `The address itself is labelled ${subjectLabel.label} [${subjectLabel.category}]${subjectLabel.evidence ? ` (${subjectLabel.evidence})` : ""}.` : "",
          result.exposures.length === 0
            ? incomplete
              ? "No exposure found in the fully read transactions; screening is incomplete (see windows.incomplete_transactions)."
       : bridgeDestinationsIncomplete
        ? "No exposure found in the transactions read; bridge destinations were not all screened (see bridge_destinations_incomplete)."
              : "No exposure to a labelled or sanctioned account within the screened window."
            : `${result.exposures.length} exposure(s): ${Object.entries(byCategory).map(([c, n]) => `${n} ${c}`).join(", ")}.`,
          incomplete && result.exposures.length > 0 ? "Screening is incomplete (see windows.incomplete_transactions)." : "",
     bridgeDestinationsIncomplete ? `${result.bridge_exits_seen - result.bridge_exits_with_destination_read} bridge exit destination(s) were not read; sanctions screening is incomplete.` : "",
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
     ...(result.digest_page_remaining ? {
      digest_listing: { digest_offset: digest_offset ?? 0, next_call: { tool: "screen_address", repeat_with: { digest_offset: (digest_offset ?? 0) + 5 } } },
     } : {}),
     ...(bridgeDestinationsIncomplete ? {
      bridge_destinations_incomplete: true,
      bridge_destinations_unread: result.bridge_destinations_unread,
      next_call: result.bridge_destinations_unread.some((row) => row.reason === "lookup_budget") && (max_bridge_lookups ?? 10) < 300
       ? { tool: "screen_address", repeat_with: { max_bridge_lookups: Math.min(300, result.bridge_exits_seen) } }
       : result.bridge_destinations_unread[0]?.next_call,
     } : {}),
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
