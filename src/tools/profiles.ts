/**
 * Tool profiles — ship a small default surface, expand on demand.
 *
 * The full tool manifest is ~26k tokens (103k characters; `core` alone is ~6k),
 * and MCP sends it on *every* request.
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

/**
 * Tools that deliberately appear in more than one profile.
 *
 * Profiles are additive — nothing ever removes one — so a tool reachable from
 * two of them is only ever easier to get at, never ambiguous to turn off. Two
 * jobs genuinely need these: reading an unknown package is developer work and
 * investigation work alike, and an investigator who cannot inspect a package
 * falls back to hand-written GraphQL against the Move schema, which is easy to
 * get wrong and is not authoritative anyway. The deployed bytecode is.
 *
 * Anything NOT listed here appearing twice is an accident, and the profile test
 * still fails on it.
 */
export const SHARED_TOOLS = [
  "analyze_package",
  "get_package",
  "get_move_function",
  "disassemble_module",
] as const;

export const PROFILES = {
  /** Everyday lookups: what is this, what does this wallet hold, what happened. */
  core: [
    "identify_address",
    "get_wallet_overview",
    "get_transaction",
    "get_transactions",
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
    // Exchange deposit addresses are the subpoena target, and screening is the
    // first question asked of any address that turns up in a case.
    "classify_deposit_address",
    "screen_address",
    "build_wallet_edges",
    // Multisig work is investigation work: whether a treasury is really run by
    // seven people or two, and whether known wallets share a committee that
    // never surfaced in the trace.
    "analyze_multisig",
    "find_shared_multisig",
    // Whether an issuer has frozen an address is chain-derived attribution, and
    // the question comes up the moment a traced address stops being able to move
    // a token.
    "check_coin_restrictions",
    // Reading an unknown package IS investigation work: naming an obfuscated
    // wrapper, reading a protocol's event structs, checking what a suspicious
    // package can do. These sat in `developer` only, so an investigator running
    // core+forensics had no way to inspect a package — and the observed
    // consequence was hand-written GraphQL against the Move schema, which is
    // both easy to get wrong and not authoritative. The deployed bytecode is.
    "analyze_package",
    "get_package",
    "get_move_function",
    "disassemble_module",
    "build_timeline",
    "trace_object_history",
    "get_upgrade_history",
    "manage_labels",
    "query_events",
    "check_activity",
    "get_top_holders",
    "compare_oracle_price",
    // What an exploit took, per transaction and across an incident, in USD at
    // the time: the question every incident report opens with.
    "analyze_attack_tx",
    "summarize_incident_losses",
    "aggregate_events",
    "save_finding",
    "list_findings",
    "export_case",
    "delete_finding",
    "watch_addresses",
    "poll_watch",
    "get_nft_sales",
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

/**
 * Short labels, used in the `enable_tools` description and the server
 * instructions. The tool names beside them carry the detail; a long summary
 * here is paid on every request and pushes the description past the 2,048
 * characters Claude Code shows.
 */
export const PROFILE_SUMMARIES: Record<ProfileName, string> = {
  core: "wallets, balances, transactions, tokens, NFTs, DeFi",
  forensics: "incident investigation: tracing, attribution, clustering, packages, labels, case findings",
  developer: "Move packages, bytecode, upgrades, PTBs, unsigned transactions, MVR",
  market: "DeepBook, pools, token search, validators",
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
