import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const protocolsData = require("../data/protocols.json");

export interface ProtocolInfo {
  name: string;
  type: "dex" | "lending" | "stablecoin" | "liquid_staking" | "perps" | "system" | "name_service" | "storage" | "options";
}

export interface OperationInfo {
  action: string;
  skip?: boolean; // true for internal/infrastructure ops to omit from summary
}

// Package ID -> Protocol mapping loaded from src/data/protocols.json
const PROTOCOL_MAP: Record<string, ProtocolInfo> = protocolsData.protocols as Record<string, ProtocolInfo>;

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

export function lookupProtocol(packageId: string): ProtocolInfo | null {
  return PROTOCOL_MAP[packageId] ?? null;
}

export function lookupOperation(module: string, fn: string): OperationInfo | null {
  for (const p of OPERATION_PATTERNS) {
    if (p.module === module && (p.fnPrefix === "" || fn === p.fnPrefix || fn.startsWith(p.fnPrefix + "_") || fn.startsWith(p.fnPrefix))) {
      return p.operation;
    }
  }
  return null;
}
