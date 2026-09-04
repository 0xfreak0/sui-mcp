/**
 * Tool profiles — ship a small default surface, expand on demand.
 *
 * The full tool manifest is ~13.8k tokens, and MCP sends it on *every* request.
 * That is context spent before any work happens, and a large flat tool list also
 * degrades selection accuracy: the failure mode is not "too many entries" so
 * much as several plausible-looking tools for one intent.
 *
 * Same approach GitHub's MCP server takes with `GITHUB_TOOLSETS` /
 * `GITHUB_DYNAMIC_TOOLSETS`, for the same stated reason.
 *
 * Two ways in, because clients differ:
 *
 *   - `SUI_TOOLS=core,forensics` picks the startup surface. Always works.
 *   - `enable_tools` turns a profile on mid-session. Depends on the client
 *     honouring `notifications/tools/list_changed`; Claude Code and Claude
 *     Desktop do, some clients cache the list and won't notice until restart.
 *
 * The env var is therefore the reliable path and the runtime tool is the
 * enhancement. Nothing is ever removed — a disabled tool is one call away.
 */

export const PROFILES = {
  /** Everyday lookups: what is this, what does this wallet hold, what happened. */
  core: [
    "identify_address",
    "get_wallet_overview",
    "get_transaction",
    "get_transaction_history",
    "query_transactions",
    "get_object",
    "list_owned_objects",
    "get_balance",
    "analyze_token",
    "get_token_prices",
    "list_nfts",
    "list_nft_collections",
    "get_defi_positions",
    "get_staking_summary",
    "find_pools",
    "resolve_name",
    "get_chain_info",
  ],

  /** Incident investigation: follow value, attribute accounts, reconstruct time. */
  forensics: [
    "resolve_protocol_packages",
    "sample_control_addresses",
    "trace_funds",
    "resolve_bridge_transfer",
    "find_funding_source",
    "find_funding_sources",
    "get_address_fanout",
    "build_wallet_edges",
    "build_timeline",
    "trace_object_history",
    "manage_labels",
    "query_events",
    "check_activity",
    "get_top_holders",
    "compare_oracle_price",
    "aggregate_events",
    "save_finding",
    "list_findings",
    "export_case",
    "delete_finding",
  ],

  /** Contract analysis and transaction construction. */
  developer: [
    "get_package",
    "get_move_function",
    "get_package_dependency_graph",
    "analyze_package",
    "disassemble_module",
    "decompile_module",
    "diff_package_upgrade",
    "decode_ptb",
    "simulate_transaction",
    "build_transfer",
    "build_staking",
    "get_checkpoint",
    "list_dynamic_fields",
    "mvr_resolve",
    "mvr_reverse_resolve",
    "mvr_get_package_info",
    "mvr_search",
    "mvr_resolve_struct",
  ],

  /** Market microstructure and token discovery. */
  market: [
    "deepbook_orderbook",
    "deepbook_trades",
    "get_pool_stats",
    "search_token",
    "get_coin_info",
    "get_validators",
  ],
} as const;

export type ProfileName = keyof typeof PROFILES;

export const PROFILE_NAMES = Object.keys(PROFILES) as ProfileName[];

/** One-line summaries, used in the `enable_tools` description. */
export const PROFILE_SUMMARIES: Record<ProfileName, string> = {
  core: "Everyday lookups — wallets, balances, transactions, tokens, NFTs, DeFi positions",
  forensics:
    "Incident investigation — fund tracing, batch funding attribution, address fan-out, live wallet-edge clustering, multi-address timelines, object provenance, address labels, cross-chain bridge resolution, oracle-vs-market deviation, and recording findings into an exportable case report",
  developer:
    "Move package analysis — modules, disassembly, decompilation, upgrade diffing, dependency graphs, PTB decoding, unsigned transaction building, Move Registry",
  market: "Market data — DeepBook order book and fills, pool stats, token search, validators",
};

export const DEFAULT_PROFILES: ProfileName[] = ["core"];

/**
 * Parse `SUI_TOOLS` into a profile list.
 *
 * Accepts a comma-separated list, `all` for everything, and is forgiving about
 * case and spacing. Unknown names are ignored rather than fatal: a typo in a
 * client config should not leave someone with a server that won't start, and
 * the resulting surface is still usable.
 *
 * Returns null to mean "every profile" so callers can distinguish `all` from
 * an explicit list that happens to cover everything.
 */
export function parseProfileList(raw: string | undefined): ProfileName[] | null {
  if (!raw?.trim()) return DEFAULT_PROFILES;

  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (parts.includes("all")) return null;

  const picked = parts.filter((p): p is ProfileName => p in PROFILES);
  // Everything was unrecognised — fall back rather than register nothing.
  return picked.length ? [...new Set(picked)] : DEFAULT_PROFILES;
}

/** Tool names covered by a profile selection; null means every profile. */
export function toolsForProfiles(profiles: ProfileName[] | null): Set<string> {
  const names = profiles ?? PROFILE_NAMES;
  const out = new Set<string>();
  for (const p of names) for (const t of PROFILES[p]) out.add(t);
  return out;
}

/** Every tool name assigned to any profile. */
export function allProfiledTools(): Set<string> {
  return toolsForProfiles(null);
}
