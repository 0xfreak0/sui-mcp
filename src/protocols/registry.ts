import { createRequire } from "node:module";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { getMvrName, prefetchMvrNames } from "./mvr-names.js";
import { getPackageRoot, prefetchPackageRoots } from "./package-roots.js";
const require = createRequire(import.meta.url);
const protocolsData = require("../data/protocols.json");
const protocolRootsData = require("../data/protocol-roots.json");

export type ProtocolType =
  | "dex"
  | "lending"
  | "stablecoin"
  | "liquid_staking"
  | "perps"
  | "system"
  | "name_service"
  | "storage"
  | "options"
  | "rwa"
  | "yield"
  | "farm"
  | "oracle"
  | "bridge"
  | "prediction_market"
  | "nft"
  /** Resolved from the Move Registry at runtime; category is not known. */
  | "unknown";

export interface ProtocolInfo {
  name: string;
  type: ProtocolType;
  /**
   * Where this identification came from. Absent means curated (the shipped
   * registry). `"mvr"` means it was reverse-resolved at runtime and carries no
   * verified category — safe to display, not safe to make decisions on.
   */
  source?: "mvr";
}

export interface OperationInfo {
  action: string;
  skip?: boolean; // true for internal/infrastructure ops to omit from summary
}

// Package ID -> Protocol mapping loaded from src/data/protocols.json
const PROTOCOL_MAP: Record<string, ProtocolInfo> = protocolsData.protocols as Record<string, ProtocolInfo>;

/**
 * Upgrade-lineage root -> Protocol, generated from PROTOCOL_MAP by
 * `npm run sync:protocol-roots`.
 *
 * This is the tier that survives an upgrade. PROTOCOL_MAP lists package
 * *versions*, so it identifies a protocol only until the next upgrade mints an
 * ID nobody has typed in; a lineage root is the same for every version the
 * protocol will ever publish. Keys are normalized, because a curated ID may be
 * written short (`0x2`) while the chain reports it padded.
 */
const ROOT_MAP: Record<string, ProtocolInfo> = Object.fromEntries(
  Object.entries(protocolRootsData.roots as Record<string, ProtocolInfo>).map(([root, info]) => [
    normalizeSuiAddress(root),
    info,
  ]),
);

// module::function pattern -> operation action
// Patterns use prefix matching: "pool::swap" matches "pool::swap", "pool::swap_a2b", etc.
interface OperationPattern {
  module: string;
  fnPrefix: string;
  operation: OperationInfo;
}

