import { DEFAULT_NETWORK } from "../config.js";

// Only server-owned metadata. Never search arbitrary event data, object content,
// samples, or omitted rows: their Move fields can also be named tool and args.
const CALL_PATHS = [
  "next_call",
 "continue_with",
 "results.*.continue_with",
  "omitted.next_call",
  "omitted.previous_call",
  "omitted.lists.*.next_call",
  "omitted.valuation_evidence.next_call",
  "scan.next_call",
 "lists.*.next_call",
 "rows_page.next_call",
 "coverage.next_call",
 "versions_page.next_call",
  "package_activity.scan.next_call",
  "package_activity_next_call",
  "recent_transactions_next_call",
  "bridge_exits.transaction_detail.next_call",
  "events_page.next_call",
  "commands_omitted.next_call",
  "events_omitted.next_call",
  "inputs_omitted.next_call",
  "object_changes_omitted.next_call",
  "flagged_commands.next_call",
 "venues.*.next_call",
 "shared_funders.*.fanout_next_call",
 "co_funded_in_one_transaction.*.recipient_count_next_call",
 "discovery_scan_next_call",
 "holdings_next_call",
 "staked_sui_count_next_call",
 "collections_next_call",
 "estimated_value.next_call",
 "valuation.next_call",
 "nft_scan_next_call",
 "estimated_value.market_next_call",
 "valuation.market_next_call",
 "nft_market_next_call",
 "owned_scan_next_call",
 "position_scan_next_call",
 "operated_scan.next_call",
 "operated_scan.incomplete_transactions.*.next_call",
 "leads.*.listed_with_next_call",
 "coverage.not_recognised_types.*.next_call",
 "pool_discovery.venues.*.next_call",
 "holder_scan_next_call",
 "digest_listing.next_call",
 "group_digest_listing.next_call",
 "edges.*.signals.*.digest_listing.next_call",
 "expansion_scan.next_call",
 "reciprocal_scan.next_call",
 "address_balances_next_call",
 "kiosk_cap_holder_next_call",
 "unexpanded.*.next_call",
 "bridge_destinations_unread.*.next_call",
 "terminals.*.entries_next_call",
 "explored.terminals.*.entries_next_call",
 "largest_pruned_page.next_call",
 "explored.largest_pruned_page.next_call",
 "objects_page.next_call",
 "state_deltas.read_more_with",
 "follow_up_calls.next_call",
 "state_reads.follow_up_calls.*",
 "objects_follow_up_calls.*",
 "state_reads.read_more_with",
 "object_values_page.next_call",
 "objects_unread_follow_up_calls.*",
 "pnl.senders_next_call",
 "pnl.digests_next_call",
 "pnl.transactions_next_call",
 "event_types_page.next_call",
 "capabilities.next_call",
 "bytecode_scan.version_gates.next_call",
 "owner_change_next_call",
  "upgrade_cap.see",
  "diff.changed_modules.*.sample_next_call",
  "linkage_changes.*.diff",
  "hops.*.kept_as_claim_omitted.next_call",
  "positions.omitted.next_call",
  "nfts.omitted.next_call",
  "nfts_not_valued.next_call",
 "liquidity_custody.next_call",
 "liquidity_custody.pools.*.scan.next_call",
 "liquidity_custody.pools.*.omitted.next_call",
 "liquidity_custody.pools.*.omitted.lists.*.next_call",
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
