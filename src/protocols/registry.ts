export interface ProtocolInfo {
  name: string;
  type: "dex" | "lending" | "stablecoin" | "system";
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
  // NAVI
  "0x834a86970ae93a73faf4fff16ae40bdb72b91c47be585fff19a2af60a19ddca3": { name: "NAVI", type: "lending" },
  // Bucket
  "0x9f835c21d21f8ce519fec17d679cd38243ef2643ad879e7048ba77374be4036e": { name: "Bucket", type: "stablecoin" },
  "0x665188033384920a5bb5dcfb2ef21f54b4568d08b431718b97e02e5c184b92cc": { name: "Bucket", type: "stablecoin" },
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
  { module: "router", fnPrefix: "confirm_swap", operation: { action: "swap" } },

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
