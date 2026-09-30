import { currentSuiChain, formatAccountId, namespaceOf, parseAccountId } from "./chain-id.js";
import { getLabel, isSinkCategory, labelProvenance } from "./labels.js";
import type { BalanceReconstruction, DepositWindow, VerdictResult } from "./deposit.js";
import type { ResolvedWindow } from "./checkpoint-time.js";

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

export interface DepositRoleWindow {
  from?: string | number;
  to?: string | number;
  resolved: ResolvedWindow;
}

/** Full observations are requested explicitly, never repeated on every flow row. */
export function depositObservations(reference: string): SessionVerdict[] {
  const account = parseAccountId(reference, currentSuiChain());
  return [...(verdicts.get(formatAccountId(account))?.values() ?? [])].reverse();
}

/** Local evidence only. This must never trigger the classifier's network reads. */
export function depositRole(reference: string, requested?: DepositRoleWindow) {
  const account = parseAccountId(reference, currentSuiChain());
  if (namespaceOf(account.chain) !== "sui") return undefined;
  const label = getLabel(reference);
  const inferred = label?.inferred_from;
  const stored = verdicts.get(formatAccountId(account));
  let latest: SessionVerdict | undefined;
  if (requested) {
    latest = stored?.get(JSON.stringify([
      requested.resolved.after?.checkpoint ?? null, requested.resolved.before?.checkpoint ?? null,
    ]));
  } else {
    for (const observation of stored?.values() ?? []) latest = observation;
  }
  const { note: _note, ...window } = latest?.window ?? {};
  const network = account.chain.slice("sui:".length);
  return {
    status: inferred || latest ? "classified" : "not classified",
    role: inferred || (!label && latest?.verdict === "likely") ? "likely exchange deposit" : null,
    source: inferred ? "inferred_label" : latest ? "session_verdict" : null,
    ...(inferred
      ? { verdict: "likely", hot_wallet: inferred.swept_to, label_provenance: labelProvenance(label!) }
      : latest ? { verdict: latest.verdict, hot_wallet: latest.hot_wallet } : {}),
    ...(latest ? { session_verdict: { verdict: latest.verdict, classified_at: latest.classified_at, window } } : {}),
    other_session_observations: (stored?.size ?? 0) - (latest ? 1 : 0),
    ...(stored?.size ? { session_observations_call: {
      tool: "manage_labels", args: { action: "lookup", address: account.address, network, detail: "full" },
    } } : {}),
    ...(label && !inferred && latest ? { role_withheld: "Registry label takes precedence." } : {}),
    stops_trace: label ? isSinkCategory(label.category) : false,
    next_call: {
      tool: "classify_deposit_address",
      args: { address: account.address, network, ...(requested ? { from: requested.from, to: requested.to } : {}) },
    },
  };
}
