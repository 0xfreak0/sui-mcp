import { z } from "zod";
import { boolArg, numArg } from "./args.js";
import { currentSuiAccount } from "../utils/chain-id.js";
import { errorResult } from "../utils/errors.js";
import { renderCaseReport } from "../utils/case-report.js";
import { invalidDigestMessage, isDigest, normalizeDigest } from "../utils/digest.js";
import {
  deleteFinding,
  EVIDENCE_TIERS,
  listCases,
  loadFindings,
  saveFinding,
  storeStatus,
  type Finding,
} from "../utils/store.js";
import { buildCaseGraph, type CaseTx } from "../utils/case-graph.js";
import { toCsv, toGraphJson, toMermaid } from "../utils/flow-export.js";
import { fetchTx, formatAmount } from "../utils/trace-read.js";
import { getLabel } from "../utils/labels.js";
import { detectBridges } from "../utils/bridge/detect.js";
import { lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ok = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});

/** Shared refusal, since every tool here is useless without the store. */
function storeRequired() {
  const s = storeStatus();
  if (s.enabled) return null;
  return errorResult(
    `Findings need the local store, which is off (${s.reason}). ` +
      "Set SUI_STORE_PATH in your MCP client config, e.g. " +
      "\"env\": { \"SUI_STORE_PATH\": \"~/.local/share/sui-mcp/store.db\" }, then restart. " +
      "It uses Node's built-in SQLite and writes nothing until you set it.",
  );
}

/** Transactions read for a case diagram. */
const CASE_GRAPH_DIGESTS = 50;

/** Move stdlib, Sui framework and Sui system: called by nearly every transaction, never the protocol holding value. */
const FRAMEWORK = new Set(["0x1", "0x2", "0x3"].map((a) => normalizeSuiAddress(a)));

/** The case's transfers, read from the transactions its findings cite. */
async function caseFlowGraph(findings: Finding[]) {
  const all = [...new Set(findings.flatMap((f) => f.digests))];
  const digests = all.slice(0, CASE_GRAPH_DIGESTS);
  const read = await Promise.all(digests.map((d) => fetchTx(d).catch(() => null)));
  const txs: CaseTx[] = [];
  const unread: string[] = [];
  // Value a case address received that no address paid came out of the called
  // protocols' shared objects, so those protocols need a name in the diagram.
  const packages = new Set(
    read.flatMap((tx) => tx?.callSites.map((c) => normalizeSuiAddress(c.packageId)) ?? []).filter((p) => !FRAMEWORK.has(p)),
  );
  await prefetchProtocolNames(packages).catch(() => undefined);
  read.forEach((tx, i) => {
    if (!tx) {
      unread.push(digests[i]);
      return;
    }
    const bridges = [...new Set(detectBridges(tx.callSites, tx.eventTypes ?? []).map((h) => h.protocol))];
    const protocols = [
      ...new Set(
        tx.callSites
          .map((c) => normalizeSuiAddress(c.packageId))
          .filter((p) => !FRAMEWORK.has(p))
          .map((p) => lookupProtocolDisplay(p)?.name ?? `${p.slice(0, 10)}…`),
      ),
    ];
    txs.push({
      digest: digests[i],
      sender: tx.sender,
      ...(bridges.length ? { bridges } : {}),
      ...(protocols.length ? { protocols } : {}),
      timestamp: tx.timestamp,
      changes: tx.balanceChanges,
      gas: { payer: tx.gasPayer ?? null, net: tx.netGas == null ? null : BigInt(tx.netGas) },
    });
  });
  const graph = buildCaseGraph(findings, txs, {
    nameOf: (a) => getLabel(a)?.label,
    formatAmount: (raw, coin) => formatAmount(raw.toString(), coin).replace(/^[+-]/, ""),
  });
  return {
    graph,
    notes: {
      ...(unread.length ? { unread_digests: unread } : {}),
      ...(all.length > digests.length ? { digests_capped: all.length } : {}),
    },
  };
}