const OPERATION_PATTERNS: OperationPattern[] = [
  // DEX: swap
  { module: "pool", fnPrefix: "swap", operation: { action: "swap" } },
  { module: "pool", fnPrefix: "flash_swap", operation: { action: "swap" } },
  { module: "router", fnPrefix: "swap", operation: { action: "swap" } },
  { module: "cetus", fnPrefix: "swap", operation: { action: "swap" } },
  { module: "router", fnPrefix: "new_swap_context", operation: { action: "swap" } },
  { module: "router", fnPrefix: "confirm_swap", operation: { action: "swap", skip: true } },

  // DEX: liquidity
  { module: "pool", fnPrefix: "add_liquidity", operation: { action: "add_liquidity" } },
  { module: "pool", fnPrefix: "repay_add_liquidity", operation: { action: "add_liquidity" } },
  { module: "pool", fnPrefix: "remove_liquidity", operation: { action: "remove_liquidity" } },

  // DEX: position management
  { module: "pool", fnPrefix: "open_position", operation: { action: "open_position" } },
  { module: "pool", fnPrefix: "close_position", operation: { action: "close_position" } },

  // Lending: deposit/withdraw
  { module: "lending", fnPrefix: "deposit", operation: { action: "deposit" } },
  { module: "lending", fnPrefix: "withdraw", operation: { action: "withdraw" } },

  // Lending: borrow/repay
  { module: "lending", fnPrefix: "borrow", operation: { action: "borrow" } },
  { module: "lending", fnPrefix: "repay", operation: { action: "repay" } },

  // Lending: flash loans
  { module: "lending", fnPrefix: "flash_loan", operation: { action: "flash_loan" } },
  { module: "lending", fnPrefix: "flash_repay", operation: { action: "flash_repay" } },

  // Suilend: lending_market module
  { module: "lending_market", fnPrefix: "deposit_liquidity", operation: { action: "deposit" } },
  { module: "lending_market", fnPrefix: "redeem_ctokens", operation: { action: "withdraw" } },
  { module: "lending_market", fnPrefix: "borrow", operation: { action: "borrow" } },
  { module: "lending_market", fnPrefix: "repay", operation: { action: "repay" } },
  { module: "lending_market", fnPrefix: "liquidate", operation: { action: "liquidate" } },
  { module: "lending_market", fnPrefix: "claim_rewards", operation: { action: "claim_rewards" } },
  { module: "lending_market", fnPrefix: "create_obligation", operation: { action: "create_obligation" } },
  { module: "lending_market", fnPrefix: "deposit_ctokens", operation: { action: "deposit" } },
  { module: "lending_market", fnPrefix: "withdraw_ctokens", operation: { action: "withdraw" } },
  { module: "lending_market", fnPrefix: "refresh_reserve", operation: { action: "refresh", skip: true } },
  { module: "lending_market", fnPrefix: "compound_interest", operation: { action: "compound", skip: true } },

  // SpringSui: liquid staking
  { module: "liquid_staking", fnPrefix: "mint", operation: { action: "stake" } },
  { module: "liquid_staking", fnPrefix: "redeem", operation: { action: "unstake" } },

  // Turbos: swap + position management
  { module: "swap_router", fnPrefix: "swap", operation: { action: "swap" } },
  { module: "position_manager", fnPrefix: "mint", operation: { action: "open_position" } },
  { module: "position_manager", fnPrefix: "increase_liquidity", operation: { action: "add_liquidity" } },
  { module: "position_manager", fnPrefix: "decrease_liquidity", operation: { action: "remove_liquidity" } },
  { module: "position_manager", fnPrefix: "collect", operation: { action: "claim_rewards" } },
  { module: "position_manager", fnPrefix: "burn", operation: { action: "close_position" } },
  { module: "pool_fetcher", fnPrefix: "compute_swap_result", operation: { action: "quote", skip: true } },

  // Aftermath: swap + liquidity
  { module: "swap", fnPrefix: "swap", operation: { action: "swap" } },
  { module: "deposit", fnPrefix: "deposit", operation: { action: "add_liquidity" } },
  { module: "withdraw", fnPrefix: "", operation: { action: "remove_liquidity" } },

  // Haedal: liquid staking
  { module: "hasui", fnPrefix: "request_stake", operation: { action: "stake" } },
  { module: "hasui", fnPrefix: "request_unstake", operation: { action: "unstake" } },

  // Bluefin: perps settlement
  { module: "settlement", fnPrefix: "", operation: { action: "settle" } },
  { module: "margin", fnPrefix: "", operation: { action: "manage_margin" } },

  // SuiNS: name service
  { module: "payment", fnPrefix: "register", operation: { action: "register" } },
  { module: "payment", fnPrefix: "renew", operation: { action: "renew" } },
  { module: "payment", fnPrefix: "init_registration", operation: { action: "register", skip: true } },
  { module: "payment", fnPrefix: "init_renewal", operation: { action: "renew", skip: true } },
  { module: "controller", fnPrefix: "set_target_address", operation: { action: "set_address", skip: true } },
  { module: "controller", fnPrefix: "set_reverse_lookup", operation: { action: "set_reverse_lookup", skip: true } },
  { module: "controller", fnPrefix: "set_user_data", operation: { action: "set_user_data", skip: true } },
  { module: "register", fnPrefix: "register", operation: { action: "register" } },
  { module: "direct_setup", fnPrefix: "set_target_address", operation: { action: "set_address", skip: true } },
  { module: "direct_setup", fnPrefix: "set_reverse_lookup", operation: { action: "set_reverse_lookup", skip: true } },

  // SuiNS: payments helper (skip — internal price calculations)
  { module: "payments", fnPrefix: "calculate_price", operation: { action: "calculate_price", skip: true } },
  { module: "payments", fnPrefix: "handle_payment", operation: { action: "handle_payment", skip: true } },

  // Walrus: storage
  { module: "staking", fnPrefix: "stake_with_pool", operation: { action: "stake" } },
  { module: "staking", fnPrefix: "request_withdraw_stake", operation: { action: "unstake" } },
  { module: "blob", fnPrefix: "register", operation: { action: "register_blob" } },
  { module: "blob", fnPrefix: "certify", operation: { action: "certify_blob" } },

  // Kriya: DEX
  { module: "spot_dex", fnPrefix: "swap", operation: { action: "swap" } },
  { module: "spot_dex", fnPrefix: "add_liquidity", operation: { action: "add_liquidity" } },
  { module: "spot_dex", fnPrefix: "remove_liquidity", operation: { action: "remove_liquidity" } },

  // DeepBook v3: order book
  { module: "pool", fnPrefix: "place_limit_order", operation: { action: "place_order" } },
  { module: "pool", fnPrefix: "place_market_order", operation: { action: "swap" } },
  { module: "pool", fnPrefix: "cancel_order", operation: { action: "cancel_order" } },
  { module: "balance_manager", fnPrefix: "deposit", operation: { action: "deposit" } },
  { module: "balance_manager", fnPrefix: "withdraw", operation: { action: "withdraw" } },

  // Typus: options / structured products
  { module: "tails_staking", fnPrefix: "stake", operation: { action: "stake" } },
  { module: "tails_staking", fnPrefix: "unstake", operation: { action: "unstake" } },

  // Staking
  { module: "staking_pool", fnPrefix: "request_add_stake", operation: { action: "stake" } },
  { module: "staking_pool", fnPrefix: "request_withdraw_stake", operation: { action: "unstake" } },

  // Transfers
  { module: "coin", fnPrefix: "transfer", operation: { action: "transfer" } },
  { module: "pay", fnPrefix: "", operation: { action: "transfer" } },

  // Internal operations (skip in summary)
  { module: "coin", fnPrefix: "from_balance", operation: { action: "convert", skip: true } },
  { module: "coin", fnPrefix: "into_balance", operation: { action: "convert", skip: true } },
];

