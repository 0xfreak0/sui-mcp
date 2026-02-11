export interface ProtocolInfo {
  name: string;
  type: "dex" | "lending" | "stablecoin" | "liquid_staking" | "perps" | "system";
}

export interface OperationInfo {
  action: string;
  skip?: boolean; // true for internal/infrastructure ops to omit from summary
}

// Package ID → Protocol mapping (verified on-chain)
const PROTOCOL_MAP: Record<string, ProtocolInfo> = {
  // Cetus
  "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb": { name: "Cetus", type: "dex" },
  "0xb1e11ceaf3e7cd3031ef5e24804478ec3441c5aecdace910bdaca317a0c1c535": { name: "Cetus", type: "dex" },
  // DeepBook
  "0x158f2027f60c89bb91526d9bf08831d27f5a0fcb0f74e6698b9f0e1fb2be5d05": { name: "DeepBook", type: "dex" },
  // FlowX
  "0x25929e7f29e0a30eb4e692952ba1b5b65a3a4d65ab5f2a32e1ba3edcb587f26d": { name: "FlowX", type: "dex" },
  "0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0": { name: "FlowX", type: "dex" },
  // Scallop
  "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf": { name: "Scallop", type: "lending" },
  // Cetus Aggregator Router
  "0x33ec64e9bb369bf045ddc198c81adbf2acab424da37465d95296ee02045d2b17": { name: "Cetus", type: "dex" },
  // NAVI
  "0x834a86970ae93a73faf4fff16ae40bdb72b91c47be585fff19a2af60a19ddca3": { name: "NAVI", type: "lending" },
  "0xee0041239b89564ce870a7dec5ddc5d114367ab94a1137e90aa0633cb76518e0": { name: "NAVI", type: "lending" },
  // Suilend
  "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf": { name: "Suilend", type: "lending" },
  "0x5b54b47971238403d6ade3c8c2cc75814cb55145a5184af916bb5b12aaf184cb": { name: "Suilend", type: "lending" },
  "0xe37cc7bb50fd9b6dbd3873df66fa2c554e973697f50ef97707311dc78bd08444": { name: "Suilend", type: "lending" },
  "0xd2a67633ccb8de063163e25bcfca242929caf5cf1a26c2929dab519ee0b8f331": { name: "Suilend", type: "lending" },
  // SpringSui (Suilend liquid staking)
  "0xb0575765166030556a6eafd3b1b970eba8183ff748860680245b9edd41c716e7": { name: "SpringSui", type: "lending" },
  // Bucket
  "0x9f835c21d21f8ce519fec17d679cd38243ef2643ad879e7048ba77374be4036e": { name: "Bucket", type: "stablecoin" },
  "0x665188033384920a5bb5dcfb2ef21f54b4568d08b431718b97e02e5c184b92cc": { name: "Bucket", type: "stablecoin" },
  // Turbos Finance
  "0xa5a0c25c79e428eba04fb98b3fb2a34db45ab26d4c8faf0d7e39d66a63891e64": { name: "Turbos", type: "dex" },
  "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1": { name: "Turbos", type: "dex" },
  // Aftermath Finance
  "0xc4049b2d1cc0f6e017fda8260e4377cecd236bd7f56a54fee120816e72e2e0dd": { name: "Aftermath", type: "dex" },
  "0x8d8bba50c626753589aa5abbc006c9fa07736f55f4e6fb57481682997c0b0d52": { name: "Aftermath", type: "dex" },
  "0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c": { name: "Aftermath", type: "dex" },
  "0x1575034d2729907aefca1ac757d6ccfcd3fc7e9e77927523c06007d8353ad836": { name: "Aftermath", type: "liquid_staking" },
  "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc": { name: "Aftermath", type: "liquid_staking" },
  // Haedal
  "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d": { name: "Haedal", type: "liquid_staking" },
  // Bluefin
  "0x039146aa464eb40568353e0d8e4c38455ef5781d964ffc9fef4eb5ae023cac58": { name: "Bluefin", type: "perps" },
  "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267": { name: "Bluefin", type: "dex" },
  "0x6c796c3ab3421a68158e0df18e4657b2827b1f8fed5ed4b82dba9c935988711b": { name: "Bluefin", type: "dex" },
  // Sui System
  "0x0000000000000000000000000000000000000000000000000000000000000003": { name: "Sui System", type: "system" },
  "0x3": { name: "Sui System", type: "system" },
  // Sui Framework
  "0x0000000000000000000000000000000000000000000000000000000000000002": { name: "Sui Framework", type: "system" },
  "0x2": { name: "Sui Framework", type: "system" },
};

// module::function pattern → operation action
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