export function registerFindingsTools(server: McpServer) {
  server.tool(
    "save_finding",
    "(Incident investigation) Record a conclusion against a named case, so an investigation survives the session it happened in. Save findings as you establish them — what you concluded, how it is known (evidence_tier), which addresses and transactions it concerns, and the evidence that supports it — then use export_case to render the whole case as a report. Requires SUI_STORE_PATH.",
    {
      case_name: z
        .string()
        .describe("Case this belongs to, e.g. 'alphalend-sybil-2026-08'. Reused across findings."),
      title: z.string().describe("One-line statement of the finding."),
      detail: z.string().optional().describe("Fuller explanation, including caveats."),
      confidence: z
        .enum(["high", "medium", "low"])
        .optional()
        .describe("How firmly this is established. Reports sort high confidence first."),
      evidence_tier: z
        .enum(EVIDENCE_TIERS)
        .optional()
        .describe(
          "How the finding is known: 'chain-derived' (read from Sui itself, e.g. a transfer in a transaction), " +
            "'indexer-attested' (a third party asserts it, e.g. a bridge indexer), or 'heuristic' (an inference " +
            "from patterns, e.g. a shared funder). Default 'heuristic', the weakest, so an unstated tier is never " +
            "read as a stronger one. export_case groups findings by it.",
        ),
      addresses: z
        .array(z.string())
        .optional()
        .describe(
          "Addresses the finding concerns. A bare address is recorded against the network this " +
            "call ran on; pass a CAIP-10 id ('eip155:1:0x…', 'sui:mainnet:0x…') to record an " +
            "address on another chain, which is how a cross-chain case keeps both sides of a " +
            "bridge hop straight.",
        ),
      digests: z
        .array(z.string())
        .optional()
        .describe("Sui transaction digests the finding rests on. Each is checked to be a real digest before saving."),
      evidence: z
        .array(z.string())
        .optional()
        .describe(
          "What establishes it — tool calls, counts, digests, sample sizes. This is what makes a finding checkable rather than asserted.",
        ),
    },
    async ({ case_name, title, detail, confidence, evidence_tier, addresses, digests, evidence }) => {
      const blocked = storeRequired();
      if (blocked) return blocked;

      // Store canonical CAIP-10 ids, never what the caller happened to type.
      // A finding outlives the session, and an unqualified address in a
      // cross-chain case is genuinely ambiguous later.
      let qualified: string[];
      try {
        qualified = (addresses ?? []).map(currentSuiAccount);
      } catch (err) {
        return errorResult(
          `Could not record this finding: ${(err as Error).message.replace(/\.$/, "")}. ` +
            "Pass a bare address for the network this call targets, or a full CAIP-10 id.",
        );
      }

      // A mistyped digest in a report is a citation nobody can follow.
      const badDigest = (digests ?? []).find((d) => !isDigest(d));
      if (badDigest !== undefined) {
        return errorResult(`Could not record this finding: ${invalidDigestMessage(badDigest)}`);
      }

      const tier = evidence_tier ?? "heuristic";
      const id = saveFinding({
        case_name,
        title,
        detail: detail ?? null,
        confidence: confidence ?? null,
        evidence_tier: tier,
        addresses: qualified,
        evidence: evidence ?? [],
        digests: (digests ?? []).map(normalizeDigest),
      });
      return ok({
        saved: true,
        finding_id: id,
        case_name,
        title,
        evidence_tier: tier,
        note: `Use export_case with case_name '${case_name}' to render the full report.`,
      });
    },
  );

  server.tool(
    "list_findings",
    "(Incident investigation) List recorded findings, or every case with its finding count. Call with no arguments to see what cases exist. Requires SUI_STORE_PATH.",
    {
      case_name: z
        .string()
        .optional()
        .describe("Case to list. Omit to list all cases with their counts instead."),
    },
    async ({ case_name }) => {
      const blocked = storeRequired();
      if (blocked) return blocked;

      if (!case_name) {
        const cases = listCases();
        return ok({
          case_count: cases.length,
          cases: cases.map((c) => ({
            case_name: c.case_name,
            finding_count: c.finding_count,
            last_updated: new Date(c.last_updated).toISOString(),
          })),
        });
      }

      const findings = loadFindings(case_name);
      return ok({
        case_name,
        finding_count: findings.length,
        findings: findings.map((f) => ({
          id: f.id,
          title: f.title,
          confidence: f.confidence,
          evidence_tier: f.evidence_tier,
          detail: f.detail,
          addresses: f.addresses,
          digests: f.digests,
          evidence: f.evidence,
          recorded: f.created_at ? new Date(f.created_at).toISOString() : null,
        })),
      });
    },
  );

  server.tool(
    "export_case",
    "(Incident investigation) Render a case's findings as a Markdown report — ready to paste into a ticket, post-mortem or writeup. Findings are grouped by evidence tier (chain-derived, then indexer-attested, then heuristic) and highest confidence first within each, with an appendix of full addresses. Requires SUI_STORE_PATH.",
    {
      case_name: z.string().describe("Case to render."),
      include_appendix: boolArg()
        .optional()
        .describe("Append the full-address list (default true)."),
      format: z
        .enum(["markdown", "mermaid", "graph_json", "csv"])
        .optional()
        .describe(
          "markdown (default): the report. mermaid: the report followed by a fund-flow diagram (a ```mermaid block) of the transfers in the findings' transactions between the case's addresses, including value the case's addresses took out of or paid into protocols' shared objects (drawn as one node per protocol set), with each finding's cross-chain accounts linked dashed; reads those transactions from the chain. graph_json: that diagram as {nodes, edges}. csv: one row per finding.",
        ),
    },
    async ({ case_name, include_appendix, format }) => {
      const blocked = storeRequired();
      if (blocked) return blocked;

      const findings = loadFindings(case_name);
      if (findings.length === 0) {
        return errorResult(
          `No findings recorded for case '${case_name}'. Use list_findings with no arguments to see existing cases.`,
        );
      }

      if (format === "csv") {
        return {
          content: [
            {
              type: "text" as const,
              text: toCsv(
                ["id", "evidence_tier", "confidence", "title", "detail", "addresses", "digests", "evidence", "created_at"],
                findings.map((f) => ({
                  ...f,
                  evidence: f.evidence.join(" | "),
                  created_at: f.created_at ? new Date(f.created_at).toISOString() : "",
                })),
              ),
            },
          ],
        };
      }
      if (format === "mermaid" || format === "graph_json") {
        const flow = await caseFlowGraph(findings);
        if (format === "graph_json") {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ...toGraphJson(flow.graph), ...flow.notes }, null, 2) }] };
        }
        const report = renderCaseReport({ caseName: case_name, findings, includeAppendix: include_appendix });
        const diagram = flow.graph.edges.length
          ? toMermaid(flow.graph)
          : "_No transfers between the case's addresses were found in its findings' transactions, and no finding links accounts on two chains._";
        const caveats = [
          "Solid arrows are transfers read from the chain in the findings' transactions, each recipient paired with the largest payer of that coin. Dashed arrows are cross-chain links a finding records.",
          ...(flow.notes.unread_digests ? [`Not read: ${flow.notes.unread_digests.join(", ")}.`] : []),
          ...(flow.notes.digests_capped ? [`Only the first ${CASE_GRAPH_DIGESTS} transactions were read.`] : []),
        ];
        return {
          content: [{ type: "text" as const, text: `${report}\n## Fund flow\n\n${diagram}\n\n_${caveats.join(" ")}_\n` }],
        };
      }

      // Returned as text, not JSON: the whole point is a document someone
      // pastes somewhere, and JSON-escaping it would defeat that.
      return {
        content: [
          {
            type: "text" as const,
            text: renderCaseReport({
              caseName: case_name,
              findings,
              includeAppendix: include_appendix,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "delete_finding",
    "(Incident investigation) Remove a finding by id — for retracting something that turned out to be wrong. Use list_findings to get ids. Requires SUI_STORE_PATH.",
    {
      finding_id: numArg().int().describe("Finding id from list_findings."),
    },
    async ({ finding_id }) => {
      const blocked = storeRequired();
      if (blocked) return blocked;
      const deleted = deleteFinding(finding_id);
      return ok({
        deleted,
        finding_id,
        ...(deleted ? {} : { note: "No finding has that id. Nothing was deleted — check list_findings." }),
      });
    },
  );
}
