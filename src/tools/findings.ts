import { z } from "zod";
import { boolArg, numArg } from "./args.js";
import { currentSuiAccount } from "../utils/chain-id.js";
import { errorResult } from "../utils/errors.js";
import { renderCaseReport } from "../utils/case-report.js";
import {
  deleteFinding,
  listCases,
  loadFindings,
  saveFinding,
  storeStatus,
} from "../utils/store.js";
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

export function registerFindingsTools(server: McpServer) {
  server.tool(
    "save_finding",
    "(Incident investigation) Record a conclusion against a named case, so an investigation survives the session it happened in. Save findings as you establish them — what you concluded, which addresses it concerns, and the evidence that supports it — then use export_case to render the whole case as a report. Requires SUI_STORE_PATH.",
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
      addresses: z
        .array(z.string())
        .optional()
        .describe(
          "Addresses the finding concerns. A bare address is recorded against the network this " +
            "call ran on; pass a CAIP-10 id ('eip155:1:0x…', 'sui:mainnet:0x…') to record an " +
            "address on another chain, which is how a cross-chain case keeps both sides of a " +
            "bridge hop straight.",
        ),
      evidence: z
        .array(z.string())
        .optional()
        .describe(
          "What establishes it — tool calls, counts, digests, sample sizes. This is what makes a finding checkable rather than asserted.",
        ),
    },
    async ({ case_name, title, detail, confidence, addresses, evidence }) => {
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
          `Could not record this finding: ${(err as Error).message}. ` +
            "Pass a bare address for the network this call targets, or a full CAIP-10 id.",
        );
      }

      const id = saveFinding({
        case_name,
        title,
        detail: detail ?? null,
        confidence: confidence ?? null,
        addresses: qualified,
        evidence: evidence ?? [],
      });
      return ok({
        saved: true,
        finding_id: id,
        case_name,
        title,
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
          detail: f.detail,
          addresses: f.addresses,
          evidence: f.evidence,
          recorded: f.created_at ? new Date(f.created_at).toISOString() : null,
        })),
      });
    },
  );

  server.tool(
    "export_case",
    "(Incident investigation) Render a case's findings as a Markdown report — ready to paste into a ticket, post-mortem or writeup. Highest-confidence findings first, with an appendix of full addresses. Requires SUI_STORE_PATH.",
    {
      case_name: z.string().describe("Case to render."),
      include_appendix: boolArg()
        .optional()
        .describe("Append the full-address list (default true)."),
    },
    async ({ case_name, include_appendix }) => {
      const blocked = storeRequired();
      if (blocked) return blocked;

      const findings = loadFindings(case_name);
      if (findings.length === 0) {
        return errorResult(
          `No findings recorded for case '${case_name}'. Use list_findings with no arguments to see existing cases.`,
        );
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
      deleteFinding(finding_id);
      return ok({ deleted: true, finding_id });
    },
  );
}
