import { DEFAULT_NETWORK } from "../config.js";

// Only server-owned metadata. Never search arbitrary event data, object content,
// samples, or omitted rows: their Move fields can also be named tool and args.
const CALL_PATHS = [
  "next_call",
  "omitted.next_call",
  "omitted.lists.*.next_call",
  "omitted.valuation_evidence.next_call",
  "scan.next_call",
  "events_page.next_call",
  "commands_omitted.next_call",
  "events_omitted.next_call",
  "inputs_omitted.next_call",
  "object_changes_omitted.next_call",
  "flagged_commands.next_call",
  "upgrade_cap.see",
  "diff.changed_modules.*.sample_next_call",
  "linkage_changes.*.diff",
  "hops.*.kept_as_claim_omitted.next_call",
  "positions.omitted.next_call",
  "nfts.omitted.next_call",
  "nfts_not_valued.next_call",
].map((path) => path.split("."));

/** Bind a known server-generated call, or a stored result's original args. */
export function bindCallNetwork(value: unknown, network: string): boolean {
  if (network === DEFAULT_NETWORK || value === null || typeof value !== "object") return false;
  const call = value as Record<string, unknown>;
  if (typeof call.tool !== "string" || !call.args || typeof call.args !== "object" || Array.isArray(call.args)) return false;
  const args = call.args as Record<string, unknown>;
  if (args.network !== undefined) return false;
  args.network = network;
  return true;
}

/**
 * Bind only output metadata whose schema defines a tool call. `repeat_with`
 * patches the original args, which retain network. Returns whether JSON changed.
 */
export function bindContinuationNetwork(value: unknown, network: string): boolean {
  if (network === DEFAULT_NETWORK) return false;
  const visit = (node: unknown, path: readonly string[], index: number): boolean => {
    if (index === path.length) return bindCallNetwork(node, network);
    if (!node || typeof node !== "object") return false;
    if (path[index] === "*") {
      let changed = false;
      for (const child of Object.values(node)) changed = visit(child, path, index + 1) || changed;
      return changed;
    }
    return visit((node as Record<string, unknown>)[path[index]], path, index + 1);
  };
  let changed = false;
  for (const path of CALL_PATHS) changed = visit(value, path, 0) || changed;
  return changed;
}