/**
 * Curated protocol identification only.
 *
 * Use this anywhere the answer changes behaviour rather than wording — fund
 * tracing's pass-through test, parser selection in `find_pools`. Every entry
 * here was verified by hand and carries a real category. Never widened by
 * runtime resolution; see {@link lookupProtocolDisplay}.
 */
/**
 * The curated package-ID → protocol map, for callers that need to search it by
 * name rather than look up a single ID.
 *
 * Read-only by contract. This is a decode map full of historical package IDs on
 * purpose, so anything using it to pick a *query* target must resolve the
 * lineage and check liveness first — see utils/package-lineage.ts.
 */
export function loadProtocolRegistry(): Record<string, ProtocolInfo> {
  return PROTOCOL_MAP;
}

/**
 * Curated protocol identification: the exact ID first, then the protocol that
 * owns this package's upgrade lineage.
 *
 * Both tiers are hand-verified data, so this stays safe for the callers that
 * change *behaviour* on the answer — fund tracing's pass-through test, parser
 * selection in `find_pools`. The lineage tier only widens an existing curated
 * entry to other versions of the same package, which the chain enforces: only
 * the `UpgradeCap` holder can add one. Contrast {@link lookupProtocolDisplay},
 * which will also hand back a name anybody could have registered.
 *
 * The lineage tier answers only for packages a prefetch has already resolved
 * (see {@link prefetchProtocolNames}); without one this degrades to exact-match,
 * never to a blocking call.
 */
export function lookupProtocol(packageId: string): ProtocolInfo | null {
  const exact = PROTOCOL_MAP[packageId];
  if (exact) return exact;
  const root = getPackageRoot(packageId);
  return root ? (ROOT_MAP[root] ?? null) : null;
}

/**
 * Is this exact package ID in the shipped registry file?
 *
 * Deliberately not lineage-aware: this is the prefetch filter, and it has to
 * answer before any lineage is known. Use {@link lookupProtocol} to ask whether
 * a package *belongs to* a curated protocol.
 */
export function isCuratedProtocol(packageId: string): boolean {
  return packageId in PROTOCOL_MAP;
}

/**
 * Warm the identification caches for packages this call is about to decode.
 *
 * Call once with every package ID in a batch, before the (synchronous) decode
 * loop. Three tiers, cheapest first, each one narrowing what the next has to
 * ask about:
 *
 *   1. The shipped registry, in memory — a fully-known transaction makes no
 *      network call at all.
 *   2. Upgrade lineages, batched (./package-roots.ts). This is what identifies a
 *      protocol that shipped an upgrade since the registry was last curated, and
 *      it yields a real category, not just a name.
 *   3. The Move Registry, in bulk (./mvr-names.ts), for whatever is left —
 *      display names only.
 *
 * Awaiting this is optional: skipping it, or either network step failing, just
 * means fewer packages are identified, exactly as before these tiers existed.
 */
export async function prefetchProtocolNames(packageIds: Iterable<string>): Promise<void> {
  const unknown: string[] = [];
  for (const id of packageIds) {
    if (id && !isCuratedProtocol(id)) unknown.push(id);
  }
  if (unknown.length === 0) return;

  await prefetchPackageRoots(unknown);

  // Only packages no lineage claimed are worth an MVR round trip — and a
  // curated lineage hit is strictly better than an MVR name anyway, since it
  // carries a verified category.
  const stillUnknown = unknown.filter((id) => !lookupProtocol(id));
  await prefetchMvrNames(stillUnknown);
}

/**
 * Protocol identification for **display**: curated first — including the
 * lineage tier, so an upgraded package still reports its protocol and category
 * — then any name the Move Registry gave us for this package (./mvr-names.ts).
 *
 * MVR entries come back with `type: "unknown"` and `source: "mvr"` so callers
 * can tell a verified category from a name someone registered. Falls back to
 * the curated answer — which may be null — when nothing has been prefetched,
 * so this is always safe to call.
 */
export function lookupProtocolDisplay(packageId: string): ProtocolInfo | null {
  const curated = lookupProtocol(packageId);
  if (curated) return curated;
  const mvrName = getMvrName(packageId);
  return mvrName ? { name: mvrName, type: "unknown", source: "mvr" } : null;
}

export function lookupOperation(module: string, fn: string): OperationInfo | null {
  for (const p of OPERATION_PATTERNS) {
    if (p.module === module && (p.fnPrefix === "" || fn === p.fnPrefix || fn.startsWith(p.fnPrefix + "_") || fn.startsWith(p.fnPrefix))) {
      return p.operation;
    }
  }
  return null;
}
