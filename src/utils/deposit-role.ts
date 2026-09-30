import { getNetwork } from "../config.js";
import { currentSuiChain, formatAccountId, namespaceOf, parseAccountId } from "./chain-id.js";
import { getLabel, isSinkCategory, labelProvenance } from "./labels.js";
import type { BalanceReconstruction, DepositWindow, VerdictResult } from "./deposit.js";

interface DepositAssessment extends VerdictResult {
  address: string;
  hot_wallet: string | null;
  window: DepositWindow;
  balance_reconstruction: BalanceReconstruction | null;
  incomplete_transactions?: string[];
}

interface SessionVerdict extends VerdictResult {
  classified_at: string;
  hot_wallet: string | null;
  window: DepositWindow;
  balance_reconstruction: BalanceReconstruction | null;
  incomplete_transactions?: string[];
}

// Observations, not labels. A cached heuristic never changes trace stops or
// replaces a label supplied by an investigator or the shipped registry.
const verdicts = new Map<string, Map<string, SessionVerdict>>();

export function rememberDepositVerdict<T extends DepositAssessment>(result: T): T {
  const account = `${currentSuiChain()}:${result.address}`;
  let windows = verdicts.get(account);
  if (!windows) verdicts.set(account, windows = new Map());
  const key = JSON.stringify([result.window.after_checkpoint, result.window.before_checkpoint]);
  windows.delete(key);
  windows.set(key, {
    classified_at: new Date().toISOString(), verdict: result.verdict,
    hot_wallet: result.hot_wallet, window: result.window,
    checks: result.checks, checks_not_run: result.checks_not_run, reasons: result.reasons,
    balance_reconstruction: result.balance_reconstruction,
    ...(result.incomplete_transactions ? { incomplete_transactions: result.incomplete_transactions } : {}),
  });
  return result;
}

/** Local evidence only. This must never trigger the classifier's network reads. */
export function depositRole(reference: string, requested?: { from?: string | number; to?: string | number }) {
  const account = parseAccountId(reference, currentSuiChain());
  if (namespaceOf(account.chain) !== "sui") return undefined;
  const label = getLabel(reference);
  const inferred = label?.inferred_from;
  const stored = [...(verdicts.get(formatAccountId(account))?.values() ?? [])].reverse();
  const bound = (v: string | number | null | undefined) => v == null || v === "now" ? null : String(v);
  const matching = requested ? stored.filter((r) =>
    bound(r.window.from) === bound(requested.from) && bound(r.window.to) === bound(requested.to)) : stored;
  const latest = matching[0];
  const network = account.chain.slice("sui:".length);
  return {
    status: inferred || latest ? "classified" : "not classified",
    role: inferred || (!label && latest?.verdict === "likely") ? "likely exchange deposit" : null,
    source: inferred ? "inferred_label" : latest ? "session_verdict" : null,
    ...(inferred ? { verdict: "likely", hot_wallet: inferred.swept_to, label_provenance: labelProvenance(label!) } : latest ? { verdict: latest.verdict, window: latest.window, hot_wallet: latest.hot_wallet } : {}),
    ...(stored.length ? { session_verdicts: stored } : {}),
    ...(label && !inferred && latest ? { role_withheld: "The effective registry label takes precedence over session heuristics." } : {}),
    scope: "Inferred labels describe the sweeps in their provenance; session_verdicts describe only their recorded windows. Neither is a lifetime classification.",
    stops_trace: label ? isSinkCategory(label.category) : false,
    trace_rule: inferred
      ? "The effective inferred cex label stops a trace. Override it with manage_labels category other to follow onward."
      : "Only the effective registry label controls label-based trace stops; a session verdict does not add a sink.",
    next_call: {
      tool: "classify_deposit_address",
      args: { address: account.address, network: network || getNetwork(), ...requested },
    },
  };
}
